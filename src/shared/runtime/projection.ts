/** 会话投影契约：消息、工具、历史、活动与用量投影的展示结构、上限与校验；投影批次与历史分页也在这里。 */

import type { RuntimeError } from './status'
import type { GenuiPayload } from '../genui-api'


/**
 * 当前上下文占用；`tokens`/`percent` 在压缩后到下一次响应前为 null，
 * `contextWindow` 在模型目录未提供时也为 null，都按未知展示，不伪装成 0。
 */
export interface ContextUsage {
  readonly tokens: number | null
  readonly contextWindow: number | null
  readonly percent: number | null
}

/**
 * `get_session_stats` 的用量投影：累计数值缺失按 0，未知的上下文占用保持 null。
 * 主进程尚未读到统计时为 null，与“读到全零”区分。
 */
export interface SessionUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cost: number
  readonly context: ContextUsage | null
}

/**
 * 输出速率（tokens/秒）：上一轮模型调用的平均值，按模型上报的输出 token 与生成时长计算。
 */
export interface OutputRate {
  readonly average: number | null
}

/** 投影只重建页面要展示的内容块；诊断不进入内容块投影，用户消息图片以附件描述块表达，工具结果以独立工具条目表达。 */
export type ProjectionBlockKind = 'text' | 'thinking' | 'toolcall'

/**
 * 块的 `text` 是当前完整内容；`truncated` 表示已按展示上限截断。
 * 收缩时工具调用块的参数文本会被清空，这类块的 `truncated` 同样为 true、`text` 为空串。
 */
export interface ProjectionBlock {
  readonly contentIndex: number
  readonly kind: ProjectionBlockKind
  readonly text: string
  readonly truncated: boolean
  readonly toolCallId: string | null
  readonly toolName: string | null
  /**
   * 图片内容块的附件描述：`dataUrl` 是 base64 本体转成的 data URL（仅限用户消息），
   * `bytes` 是估算字节数；非图片块为 null。图片本体不进入文本投影。
   */
  readonly image: { readonly dataUrl: string; readonly mimeType: string; readonly bytes: number } | null
  /**
   * 该块文本由投影自己生成（当前只有超出展示上限的附件说明），不是用户或模型的正文。
   * 界面仍展示这段说明，但复制、摘要与修改预填不把它当用户输入。
   */
  readonly notice: boolean
}

/** 工具执行的终态；`unknown` 表示代际收敛时仍未收到结束事件，不冒充成功。 */
export type ToolExecutionPhase = 'running' | 'succeeded' | 'failed' | 'unknown'

/** 工具输出的来源：`partial` 只是最近一次报告，`result` 才是结束事件的权威结果。 */
export type ToolExecutionTextKind = 'none' | 'partial' | 'result'

/** 非文本内容块的描述；只带类型与估算大小，不携带图片数据等载荷。 */
export interface ToolNonTextPart {
  readonly type: string
  readonly mimeType: string | null
  /** 估算的字节数；无法估算时为 null，界面不猜造大小。 */
  readonly bytes: number | null
}

/**
 * 工具参数的单个值摘要：源码、长文本与嵌套结构都只给规模，不携带原文。
 * `inline` 可直接显示；`text` 是长文本，只给行数与字节数；`items` 是数组项数；
 * `object` 是嵌套对象的字段数。
 */
export type ToolArgValue =
  | { readonly kind: 'inline'; readonly text: string }
  | { readonly kind: 'text'; readonly lines: number; readonly bytes: number }
  | { readonly kind: 'items'; readonly count: number }
  | { readonly kind: 'object'; readonly fields: number }

/** 参数摘要的一个键值对；值摘要由投影层按完整参数对象算出，不受参数文本截断影响。 */
export interface ToolArgSummaryEntry {
  readonly key: string
  readonly value: ToolArgValue
}

/** Diff 单行语义：`fold` 为 Pi 折叠省略行的占位，无内容文本。 */
export type ToolDiffLineKind = 'add' | 'remove' | 'context' | 'fold'

