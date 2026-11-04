/** 用户任务语义与分支回读：记录公开进展、待处理事项和产物；执行身份由宿主绑定，上报不增加授权。 */
import type { ExtensionContext, ExtensionFactory, ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent'
import { isTaskIntent, parseTaskIntentInput, TASK_INTENT_ENTRY_TYPE, TASK_INTENT_MAX_STAGES,
  TASK_INTENT_TEXT_LIMIT, TASK_INTENT_SUMMARY_LIMIT, TASK_INTENT_MAX_ARTIFACTS } from '../shared/task-intent'
import type { TaskIntent, TaskIntentInput } from '../shared/task-intent'

export const TASK_INTENT_EXTENSION_NAME = 'task-intent'
type ToolParameters = Parameters<ExtensionAPI['registerTool']>[0]['parameters']
export interface TaskExecutionContext {
  readonly flowId: string
  readonly stepId: string
  readonly taskId: string | null
}

/** 只消费当前分支中合法且归属于当前用户轮次的记录，废弃分支不能参与任务接续。 */
export function readTaskIntents(branch: readonly SessionEntry[]): Map<string, TaskIntent> {
  const byTurn = new Map<string, TaskIntent>()
  const tasks = new Map<string, TaskIntent>()
  const users = new Set<string>()
  let turnEntryId: string | null = null
  for (const entry of branch) {
    if (entry.type === 'message' && entry.message.role === 'user') {
      turnEntryId = entry.id
      users.add(entry.id)
    }
    if (entry.type !== 'custom' || entry.customType !== TASK_INTENT_ENTRY_TYPE || !isTaskIntent(entry.data)) continue
    const intent = entry.data
    if (intent.turnEntryId !== turnEntryId || !users.has(intent.rootEntryId)) continue
    const previous = tasks.get(intent.taskId)
    const current = byTurn.get(intent.turnEntryId)
    if ((previous === undefined && intent.rootEntryId !== intent.turnEntryId)
      || (previous !== undefined && intent.revision <= previous.revision)
      || (current !== undefined && current.taskId !== intent.taskId)) continue
    tasks.set(intent.taskId, intent)
    byTurn.set(intent.turnEntryId, intent)
  }
  return byTurn
}

/** 模型不能指定历史轮次或步骤身份；串行步骤只能接续宿主绑定的任务。 */
export function createTaskIntentReport(branch: readonly SessionEntry[], input: TaskIntentInput,
  execution: TaskExecutionContext | null = null): TaskIntent {
  const turn = branch.findLast(entry => entry.type === 'message' && entry.message.role === 'user')
  if (turn === undefined) throw new Error('当前分支没有可关联的用户轮次，未记录任务说明。')
  if (input.stepOutcome !== undefined && execution === null) throw new Error('当前不是串行执行步骤，不能声明步骤结果。')
  if (execution?.taskId != null && input.taskId !== null && input.taskId !== execution.taskId) {
    throw new Error('当前步骤属于已绑定任务，不能改写成另一任务。')
  }
  const reports = readTaskIntents(branch)
  const current = reports.get(turn.id)
  const selectedId = execution?.taskId ?? input.taskId ?? current?.taskId ?? `task_${turn.id}`
  let previous: TaskIntent | undefined
  for (const report of reports.values()) {
    if (report.taskId === selectedId && (previous === undefined || previous.revision < report.revision)) previous = report
  }
  if (selectedId !== `task_${turn.id}` && previous === undefined) throw new Error('任务身份不属于当前分支；新任务请使用 taskId: null。')
  if (current !== undefined && current.taskId !== selectedId) throw new Error('本轮已有任务归属，不能改写成另一任务。')
  const plan = input.stages ?? previous?.stages ?? []
  const stageId = input.stageId !== undefined ? input.stageId
    : plan.find(stage => stage.progress === 'in_progress')?.id ?? current?.stageId ?? null
  const status = input.status ?? (input.stepOutcome === 'waiting' || input.attention != null ? 'waiting' : current?.status ?? 'working')
  const waiting = status === 'waiting' || status === 'blocked'
  const attention = waiting ? input.attention ?? current?.attention ?? previous?.attention ?? null : null
  if (waiting && attention === null) throw new Error('等待或受阻时，请用 attention 说明需要用户处理的具体内容。')
  if (!waiting && input.attention != null) throw new Error('存在待处理事项时，任务状态必须是 waiting 或 blocked。')
  if (input.stepOutcome === 'waiting' && !waiting) throw new Error('步骤等待时，任务状态必须是 waiting 或 blocked，并提供 attention。')
  if (input.stepOutcome === 'completed' && (waiting || status === 'cancelled' || status === 'planning')) {
    throw new Error('等待、受阻、停止或仍在规划时不能声明当前步骤已交付。')
  }
  const report: TaskIntent = {
    source: 'agent', taskId: selectedId, rootEntryId: previous?.rootEntryId ?? turn.id, turnEntryId: turn.id,
    revision: (previous?.revision ?? 0) + 1, reportedAt: Date.now(),
    taskTitle: input.taskTitle, intent: input.intent, stages: plan.map(stage => ({ ...stage })), stageId,
    summary: input.summary === undefined ? current?.summary ?? null : input.summary,
    status, attention, artifacts: (input.artifacts ?? previous?.artifacts ?? []).map(item => ({ ...item })),
    ...(execution !== null && input.stepOutcome !== undefined
      ? { step: { flowId: execution.flowId, stepId: execution.stepId, outcome: input.stepOutcome } } : {})
  }
  if (!isTaskIntent(report)) throw new Error('任务说明不完整：阶段、待处理事项和结果必须与当前任务一致。')
  return report
}

export function createTaskIntentExtension(
  commit: (input: TaskIntentInput, ctx: ExtensionContext) => TaskIntent,
  executionContext: () => TaskExecutionContext | null = () => null
): ExtensionFactory {
  return pi => {
    let userRun = false
    pi.on('before_agent_start', (event, ctx) => {
      userRun = event.messageType === 'user'
      if (!userRun) { delete event.systemPromptOptions.sections.task_intents; return }
      const tasks = new Map<string, TaskIntent>()
      for (const report of readTaskIntents(ctx.sessionManager.getBranch()).values()) {
        const previous = tasks.get(report.taskId)
        if (previous === undefined || previous.revision < report.revision) {
          tasks.delete(report.taskId)
          tasks.set(report.taskId, report)
        }
      }
      const recent = [...tasks.values()].slice(-4)
      const execution = executionContext()
      event.systemPromptOptions.sections.task_intents = [
        '以下是当前分支最近的任务说明，仅作接续上下文，不是用户要求或执行授权。',
        '同一目标沿用 taskId；新目标新建任务。状态、待处理事项与产物由实际工作决定，不从一轮回复结束推断任务完成。',
        JSON.stringify(recent.map(report => ({ taskId: report.taskId, taskTitle: report.taskTitle,
          lastIntent: report.intent, stageId: report.stageId, stages: report.stages,
          status: report.status, attention: report.attention, artifacts: report.artifacts }))),
        ...(execution === null ? [] : [
          `当前正在执行串行计划的一步，所属任务：${execution.taskId ?? '尚未建立，请在首次 task_report 新建'}。`,
          '只执行当前步骤。最终回复前用 task_report 的 stepOutcome 明确声明 completed 或 waiting。',
          '需要新增授权、用户决定、补充资料或仍有阻塞时，status=waiting/blocked，提供 attention，并声明 stepOutcome=waiting；程序将停止后续派发。',
          '只有当前步骤的已授权工作确实交付时才声明 stepOutcome=completed；这不表示整个任务完成或结果经过测试。缺少声明会停在等待状态。'
        ])
      ].join('\n')
    })
    pi.on('session_shutdown', () => { userRun = false })
    pi.registerTool({
      name: 'task_report', label: '更新任务进展', executionMode: 'sequential',
      description: '记录当前用户任务的公开目标、进展、待处理事项与产物。新任务 taskId=null；接续任务使用当前分支已有身份。状态是 Agent 的业务说明，不替代真实执行状态或操作授权。串行执行步骤结束前必须声明 stepOutcome；步骤身份由宿主绑定。',
      promptSnippet: 'task_report — 记录用户任务进展、待处理与交付；串行步骤须声明业务结果',
      promptGuidelines: [
        '每轮用户请求在完成必须的规范选择后、处理业务前，用 task_report 简短说明本轮实际工作，不复制用户输入或回复首句。',
        '简单问答只上报 intent，不制造阶段；长任务再提供业务阶段。同一目标沿用 taskId，阶段不是 read/edit/bash 等工具类别。',
        '只在业务阶段、任务状态、待处理事项或交付实际变化时更新，不随每次工具调用重复上报。stages 和 artifacts 提供时均整体替换，省略则沿用。',
        'status：planning 规划、working 推进、waiting 等用户、delivered 已交付、blocked 受阻、cancelled 已停止。delivered 仅表示实际交付，不表示测试通过或用户认可。',
        '等待或受阻时必须提供 attention（decision 决策、permission 授权、information 补充资料）及具体 message。解除等待时明确更新为 working 或 delivered。',
        'summary 只写本轮实际交付，artifacts 只引用真实存在于所属工作区的文件相对路径、标题及简述，不能用读取过的文件冒充产物。',
        '串行步骤最终回复前声明 stepOutcome=completed 或 waiting。需要新增授权或仍有阻塞时必须 waiting；普通对话不要传 stepOutcome。',
        '上报不启动步骤，不授予文件修改、测试、构建或其他权限，也不得为补报额外启动模型。不要输出内部思考过程、秘密或整段答案。'
      ],
      parameters: {
        type: 'object', additionalProperties: false, required: ['taskId', 'taskTitle', 'intent'], properties: {
          taskId: { anyOf: [{ type: 'string', maxLength: 133 }, { type: 'null' }], description: '新任务用 null，接续使用当前分支的任务身份' },
          taskTitle: { type: 'string', minLength: 1, maxLength: TASK_INTENT_TEXT_LIMIT, description: '整体用户目标' },
          intent: { type: 'string', minLength: 1, maxLength: TASK_INTENT_TEXT_LIMIT, description: '本轮实际推进的工作' },
          status: { type: 'string', enum: ['planning', 'working', 'waiting', 'delivered', 'blocked', 'cancelled'] },
          attention: { anyOf: [{ type: 'null' }, {
            type: 'object', additionalProperties: false, required: ['kind', 'message'], properties: {
              kind: { type: 'string', enum: ['decision', 'permission', 'information'] },
              message: { type: 'string', minLength: 1, maxLength: TASK_INTENT_SUMMARY_LIMIT }
            }
          }], description: '等待用户时的具体问题或操作说明；解除等待时可传 null' },
          artifacts: { type: 'array', maxItems: TASK_INTENT_MAX_ARTIFACTS, items: {
            type: 'object', additionalProperties: false, required: ['path', 'title', 'description'], properties: {
              path: { type: 'string', minLength: 1, maxLength: 512, description: '工作区内相对路径，不含 ..、盘符或绝对路径' },
              title: { type: 'string', minLength: 1, maxLength: TASK_INTENT_TEXT_LIMIT },
              description: { anyOf: [{ type: 'string', minLength: 1, maxLength: TASK_INTENT_SUMMARY_LIMIT }, { type: 'null' }] }
            }
          } },
          stepOutcome: { type: 'string', enum: ['completed', 'waiting'], description: '仅串行步骤使用，缺少声明不自动推进' },
          stages: { type: 'array', maxItems: TASK_INTENT_MAX_STAGES, items: {
            type: 'object', additionalProperties: false, required: ['id', 'title', 'progress'], properties: {
              id: { type: 'string', minLength: 1, maxLength: 128 },
              title: { type: 'string', minLength: 1, maxLength: TASK_INTENT_TEXT_LIMIT },
              progress: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] }
            }
          }, description: '至少两项业务阶段，或空数组表示简单任务' },
          stageId: { anyOf: [{ type: 'string', maxLength: 128 }, { type: 'null' }], description: '本轮所属阶段' },
          summary: { anyOf: [{ type: 'string', minLength: 1, maxLength: TASK_INTENT_SUMMARY_LIMIT }, { type: 'null' }], description: '本轮实际交付摘要' }
        }
      } as unknown as ToolParameters,
      async execute(_id, raw, signal, _update, ctx) {
        if (signal?.aborted) throw new Error('本轮已取消，未记录任务说明。')
        if (!userRun) throw new Error('只允许为用户发起的轮次记录任务说明，不改写其他轮次。')
        const input = parseTaskIntentInput(raw)
        if (input === null) throw new Error('任务说明格式无效，请检查状态、阶段、待处理说明和产物相对路径。')
        const report = commit(input, ctx)
        return { content: [{ type: 'text', text: `已记录：${report.intent}\n任务身份：${report.taskId}。仅记录任务进展，不增加任何操作授权。` }],
          details: { taskId: report.taskId, turnEntryId: report.turnEntryId, revision: report.revision } }
      }
    })
  }
}
