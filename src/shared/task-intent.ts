/** 用户任务的公开语义契约：目标、进展、待处理事项与产物随分支保存，不替代运行事实或操作授权。 */
export const TASK_INTENT_ENTRY_TYPE = 'pi-desk.task-intent.v1'
export const TASK_INTENT_MAX_STAGES = 12
export const TASK_INTENT_TEXT_LIMIT = 200
export const TASK_INTENT_SUMMARY_LIMIT = 400
export const TASK_INTENT_MAX_ARTIFACTS = 16
export type TaskStageProgress = 'pending' | 'in_progress' | 'completed' | 'blocked'
export type TaskLifecycle = 'planning' | 'working' | 'waiting' | 'delivered' | 'blocked' | 'cancelled'
export interface TaskIntentStage {
  readonly id: string
  readonly title: string
  readonly progress: TaskStageProgress
}
export interface TaskAttention {
  readonly kind: 'decision' | 'permission' | 'information'
  readonly message: string
}
export interface TaskArtifact {
  /** 只允许所属工作区内的相对路径，不能借产物入口打开任意系统文件。 */
  readonly path: string
  readonly title: string
  readonly description: string | null
}
export interface TaskStepReport {
  /** 执行身份由宿主附加，模型只声明当前步骤的业务结果。 */
  readonly flowId: string
  readonly stepId: string
  readonly outcome: 'completed' | 'waiting'
}
export interface TaskIntent {
  readonly source: 'agent'
  readonly taskId: string
  readonly rootEntryId: string
  readonly turnEntryId: string
  readonly revision: number
  readonly reportedAt: number
  readonly taskTitle: string
  readonly intent: string
  readonly stageId: string | null
  readonly stages: readonly TaskIntentStage[]
  readonly summary: string | null
  /** 旧记录缺失时保持未说明，不能从回复结束猜测业务任务完成。 */
  readonly status?: TaskLifecycle
  readonly attention?: TaskAttention | null
  readonly artifacts?: readonly TaskArtifact[]
  readonly step?: TaskStepReport
}
export interface TaskIntentInput {
  readonly taskId: string | null
  readonly taskTitle: string
  readonly intent: string
  readonly stages: readonly TaskIntentStage[] | undefined
  readonly stageId: string | null | undefined
  readonly summary: string | null | undefined
  readonly status: TaskLifecycle | undefined
  readonly attention: TaskAttention | null | undefined
  readonly artifacts: readonly TaskArtifact[] | undefined
  readonly stepOutcome: TaskStepReport['outcome'] | undefined
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}
export function isTaskIntentEntryId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
}
function text(value: unknown, limit = TASK_INTENT_TEXT_LIMIT): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= limit && !/[\u0000-\u001f]/u.test(value)
}
export function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('task_') && isTaskIntentEntryId(value.slice(5))
}
export function isTaskLifecycle(value: unknown): value is TaskLifecycle {
  return typeof value === 'string' && ['planning', 'working', 'waiting', 'delivered', 'blocked', 'cancelled'].includes(value)
}
export function isTaskArtifactPath(value: unknown): value is string {
  return text(value, 512) && !/^[\\/]|[:\\]/u.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
function attention(value: unknown): value is TaskAttention {
  return record(value) && keys(value, ['kind', 'message'])
    && typeof value.kind === 'string' && ['decision', 'permission', 'information'].includes(value.kind)
    && text(value.message, TASK_INTENT_SUMMARY_LIMIT)
}
function artifacts(value: unknown): value is readonly TaskArtifact[] {
  return Array.isArray(value) && value.length <= TASK_INTENT_MAX_ARTIFACTS
    && new Set(value.map(item => record(item) ? item.path : null)).size === value.length
    && value.every(item => record(item) && keys(item, ['path', 'title', 'description'])
      && isTaskArtifactPath(item.path) && text(item.title)
      && (item.description === null || text(item.description, TASK_INTENT_SUMMARY_LIMIT)))
}
function stages(value: unknown): value is readonly TaskIntentStage[] {
  if (!Array.isArray(value) || value.length > TASK_INTENT_MAX_STAGES || value.length === 1) return false
  const seen = new Set<string>()
  let active = 0
  for (const stage of value) {
    if (!record(stage) || !keys(stage, ['id', 'title', 'progress']) || !isTaskIntentEntryId(stage.id)
      || !text(stage.title) || typeof stage.progress !== 'string'
      || !['pending', 'in_progress', 'completed', 'blocked'].includes(stage.progress)
      || seen.has(stage.id)) return false
    seen.add(stage.id)
    if (stage.progress === 'in_progress') active++
  }
  return active <= 1
}
export function parseTaskIntentInput(value: unknown): TaskIntentInput | null {
  if (!record(value) || !keys(value, ['taskId', 'taskTitle', 'intent', 'stages', 'stageId', 'summary',
    'status', 'attention', 'artifacts', 'stepOutcome'])
    || (value.taskId !== null && !isTaskId(value.taskId)) || !text(value.taskTitle) || !text(value.intent)
    || (value.stages !== undefined && !stages(value.stages))
    || (value.stageId !== undefined && value.stageId !== null && !isTaskIntentEntryId(value.stageId))
    || (value.summary !== undefined && value.summary !== null && !text(value.summary, TASK_INTENT_SUMMARY_LIMIT))
    || (value.status !== undefined && !isTaskLifecycle(value.status))
    || (value.attention !== undefined && value.attention !== null && !attention(value.attention))
    || (value.artifacts !== undefined && !artifacts(value.artifacts))
    || (value.stepOutcome !== undefined && value.stepOutcome !== 'completed' && value.stepOutcome !== 'waiting')) return null
  return { taskId: value.taskId, taskTitle: value.taskTitle.trim(), intent: value.intent.trim(),
    stages: value.stages?.map(stage => ({ ...stage, title: stage.title.trim() })),
    stageId: value.stageId, summary: typeof value.summary === 'string' ? value.summary.trim() : value.summary,
    status: value.status, attention: value.attention, artifacts: value.artifacts, stepOutcome: value.stepOutcome }
}
export function isTaskIntent(value: unknown): value is TaskIntent {
  if (!record(value) || !keys(value, ['source', 'taskId', 'rootEntryId', 'turnEntryId', 'revision', 'reportedAt',
    'taskTitle', 'intent', 'stageId', 'stages', 'summary', 'status', 'attention', 'artifacts', 'step'])) return false
  return value.source === 'agent' && isTaskIntentEntryId(value.rootEntryId) && isTaskIntentEntryId(value.turnEntryId)
    && value.taskId === `task_${value.rootEntryId}`
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision > 0
    && typeof value.reportedAt === 'number' && Number.isSafeInteger(value.reportedAt) && value.reportedAt >= 0
    && text(value.taskTitle) && text(value.intent) && stages(value.stages)
    && (value.stageId === null || (isTaskIntentEntryId(value.stageId) && value.stages.some(stage => stage.id === value.stageId)))
    && (value.summary === null || text(value.summary, TASK_INTENT_SUMMARY_LIMIT))
    && (value.status === undefined || isTaskLifecycle(value.status))
    && (value.attention === undefined || value.attention === null || attention(value.attention))
    && (value.artifacts === undefined || artifacts(value.artifacts))
    && (value.step === undefined || (record(value.step) && keys(value.step, ['flowId', 'stepId', 'outcome'])
      && isTaskIntentEntryId(value.step.flowId) && isTaskIntentEntryId(value.step.stepId)
      && (value.step.outcome === 'completed' || value.step.outcome === 'waiting')))
    && (value.attention == null || value.status === 'waiting' || value.status === 'blocked')
}
/** 同一轮次的历史详情不得把较新的语义上报覆盖成旧副本。 */
export function newerTaskIntent(left: TaskIntent | undefined, right: TaskIntent | undefined): TaskIntent | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  if (left.turnEntryId !== right.turnEntryId || left.taskId !== right.taskId) return left
  return left.revision >= right.revision ? left : right
}