/** Diff 展示行；行号由主进程从 Pi 的 diff 行解析，`args` 推断来源无行号。 */
export interface ToolDiffLine {
  readonly kind: ToolDiffLineKind
  /** 变更前行号；来源没有该信息时为 null。 */
  readonly oldLine: number | null
  /** 变更后行号；来源没有该信息时为 null。 */
  readonly newLine: number | null
  readonly text: string
}

/**
 * Edit / Write 变更的展示数据；只来自 Pi 已有的信息，Desktop 不读文件、不自行计算基线。
 * `result` 为 Pi 结束结果 `details.diff` 的逐行解析（Pi 执行时刻基于真实文件内容算出，
 * 天然覆盖重复修改与并发变更）；`args` 为 edit 参数 `edits[]` 的降级推断（无实际文件行号，
 * 界面必须标注推断性质）。形状不符或非文件变更工具时为 null，不伪造 Diff。
 */
export interface ToolDiff {
  readonly source: 'result' | 'args'
  readonly lines: readonly ToolDiffLine[]
  /** 超出展示上限后停止收行；不伪装成完整 Diff。 */
  readonly truncated: boolean
}

/**
 * 工具执行条目按 `toolCallId` 与消息块解耦：参数与输出各有独立上限，
 * 工具结果的非文本内容只保留描述、不进入消息块投影。
 *
 * `startedAt`、`endedAt` 是 Desktop 收到开始与结束事件的时刻（纪元毫秒），不是 Pi 字段：
 * Pi 的工具事件没有时间字段，因此它只用于界面展示耗时，不代表工具的真实执行时间。
 * 未确认结束的条目与恢复会话补种的历史条目缺少开始或结束时刻，界面不显示耗时。
 */
export interface ToolExecution {
  readonly toolCallId: string
  readonly toolName: string
  readonly phase: ToolExecutionPhase
  readonly startedAt: number | null
  readonly endedAt: number | null
  readonly argsText: string | null
  readonly argsTruncated: boolean
  /** 参数摘要；无法解析时 null，界面回退到 `argsText` 原文。 */
  readonly argsSummary: readonly ToolArgSummaryEntry[] | null
  /** 结果里 Pi 保存完整输出的文件路径；没有保存或形状不符时为 null。 */
  readonly outputPath: string | null
  readonly text: string
  readonly textKind: ToolExecutionTextKind
  readonly textTruncated: boolean
  /** 结束结果中的非文本内容块总数；与 `nonTextParts` 的条数可能不同。 */
  readonly nonTextBlocks: number
  /** 非文本内容块描述，条数有上限；界面按描述标示类型与大小。 */
  readonly nonTextParts: readonly ToolNonTextPart[]
  /** 文件变更展示数据；null 表示无可信来源，不伪造 Diff。 */
  readonly diff: ToolDiff | null
  /**
   * 生成式 UI 载荷；null 表示该工具没有交付界面，或载荷未通过校验。
   * 载荷已由主进程按 `parseGenuiPayload` 校验并归一，渲染端可直接使用。
   */
  readonly ui: GenuiPayload | null
  /** 完整当前分支中该界面的最高版本，避免回读旧页时误启用旧界面。 */
  readonly latestRevision?: number
}

/** AI 消息生成计时：时刻来自 Desktop 接收事件，不代表模型服务端耗时，也不包含后续工具执行。 */
export interface MessageGeneration {
  readonly phase: 'running' | 'completed' | 'interrupted'
  readonly startedAt: number
  /** 正常结束或异常收敛时固定结束时刻；仅运行中的消息为 null。 */
  readonly endedAt: number | null
}

/**
 * 本轮响应计时：挂在触发本轮的用户消息上，从提交（用户消息的 `timestamp`）算到 Agent 收敛，
 * 因此包含工具执行与等待，是整轮口径而不是单条消息的生成时间。时刻同样来自 Desktop 侧事件，
 * 不代表模型服务端耗时；仅在本地实时轮次上有值，恢复的历史轮次为 null，不推算。
 */
