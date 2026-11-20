/**
 * 派活与停止：团长手里唯一能真正让别人干活的入口。
 *
 * 这里把「派活必填四项」做成拒绝而不是降级：条目不存在、没有验收项、依赖未完成、
 * 指派对象不在团队、同一条目已用尽打回机会，全部在起子进程之前否掉，并说明差什么。
 * 验收不设新工具——团长用 `team_board` 把条目置 done，未勾完验收项会被账本侧拒绝，
 * 因此「完成」永远由验收项与宿主记录共同决定，不由团长一句话决定。
 *
 * 成员一轮的终态由 `team-runner` 从执行快照收敛，这里只负责追加到根会话（自定义条目，
 * 不进团长上下文正文）并回报给团长；打回次数统计也读同一批记录，团长自述不参与计数。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionFactory, SessionEntry } from '@earendil-works/pi-coding-agent'
import { readAgentResourceBundle } from '../shared-process/agent-resources'
import { builtinExperts, loadExpertCatalog, skillDirectoryIds } from '../shared-process/expert-definitions'
import type { ExpertDefinition } from '../shared-process/expert-definitions'
import type { TeamDefinition } from '../shared-process/team-definitions'
import { resolveSessionCapabilityScope } from './expert-capability'
import { expertRoleSection } from './expert-role'
import { readTeamBoard } from './team-board'
import { startTeamMember } from './team-runner'
import type { TeamMemberHandle } from './team-runner'
import {
  MAX_TEAM_ITEM_REJECTIONS,
  TEAM_MEMBER_RUN_CUSTOM_TYPE,
  TEAM_MEMBER_RUN_STATUS_LABELS,
  latestTeamMemberRun,
  parseTeamMemberRun,
  teamMemberRunRejections
} from '../shared/team-run-api'
import type { TeamMemberRun } from '../shared/team-run-api'
import { teamMemberSessionId, teamSessionDirectory } from '../shared/team-session-path'
import type { TeamBoardItem } from '../shared/team-board-api'
import { TEAM_BOARD_TOOL_NAME } from '../shared/team-board-api'
import type { TeamBoardDetails } from '../shared/team-board-api'

export const TEAM_ASSIGN_TOOL_NAME = 'team_assign'
export const TEAM_STOP_TOOL_NAME = 'team_stop'
export const TEAM_DISPATCH_EXTENSION_NAME = 'team-dispatch'

type ToolParameters = Parameters<ExtensionAPI['registerTool']>[0]['parameters']

const ASSIGN_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['itemId', 'instruction'],
  properties: {
    itemId: { type: 'string', description: '账本条目 id；该条目必须已有验收项，且依赖全部完成。' },
    memberExpertId: { type: 'string', description: '改派时指定另一名成员；省略则用条目上的负责人。' },
    instruction: {
      type: 'string',
      description: '任务说明：目标、产出形式、验收项、边界（不许改动什么）。打回时写清上一轮缺什么。'
    }
  }
} as unknown as ToolParameters

const STOP_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['itemId'],
  properties: {
    itemId: { type: 'string', description: '要停止的账本条目 id；只终止这一条在途的成员轮。' }
  }
} as unknown as ToolParameters

export interface TeamDispatchOptions {
  readonly team: TeamDefinition
  readonly projectPath: string
  readonly entryPath: string
  readonly guardPath: string
  readonly resourcesDirectory: string
  readonly agentDir: string
  readonly sharedAgentDir: string
}

export interface TeamDispatch {
  readonly extension: ExtensionFactory
  /** 应用退出、根会话关闭或用户停止时调用：终止全部在途成员轮。 */
  stopAll(): void
}

/** 成员任务说明的固定头部：成员只看这一条，不注入账本全貌与其他成员的结论。 */
const TASK_HEADER = [
  '你是本团队的一名成员，只完成下面这一项任务，不要扩展范围，也不要处理其他条目。',
  '完成后在结论末尾用两行分别列出：实际写入的文件（相对项目根）与需要团长拍板的事；',
  '没有待决的事就写「待决：无」。需要拍板时逐行写「待决：…」，不要自行决定跨条目的取舍。'
].join('')

/** 成员专家定义：与主会话同一套清单与技能可见性口径，找不到即拒绝派活。 */
function loadMemberExpert(options: TeamDispatchOptions, memberExpertId: string): ExpertDefinition | null {
  const bundle = readAgentResourceBundle(options.resourcesDirectory)
  const catalog = loadExpertCatalog({
    builtin: builtinExperts(bundle),
    userDirectory: join(options.agentDir, 'experts'),
    availableSkillIds: [
      ...bundle.skills.filter(item => !item.subAgentOnly).map(item => item.id),
      ...skillDirectoryIds(join(options.sharedAgentDir, 'skills'))
    ],
    subAgentOnlySkillIds: bundle.skills.filter(item => item.subAgentOnly).map(item => item.id)
  })
  return catalog.experts.find(item => item.id === memberExpertId) ?? null
}

