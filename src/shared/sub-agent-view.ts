/**
 * 子任务执行视图：委派工具在 `details.subAgents` 里交付的结构化快照，数组一项对应一个子任务。
 *
 * 这里是渲染端唯一可信的形状来源：主进程在投影时读一次、跨进程送达前再校验一次，
 * 因此字段必须自足、有界，并且只描述真实执行事件，不承载模型自述的进度。
 */

/** 子任务阶段：`cancelling` 表示已请求停止但子进程尚未收敛。 */
export type SubAgentPhase = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'aborted'

/** 任务模式；与委派工具的 `subagent_type` 一致，只保留当前可执行的四种。 */
export type SubAgentTaskType = 'query' | 'research' | 'review' | 'document'

/** 单条活动：一次真实工具调用，不包含模型的中间叙述。 */
export interface SubAgentActivity {
  readonly tool: string
  /** 目标（文件路径、检索式等）；无法确定时为 null，不猜测。 */
  readonly target: string | null
  readonly phase: 'running' | 'done' | 'error'
  readonly durationMs: number | null
}

/**
 * 对话时间线条目：子代理真实说过的话与真实发生过的工具调用，按发生顺序交错。
 * 判别联合而非可空字段：文本条目没有阶段与目标，工具条目没有叙述正文。
 * 只收录子代理自己的 assistant 文本，不收录工具输出正文与用户/系统消息。
 */
export type SubAgentTranscriptItem =
  | { readonly kind: 'assistant'; readonly text: string }
  | {
    readonly kind: 'tool'
    readonly tool: string
    readonly target: string | null
    readonly phase: SubAgentActivity['phase']
    readonly durationMs: number | null
  }

/** 用量口径：供应商未报告时各字段为 null，不以 0 表示确定没有消耗。 */
export interface SubAgentUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalTokens: number | null
}

/** 子任务快照；所有列表都有界，真实总数另记。 */
export interface SubAgentView {
  readonly taskId: string
  readonly taskType: SubAgentTaskType
  /** 交给子代理的目标摘要，用于在卡片上识别这是哪项工作。 */
  readonly objective: string
  readonly phase: SubAgentPhase
  readonly startedAt: number | null
  readonly endedAt: number | null
  /** 最近若干条活动，按发生顺序；超出上限的部分只体现为 `activityTotal`。 */
  readonly activities: readonly SubAgentActivity[]
  /** 真实活动总数；必须给出，缺失时视为载荷不合规。 */
  readonly activityTotal: number
  /**
   * 对话时间线：assistant 叙述与工具调用按发生顺序交错，供弹窗按对话阅读。
   * 历史记录早于本字段，缺失时归一为空数组而不是判为不合规——旧会话必须仍能展示。
   */
  readonly transcript: readonly SubAgentTranscriptItem[]
  /** 真实时间线条目总数；历史记录缺失时为 0。 */
  readonly transcriptTotal: number
  readonly usage: SubAgentUsage
  /** 结论摘要；失败时为 null，结论正文仍在工具结果文本里。 */
  readonly summary: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  /** 未解决事项；条数与单条长度都有界。 */
  readonly pending: readonly string[]
  /** 实际写入的文件路径（相对项目根，已去重）；只有文档任务会产生，只读任务为空。 */
  readonly writes: readonly string[]
}

/** 视图字段上限：与渲染端展示的容量一致，超出部分不进入契约。 */
export const SUB_AGENT_VIEW_LIMITS = {
  activity: 24,
  transcript: 20,
  transcriptText: 1600,
  objective: 400,
  summary: 800,
  pendingItems: 6,
  pendingItem: 240,
  errorMessage: 400,
  target: 240,
  tool: 48,
  taskId: 128,
  writes: 12,
  writePath: 240
} as const

const PHASES: readonly SubAgentPhase[] = ['queued', 'running', 'cancelling', 'succeeded', 'failed', 'aborted']
const TASK_TYPES: readonly SubAgentTaskType[] = ['query', 'research', 'review', 'document']
const ACTIVITY_PHASES: readonly SubAgentActivity['phase'][] = ['running', 'done', 'error']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有界短文本：空串按缺失处理，超限即判为不合规，不静默截断上游数据。 */
function isText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
}

function isNullableText(value: unknown, limit: number): value is string | null {
  return value === null || isText(value, limit)
}

/** 计数类字段：非负安全整数或 null。 */
function isCountOrNull(value: unknown): value is number | null {
  return value === null || isCount(value)
}

/** 必填计数：只接受非负安全整数。 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isTimestampOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0)
}

function parseActivity(value: unknown): SubAgentActivity | null {
  if (!isRecord(value)) return null
  const { tool, target, phase, durationMs } = value
  if (!isText(tool, SUB_AGENT_VIEW_LIMITS.tool)) return null
  if (!isNullableText(target, SUB_AGENT_VIEW_LIMITS.target)) return null
  if (typeof phase !== 'string' || !(ACTIVITY_PHASES as readonly string[]).includes(phase)) return null
  if (!isCountOrNull(durationMs)) return null
  return { tool, target, phase: phase as SubAgentActivity['phase'], durationMs }
}

/**
 * 对话条目校验：文本条目只要文本，工具条目只要工具名与目标；
 * 任一字段超限或形状不符即整条判为不合规，不做部分修补。
 */
function parseTranscriptItem(value: unknown): SubAgentTranscriptItem | null {
  if (!isRecord(value)) return null
  if (value.kind === 'assistant') {
    const { text } = value
    if (!isText(text, SUB_AGENT_VIEW_LIMITS.transcriptText)) return null
    return { kind: 'assistant', text }
  }
  if (value.kind === 'tool') {
    const { tool, target, phase, durationMs } = value
    if (!isText(tool, SUB_AGENT_VIEW_LIMITS.tool)) return null
    if (!isNullableText(target, SUB_AGENT_VIEW_LIMITS.target)) return null
    if (typeof phase !== 'string' || !(ACTIVITY_PHASES as readonly string[]).includes(phase)) return null
    if (!isCountOrNull(durationMs)) return null
    return { kind: 'tool', tool, target, phase: phase as SubAgentActivity['phase'], durationMs }
  }
  return null
}

