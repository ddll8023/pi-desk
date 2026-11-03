/** 任务侧栏展示模型：意图与业务阶段仅取宿主语义上报，运行状态取事实投影，正文、工具与文件只供下钻。 */
import type { TaskFlow, TaskFlowPhase } from '../../../shared/task-flow'
import { isTaskFlowActive } from '../../../shared/task-flow'
import type { TaskIntent, TaskIntentStage } from '../../../shared/task-intent'
import { getToolOperation, toolLocalName } from '../../../shared/tool-operation'
import type { ChatMessageView, ChatToolBlock, ChatTurnView } from './chat-view'
import { displayToolPath, toolCallPreview, toolFilePath } from './tool-summary'

export type TaskViewTone = 'accent' | 'success' | 'danger' | 'warning' | 'muted'
export interface TaskViewStatus {
  readonly kind: 'running' | 'responded' | 'pending' | 'failed' | 'interrupted' | 'unknown'
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
export interface SessionTaskGroup {
  readonly id: string
  readonly title: string
  readonly current: boolean
  readonly status: TaskViewStatus
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
    case 'stopping': return { kind: 'running', label: '停止中', tone: 'warning' }
    case 'completed': return { kind: 'responded', label: '执行结束', tone: 'success' }
    case 'failed': return { kind: 'failed', label: '执行失败', tone: 'danger' }
    case 'cancelled': return { kind: 'interrupted', label: '已取消', tone: 'muted' }
    case 'interrupted': return { kind: 'interrupted', label: '已中断', tone: 'warning' }
  }
}
function stageStatus(stage: TaskIntentStage): TaskViewStatus {
  switch (stage.progress) {
    case 'pending': return { kind: 'pending', label: '待推进', tone: 'muted' }
    case 'in_progress': return { kind: 'running', label: '推进中', tone: 'accent' }
    case 'completed': return { kind: 'responded', label: '已完成', tone: 'muted' }
    case 'blocked': return { kind: 'unknown', label: '受阻', tone: 'warning' }
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
  const tasks = [...grouped.values()].sort((a, b) => a.index - b.index).map<SessionTaskGroup>(group => {
    const last = group.last
    const stageIds = new Set(group.report.stages.map(stage => stage.id))
    return {
      id: group.report.taskId, title: group.report.taskTitle, current: group.turns.some(turn => turn.current), status: last.status,
      turns: group.turns,
      stages: group.report.stages.map(stage => ({ ...stage, status: stageStatus(stage),
        current: group.turns.some(turn => turn.current && turn.report?.stageId === stage.id),
        turns: group.turns.filter(turn => turn.report?.stageId === stage.id) })),
      unassigned: group.turns.filter(turn => turn.report?.stageId == null || !stageIds.has(turn.report.stageId))
    }
  })
  return { tasks, turns: items, unreported: items.filter(turn => turn.report === null), unattachedPlans }
}