/** 依赖是否全部完成；返回还没完成的那些，回执里逐个点名。 */
function pendingDependencies(board: TeamBoardDetails, item: TeamBoardItem): string[] {
  return item.blockedBy.filter(id => {
    const dependency = board.items.find(candidate => candidate.id === id)
    return dependency === undefined || dependency.status !== 'done'
  })
}

/** 回执里的成员轮摘要：状态、结论、写入文件、待决项与用量，一段话说清。 */
function renderRun(run: TeamMemberRun): string {
  const lines = [
    `${run.itemId} 第 ${run.attempt} 轮：${TEAM_MEMBER_RUN_STATUS_LABELS[run.status]}`
      + (run.failure === null ? '' : `（${run.failure}）`),
    run.summary === null ? '成员没有给出结论。' : `结论：${run.summary}`,
    run.files.length === 0 ? '未写入任何文件。' : `写入文件：${run.files.join('、')}`,
    run.questions.length === 0 ? '没有待决项。' : `待决项：\n${run.questions.map(item => `- ${item}`).join('\n')}`,
    run.usage === null ? '' : `用量：输入 ${run.usage.inputTokens} / 输出 ${run.usage.outputTokens}`
  ]
  return lines.filter(line => line !== '').join('\n')
}

/** 成员技能规范的注入上限：规范只是方法约束，不能把成员上下文挤满。 */
const MAX_MEMBER_SKILL_PROMPT = 24_000
/** 单个 SKILL.md 的读取上限：与专家正文同级的边界，超限截断而不整份丢弃。 */
const SKILL_BODY_LIMIT_BYTES = 65_536

/** 按标识在三处技能目录里找正文：先产品随包，再产品 agent 目录，最后共享目录。 */
function readSkillBody(skillId: string, directories: readonly string[]): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skillId)) return null
  for (const directory of directories) {
    try {
      const body = readFileSync(join(directory, skillId, 'SKILL.md'), 'utf8')
      return body.length > SKILL_BODY_LIMIT_BYTES ? body.slice(0, SKILL_BODY_LIMIT_BYTES) : body
    } catch {
      // 不在这一层就继续找下一层；都没有时返回 null，由调用方跳过该技能。
    }
  }
  return null
}

/**
 * 把成员专家范围内的技能正文写成一份提示文件，交给 `--append-system-prompt` 读取。
 * 成员进程带 `--no-skills`，不写这份文件就没有任何技能规范可达，
 * 而正文又远超命令行长度上限，因此用成员会话目录下的文件承载：它随根会话目录一起清理。
 * 找不到正文、超出注入上限或写入失败都记进 `missing`，由派活回执告诉团长。
 */
function writeMemberSkillPrompt(options: TeamDispatchOptions, expert: ExpertDefinition, sessionDir: string): {
  path: string | null
  missing: string[]
} {
  if (expert.skillIds.length === 0) return { path: null, missing: [] }
  const directories = [
    join(options.resourcesDirectory, 'skills'),
    join(options.agentDir, 'skills'),
    join(options.sharedAgentDir, 'skills')
  ]
  const loaded: { readonly id: string; readonly body: string }[] = []
  const missing: string[] = []
  let size = 0
  for (const skillId of expert.skillIds) {
    const body = readSkillBody(skillId, directories)
    if (body === null) {
      missing.push(skillId)
      continue
    }
    if (size + body.length > MAX_MEMBER_SKILL_PROMPT) {
      missing.push(`${skillId}（超出注入上限）`)
      continue
    }
    loaded.push({ id: skillId, body })
    size += body.length
  }
  if (loaded.length === 0) return { path: null, missing }
  const file = join(sessionDir, `${expert.id}.skills.md`)
  try {
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(file, [
      '# 成员技能规范',
      '',
      '下面是本成员可用的技能规范，按任务需要引用；与专家角色冲突时以专家角色为准。',
      '',
      loaded.map(item => `## 技能：${item.id}\n\n${item.body}`).join('\n\n')
    ].join('\n'), 'utf8')
    return { path: file, missing }
  } catch {
    // 写入失败时这些规范同样不可达：整批记进未注入清单，不留“以为已注入”的空档。
    return { path: null, missing: [...missing, ...loaded.map(item => `${item.id}（规范文件写入失败）`)] }
  }
}