export interface TurnTiming {
  readonly startedAt: number
  /** 本轮收敛时固定；仍在响应中的轮次为 null。 */
  readonly endedAt: number | null
}

/**
 * 一次上下文压缩的记录；摘要由 Pi 生成，`tokensBefore`/`tokensAfter` 缺失时保持 null。
 * `reason` 为 null 表示记录来自恢复会话时的历史压缩条目（条目本身不带触发原因）。
 * `aborted` 为 true 表示压缩被取消（含用户中止），此时 `summary` 为空、`errorMessage` 为 null。
 */
export interface ProjectionCompaction {
  readonly reason: 'manual' | 'threshold' | 'overflow' | null
  readonly summary: string
  readonly tokensBefore: number | null
  readonly tokensAfter: number | null
  readonly aborted: boolean
  readonly errorMessage: string | null
}

/**
 * 单次模型调用的用量；Pi 的 `turn` 就是围绕一条 assistant 消息，因此它等价于单轮用量。
 * 字段缺失、形状不符或全零（失败调用）时整条按未知处理，不用 0 冒充。
 */
export interface MessageUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** `id` 由 Desktop 生成，不冒充 Pi 消息字段。 */
export interface ProjectionMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'compaction'
  readonly blocks: readonly ProjectionBlock[]
  readonly timestamp: number | null
  /** 用户消息、历史消息与缺少开始事件的 AI 消息为 null，不推算缺失耗时。 */
  readonly generation: MessageGeneration | null
  /** 本次模型调用的用量；仅 AI 消息可能非 null，缺失时保持 null，不推算。 */
  readonly usage: MessageUsage | null
  /** 本轮响应计时；只挂在用户消息上，历史轮次与 AI 消息为 null。 */
  readonly turn: TurnTiming | null
  readonly stopReason: string | null
  readonly errorMessage: string | null
  /** 压缩记录；仅 `role === 'compaction'` 时非 null，此时 `blocks` 为空。 */
  readonly compaction: ProjectionCompaction | null
  /** 官方来源条目；临时流式消息在落盘前为空。 */
  readonly entryId?: string | null
  /** 展示窗口中的摘要或截断内容可以按此标记回读，不代表原始记录已丢失。 */
  readonly recoverable?: boolean
  /** 前置轮也有稳定身份；不依赖某次分页恰好保留的最后一条回答。 */
  readonly turnEntryId?: string
}

/**
 * `append` 携带追加后的块总长度；渲染端长度不符时必须换取快照，不能猜测补齐。
 * `block` 是权威块内容，`message` 是新消息或整条替换，`tool` 是按 `toolCallId` 整条替换的工具条目。
 */
export type ProjectionUpdate =
  | {
    readonly kind: 'append'
    readonly messageId: string
    readonly contentIndex: number
    readonly text: string
    readonly length: number
  }
  | { readonly kind: 'block'; readonly messageId: string; readonly block: ProjectionBlock }
  | { readonly kind: 'message'; readonly message: ProjectionMessage }
  | { readonly kind: 'tool'; readonly tool: ToolExecution }
  | { readonly kind: 'activity'; readonly activity: SessionActivity }

/** 重新订阅或失去同步时的唯一基准；没有活动 Runtime 时消息与工具列表为空。 */
export interface ProjectionSnapshot {
  /** 来源运行实例；宿主协议载荷不带该字段，桥接层为页面补充，跨进程校验按可缺失处理。 */
  readonly runId?: number | null
  readonly runtimeId: number | null
  readonly seq: number
  readonly messages: readonly ProjectionMessage[]
  readonly tools: readonly ToolExecution[]
  /** 投影是否收缩过：块被截断、过程细节被丢弃、AI 消息被丢弃或工具条目被截断时为 true。 */
  readonly truncated: boolean
  /** 被丢弃的 AI 侧消息条数；用户消息永不丢弃，因此不计入。 */
  readonly droppedMessages: number
  readonly droppedTools: number
  readonly activity?: SessionActivity
  readonly history?: { readonly before: string | null; readonly revision: number }
}

