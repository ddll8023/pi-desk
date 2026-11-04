/** 用户任务展示模型：以目标、进展、待处理与结果为主体，轮次和工具只供追溯，不从回复结束猜测任务完成。 */
import type { TaskFlow, TaskFlowPhase } from '../../../shared/task-flow'
import { isTaskFlowActive } from '../../../shared/task-flow'
import { isTaskArtifactPath } from '../../../shared/task-intent'
import type { TaskAttention, TaskArtifact, TaskIntent, TaskIntentStage } from '../../../shared/task-intent'
import { getToolOperation, toolLocalName } from '../../../shared/tool-operation'
import type { ChatMessageView, ChatToolBlock, ChatTurnView } from './chat-view'
import { displayToolPath, toolCallPreview, toolFilePath } from './tool-summary'

export type TaskViewTone = 'accent' | 'success' | 'danger' | 'warning' | 'muted'
export interface TaskViewStatus {
  readonly kind: 'running' | 'responded' | 'pending' | 'waiting' | 'delivered' | 'blocked' | 'cancelled' | 'failed' | 'interrupted' | 'unknown'
  readonly label: string
  readonly tone: TaskViewTone
}
export interface TaskTurnHistory {
  readonly available: boolean
  readonly loaded: boolean
  readonly loading: boolean
  readonly hasMore: boolean
  readonly error: string | null
}
export interface TaskActivityView {
  readonly id: string
  readonly title: string
  readonly subjects: readonly string[]
  readonly count: number
  readonly status: TaskViewStatus
}
export interface SessionTaskTurn {
  readonly id: string
  readonly messageId: string | null
  readonly historyId: string | null
  readonly time: string | null
  readonly title: string
  readonly request: string
  readonly responseText: string | null
  readonly report: TaskIntent | null
  readonly current: boolean
  readonly status: TaskViewStatus
  readonly action: string | null
  readonly summary: string | null
  readonly activities: readonly TaskActivityView[]
  readonly readFiles: readonly string[]
  readonly changedFiles: readonly string[]
  readonly plans: readonly TaskFlow[]
  readonly history: TaskTurnHistory
}
export interface TaskBusinessStage extends TaskIntentStage {
  readonly status: TaskViewStatus
  readonly current: boolean
  readonly turns: readonly SessionTaskTurn[]
}
export interface TaskArtifactView extends TaskArtifact {
  readonly kind: 'artifact' | 'change'
}
export interface TaskTrackNode {
  readonly id: string
  readonly kind: 'stage' | 'step' | 'progress' | 'delivery'
  readonly title: string
  readonly description: string | null
  readonly status: TaskViewStatus
  readonly current: boolean
  readonly entryId: string | null
  readonly turns: readonly SessionTaskTurn[]
  readonly artifacts: readonly TaskArtifactView[]
}
export interface SessionTaskGroup {
  readonly id: string
  readonly title: string
  readonly current: boolean
  readonly status: TaskViewStatus
  readonly intent: string
  readonly summary: string | null
  readonly attention: TaskAttention | null
  readonly artifacts: readonly TaskArtifactView[]
  readonly plans: readonly TaskFlow[]
  readonly latest: SessionTaskTurn | null
  readonly reported: boolean
  readonly nodes: readonly TaskTrackNode[]
  readonly stages: readonly TaskBusinessStage[]
  readonly turns: readonly SessionTaskTurn[]
  /** 未归入阶段的真实轮次仍保留，不能因计划修订而丢失。 */
  readonly unassigned: readonly SessionTaskTurn[]
}
export interface SessionTaskTrack {
  readonly tasks: readonly SessionTaskGroup[]
  readonly turns: readonly SessionTaskTurn[]
  readonly unreported: readonly SessionTaskTurn[]
  readonly unattachedPlans: readonly TaskFlow[]
}
interface TrackOptions {
  readonly live: boolean
  readonly streaming: boolean
  readonly compacting: boolean
  readonly projectRoot: string | null
  readonly history: ReadonlyMap<string, TaskTurnHistory>
}
interface ActivityGroup {
  readonly id: string
  readonly key: string
  readonly title: string
  readonly calls: ChatToolBlock[]
  readonly subjects: string[]
}
const NO_HISTORY: TaskTurnHistory = { available: false, loaded: true, loading: false, hasMore: false, error: null }
function excerpt(text: string, limit = 4000): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…（原文节选，完整内容见对话）` : text
}
/** 原文只用于详情，不将正文首句、图片占位或思考解释成任务意图。 */
function messageText(message: ChatMessageView): string {
  return message.blocks.flatMap(block => block.kind === 'text' && block.image === null && !block.notice
    ? [block.text] : []).join('\n').trim()
}
function toolCalls(turn: ChatTurnView): ChatToolBlock[] {
  const seen = new Set<string>()
  return turn.responses.flatMap(message => message.blocks.flatMap(block => {
    if (block.kind !== 'toolcall') return []
    const key = block.toolCallId ?? block.key
    if (seen.has(key)) return []
    seen.add(key)
    return [block]
  }))
}
function turnStatus(turn: ChatTurnView, calls: readonly ChatToolBlock[], current: boolean, options: TrackOptions): TaskViewStatus {
  const open = (turn.turn !== null && turn.turn.endedAt === null)
    || calls.some(call => call.execution?.phase === 'running')
    || turn.responses.some(message => message.generation?.phase === 'running')
  if (current && options.live && (open || options.streaming || options.compacting)) {
    return { kind: 'running', label: options.compacting ? '整理上下文' : '响应中', tone: 'accent' }
  }
  if (open) return { kind: 'unknown', label: '未确认结束', tone: 'warning' }
  const assistant = turn.responses.filter(message => message.role === 'assistant').at(-1)
  if (assistant?.stopReason === 'aborted') return { kind: 'interrupted', label: '已中断', tone: 'warning' }
  if (assistant?.failure) return { kind: 'failed', label: '响应异常', tone: 'danger' }
  if (assistant?.generation?.phase === 'interrupted') return { kind: 'interrupted', label: '已中断', tone: 'warning' }
  if (turn.turn?.endedAt != null || (assistant !== undefined && !assistant.blocks.some(block => block.kind === 'toolcall') && messageText(assistant) !== '')) {
    return { kind: 'responded', label: '本轮已结束', tone: 'muted' }
  }
  return { kind: 'pending', label: turn.responses.length === 0 ? '暂无回复记录' : '仅有过程记录', tone: 'muted' }
}
export function taskFlowStatus(phase: TaskFlowPhase, live: boolean, uncertain = false): TaskViewStatus {
  if (isTaskFlowActive(phase) && !live) return { kind: 'unknown', label: '未确认结束', tone: 'warning' }
  if (isTaskFlowActive(phase) && uncertain) return { kind: 'unknown', label: '状态待确认', tone: 'warning' }
  switch (phase) {
    case 'pending': return { kind: 'pending', label: '待执行', tone: 'muted' }
    case 'running': return { kind: 'running', label: '执行中', tone: 'accent' }
    case 'waiting': return { kind: 'waiting', label: '等你处理', tone: 'warning' }
    case 'stopping': return { kind: 'running', label: '停止中', tone: 'warning' }
    case 'completed': return { kind: 'responded', label: '执行结束', tone: 'success' }
    case 'failed': return { kind: 'failed', label: '执行失败', tone: 'danger' }
    case 'cancelled': return { kind: 'interrupted', label: '已取消', tone: 'muted' }
    case 'interrupted': return { kind: 'interrupted', label: '已中断', tone: 'warning' }
  }
}
/** 任务状态是显式业务说明，和一轮响应是否结束没有等价关系。 */
function taskStatus(report: TaskIntent | null, plans: readonly TaskFlow[], live: boolean): TaskViewStatus {
  const ordered = [...plans].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
  const latest = ordered.find(flow => isTaskFlowActive(flow.phase)) ?? ordered.find(flow => flow.phase === 'waiting')
    ?? ordered.find(flow => flow.phase === 'pending') ?? ordered[0]
  if (latest !== undefined && (report === null || latest.updatedAt >= report.reportedAt || latest.phase === 'waiting')) {
    if (latest.phase !== 'pending' && latest.phase !== 'completed') return taskFlowStatus(latest.phase, live)
    if (report === null) return taskFlowStatus(latest.phase, live)
  }
  switch (report?.status) {
    case 'planning': return { kind: 'running', label: '规划中', tone: 'accent' }
    case 'working': return { kind: 'running', label: '推进中', tone: 'accent' }
    case 'waiting': return { kind: 'waiting', label: '等你处理', tone: 'warning' }
    case 'delivered': return { kind: 'delivered', label: '已交付', tone: 'success' }
    case 'blocked': return { kind: 'blocked', label: '受阻', tone: 'warning' }
    case 'cancelled': return { kind: 'cancelled', label: '已停止', tone: 'muted' }
    default: return { kind: 'unknown', label: '进展未说明', tone: 'muted' }
  }
}
function taskAttention(report: TaskIntent | null, plans: readonly TaskFlow[]): TaskAttention | null {
  const waiting = [...plans].reverse().find(flow => flow.phase === 'waiting')?.steps.find(step => step.phase === 'waiting')
  if (waiting !== undefined) return report?.attention ?? { kind: 'information', message: waiting.waitingReason ?? '当前步骤等待补充说明后继续。' }
  return report?.attention ?? null
}
function taskArtifacts(report: TaskIntent | null, turns: readonly SessionTaskTurn[], plans: readonly TaskFlow[], root: string | null): TaskArtifactView[] {
  const result = new Map<string, TaskArtifactView>()
  for (const artifact of report?.artifacts ?? []) result.set(artifact.path, { ...artifact, kind: 'artifact' })
  const changed = [...turns.flatMap(turn => turn.changedFiles), ...plans.flatMap(flow => flow.steps.flatMap(step => step.changedFiles ?? []))]
  for (const raw of changed) {
    const normalized = raw.trim().replace(/\\/g, '/')
    const base = root?.replace(/\\/g, '/').replace(/\/+$/, '') ?? null
    let path = displayToolPath(normalized, base)
    // Windows 的同一工作区允许大小写不同的绝对路径；只裁剪已知根，不把盘外路径变成链接。
    if (base !== null && /^[A-Za-z]:\//.test(base) && normalized.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
      path = normalized.slice(base.length + 1)
    }
    path = path.replace(/^\.\/+/, '')
    if (!isTaskArtifactPath(path) || result.has(path)) continue
    result.set(path, { path, title: path.split('/').at(-1) ?? path, description: null, kind: 'change' })
  }
  return [...result.values()]
}
function stageStatus(stage: TaskIntentStage): TaskViewStatus {
  switch (stage.progress) {
    case 'pending': return { kind: 'pending', label: '待推进', tone: 'muted' }
    case 'in_progress': return { kind: 'running', label: '推进中', tone: 'accent' }
    case 'completed': return { kind: 'responded', label: '已完成', tone: 'muted' }
    case 'blocked': return { kind: 'blocked', label: '受阻', tone: 'warning' }
  }
}
function callSubject(call: ChatToolBlock, root: string | null): string | null {
  const tool = call.execution
  if (tool === null) return null
  const path = toolFilePath(tool.argsSummary)
  return path !== null ? displayToolPath(path, root)
    : tool.presentation?.request?.subject ?? toolCallPreview(call.toolName, tool.argsSummary, tool.argsText)
}
function activityStatus(calls: readonly ChatToolBlock[], live: boolean): TaskViewStatus {
  if (live && calls.some(call => call.execution?.phase === 'running')) return { kind: 'running', label: '进行中', tone: 'accent' }
  if (calls.some(call => call.execution?.phase === 'failed')) return { kind: 'failed', label: '操作失败', tone: 'danger' }
  if (calls.some(call => call.execution === null || call.execution.phase === 'running' || call.execution.phase === 'unknown')) {
    return { kind: 'unknown', label: '结果未确认', tone: 'warning' }
  }
  return { kind: 'responded', label: '已执行', tone: 'muted' }
}
function activitiesOf(calls: readonly ChatToolBlock[], root: string | null, live: boolean): TaskActivityView[] {
  const groups: ActivityGroup[] = []
  for (const call of calls) {
    const operation = getToolOperation(call.toolName)
    const local = toolLocalName(call.toolName)
    const internal = operation.kind === 'control' || operation.kind === 'memory-search' || local.startsWith('memory_') || local === 'task_report'
    if (internal && call.execution?.phase === 'succeeded') continue
    const key = operation.kind === 'edit' || operation.kind === 'write' ? 'modify'
      : operation.kind === 'tool' ? call.toolName : operation.kind
    const title = key === 'modify' ? '修改文件' : operation.kind === 'tool' ? call.toolName : operation.label
    let group = groups.at(-1)
    if (group === undefined || group.key !== key) {
      group = { id: call.toolCallId ?? call.key, key, title, calls: [], subjects: [] }
      groups.push(group)
    }
    group.calls.push(call)
    const subject = callSubject(call, root)
    if (subject !== null && subject !== '' && !group.subjects.includes(subject)) group.subjects.push(subject)
  }
  return groups.map(group => ({ id: group.id, title: group.title, subjects: group.subjects,
    count: group.calls.length, status: activityStatus(group.calls, live) }))
}
function filesOf(calls: readonly ChatToolBlock[], root: string | null): { readFiles: string[]; changedFiles: string[] } {
  const readFiles = new Set<string>()
  const changedFiles = new Set<string>()
  for (const call of calls) {
    const tool = call.execution
    if (tool?.phase !== 'succeeded') continue
    const path = toolFilePath(tool.argsSummary)
    if (path === null) continue
    const local = toolLocalName(call.toolName)
    if (local === 'read') readFiles.add(displayToolPath(path, root))
    else if (['edit', 'write', 'patch', 'apply_patch'].includes(local)) changedFiles.add(displayToolPath(path, root))
  }
  return { readFiles: [...readFiles], changedFiles: [...changedFiles] }
}

/** 对照 Lancer 的可读单轨道：只映射已有阶段、真实计划或已归属的公开进展，不从工具类别编造业务节点。 */
function buildTaskTrackNodes(task: SessionTaskGroup, live: boolean): TaskTrackNode[] {
  let nodes: TaskTrackNode[]
  if (task.stages.length > 0) {
    nodes = task.stages.map<TaskTrackNode>(stage => {
      const turn = stage.turns.at(-1) ?? null
      const description = turn?.summary ?? (stage.current ? turn?.title ?? null : null)
      return { id: `stage:${stage.id}`, kind: 'stage', title: stage.title,
        description: description === task.summary ? null : description,
        status: stage.status, current: stage.current, entryId: turn?.report?.turnEntryId ?? turn?.historyId ?? null,
        turns: stage.turns, artifacts: [] }
    })
  } else {
    const ordered = [...task.plans].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    const flow = ordered.find(plan => isTaskFlowActive(plan.phase)) ?? ordered.find(plan => plan.phase === 'waiting')
      ?? ordered.find(plan => plan.phase === 'pending') ?? ordered[0]
    if (flow !== undefined) {
      nodes = flow.steps.map<TaskTrackNode>(step => {
        const turns = task.turns.filter(turn => turn.report?.step?.stepId === step.id
          || turn.report?.turnEntryId === step.promptEntryId || turn.historyId === step.promptEntryId)
        const state = taskFlowStatus(step.phase, live)
        const status = step.phase === 'completed' ? { ...state, label: '已交付' }
          : step.phase === 'pending' && !['pending', 'running', 'stopping', 'waiting'].includes(flow.phase)
            ? { ...state, label: '未执行' } : state
        return { id: `step:${step.id}`, kind: 'step', title: step.title,
          description: step.phase === 'waiting' ? step.waitingReason ?? null : turns.at(-1)?.summary ?? null,
          status, current: ['running', 'stopping', 'waiting'].includes(step.phase),
          entryId: step.resultEntryId ?? step.promptEntryId, turns, artifacts: [] }
      })
    } else {
      nodes = task.turns.filter(turn => turn.report !== null).map<TaskTrackNode>(turn => ({
        id: `turn:${turn.report?.turnEntryId ?? turn.id}`, kind: 'progress', title: turn.title,
        description: turn.summary === task.summary ? null : turn.summary,
        status: turn.id === task.latest?.id ? taskStatus(turn.report, [], live)
          : { kind: 'responded', label: '已记录', tone: 'muted' },
        current: turn.id === task.latest?.id, entryId: turn.report?.turnEntryId ?? turn.historyId,
        turns: [turn], artifacts: []
      }))
    }
  }
  return nodes
}

export function buildSessionTaskTrack(turns: readonly ChatTurnView[], flows: readonly TaskFlow[], options: TrackOptions): SessionTaskTrack {
  const byEntry = new Map<string, ChatTurnView>()
  for (const turn of turns) {
    if (turn.user?.entryId) byEntry.set(turn.user.entryId, turn)
    for (const response of turn.responses) if (response.entryId !== null) byEntry.set(response.entryId, turn)
  }
  const owned = new Map<string, TaskFlow[]>()
  const unattachedPlans: TaskFlow[] = []
  for (const flow of flows) {
    let owner = flow.originEntryId === null ? undefined : byEntry.get(flow.originEntryId)
    for (const step of flow.steps) {
      owner ??= (step.promptEntryId === null ? undefined : byEntry.get(step.promptEntryId))
        ?? (step.resultEntryId === null ? undefined : byEntry.get(step.resultEntryId))
    }
    if (owner === undefined) unattachedPlans.push(flow)
    else owned.set(owner.key, [...(owned.get(owner.key) ?? []), flow])
  }
  const latest = turns.at(-1)?.key ?? null
  const items = turns.map<SessionTaskTurn>(turn => {
    const report = turn.user?.taskIntent ?? null
    const calls = toolCalls(turn)
    const current = turn.key === latest
    const status = turnStatus(turn, calls, current, options)
    const live = current && options.live && status.kind === 'running'
    const running = live ? calls.find(call => call.execution?.phase === 'running') : undefined
    const assistant = turn.responses.filter(message => message.role === 'assistant').at(-1)
    const response = assistant?.failure ?? (assistant === undefined ? '' : messageText(assistant))
    return {
      id: turn.key, messageId: turn.user?.id ?? null, historyId: turn.historyId, time: turn.user?.time ?? null,
      title: report?.intent ?? '未提供本轮工作说明', request: turn.user === null ? '' : messageText(turn.user),
      responseText: response === '' ? null : excerpt(response), report, current, status,
      action: running === undefined ? null : `${running.toolName}${callSubject(running, options.projectRoot) === null ? '' : ` · ${callSubject(running, options.projectRoot)}`}`,
      summary: report?.summary ?? null, activities: activitiesOf(calls, options.projectRoot, live),
      ...filesOf(calls, options.projectRoot), plans: owned.get(turn.key) ?? [], history: options.history.get(turn.key) ?? NO_HISTORY
    }
  })
  const grouped = new Map<string, { report: TaskIntent; turns: SessionTaskTurn[]; last: SessionTaskTurn; index: number }>()
  items.forEach((turn, index) => {
    if (turn.report === null) return
    const group = grouped.get(turn.report.taskId)
    if (group === undefined) grouped.set(turn.report.taskId, { report: turn.report, turns: [turn], last: turn, index })
    else {
      group.turns.push(turn)
      group.last = turn
      group.index = index
      if (turn.report.revision > group.report.revision) group.report = turn.report
    }
  })
  const associated = new Set<string>()
  const tasks = [...grouped.values()].sort((a, b) => a.index - b.index).map<SessionTaskGroup>(group => {
    const stageIds = new Set(group.report.stages.map(stage => stage.id))
    const plans = flows.filter(flow => flow.taskId === group.report.taskId
      || (flow.taskId == null && group.turns.some(turn => turn.plans.some(plan => plan.id === flow.id))))
    for (const plan of plans) associated.add(plan.id)
    return {
      id: group.report.taskId, title: group.report.taskTitle, current: group.turns.some(turn => turn.current),
      status: taskStatus(group.report, plans, options.live), intent: group.report.intent,
      summary: [...group.turns].reverse().find(turn => turn.summary !== null)?.summary ?? null,
      attention: taskAttention(group.report, plans), artifacts: taskArtifacts(group.report, group.turns, plans, options.projectRoot),
      plans, latest: group.last, reported: true, nodes: [], turns: group.turns,
      stages: group.report.stages.map(stage => ({ ...stage, status: stageStatus(stage),
        current: group.report.stageId === stage.id && (stage.progress === 'in_progress' || stage.progress === 'blocked'),
        turns: group.turns.filter(turn => turn.report?.stageId === stage.id) })),
      unassigned: group.turns.filter(turn => turn.report?.stageId == null || !stageIds.has(turn.report.stageId))
    }
  })
  // 计划和未上报的对话仍可回看，但不伪造业务目标或阶段。
  for (const flow of flows.filter(candidate => !associated.has(candidate.id))) {
    const related = items.filter(turn => turn.plans.some(plan => plan.id === flow.id))
    const last = related.at(-1) ?? null
    tasks.push({ id: `plan:${flow.id}`, title: flow.title, current: last?.current ?? false,
      status: taskStatus(null, [flow], options.live), intent: flow.steps.find(step => step.phase === 'running' || step.phase === 'waiting')?.title ?? '已登记的工作计划',
      summary: null, attention: taskAttention(null, [flow]), artifacts: taskArtifacts(null, related, [flow], options.projectRoot),
      plans: [flow], latest: last, reported: false, nodes: [], stages: [], turns: related, unassigned: related })
  }
  const unreported = items.filter(turn => turn.report === null && turn.plans.length === 0)
  // 待归属活动不是任务，不能抢走已知目标，也不能在归属明确前产生轨道节点。
  return { tasks: tasks.map(task => ({ ...task, nodes: buildTaskTrackNodes(task, options.live) })),
    turns: items, unreported, unattachedPlans }
}