/** 派活与停止的装配入口；返回 `stopAll` 供中断收敛使用。 */
export function createTeamDispatch(options: TeamDispatchOptions): TeamDispatch {
  const inFlight = new Map<string, TeamMemberHandle>()
  /** 账本只从根会话分支读：工具上下文能拿到分支，构造期拿不到。 */
  const readBoard = (ctx: { sessionManager: { getBranch(): readonly SessionEntry[] } }): TeamBoardDetails | null =>
    readTeamBoard(ctx.sessionManager.getBranch())

  const extension: ExtensionFactory = pi => {
    pi.registerTool({
      name: TEAM_ASSIGN_TOOL_NAME,
      label: '派活',
      description: '把一条账本条目派给成员，等它跑完一轮并回报结果。'
        + '条目的验收项与依赖决定能不能派：没有验收项、依赖未完成、负责人不在团队、打回机会已用尽时直接拒绝。'
        + '同一成员再次派活复用它会话，因此它记得自己上一轮做的事。',
      promptSnippet: 'team_assign — 把账本条目派给成员并等一轮结果',
      promptGuidelines: [
        '派活前先确认条目有验收项、依赖已完成；缺验收项的条目先补齐再派。',
        '任务说明必须写清目标、产出形式、验收项与边界（不许改动什么），成员看不到账本全貌。',
        '一轮结束后看回执再决定：勾验收项并提交账本置 done、带原因再派一次（只有一次机会）、改派别人，或上报用户。',
        '同一条目不要并发派给两个人；需要并行就拆成两条有各自验收项的条目。'
      ],
      parameters: ASSIGN_PARAMETERS,
      execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
        const board = readBoard(ctx)
        if (board === null) {
          return { content: [{ type: 'text' as const, text: `还没有任务账本：先用 ${TEAM_BOARD_TOOL_NAME} 提交目标与条目，再派活。` }], details: undefined }
        }
        const input = params as { itemId?: unknown; memberExpertId?: unknown; instruction?: unknown }
        const itemId = typeof input.itemId === 'string' ? input.itemId : ''
        const item = board.items.find(candidate => candidate.id === itemId)
        if (item === undefined) {
          return { content: [{ type: 'text' as const, text: `账本里没有条目 ${itemId}。` }], details: undefined }
        }
        if (item.checks.length === 0) {
          return { content: [{ type: 'text' as const, text: `${itemId} 没有验收项：先在 ${TEAM_BOARD_TOOL_NAME} 里补上可判定的验收项，再派活。` }], details: undefined }
        }
        const missing = pendingDependencies(board, item)
        if (missing.length > 0) {
          return { content: [{ type: 'text' as const, text: `${itemId} 的依赖还没完成：${missing.join('、')}。` }], details: undefined }
        }
        const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : ''
        if (instruction === '') {
          return { content: [{ type: 'text' as const, text: '任务说明不能为空：写清目标、产出形式、验收项与边界。' }], details: undefined }
        }
        const memberExpertId = typeof input.memberExpertId === 'string' && input.memberExpertId !== ''
          ? input.memberExpertId
          : item.assignee
        if (memberExpertId === null || memberExpertId === '') {
          return { content: [{ type: 'text' as const, text: `${itemId} 还没有负责人：派活时指定成员，或先在账本里分配。` }], details: undefined }
        }
        if (!options.team.memberExpertIds.includes(memberExpertId)) {
          return { content: [{ type: 'text' as const, text: `${memberExpertId} 不在本团队成员名单里：可用成员 ${options.team.memberExpertIds.join('、')}。` }], details: undefined }
        }
        if (inFlight.has(itemId)) {
          return { content: [{ type: 'text' as const, text: `${itemId} 正在执行中：等它跑完，或先用 ${TEAM_STOP_TOOL_NAME} 停止。` }], details: undefined }
        }
        const runs = readMemberRuns(ctx)
        const rejections = teamMemberRunRejections(runs, itemId)
        // 打回机会只有一次：失败轮数超过上限后不再接受再派，不走团长自述。
        if (rejections > MAX_TEAM_ITEM_REJECTIONS) {
          return {
            content: [{
              type: 'text' as const,
              text: `${itemId} 已经用掉打回机会（${rejections} 次失败）：改派给其他成员，或把情况上报用户。`
            }],
            details: undefined
          }
        }
        const expert = loadMemberExpert(options, memberExpertId)
        if (expert === null) {
          return { content: [{ type: 'text' as const, text: `成员专家 ${memberExpertId} 定义不可用：换成员或先修好专家定义。` }], details: undefined }
        }
        const previous = latestTeamMemberRun(runs, itemId)
        const attempt = (previous?.attempt ?? 0) + 1
        // 会话 id 由根会话与成员确定性推出：同一个成员在同一个根会话里永远续用同一份上下文。
        const rootSessionId = ctx.sessionManager.getSessionId()
        const sessionId = teamMemberSessionId(rootSessionId, memberExpertId)
        const sessionDir = teamSessionDirectory(rootSessionId, options.agentDir)
        const skillPrompt = writeMemberSkillPrompt(options, expert, sessionDir)
        const scope = resolveSessionCapabilityScope({
          expert,
          resourcesDirectory: options.resourcesDirectory,
          agentDir: options.agentDir,
          sharedAgentDir: options.sharedAgentDir,
          availableMcpServers: []
        })
        onUpdate?.({ content: [{ type: 'text', text: `已派给 ${memberExpertId}，等待一轮结果…` }], details: {} })
        const handle = startTeamMember({
          entryPath: options.entryPath,
          guardPath: options.guardPath,
          cwd: options.projectPath,
          sessionDir,
          itemId,
          memberExpertId,
          attempt,
          sessionId,
          instruction: `${TASK_HEADER}\n\n## 本次任务\n${instruction}\n\n## 验收项（团长按这些验收）\n${
            item.checks.map(check => `- ${check.text}`).join('\n')}`,
          systemPrompt: expertRoleSection(expert, { writeScope: expert.writeScope }),
          skillPromptPath: skillPrompt.path,
          tools: scope.tools,
          writeScope: expert.writeScope
        })
        inFlight.set(itemId, handle)
        // 工具被中断（用户停止或会话关闭）时一起停掉成员，不留在后台空跑。
        const onAbort = (): void => handle.stop()
        signal?.addEventListener('abort', onAbort, { once: true })
        let run: TeamMemberRun
        try {
          run = await handle.done
        } finally {
          inFlight.delete(itemId)
          signal?.removeEventListener('abort', onAbort)
        }
        pi.appendEntry(TEAM_MEMBER_RUN_CUSTOM_TYPE, run)
        const next = run.status === 'completed'
          ? `验收通过就把 ${itemId} 置 done 并勾完验收项；不通过则在 note 写清缺什么后用 ${TEAM_ASSIGN_TOOL_NAME} 再派一次。`
          : `这一轮没有交付：${item.status === 'review' ? '可以带原因再派一次' : '打回机会可能已用尽，考虑改派或上报用户'}。`
        // 规范没送达是能力问题而不是任务问题：必须让团长看到，否则只会把结果差归因于成员水平。
        const skillNotice = skillPrompt.missing.length === 0
          ? ''
          : `本次未注入的技能规范：${skillPrompt.missing.join('、')}。`
        return {
          content: [{ type: 'text' as const, text: [renderRun(run), skillNotice, `下一步：${next}`]
            .filter(line => line !== '').join('\n\n') }],
          details: run
        }
      }
    })

    pi.registerTool({
      name: TEAM_STOP_TOOL_NAME,
      label: '停止成员轮',
      description: '终止某条账目当前在途的成员轮：先请求结束，超时强制结束。用户要求停下或改方向时使用。',
      promptSnippet: 'team_stop — 停止某条在途的成员轮',
      parameters: STOP_PARAMETERS,
      execute: async (_toolCallId, params) => {
        const itemId = (params as { itemId?: unknown }).itemId
        if (typeof itemId !== 'string' || itemId === '') {
          return { content: [{ type: 'text' as const, text: '需要条目 id。' }], details: undefined }
        }
        const handle = inFlight.get(itemId)
        if (handle === undefined) {
          return { content: [{ type: 'text' as const, text: `${itemId} 没有在途的成员轮。` }], details: undefined }
        }
        handle.stop()
        return { content: [{ type: 'text' as const, text: `已请求停止 ${itemId}：这一轮会按中断收敛，计入一次打回。` }], details: undefined }
      }
    })
  }

  return {
    extension,
    stopAll(): void {
      for (const handle of inFlight.values()) handle.stop()
      inFlight.clear()
    }
  }
}

/** 根会话分支里的成员轮记录；投影与派活共用同一份解析口径。 */
export function readMemberRuns(ctx: {
  sessionManager: { getBranch(): readonly SessionEntry[] }
}): TeamMemberRun[] {
  const runs: TeamMemberRun[] = []
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== TEAM_MEMBER_RUN_CUSTOM_TYPE) continue
    const run = parseTeamMemberRun(entry.data)
    if (run !== null) runs.push(run)
  }
  return runs
}
