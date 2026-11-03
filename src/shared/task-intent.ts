/** Agent 公开工作说明的有界契约：任务身份与轮次归属由宿主确认，阶段进展是 Agent 上报，不替代运行状态或执行授权。 */
export const TASK_INTENT_ENTRY_TYPE = 'pi-desk.task-intent.v1'
export const TASK_INTENT_MAX_STAGES = 12
export const TASK_INTENT_TEXT_LIMIT = 200
export const TASK_INTENT_SUMMARY_LIMIT = 400
export type TaskStageProgress = 'pending' | 'in_progress' | 'completed' | 'blocked'
export interface TaskIntentStage {
  readonly id: string
  readonly title: string
  readonly progress: TaskStageProgress
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
}
export interface TaskIntentInput {
  readonly taskId: string | null
  readonly taskTitle: string
  readonly intent: string
  /** 省略沿用同一任务的计划；空数组明确表示简单任务。 */
  readonly stages: readonly TaskIntentStage[] | undefined
  readonly stageId: string | null | undefined
  readonly summary: string | null | undefined
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
function taskId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('task_') && isTaskIntentEntryId(value.slice(5))
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
  if (!record(value) || !keys(value, ['taskId', 'taskTitle', 'intent', 'stages', 'stageId', 'summary'])
    || (value.taskId !== null && !taskId(value.taskId)) || !text(value.taskTitle) || !text(value.intent)
    || (value.stages !== undefined && !stages(value.stages))
    || (value.stageId !== undefined && value.stageId !== null && !isTaskIntentEntryId(value.stageId))
    || (value.summary !== undefined && value.summary !== null && !text(value.summary, TASK_INTENT_SUMMARY_LIMIT))) return null
  return { taskId: value.taskId, taskTitle: value.taskTitle.trim(), intent: value.intent.trim(),
    stages: value.stages?.map(stage => ({ ...stage, title: stage.title.trim() })),
    stageId: value.stageId, summary: typeof value.summary === 'string' ? value.summary.trim() : value.summary }
}
export function isTaskIntent(value: unknown): value is TaskIntent {
  if (!record(value) || !keys(value, ['source', 'taskId', 'rootEntryId', 'turnEntryId', 'revision', 'reportedAt',
    'taskTitle', 'intent', 'stageId', 'stages', 'summary'])) return false
  return value.source === 'agent' && isTaskIntentEntryId(value.rootEntryId) && isTaskIntentEntryId(value.turnEntryId)
    && value.taskId === `task_${value.rootEntryId}`
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision > 0
    && typeof value.reportedAt === 'number' && Number.isSafeInteger(value.reportedAt) && value.reportedAt >= 0
    && text(value.taskTitle) && text(value.intent) && stages(value.stages)
    && (value.stageId === null || (isTaskIntentEntryId(value.stageId) && value.stages.some(stage => stage.id === value.stageId)))
    && (value.summary === null || text(value.summary, TASK_INTENT_SUMMARY_LIMIT))
}
/** 同一轮次的历史详情不得把较新的语义上报覆盖成旧副本。 */
export function newerTaskIntent(left: TaskIntent | undefined, right: TaskIntent | undefined): TaskIntent | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  if (left.turnEntryId !== right.turnEntryId || left.taskId !== right.taskId) return left
  return left.revision >= right.revision ? left : right
}