/** `resyncRequired` 表示增量已作废，渲染端应换取快照而不是继续应用本批更新。 */
export interface ProjectionBatch {
  /** 来源运行实例；宿主协议载荷不带该字段，桥接层为页面补充，渲染端据此丢弃非前台批次。 */
  readonly runId?: number | null
  readonly runtimeId: number
  readonly seq: number
  readonly updates: readonly ProjectionUpdate[]
  readonly resyncRequired: boolean
}

export type ProjectionResult =
  | { readonly ok: true; readonly data: ProjectionSnapshot }
  | { readonly ok: false; readonly error: RuntimeError }

/** 轻量会话活动契约；共享层不依赖宿主、SDK或渲染实现。 */
export type SkillActivitySource = 'command' | 'file' | 'host'
export interface SessionFileActivity {
  readonly key: string
  readonly label: string
  readonly reads: number
  readonly writes: number
}

export interface SessionSkillActivity {
  readonly name: string
  readonly source: SkillActivitySource
  readonly location: string | null
  readonly count: number
}

export interface SessionMcpActivity {
  readonly server: string
  readonly tools: readonly { readonly name: string; readonly count: number }[]
  readonly count: number
}

export interface SessionPluginActivity {
  readonly toolName: string
  readonly count: number
}

/**
 * 一份生成式界面的交付事实：只记身份与版本，不带节点树与标题以外的内容。
 * `versions` 是该界面在分支上出现过的次数（含修改），与 `ui_inspect` 的列表口径一致。
 */
export interface SessionGenuiActivity {
  readonly documentId: string
  readonly title: string
  readonly revision: number
  readonly versions: number
}

export interface SessionActivity {
  readonly files: readonly SessionFileActivity[]
  readonly skills: readonly SessionSkillActivity[]
  readonly mcp: readonly SessionMcpActivity[]
  readonly plugins: readonly SessionPluginActivity[]
  readonly genui: readonly SessionGenuiActivity[]
  readonly fileCount: number
  readonly skillCount: number
  readonly mcpCount: number
  readonly pluginCount: number
  readonly genuiCount: number
  readonly empty: boolean
  /** SDK嵌套记录曾省略调用或参数，恢复时无法凭空补全。 */
  readonly incomplete?: boolean
}

/** 分段读取始终指向当前分支中的一个原始内容块。 */
export interface HistoryChunk {
  readonly entryId: string
  readonly contentIndex: number
  readonly field: 'text' | 'thinking' | 'arguments' | 'output' | 'summary'
  readonly offset: number
  /** 工具续段必须写回原卡片，不另外生成原文区域。 */
  readonly toolCallId?: string
  /** 已载入的该文本块末尾在工具聚合输出中的位置。 */
  readonly targetOffset?: number
}

export type HistoryQuery =
  | { readonly kind: 'page'; readonly before: string | null }
  | { readonly kind: 'turn'; readonly turnId: string; readonly after: string | null }
  | ({ readonly kind: 'text' } & HistoryChunk)
export interface RuntimeHistoryRequest {
  readonly revision: number
  readonly runId: number
  readonly runtimeId: number
  readonly sessionId: string
  readonly query: HistoryQuery
}

export interface HistoryPage {
  readonly kind: 'page' | 'turn'
  readonly messages: readonly ProjectionMessage[]
  readonly tools: readonly ToolExecution[]
  readonly chunks: readonly HistoryChunk[]
  readonly before: string | null
  readonly next: string | null
  readonly turnId: string | null
}

export type HistoryData = HistoryPage | {
  readonly kind: 'text'
  readonly chunk: HistoryChunk
  readonly text: string
  readonly next: number | null
}

/** Pi 上报的 Extension 运行时错误（handler 抛错、命令抛错、技能展开失败）；不含堆栈。 */
export interface ExtensionErrorEntry {
  readonly path: string | null
  readonly event: string | null
  readonly error: string
}
