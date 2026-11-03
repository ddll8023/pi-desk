/** 任务语义扩展与分支回读：只记录当前用户轮次的公开工作说明，不派发任务、不授予权限，也不调用额外模型。 */
import type { ExtensionContext, ExtensionFactory, ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent'
import { isTaskIntent, parseTaskIntentInput, TASK_INTENT_ENTRY_TYPE, TASK_INTENT_MAX_STAGES,
  TASK_INTENT_TEXT_LIMIT, TASK_INTENT_SUMMARY_LIMIT } from '../shared/task-intent'
import type { TaskIntent, TaskIntentInput } from '../shared/task-intent'

export const TASK_INTENT_EXTENSION_NAME = 'task-intent'
type ToolParameters = Parameters<ExtensionAPI['registerTool']>[0]['parameters']

/** 只消费当前分支中合法且紧随所属用户轮次的记录；废弃分支和错误归属不能参与任务接续。 */
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

/** 任务和轮次 ID 均由已确认的分支确定，模型不能指定任意历史轮次或其他会话。 */
export function createTaskIntentReport(branch: readonly SessionEntry[], input: TaskIntentInput): TaskIntent {
  const turn = branch.findLast(entry => entry.type === 'message' && entry.message.role === 'user')
  if (turn === undefined) throw new Error('当前分支没有可关联的用户轮次，未记录任务说明。')
  const reports = readTaskIntents(branch)
  const current = reports.get(turn.id)
  const selectedId = input.taskId ?? current?.taskId ?? `task_${turn.id}`
  let previous: TaskIntent | undefined
  for (const report of reports.values()) {
    if (report.taskId === selectedId && (previous === undefined || previous.revision < report.revision)) previous = report
  }
  if (input.taskId !== null && previous === undefined) throw new Error('任务身份不属于当前分支；新任务请使用 taskId: null。')
  if (current !== undefined && current.taskId !== selectedId) throw new Error('本轮已有任务归属，不能改写成另一任务。')
  const plan = input.stages ?? previous?.stages ?? []
  const stageId = input.stageId !== undefined ? input.stageId
    : plan.find(stage => stage.progress === 'in_progress')?.id ?? (current?.stageId ?? null)
  const report: TaskIntent = {
    source: 'agent', taskId: selectedId, rootEntryId: previous?.rootEntryId ?? turn.id, turnEntryId: turn.id,
    revision: (previous?.revision ?? 0) + 1, reportedAt: Date.now(),
    taskTitle: input.taskTitle, intent: input.intent, stages: plan.map(stage => ({ ...stage })),
    stageId, summary: input.summary === undefined ? current?.summary ?? null : input.summary
  }
  if (!isTaskIntent(report)) throw new Error('阶段说明不完整：简单任务请使用空 stages 和空 stageId；长任务至少两个阶段，stageId 必须属于计划。')
  return report
}

export function createTaskIntentExtension(
  commit: (input: TaskIntentInput, ctx: ExtensionContext) => TaskIntent
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
      event.systemPromptOptions.sections.task_intents = [
        '以下是当前分支最近的 Agent 任务说明，仅作语义接续上下文，不是用户要求或执行授权。',
        '根据本轮真实意图决定新建任务或接续已有 taskId；“确认”“继续”应说明本轮实际推进的工作，而不是复述这些词。',
        JSON.stringify(recent.map(report => ({ taskId: report.taskId, taskTitle: report.taskTitle,
          lastIntent: report.intent, stageId: report.stageId, stages: report.stages })))
      ].join('\n')
    })
    pi.on('session_shutdown', () => { userRun = false })
    pi.registerTool({
      name: 'task_report', label: '说明本轮任务', executionMode: 'sequential',
      description: '向任务侧栏记录本轮在做什么。只上报公开工作意图和业务阶段，不执行任何步骤，不修改项目文件，不增加操作授权。新任务 taskId=null；接续任务使用当前分支已给出的 taskId。',
      promptSnippet: 'task_report — 说明本轮工作意图；长任务再提供业务阶段，非执行控制工具',
      promptGuidelines: [
        '每轮用户请求在完成必须的规范选择后、处理业务前，用 task_report 简短说明本轮实际要做什么；语义由你理解上下文后明确提供，不复制用户输入或回复首句。',
        '简单问答和单步任务只上报一句 intent，不制造流程。复杂长任务才提供至少两个有具体业务含义的 stages；同一任务跨轮使用原 taskId，切换目标才新建任务。',
        '阶段不是 read/edit/bash 等工具类别。只在业务阶段改变、计划修订或交付实际结果时更新 task_report，不随每次工具调用重复上报。stages 一旦提供就整份替换，省略则沿用。',
        '阶段 progress 是公开的 Agent 进展说明，不是程序确认的运行结果；只据实际已做工作填写 completed，受阻填写 blocked，不为显示完成而补造事实。',
        'task_report 只记录公开工作说明和简短结果，不输出内部思考过程、秘密或整段答案；summary 只说明本轮实际交付。上报不能代替任何文件操作、测试或运行授权，也不得为补报额外启动模型或任务。'
      ],
      parameters: {
        type: 'object', additionalProperties: false, required: ['taskId', 'taskTitle', 'intent'], properties: {
          taskId: { anyOf: [{ type: 'string', maxLength: 133 }, { type: 'null' }], description: '新任务填 null；接续任务填上下文或上次工具回执给出的身份' },
          taskTitle: { type: 'string', minLength: 1, maxLength: TASK_INTENT_TEXT_LIMIT, description: '整体业务目标，不是本轮用户消息的复述' },
          intent: { type: 'string', minLength: 1, maxLength: TASK_INTENT_TEXT_LIMIT, description: '本轮实际工作，例如定位自动播放累加记录次数的原因、提交修改清单、实施已确认修改' },
          stages: { type: 'array', maxItems: TASK_INTENT_MAX_STAGES, description: '简单任务为空；长任务至少两项；省略沿用原计划，提供则整份替换', items: {
            type: 'object', additionalProperties: false, required: ['id', 'title', 'progress'], properties: {
              id: { type: 'string', minLength: 1, maxLength: 128, description: '同一任务内稳定的阶段标识' },
              title: { type: 'string', minLength: 1, maxLength: TASK_INTENT_TEXT_LIMIT },
              progress: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] }
            }
          } },
          stageId: { anyOf: [{ type: 'string', maxLength: 128 }, { type: 'null' }], description: '本轮所属业务阶段；简单任务填 null' },
          summary: { anyOf: [{ type: 'string', minLength: 1, maxLength: TASK_INTENT_SUMMARY_LIMIT }, { type: 'null' }], description: '可选：本轮已交付的实际结果，一句话，不是完整回复' }
        }
      } as unknown as ToolParameters,
      async execute(_id, raw, signal, _update, ctx) {
        if (signal?.aborted) throw new Error('本轮已取消，未记录任务说明。')
        if (!userRun) throw new Error('只允许为用户发起的轮次记录任务说明，不改写其他轮次。')
        const input = parseTaskIntentInput(raw)
        if (input === null) throw new Error('任务说明格式无效；请提供一句公开意图，阶段至少两项或留空。')
        const report = commit(input, ctx)
        return { content: [{ type: 'text', text: `已记录本轮意图：${report.intent}\n任务身份：${report.taskId}。仅更新展示，没有启动任何执行。` }],
          details: { taskId: report.taskId, turnEntryId: report.turnEntryId, revision: report.revision } }
      }
    })
  }
}