/** 时间线缺失按空数组处理：旧快照没有该字段，不能因此丢掉整份执行记录。 */
function parseTranscript(value: unknown): SubAgentTranscriptItem[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > SUB_AGENT_VIEW_LIMITS.transcript) return null
  const parsed: SubAgentTranscriptItem[] = []
  for (const item of value) {
    const entry = parseTranscriptItem(item)
    if (entry === null) return null
    parsed.push(entry)
  }
  return parsed
}

function parseUsage(value: unknown): SubAgentUsage | null {
  if (!isRecord(value)) return null
  const { inputTokens, outputTokens, totalTokens } = value
  if (!isCountOrNull(inputTokens) || !isCountOrNull(outputTokens) || !isCountOrNull(totalTokens)) return null
  return { inputTokens, outputTokens, totalTokens }
}

/**
 * 校验并归一化子任务快照。
 * 形状不符、字段超限或枚举未知时返回 null，由界面降级为普通工具结果，不猜测缺失字段。
 */
export function parseSubAgentView(value: unknown): SubAgentView | null {
  if (!isRecord(value)) return null
  const { taskId, taskType, objective, phase, startedAt, endedAt, activities, activityTotal,
    transcript, transcriptTotal, usage, summary, errorCode, errorMessage, pending, writes } = value
  if (!isText(taskId, SUB_AGENT_VIEW_LIMITS.taskId)) return null
  if (typeof taskType !== 'string' || !(TASK_TYPES as readonly string[]).includes(taskType)) return null
  if (!isText(objective, SUB_AGENT_VIEW_LIMITS.objective)) return null
  if (typeof phase !== 'string' || !(PHASES as readonly string[]).includes(phase)) return null
  if (!isTimestampOrNull(startedAt) || !isTimestampOrNull(endedAt)) return null
  if (!Array.isArray(activities) || activities.length > SUB_AGENT_VIEW_LIMITS.activity) return null
  const parsedActivities: SubAgentActivity[] = []
  for (const item of activities) {
    const activity = parseActivity(item)
    if (activity === null) return null
    parsedActivities.push(activity)
  }
  if (!isCount(activityTotal)) return null
  const parsedTranscript = parseTranscript(transcript)
  if (parsedTranscript === null) return null
  // 总数缺失时按已保留条数兜底：旧快照没有该字段，界面不应显示成“另有 0 条未保留”。
  if (transcriptTotal !== undefined && !isCount(transcriptTotal)) return null
  const parsedUsage = parseUsage(usage)
  if (parsedUsage === null) return null
  if (!isNullableText(summary, SUB_AGENT_VIEW_LIMITS.summary)) return null
  if (!isNullableText(errorCode, 64)) return null
  if (!isNullableText(errorMessage, SUB_AGENT_VIEW_LIMITS.errorMessage)) return null
  if (!Array.isArray(pending) || pending.length > SUB_AGENT_VIEW_LIMITS.pendingItems) return null
  for (const item of pending) {
    if (!isText(item, SUB_AGENT_VIEW_LIMITS.pendingItem)) return null
  }
  // 写入列表只记录事实：条数与单条长度都有界，超限即判为不合规，不静默截断成半个路径。
  if (!Array.isArray(writes) || writes.length > SUB_AGENT_VIEW_LIMITS.writes) return null
  for (const item of writes) {
    if (!isText(item, SUB_AGENT_VIEW_LIMITS.writePath)) return null
  }
  return {
    taskId,
    taskType: taskType as SubAgentTaskType,
    objective,
    phase: phase as SubAgentPhase,
    startedAt,
    endedAt,
    activities: parsedActivities,
    activityTotal: activityTotal as number,
    transcript: parsedTranscript,
    transcriptTotal: typeof transcriptTotal === 'number' ? transcriptTotal : parsedTranscript.length,
    usage: parsedUsage,
    summary,
    errorCode,
    errorMessage,
    pending,
    writes
  }
}

/** 跨进程校验入口：只判断形状，不复制对象。 */
export function isSubAgentView(value: unknown): value is SubAgentView {
  return parseSubAgentView(value) !== null
}

/** 批次上限：只防止载荷无界，与扩展内部的并发上限无关。 */
export const SUB_AGENT_GROUP_LIMITS = { tasks: 6 } as const

/** 一次委派的批次快照：同一工具调用内的多个子任务各自独立收敛。 */
export interface SubAgentGroupView {
  readonly tasks: readonly SubAgentView[]
}

/**
 * 校验批次快照：每项都要是合规子任务，且 `taskId` 在批内唯一。
 * 任一项不合规就整批丢弃，避免界面把不完整的批次当成完整执行。
 */
export function parseSubAgentGroup(value: unknown): SubAgentGroupView | null {
  if (!isRecord(value)) return null
  const { tasks } = value
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > SUB_AGENT_GROUP_LIMITS.tasks) return null
  const parsed: SubAgentView[] = []
  const seen = new Set<string>()
  for (const item of tasks) {
    const view = parseSubAgentView(item)
    if (view === null || seen.has(view.taskId)) return null
    seen.add(view.taskId)
    parsed.push(view)
  }
  return { tasks: parsed }
}

/** 跨进程校验入口：批次形状判断。 */
export function isSubAgentGroup(value: unknown): value is SubAgentGroupView {
  return parseSubAgentGroup(value) !== null
}
