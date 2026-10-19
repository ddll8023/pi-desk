/** 只定义 Runtime 状态、Prompt 提交、对话回退、中止、可用模型读取与当前会话模型切换、手动上下文压缩、Pi 资源与资源预读、诊断读取、MCP 状态、MCP 配置列举、MCP 服务器探测与 MCP 登录/退出/重连命令、当前分支历史分页与原文回读、累计活动、消息/工具投影（含生成计时与压缩记录）IPC 的固定通道、事件名、结果类型与跨进程响应校验。 */
import type { DesktopErrorCode } from './desktop-api'
import { isGenuiPayload } from './genui-api'
import type { GenuiPayload } from './genui-api'

export const RUNTIME_STATUS_CHANNEL = 'desktop:runtime-status'
export const RUNTIME_PROMPT_CHANNEL = 'desktop:runtime-prompt'
/** 仅回退对话；目标由主进程核对，页面不能指定任意会话文件或 Pi 条目。 */
export const RUNTIME_REWIND_CHANNEL = 'desktop:runtime-rewind'
export const RUNTIME_ABORT_CHANNEL = 'desktop:runtime-abort'
export const RUNTIME_PROJECTION_CHANNEL = 'desktop:runtime-projection'
/** 历史读取只针对已绑定会话的当前分支，不接受文件路径。 */
export const RUNTIME_HISTORY_CHANNEL = 'desktop:runtime-history'
export const RUNTIME_PROJECTION_ACK_CHANNEL = 'desktop:runtime-projection-ack'
export const RUNTIME_CAPABILITIES_CHANNEL = 'desktop:runtime-capabilities'
export const RUNTIME_SET_MODEL_CHANNEL = 'desktop:runtime-set-model'
/** 手动压缩当前会话上下文；说明文本可选，压缩过程与结果由投影事件表达。 */
export const RUNTIME_COMPACT_CHANNEL = 'desktop:runtime-compact'
/** 只读：读取当前代际已加载的 Pi 资源清单（扩展命令、提示词与技能）。 */
export const RUNTIME_RESOURCES_CHANNEL = 'desktop:runtime-resources'
/**
 * 只读：Runtime 未启动时用一次性 Pi 进程预读资源、可用模型与默认模型。
 * 结果用于输入框补全、设置页与启动前模型选择；
 * Runtime 就绪后一律以运行中的清单为权威，两份数据不合并。
 * 带 `force` 的请求绕过主进程的进程内缓存，用于手动刷新或认证更新后重读。
 */
export const RUNTIME_RESOURCE_PREVIEW_CHANNEL = 'desktop:runtime-resource-preview'
/** 只读：读取当前代际的启动诊断尾部与 Extension 运行时错误。 */
export const RUNTIME_DIAGNOSTICS_CHANNEL = 'desktop:runtime-diagnostics'
/** 固定请求 `/mcp` 状态；不接受页面传入命令文本。 */
export const RUNTIME_MCP_STATUS_CHANNEL = 'desktop:runtime-mcp-status'
/** MCP 服务器 OAuth 登录、退出与重连；只接受受校验的服务器名，命令文本由主进程拼出。 */
export const RUNTIME_MCP_COMMAND_CHANNEL = 'desktop:runtime-mcp-command'
/**
 * 只读：用官方 CLI 的 `pi mcp list --json` 探测每个 MCP 服务器的连接状态、工具与错误。
 * 它与运行中的 Runtime 是两套独立连接（stdio 服务器会被再启动一次），因此只在用户显式请求时执行。
 */
export const RUNTIME_MCP_INSPECT_CHANNEL = 'desktop:runtime-mcp-inspect'
/** 零参数：中止一次进行中的 MCP 探测；没有进行中的探测时不做任何事。 */
export const RUNTIME_MCP_INSPECT_ABORT_CHANNEL = 'desktop:runtime-mcp-inspect-abort'
/**
 * 只读：列举 Pi 的 mcp.json 里配置的服务器（全局与项目两处），不连接服务器、不写配置文件。
 * `pi mcp list` 没有「只列举不连接」的模式，因此列表来源是配置文件本身，连接状态仍由探测补充。
 */
export const RUNTIME_MCP_CONFIG_CHANNEL = 'desktop:runtime-mcp-config'
/** 主进程到渲染进程的单向状态通知，payload 是 RuntimeStatus。 */
export const RUNTIME_STATUS_EVENT = 'desktop:runtime-status-changed'
/** 主进程到渲染进程的单向投影批次通知，payload 是 ProjectionBatch。 */
export const RUNTIME_PROJECTION_EVENT = 'desktop:runtime-projection-changed'

/**
 * 页面动作的二维目标：`runId` 定位运行实例，`runtimeId` 固定发起时所见绑定代际。
 * 主进程按注册表复核两者，不符时按未就绪拒绝，不向旧目标转发动作。
 */
export interface RuntimeTarget {
  readonly runId: number
  readonly runtimeId: number | null
}

/** 二维目标只放行安全整数；`runtimeId` 为 null 表示该运行实例尚未绑定会话。 */
export function isRuntimeTarget(value: unknown): value is RuntimeTarget {
  if (!isRecord(value)) return false
  const generationOk = value.runtimeId === null
    || (typeof value.runtimeId === 'number' && Number.isSafeInteger(value.runtimeId) && value.runtimeId > 0)
  return typeof value.runId === 'number'
    && Number.isSafeInteger(value.runId)
    && value.runId > 0
    && generationOk
    && Object.keys(value).every(key => key === 'runId' || key === 'runtimeId')
}

/** 模型的复合身份；只保存供应商和模型 ID，不携带凭据或任意启动参数。 */
export interface ModelIdentity {
  readonly provider: string
  readonly modelId: string
}

/** 与模型切换入口保持相同长度边界，拒绝多余字段。 */
export function isModelIdentity(value: unknown): value is ModelIdentity {
  if (!isRecord(value)) return false
  return typeof value.provider === 'string'
    && value.provider.trim() !== ''
    && value.provider.length <= 256
    && typeof value.modelId === 'string'
    && value.modelId.trim() !== ''
    && value.modelId.length <= 1024
    && Object.keys(value).every(key => key === 'provider' || key === 'modelId')
}

/** 模型切换只针对发起时所见运行实例与绑定代际，不接受任意 RPC 或全局持久化参数。 */
export interface RuntimeSetModelRequest {
  readonly runId: number
  readonly runtimeId: number
  readonly provider: string
  readonly modelId: string
}

/**
 * `idle` 且 `runtimeId` 非空表示上一次 Runtime 已正常关闭；
 * `runtimeId` 仍为 null 表示从未启动。`failed` 表示异常退出或启动失败。
 */
export type RuntimeState = 'idle' | 'starting' | 'ready' | 'stopping' | 'failed'

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

/** 只投影页面需要的会话信息，不搬运 Pi 的完整状态或消息。 */
export interface RuntimeInfo {
  /** 当前模型的 provider 与 id；图片附件能力按模型目录精确匹配。 */
  readonly modelProvider: string | null
  readonly modelId: string | null
  readonly sessionId: string | null
  readonly messageCount: number
  readonly isStreaming: boolean
  /** 压缩或分支摘要正在进行；界面据此把运行中提示写成压缩文案。 */
  readonly isCompacting: boolean
  /** 会话累计用量与上下文占用；统计未取到或形状不符时为 null。 */
  readonly usage: SessionUsage | null
  /** 输出速率；未结算到有效值时为 null。 */
  readonly rate: OutputRate
}

export interface RuntimeStatus {
  readonly state: RuntimeState
  /** 来源运行实例；没有前台运行实例时为 null。 */
  readonly runId: number | null
  readonly runtimeId: number | null
  /**
   * 当前绑定或最近绑定的会话身份；未绑定时为 null。
   * 宿主已回收（空闲释放）时它是页面唯一的恢复目标：`state` 为 `idle` 但会话身份仍在，
   * 页面按「上次 Runtime 已关闭」展示并保留历史，下一次发送先恢复该会话。
   */
  readonly sessionId: string | null
  readonly info: RuntimeInfo | null
  /**
   * 前台宿主实际加载的 SDK 版本；宿主尚未启动或还没就绪时为 null。
   * 口径与版本检查快照里的版本不同：这里是「正在跑的那个」，快照里的版本是「下次启动会加载的」。
   */
  readonly sdkVersion: string | null
  readonly lastError: string | null
}

export type RuntimeErrorCode =
  | DesktopErrorCode
  | 'INVALID_PROJECT_PATH'
  | 'RUNTIME_NOT_READY'
  | 'RUNTIME_SPAWN_FAILED'
  | 'RUNTIME_EXITED'
  | 'RUNTIME_TIMEOUT'
  | 'RUNTIME_PROTOCOL_ERROR'
  /** Pi 以 `success: false` 拒绝了受支持的运行命令；消息带 Pi 的原因文本。 */
  | 'RUNTIME_COMMAND_REJECTED'
  /** 项目存在受保护资源且尚无信任决定；先完成信任决定再重试。 */
  | 'TRUST_REQUIRED'

export interface RuntimeError {
  readonly code: RuntimeErrorCode
  readonly message: string
}

export type RuntimeResult =
  | { readonly ok: true; readonly data: RuntimeStatus }
  | { readonly ok: false; readonly error: RuntimeError }

/** 消息 ID 仅在 Runtime 投影内有效；运行实例与会话身份防止确认弹窗的旧目标作用于新会话。 */
export interface RuntimeRewindRequest {
  readonly runId: number
  readonly runtimeId: number
  readonly sessionId: string
  readonly messageId: string
}

/** text 是 Pi 返回的完整原文；渲染端当前不消费该字段，回退与重新发送均使用页面编辑框内的文本。 */
export type RuntimeRewindResult =
  | { readonly ok: true; readonly data: { readonly status: RuntimeStatus; readonly cancelled: boolean; readonly text: string | null } }
  | { readonly ok: false; readonly error: RuntimeError; readonly blocked?: boolean }

/**
 * 手动压缩请求：目标身份之外只带可选的摘要说明（聚焦要保留的内容）。
 * 压缩过程与结果不在这里返回，而是由投影中的压缩记录表达。
 */
export interface RuntimeCompactRequest {
  readonly runId: number
  readonly runtimeId: number
  readonly sessionId: string
  readonly instructions: string | null
}

/** `handled` 表示被扩展或输入处理器消费，不表示本次一定启动了 Agent run。 */
export type PromptDisposition = 'started' | 'queued' | 'handled'

/**
 * 随 Prompt 提交的图片附件：`data` 是 base64 编码的图片本体。
 * MIME 白名单、大小与条数上限由主进程校验；页面传入的其他字段一律丢弃。
 */
export interface PromptImageInput {
  readonly name: string
  readonly mimeType: string
  readonly data: string
}

/**
 * 单条 Prompt 的图片条数上限；主进程校验与渲染端还原历史附件共用同一份，避免两处上限漂移。
 */
export const PROMPT_IMAGE_MAX_COUNT = 4

/** 单张图片 base64 编码后的字符数上限；主进程校验与渲染端还原历史附件共用同一份。 */
export const PROMPT_IMAGE_MAX_CHARS = 4_194_304

/** prompt 结果只表达请求被接受、排队或被处理，不等待 Agent 执行结束。 */
export type PromptResult =
  | { readonly ok: true; readonly data: { readonly disposition: PromptDisposition } }
  | { readonly ok: false; readonly error: RuntimeError }

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
export type RuntimeHistoryResult =
  | { readonly ok: true; readonly data: HistoryData }
  | { readonly ok: false; readonly error: RuntimeError }

/** 可用模型的精简投影；仅保留模型选择与展示、Provider 状态与图片输入判断所需字段。 */
export interface ModelSummary {
  readonly provider: string
  readonly id: string
  /** 模型显示名；目录未提供时为 null。 */
  readonly name: string | null
  /** 上下文窗口大小（token）；目录未提供或形状不符时为 null。 */
  readonly contextWindow: number | null
  /** 是否支持图片输入；未知时为 null。 */
  readonly imageInput: boolean | null
}

/** 当前 Runtime 代际的可用模型；模型列表失败与空列表保持区分。 */
export interface AgentCapabilities {
  readonly runtimeId: number
  readonly models: readonly ModelSummary[]
  readonly modelsError: string | null
}

export type CapabilitiesResult =
  | { readonly ok: true; readonly data: AgentCapabilities }
  | { readonly ok: false; readonly error: RuntimeError }

/**
 * Pi 侧资源的来源分类；三类分别对应当前会话已注册的扩展命令、提示词模板与技能。
 * 其他来源（内置 TUI 命令等）不进入页面。
 */
export type PiResourceKind = 'skill' | 'prompt' | 'extension'

/**
 * 一条已加载的 Pi 资源条目，只来自当前会话已加载的扩展、提示词与技能投影。
 * `path` 是资源在磁盘上的绝对路径，`scope` 是 `user`/`project`/`temporary`，
 * `origin` 是 `top-level`/`package`，`baseDir` 只在包资源上有值；字段缺失一律为 null，不猜造。
 */
export interface PiResourceEntry {
  readonly kind: PiResourceKind
  readonly name: string
  readonly description: string | null
  readonly path: string | null
  readonly scope: string | null
  readonly origin: string | null
  readonly baseDir: string | null
}

/**
 * 当前代际已加载的 Pi 资源清单。清单只有一个来源，因此只有一个失败区：
 * `error` 非空时 `entries` 为空且不代表“没有资源”。
 */
export interface PiResources {
  readonly runtimeId: number
  readonly entries: readonly PiResourceEntry[]
  /** 超出条目上限被省略；不伪装成完整清单。 */
  readonly truncated: boolean
  readonly error: string | null
}

/** Pi 上报的 Extension 运行时错误（handler 抛错、命令抛错、技能展开失败）；不含堆栈。 */
export interface ExtensionErrorEntry {
  readonly path: string | null
  readonly event: string | null
  readonly error: string
}

/**
 * 当前 Runtime 代际的启动诊断与 Extension 运行时错误。
 * `stderrLines` 是宿主内 SDK 会话的创建期诊断文本（settings 与资源加载告警，按行有界），
 * 按不可信纯文本展示；宿主进程自身的输出不进入本通道。
 */
export interface RuntimeDiagnostics {
  readonly runtimeId: number | null
  readonly stderrLines: readonly string[]
  readonly extensionErrors: readonly ExtensionErrorEntry[]
}

/**
 * `/mcp` 在非 TUI 模式下的状态读取结果：命令被 Pi 处理（`handled`），
 * 状态文本经 Extension UI 的 notify 捕获得到；`messages` 为空表示 Pi 没有输出文本。
 */
export interface McpStatus {
  readonly disposition: PromptDisposition
  readonly messages: readonly string[]
}

/** MCP 服务器的受支持动作；enable/disable/exposure 需要改配置，不在此范围。 */
export type McpCommandAction = 'login' | 'logout' | 'reconnect'

/**
 * MCP 登录/退出请求的结果。登录需要用户在浏览器里完成授权，期间浏览器地址、进度与
 * redirect URL 输入都经既有 Extension UI 通道展示；这里只回传命令被处理时的捕获文本。
 */
export type McpCommandResult =
  | { readonly ok: true; readonly data: McpStatus }
  | { readonly ok: false; readonly error: RuntimeError }

export type ResourcesResult =
  | { readonly ok: true; readonly data: PiResources }
  | { readonly ok: false; readonly error: RuntimeError }

/**
 * Runtime 未启动时的资源预读结果。`projectPath` 是主进程实际探测的项目，页面据此丢弃已切换项目的结果；
 * 未选项目时为 null，表示按全局范围只预读了模型与默认身份（此时 `entries` 恒为空）。
 * 资源、模型与默认身份分别来自 `get_commands`、`get_available_models` 和 `get_state`。
 * 预读不加载 Extension、不连接 MCP，不保证与运行中的 Runtime 完全一致；各项错误独立展示。
 */
export interface PiResourcePreview {
  readonly projectPath: string | null
  readonly entries: readonly PiResourceEntry[]
  /** 资源读取错误；非空时 entries 为空，但不影响其他预读结果。 */
  readonly entriesError: string | null
  readonly models: readonly ModelSummary[]
  /** 模型目录读取错误；非空时 models 为空，与目录确实为空保持区分。 */
  readonly modelsError: string | null
  /** Pi 的默认模型身份；没有选中模型时也可能为 null，读取错误单独表达。 */
  readonly defaultModel: ModelIdentity | null
  readonly defaultModelError: string | null
}

export type ResourcePreviewResult =
  | { readonly ok: true; readonly data: PiResourcePreview }
  | { readonly ok: false; readonly error: RuntimeError }

/** 共享预读请求：`force` 为真时绕过进程内缓存，用于手动刷新或认证更新后重新探测。 */
export interface ResourcePreviewRequest {
  readonly force: boolean
}

export type RuntimeDiagnosticsResult =
  | { readonly ok: true; readonly data: RuntimeDiagnostics }
  | { readonly ok: false; readonly error: RuntimeError }

export type McpStatusResult =
  | { readonly ok: true; readonly data: McpStatus }
  | { readonly ok: false; readonly error: RuntimeError }

/**
 * `pi mcp list --json` 报告的一个 MCP 服务器。
 *
 * `scope`、`exposure`、`state` 按纯文本透传：官方可能新增取值，页面只对已知取值给中文标签，
 * 未知取值原样展示，不猜测含义。`override` 是项目级条目覆盖同名用户级条目时的来源路径。
 */
export interface McpServerReport {
  readonly name: string
  readonly scope: string
  /** 定义该服务器的配置文件路径。 */
  readonly source: string
  /** 项目级覆盖的来源路径；无覆盖为 null。 */
  readonly override: string | null
  readonly enabled: boolean
  readonly exposure: string
  /** 启动命令或 URL，由官方 CLI 汇总给出。 */
  readonly transport: string
  readonly state: string
  readonly tools: readonly string[]
  /** 与服务器默认 exposure 不同的逐工具 exposure；无差异为 null。 */
  readonly toolExposure: Readonly<Record<string, string>> | null
  /** 该服务器是否提供资源；官方 CLI 只报告有无，不报告资源与模板数量。 */
  readonly hasResources: boolean
  /** 非 connected 状态下官方给出的错误文本；无错误为 null。 */
  readonly error: string | null
}

/**
 * 一次 MCP 服务器探测结果。探测是只读的：官方 CLI 只连接并读取状态，不写任何配置文件。
 * `configErrors` 是被官方跳过条目的原因文本，`note` 是项目未信任等原因的部分忽略说明。
 * `inspectedAt` 是 Desktop 结束本次探测的时刻（纪元毫秒），不是 Pi 字段：Pi 不报告时间，
 * 界面只用于说明「这些状态是什么时候测的」。
 */
export interface McpInspection {
  readonly servers: readonly McpServerReport[]
  readonly configErrors: readonly string[]
  readonly note: string | null
  readonly inspectedAt: number
}

export type McpInspectionResult =
  | { readonly ok: true; readonly data: McpInspection }
  | { readonly ok: false; readonly error: RuntimeError }

/**
 * Pi 的 mcp.json 里配置的一条 MCP 服务器，只来自配置文件的浅层读取。
 * `enabled` 缺省视为启用；`transport` 是配置文本的摘要（不解析 `${VAR}`、不推断 exposure 默认值）；
 * `scope` 为 `global`（`<agent-dir>/mcp.json`）或 `project`（`<项目>/.pi/mcp.json`）。
 */
export interface McpConfigServer {
  readonly name: string
  readonly scope: string
  /** 定义该服务器的配置文件路径。 */
  readonly source: string
  readonly enabled: boolean
  /** 启动摘要：stdio 的 command 与 args，或 HTTP 的 url；两者都没有时为 null。 */
  readonly transport: string | null
  /** 项目级条目覆盖同名全局条目时的项目文件路径；无覆盖为 null。 */
  readonly override: string | null
}

/**
 * 两处 mcp.json 的列举结果。`errors` 是被跳过的文件或条目的原因文本；
 * `projectConfigTrusted` 表示项目级配置在当前信任决定下是否会被 Pi 读取（未信任时不生效）。
 */
export interface McpConfigListing {
  readonly servers: readonly McpConfigServer[]
  readonly errors: readonly string[]
  readonly globalConfigPath: string
  readonly projectConfigPath: string | null
  readonly projectConfigTrusted: boolean
}

export type McpConfigResult =
  | { readonly ok: true; readonly data: McpConfigListing }
  | { readonly ok: false; readonly error: RuntimeError }

/** 中止探测的结果；`aborted` 为 false 表示当时没有进行中的探测。 */
export type McpInspectAbortResult =
  | { readonly ok: true; readonly data: { readonly aborted: boolean } }
  | { readonly ok: false; readonly error: RuntimeError }

export interface RuntimeApi {
  readonly getRuntimeStatus: () => Promise<RuntimeResult>
  /** 提交 Prompt 到目标运行实例的当前绑定；成功只表达接受、排队或已处理。 */
  readonly sendPrompt: (target: RuntimeTarget, message: string, images?: readonly PromptImageInput[]) => Promise<PromptResult>
  /** 请求中止目标运行实例的当前操作；成功只表示 Pi 已确认取消，运行状态仍以事件流为准。 */
  readonly abortRuntime: (target: RuntimeTarget) => Promise<RuntimeResult>
  /** 回退到指定用户消息之前：Pi 的 fork 会新建会话并保留来源文件；不撤销项目文件改动。 */
  readonly rewindRuntime: (request: RuntimeRewindRequest) => Promise<RuntimeRewindResult>
  /** 读取目标运行实例当前绑定的投影快照；未绑定时返回空基准。 */
  readonly getRuntimeProjection: (target: RuntimeTarget) => Promise<ProjectionResult>
  readonly readRuntimeHistory: (request: RuntimeHistoryRequest) => Promise<RuntimeHistoryResult>
  /** 读取目标运行实例当前绑定的可用模型；失败原因由结果表达。 */
  readonly getRuntimeCapabilities: (target: RuntimeTarget) => Promise<CapabilitiesResult>
  /**
   * 只切换当前会话模型；成功返回 Pi 刷新后的实际状态，不改变全局默认。
   * 失败或超时不保证模型未改变，不自动重发；实际模型以 Runtime 状态为准。
   */
  readonly setRuntimeModel: (request: RuntimeSetModelRequest) => Promise<RuntimeResult>
  /**
   * 手动压缩当前会话上下文；说明可选，成功返回 Pi 刷新后的实际状态。
   * 压缩是整段操作（含一次摘要 LLM 调用），完成后才返回；过程与结果由投影中的压缩记录表达。
   */
  readonly compactRuntime: (request: RuntimeCompactRequest) => Promise<RuntimeResult>
  /** 读取目标运行实例当前绑定已加载的 Pi 资源清单；来源是会话内已加载的扩展、提示词与技能。 */
  readonly getRuntimeResources: (target: RuntimeTarget) => Promise<ResourcesResult>
  /** 预读资源、可用模型与默认模型及分项错误；项目与信任由主进程决定，`force` 绕过进程内缓存。 */
  readonly getResourcePreview: (force: boolean) => Promise<ResourcePreviewResult>
  /** 读取目标运行实例当前绑定的 SDK 会话创建期诊断与 Extension 运行时错误。 */
  readonly getRuntimeDiagnostics: (target: RuntimeTarget) => Promise<RuntimeDiagnosticsResult>
  /** 固定请求目标运行实例的 `/mcp` 状态；状态文本由 notify 捕获后返回，不在页面拼造。 */
  readonly readRuntimeMcpStatus: (target: RuntimeTarget) => Promise<McpStatusResult>
  /** MCP 服务器 OAuth 登录、退出或重连；服务器名由页面给出但由主进程校验，命令文本由主进程拼出。 */
  readonly runRuntimeMcpCommand: (target: RuntimeTarget, action: McpCommandAction, serverName: string) => Promise<McpCommandResult>
  /**
   * 只读列举 Pi 的 mcp.json 配置：零参数，agent 目录与当前项目由主进程决定；
   * 不连接服务器、不写配置文件，项目级配置是否生效由主进程按信任决定回传。
   */
  readonly getRuntimeMcpConfig: () => Promise<McpConfigResult>
  /** MCP 服务器状态探测：零参数，主进程用当前项目与信任决定执行固定的 `pi mcp list --json`。 */
  readonly inspectRuntimeMcpServers: () => Promise<McpInspectionResult>
  /** 中止进行中的 MCP 探测；零参数，没有进行中的探测时返回 `aborted: false`。 */
  readonly abortRuntimeMcpInspection: () => Promise<McpInspectAbortResult>
  /** 确认目标运行实例已应用到的最高序号；即发即忘，结果不影响页面。 */
  readonly ackRuntimeProjection: (target: RuntimeTarget, seq: number) => void
  /** 订阅状态变化；返回释放函数，页面卸载时必须调用。 */
  readonly onRuntimeStatusChanged: (listener: (status: RuntimeStatus) => void) => () => void
  /** 订阅投影批次；返回释放函数，页面卸载时必须调用。 */
  readonly onRuntimeProjectionChanged: (listener: (batch: ProjectionBatch) => void) => () => void
}

// 与 desktop-api.ts 的共享错误码保持一致，再追加 Runtime 启动与运行专有错误码。
const RUNTIME_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED',
  'INVALID_PROJECT_PATH',
  'RUNTIME_NOT_READY',
  'RUNTIME_SPAWN_FAILED',
  'RUNTIME_EXITED',
  'RUNTIME_TIMEOUT',
  'RUNTIME_PROTOCOL_ERROR',
  'RUNTIME_COMMAND_REJECTED',
  'TRUST_REQUIRED'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 切换参数只放行运行实例、代际与模型身份；字符串长度有界，保持自定义 Provider/模型名称兼容。 */
export function isRuntimeSetModelRequest(value: unknown): value is RuntimeSetModelRequest {
  if (!isRecord(value)) return false
  return typeof value.runId === 'number'
    && Number.isSafeInteger(value.runId)
    && value.runId > 0
    && typeof value.runtimeId === 'number'
    && Number.isSafeInteger(value.runtimeId)
    && value.runtimeId > 0
    && typeof value.provider === 'string'
    && value.provider.trim() !== ''
    && value.provider.length <= 256
    && typeof value.modelId === 'string'
    && value.modelId.trim() !== ''
    && value.modelId.length <= 1024
    && Object.keys(value).every(key => key === 'runId' || key === 'runtimeId' || key === 'provider' || key === 'modelId')
}

/** 回退只接受明确的运行实例、Runtime、会话和投影消息身份。 */
export function isRuntimeRewindRequest(value: unknown): value is RuntimeRewindRequest {
  if (!isRecord(value)) return false
  return typeof value.runId === 'number' && Number.isSafeInteger(value.runId) && value.runId > 0
    && typeof value.runtimeId === 'number' && Number.isSafeInteger(value.runtimeId) && value.runtimeId > 0
    && typeof value.sessionId === 'string' && value.sessionId.trim() !== '' && value.sessionId.length <= 256
    && typeof value.messageId === 'string' && value.messageId.trim() !== '' && value.messageId.length <= 128
    && Object.keys(value).every(key => key === 'runId' || key === 'runtimeId' || key === 'sessionId' || key === 'messageId')
}

/** 压缩说明长度上限；超限文本按参数拒绝，不静默截断后当成另一条指令。 */
export const COMPACT_INSTRUCTIONS_MAX_CHARS = 2_000

/** 压缩只接受明确的运行实例、Runtime、会话身份，以及有界或缺失的说明文本。 */
export function isRuntimeCompactRequest(value: unknown): value is RuntimeCompactRequest {
  if (!isRecord(value)) return false
  const instructionsOk = value.instructions === null
    || (typeof value.instructions === 'string' && value.instructions.length <= COMPACT_INSTRUCTIONS_MAX_CHARS)
  return typeof value.runId === 'number' && Number.isSafeInteger(value.runId) && value.runId > 0
    && typeof value.runtimeId === 'number' && Number.isSafeInteger(value.runtimeId) && value.runtimeId > 0
    && typeof value.sessionId === 'string' && value.sessionId.trim() !== '' && value.sessionId.length <= 256
    && instructionsOk
    && Object.keys(value).every(key => key === 'runId' || key === 'runtimeId' || key === 'sessionId' || key === 'instructions')
}

/** 成功、扩展取消与结果不确定分开表达，不能把取消当成修改成功。 */
export function isRuntimeRewindResult(value: unknown): value is RuntimeRewindResult {
  if (!isRecord(value)) return false
  if (value.ok === true) {
    return isRecord(value.data) && isRuntimeStatus(value.data.status)
      && typeof value.data.cancelled === 'boolean'
      && (value.data.cancelled ? value.data.text === null : typeof value.data.text === 'string')
  }
  return (value.blocked === undefined || typeof value.blocked === 'boolean')
    && isRuntimeResult(value) && value.ok === false
}

function isRuntimeState(value: unknown): value is RuntimeState {
  return value === 'idle' || value === 'starting' || value === 'ready'
    || value === 'stopping' || value === 'failed'
}

/** 累计统计允收任意有限数（包含 0）；未知值必须是 null。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

export function isContextUsage(value: unknown): value is ContextUsage {
  if (!isRecord(value)) return false
  return isNullableFiniteNumber(value.tokens)
    && isNullableFiniteNumber(value.contextWindow)
    && isNullableFiniteNumber(value.percent)
}

/** 会话用量形状校验；宿主协议与页面契约共用同一判定，避免两套形状。 */
export function isSessionUsage(value: unknown): value is SessionUsage {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.input)
    && isFiniteNumber(value.output)
    && isFiniteNumber(value.cacheRead)
    && isFiniteNumber(value.cacheWrite)
    && isFiniteNumber(value.cost)
    && (value.context === null || isContextUsage(value.context))
}

/** 输出速率形状校验；同上，宿主上报与页面消费共用。 */
export function isOutputRate(value: unknown): value is OutputRate {
  if (!isRecord(value)) return false
  return isNullableFiniteNumber(value.average)
}

function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  if (!isRecord(value)) return false
  return (value.modelProvider === null || typeof value.modelProvider === 'string')
    && (value.modelId === null || typeof value.modelId === 'string')
    && (value.sessionId === null || typeof value.sessionId === 'string')
    && typeof value.messageCount === 'number'
    && typeof value.isStreaming === 'boolean'
    && typeof value.isCompacting === 'boolean'
    && (value.usage === null || isSessionUsage(value.usage))
    && isOutputRate(value.rate)
}

export function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  if (!isRecord(value) || !isRuntimeState(value.state)) return false
  if (value.runId !== null && (typeof value.runId !== 'number' || !Number.isSafeInteger(value.runId))) return false
  if (value.runtimeId !== null && typeof value.runtimeId !== 'number') return false
  if (value.sessionId !== null && typeof value.sessionId !== 'string') return false
  if (value.sdkVersion !== null && typeof value.sdkVersion !== 'string') return false
  if (value.lastError !== null && typeof value.lastError !== 'string') return false
  return value.info === null || isRuntimeInfo(value.info)
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isRuntimeResult(value: unknown): value is RuntimeResult {
  if (!isRecord(value)) return false

  if (value.ok === true) return isRuntimeStatus(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  return isRuntimeError(value.error)
}

/** 运行时错误对象校验：错误码必须在白名单内，供其他共享契约复用。 */
export function isRuntimeError(value: unknown): value is RuntimeError {
  if (!isRecord(value)) return false
  const { code, message } = value
  return typeof message === 'string'
    && typeof code === 'string'
    && RUNTIME_ERROR_CODES.includes(code)
}

function isPromptDisposition(value: unknown): value is PromptDisposition {
  return value === 'started' || value === 'queued' || value === 'handled'
}

function isProjectionBlockKind(value: unknown): value is ProjectionBlockKind {
  return value === 'text' || value === 'thinking' || value === 'toolcall'
}

function isProjectionBlock(value: unknown): value is ProjectionBlock {
  if (!isRecord(value)) return false
  if (typeof value.contentIndex !== 'number'
    || !Number.isInteger(value.contentIndex)
    || !isProjectionBlockKind(value.kind)
    || typeof value.text !== 'string'
    || typeof value.truncated !== 'boolean'
    || (value.toolCallId !== null && typeof value.toolCallId !== 'string')
    || (value.toolName !== null && typeof value.toolName !== 'string')
    || typeof value.notice !== 'boolean') return false
  if (value.image === null) return true
  return isRecord(value.image)
    && typeof value.image.dataUrl === 'string'
    && value.image.dataUrl !== ''
    && typeof value.image.mimeType === 'string'
    && value.image.mimeType !== ''
    && typeof value.image.bytes === 'number'
    && Number.isInteger(value.image.bytes)
    && value.image.bytes >= 0
}

/** 计时终态必须有结束时刻；未知历史用 null 表达，不冒充仍在生成。 */
function isMessageGeneration(value: unknown): value is MessageGeneration | null {
  if (value === null) return true
  if (!isRecord(value) || value.startedAt === null || !isTimestamp(value.startedAt)) return false
  if (value.phase === 'running') return value.endedAt === null
  return (value.phase === 'completed' || value.phase === 'interrupted')
    && typeof value.startedAt === 'number'
    && typeof value.endedAt === 'number'
    && isTimestamp(value.endedAt)
    && value.endedAt >= value.startedAt
}

/** 压缩记录只接受契约内的触发原因与有界文本；取消与失败分别用 `aborted` 与 `errorMessage` 表达。 */
function isProjectionCompaction(value: unknown): value is ProjectionCompaction {
  if (!isRecord(value)) return false
  const reason = value.reason
  return (reason === null || reason === 'manual' || reason === 'threshold' || reason === 'overflow')
    && typeof value.summary === 'string'
    && (value.tokensBefore === null || typeof value.tokensBefore === 'number')
    && (value.tokensAfter === null || typeof value.tokensAfter === 'number')
    && typeof value.aborted === 'boolean'
    && (value.errorMessage === null || typeof value.errorMessage === 'string')
}

/** 单次模型调用用量形状校验：四个字段都必须是有限数，缺失或异常整条拒绝。 */
function isMessageUsage(value: unknown): value is MessageUsage {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.input)
    && isFiniteNumber(value.output)
    && isFiniteNumber(value.cacheRead)
    && isFiniteNumber(value.cacheWrite)
}

function isProjectionMessage(value: unknown): value is ProjectionMessage {
  if (!isRecord(value)) return false
  const roleOk = value.role === 'user' || value.role === 'assistant' || value.role === 'compaction'
  if (!roleOk) return false
  const compaction = value.role === 'compaction' ? isProjectionCompaction(value.compaction) : value.compaction === null
  return typeof value.id === 'string'
    && (value.entryId === undefined || value.entryId === null || isHistoryId(value.entryId))
    && (value.recoverable === undefined || typeof value.recoverable === 'boolean')
    && (value.turnEntryId === undefined || isHistoryId(value.turnEntryId))
    && compaction
    && Array.isArray(value.blocks)
    && value.blocks.every(isProjectionBlock)
    && (value.role !== 'compaction' || value.blocks.length === 0)
    && (value.timestamp === null || typeof value.timestamp === 'number')
    && isMessageGeneration(value.generation)
    && (value.role === 'assistant' || value.generation === null)
    && isTurnTiming(value.turn)
    && (value.role === 'user' || value.turn === null)
    && (value.usage === null || isMessageUsage(value.usage))
    && (value.role === 'assistant' || value.usage === null)
    && (value.stopReason === null || typeof value.stopReason === 'string')
    && (value.errorMessage === null || typeof value.errorMessage === 'string')
    && (value.role !== 'compaction' || (value.stopReason === null && value.errorMessage === null))
}

function isToolExecutionPhase(value: unknown): value is ToolExecutionPhase {
  return value === 'running' || value === 'succeeded' || value === 'failed' || value === 'unknown'
}

function isToolExecutionTextKind(value: unknown): value is ToolExecutionTextKind {
  return value === 'none' || value === 'partial' || value === 'result'
}

/** 时间字段只接受纪元毫秒整数或 null；其他取值按契约不符处理。 */
function isTimestamp(value: unknown): boolean {
  return value === null
    || (typeof value === 'number' && Number.isInteger(value) && value >= 0)
}

/** 进行中的本轮允许 `endedAt` 为 null；开始时刻必须是数字，结束时刻不得早于开始时刻。 */
function isTurnTiming(value: unknown): boolean {
  if (value === null) return true
  if (!isRecord(value) || typeof value.startedAt !== 'number' || !isTimestamp(value.startedAt)) return false
  if (value.endedAt === null) return true
  return typeof value.endedAt === 'number' && isTimestamp(value.endedAt) && value.endedAt >= value.startedAt
}

function isToolNonTextPart(value: unknown): value is ToolNonTextPart {
  if (!isRecord(value)) return false
  return typeof value.type === 'string'
    && value.type !== ''
    && (value.mimeType === null || typeof value.mimeType === 'string')
    && (value.bytes === null
      || (typeof value.bytes === 'number' && Number.isInteger(value.bytes) && value.bytes >= 0))
}

function isToolExecution(value: unknown): value is ToolExecution {
  if (!isRecord(value)) return false
  return typeof value.toolCallId === 'string'
    && value.toolCallId !== ''
    && typeof value.toolName === 'string'
    && isToolExecutionPhase(value.phase)
    && isTimestamp(value.startedAt)
    && isTimestamp(value.endedAt)
    && (value.argsText === null || typeof value.argsText === 'string')
    && typeof value.argsTruncated === 'boolean'
    && (value.argsSummary === null
      || (Array.isArray(value.argsSummary) && value.argsSummary.every(isToolArgSummaryEntry)))
    && (value.outputPath === null || typeof value.outputPath === 'string')
    && typeof value.text === 'string'
    && isToolExecutionTextKind(value.textKind)
    && typeof value.textTruncated === 'boolean'
    && typeof value.nonTextBlocks === 'number'
    && Number.isInteger(value.nonTextBlocks)
    && value.nonTextBlocks >= 0
    && Array.isArray(value.nonTextParts)
    && value.nonTextParts.every(isToolNonTextPart)
    && (value.latestRevision === undefined || isCount(value.latestRevision))
    && (value.ui === null || isGenuiPayload(value.ui))
    && isToolDiff(value.diff)
}

function isToolArgSummaryEntry(value: unknown): value is ToolArgSummaryEntry {
  if (!isRecord(value) || typeof value.key !== 'string') return false
  const summaryValue = value.value
  if (!isRecord(summaryValue)) return false
  if (summaryValue.kind === 'inline') return typeof summaryValue.text === 'string'
  if (summaryValue.kind === 'text') return isCount(summaryValue.lines) && isCount(summaryValue.bytes)
  if (summaryValue.kind === 'items') return isCount(summaryValue.count)
  if (summaryValue.kind === 'object') return isCount(summaryValue.fields)
  return false
}

/** 摘要里的计数都是非负整数。 */
function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isToolDiffLineKind(value: unknown): value is ToolDiffLineKind {
  return value === 'add' || value === 'remove' || value === 'context' || value === 'fold'
}

function isDiffLineNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0)
}

function isToolDiffLine(value: unknown): value is ToolDiffLine {
  if (!isRecord(value)) return false
  return isToolDiffLineKind(value.kind)
    && isDiffLineNumber(value.oldLine)
    && isDiffLineNumber(value.newLine)
    && typeof value.text === 'string'
}

function isToolDiff(value: unknown): value is ToolDiff | null {
  if (value === null) return true
  if (!isRecord(value)) return false
  return (value.source === 'result' || value.source === 'args')
    && Array.isArray(value.lines)
    && value.lines.every(isToolDiffLine)
    && typeof value.truncated === 'boolean'
}

function isProjectionUpdate(value: unknown): value is ProjectionUpdate {
  if (!isRecord(value)) return false
  if (value.kind === 'activity') return isSessionActivity(value.activity)
  if (value.kind === 'tool') return isToolExecution(value.tool)
  if (value.kind === 'message') return isProjectionMessage(value.message)
  if (typeof value.messageId !== 'string') return false
  if (value.kind === 'block') return isProjectionBlock(value.block)
  return value.kind === 'append'
    && typeof value.contentIndex === 'number'
    && Number.isInteger(value.contentIndex)
    && typeof value.text === 'string'
    && typeof value.length === 'number'
    && Number.isInteger(value.length)
    && value.length >= 0
}

function isProjectionSnapshot(value: unknown): value is ProjectionSnapshot {
  if (!isRecord(value)) return false
  if (value.runtimeId !== null && typeof value.runtimeId !== 'number') return false
  // runId 是桥接层补充字段：载体缺失（宿主协议载荷）或为数字都放行，由页面按来源实例路由。
  if (value.runId !== undefined
    && value.runId !== null
    && (typeof value.runId !== 'number' || !Number.isSafeInteger(value.runId))) return false
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 0) return false
  if (!Array.isArray(value.messages) || !value.messages.every(isProjectionMessage)) return false
  if (!Array.isArray(value.tools) || !value.tools.every(isToolExecution)) return false
  return (value.activity === undefined || isSessionActivity(value.activity))
    && (value.history === undefined || (isRecord(value.history)
      && (value.history.before === null || isHistoryId(value.history.before)) && isCount(value.history.revision)))
    && typeof value.truncated === 'boolean'
    && typeof value.droppedMessages === 'number'
    && Number.isInteger(value.droppedMessages)
    && value.droppedMessages >= 0
    && typeof value.droppedTools === 'number'
    && Number.isInteger(value.droppedTools)
    && value.droppedTools >= 0
}

/** 批次校验失败时渲染端直接丢弃；序号缺口由快照重同步收敛。 */
export function isProjectionBatch(value: unknown): value is ProjectionBatch {
  if (!isRecord(value)) return false
  if (typeof value.runtimeId !== 'number') return false
  // runId 是桥接层补充字段：缺失（宿主协议载荷）或为数字都放行，由页面按来源实例路由。
  if (value.runId !== undefined && value.runId !== null
    && (typeof value.runId !== 'number' || !Number.isSafeInteger(value.runId))) return false
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq <= 0) return false
  if (!Array.isArray(value.updates) || !value.updates.every(isProjectionUpdate)) return false
  return typeof value.resyncRequired === 'boolean'
}

// prompt 的成功数据只认三个合法 disposition；其他取值按响应契约不符处理。
export function isPromptResult(value: unknown): value is PromptResult {
  if (!isRecord(value)) return false

  if (value.ok === true) {
    return isRecord(value.data) && isPromptDisposition(value.data.disposition)
  }
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && RUNTIME_ERROR_CODES.includes(code)
}

// 投影快照是重同步的唯一基准，跨进程返回同样只放行本契约。
export function isProjectionResult(value: unknown): value is ProjectionResult {
  if (!isRecord(value)) return false

  if (value.ok === true) return isProjectionSnapshot(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && RUNTIME_ERROR_CODES.includes(code)
}

/** 条目身份有界；不允许把任意路径混入历史请求。 */
function isHistoryId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}
function isHistoryChunk(value: unknown): value is HistoryChunk {
  return isRecord(value) && isHistoryId(value.entryId)
    && typeof value.field === 'string' && ['text', 'thinking', 'arguments', 'output', 'summary'].includes(value.field)
    && typeof value.contentIndex === 'number' && Number.isSafeInteger(value.contentIndex) && value.contentIndex >= 0
    && typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0
    && (value.toolCallId === undefined || (typeof value.toolCallId === 'string' && value.toolCallId.length > 0
      && value.toolCallId.length <= 512 && !value.toolCallId.includes('\0')))
    && (value.targetOffset === undefined || (typeof value.targetOffset === 'number'
      && Number.isSafeInteger(value.targetOffset) && value.targetOffset >= 0))
    && Object.keys(value).every(key => ['entryId', 'field', 'contentIndex', 'offset', 'kind', 'toolCallId', 'targetOffset'].includes(key))
}
export function isHistoryQuery(value: unknown): value is HistoryQuery {
  if (!isRecord(value)) return false
  if (value.kind === 'page') return (value.before === null || isHistoryId(value.before))
    && Object.keys(value).every(key => key === 'kind' || key === 'before')
  if (value.kind === 'turn') return isHistoryId(value.turnId) && (value.after === null || isHistoryId(value.after))
    && Object.keys(value).every(key => ['kind', 'turnId', 'after'].includes(key))
  return value.kind === 'text' && isHistoryChunk(value)
}
export function isRuntimeHistoryRequest(value: unknown): value is RuntimeHistoryRequest {
  return isRecord(value) && isRuntimeTarget({ runId: value.runId, runtimeId: value.runtimeId })
    && value.runtimeId !== null && isHistoryId(value.sessionId) && isHistoryQuery(value.query) && isCount(value.revision)
    && Object.keys(value).every(key => ['runId', 'runtimeId', 'sessionId', 'query', 'revision'].includes(key))
}
/** 活动只携带轻量事实，验证每类明细而非信任静态类型。 */
export function isSessionActivity(value: unknown): value is SessionActivity {
  if (!isRecord(value)) return false
  const counted = (row: unknown): row is Record<string, unknown> => isRecord(row) && isCount(row.count)
  return Array.isArray(value.files) && value.files.every(row => isRecord(row)
      && typeof row.key === 'string' && typeof row.label === 'string' && isCount(row.reads) && isCount(row.writes))
    && Array.isArray(value.skills) && value.skills.every(row => counted(row) && typeof row.name === 'string'
      && ['command', 'file', 'host'].includes(String(row.source)) && (row.location === null || typeof row.location === 'string'))
    && Array.isArray(value.mcp) && value.mcp.every(row => counted(row) && typeof row.server === 'string'
      && Array.isArray(row.tools) && row.tools.every(tool => counted(tool) && typeof tool.name === 'string'))
    && Array.isArray(value.plugins) && value.plugins.every(row => counted(row) && typeof row.toolName === 'string')
    && Array.isArray(value.genui) && value.genui.every(row => isRecord(row)
      && typeof row.documentId === 'string' && row.documentId !== ''
      && typeof row.title === 'string' && isCount(row.revision) && isCount(row.versions) && row.versions >= 1)
    && ['fileCount', 'skillCount', 'mcpCount', 'pluginCount', 'genuiCount'].every(key => isCount(value[key]))
    && typeof value.empty === 'boolean'
    && (value.incomplete === undefined || typeof value.incomplete === 'boolean')
}
export function isHistoryData(value: unknown): value is HistoryData {
  if (!isRecord(value)) return false
  if (value.kind === 'text') return isHistoryChunk(value.chunk) && typeof value.text === 'string'
    && value.text.length <= 262_144 && (value.next === null || isCount(value.next))
  return (value.kind === 'page' || value.kind === 'turn')
    && Array.isArray(value.messages) && value.messages.length <= 64 && value.messages.every(isProjectionMessage)
    && Array.isArray(value.tools) && value.tools.length <= 100 && value.tools.every(isToolExecution)
    && Array.isArray(value.chunks) && value.chunks.every(isHistoryChunk)
    && (value.before === null || isHistoryId(value.before)) && (value.next === null || isHistoryId(value.next))
    && (value.turnId === null || isHistoryId(value.turnId))
}
export function isRuntimeHistoryResult(value: unknown): value is RuntimeHistoryResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isHistoryData(value.data)
  return value.ok === false && isRecord(value.error) && typeof value.error.message === 'string'
    && typeof value.error.code === 'string' && RUNTIME_ERROR_CODES.includes(value.error.code)
}

function isModelSummary(value: unknown): value is ModelSummary {
  if (!isRecord(value)) return false
  return typeof value.provider === 'string'
    && value.provider !== ''
    && typeof value.id === 'string'
    && value.id !== ''
    && (value.name === null || (typeof value.name === 'string' && value.name !== ''))
    && (value.contextWindow === null
      || (typeof value.contextWindow === 'number'
        && Number.isFinite(value.contextWindow)
        && value.contextWindow > 0))
    && (value.imageInput === null || typeof value.imageInput === 'boolean')
}

function isAgentCapabilities(value: unknown): value is AgentCapabilities {
  if (!isRecord(value)) return false
  return typeof value.runtimeId === 'number'
    && Number.isInteger(value.runtimeId)
    && value.runtimeId > 0
    && Array.isArray(value.models)
    && value.models.every(isModelSummary)
    && (value.modelsError === null || typeof value.modelsError === 'string')
}

/** 模型能力读取只校验可用模型列表与固定错误码。 */
export function isCapabilitiesResult(value: unknown): value is CapabilitiesResult {
  if (!isRecord(value)) return false

  if (value.ok === true) return isAgentCapabilities(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && RUNTIME_ERROR_CODES.includes(code)
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string'
}

function isPiResourceKind(value: unknown): value is PiResourceKind {
  return value === 'skill' || value === 'prompt' || value === 'extension'
}

function isPiResourceEntry(value: unknown): value is PiResourceEntry {
  if (!isRecord(value)) return false
  return isPiResourceKind(value.kind)
    && typeof value.name === 'string'
    && value.name !== ''
    && isNullableString(value.description)
    && isNullableString(value.path)
    && isNullableString(value.scope)
    && isNullableString(value.origin)
    && isNullableString(value.baseDir)
}

/** 失败结果只校验形状与固定错误码，与其余 Runtime 结果一致。 */
function isRuntimeErrorResult(value: unknown): value is { ok: false; error: RuntimeError } {
  if (!isRecord(value) || value.ok !== false || !isRecord(value.error)) return false
  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && RUNTIME_ERROR_CODES.includes(code)
}

/** 资源清单跨进程校验；`error` 非空时条目必须为空，避免渲染端把失败当成“没有资源”。 */
export function isResourcesResult(value: unknown): value is ResourcesResult {
  if (!isRecord(value)) return false

  if (value.ok === true) {
    const data = value.data
    if (!isRecord(data)) return false
    if (typeof data.runtimeId !== 'number' || !Number.isInteger(data.runtimeId) || data.runtimeId <= 0) {
      return false
    }
    if (!Array.isArray(data.entries) || !data.entries.every(isPiResourceEntry)) return false
    if (typeof data.truncated !== 'boolean') return false
    if (!isNullableString(data.error)) return false
    return data.error === null || data.entries.length === 0
  }
  return isRuntimeErrorResult(value)
}

/** 预读结果跨进程校验：项目路径非空或为 null（全局范围），条目复用资源条目校验，失败形状与其余 Runtime 结果一致。 */
export function isResourcePreviewResult(value: unknown): value is ResourcePreviewResult {
  if (!isRecord(value)) return false

  if (value.ok === true) {
    const data = value.data
    return isRecord(data)
      && (data.projectPath === null || (typeof data.projectPath === 'string' && data.projectPath !== ''))
      && Array.isArray(data.entries)
      // 全局范围不返回项目资源，避免把中立目录下的清单当成某个项目的资源。
      && (data.projectPath !== null || (data.entries.length === 0 && data.entriesError === null))
      && data.entries.every(isPiResourceEntry)
      && isNullableString(data.entriesError)
      && (data.entriesError === null || data.entries.length === 0)
      && Array.isArray(data.models)
      && data.models.every(isModelSummary)
      && isNullableString(data.modelsError)
      && (data.modelsError === null || data.models.length === 0)
      && (data.defaultModel === null || isModelIdentity(data.defaultModel))
      && isNullableString(data.defaultModelError)
      && (data.defaultModelError === null || data.defaultModel === null)
  }
  return isRuntimeErrorResult(value)
}

function isExtensionErrorEntry(value: unknown): value is ExtensionErrorEntry {
  if (!isRecord(value)) return false
  return isNullableString(value.path)
    && isNullableString(value.event)
    && typeof value.error === 'string'
    && value.error !== ''
}

/** 诊断结果跨进程校验；无活动 Runtime 时 `runtimeId` 为 null，两项均为空数组。 */
export function isRuntimeDiagnosticsResult(value: unknown): value is RuntimeDiagnosticsResult {
  if (!isRecord(value)) return false

  if (value.ok === true) {
    const data = value.data
    if (!isRecord(data)) return false
    if (data.runtimeId !== null
      && (typeof data.runtimeId !== 'number' || !Number.isInteger(data.runtimeId) || data.runtimeId <= 0)) {
      return false
    }
    if (!Array.isArray(data.stderrLines) || !data.stderrLines.every((line) => typeof line === 'string')) {
      return false
    }
    return Array.isArray(data.extensionErrors) && data.extensionErrors.every(isExtensionErrorEntry)
  }
  return isRuntimeErrorResult(value)
}

/** MCP 状态结果跨进程校验；状态文本只能是已捕获的 notify 文本数组。 */
export function isMcpStatusResult(value: unknown): value is McpStatusResult {
  if (!isRecord(value)) return false

  if (value.ok === true) {
    const data = value.data
    return isRecord(data)
      && isPromptDisposition(data.disposition)
      && Array.isArray(data.messages)
      && data.messages.every((message) => typeof message === 'string')
  }
  return isRuntimeErrorResult(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isToolExposure(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false
  return Object.values(value).every((item) => typeof item === 'string')
}

function isMcpServerReport(value: unknown): value is McpServerReport {
  if (!isRecord(value)) return false
  if (typeof value.name !== 'string' || value.name === '') return false
  if (typeof value.scope !== 'string' || typeof value.source !== 'string') return false
  if (value.override !== null && typeof value.override !== 'string') return false
  if (typeof value.enabled !== 'boolean') return false
  if (typeof value.exposure !== 'string' || typeof value.transport !== 'string') return false
  if (typeof value.state !== 'string' || value.state === '') return false
  if (!isStringArray(value.tools)) return false
  if (value.toolExposure !== null && !isToolExposure(value.toolExposure)) return false
  if (typeof value.hasResources !== 'boolean') return false
  return value.error === null || typeof value.error === 'string'
}

/** MCP 探测结果跨进程校验；服务器报告、配置错误、说明文本与探测时刻都只放行已声明的形状。 */
export function isMcpInspectionResult(value: unknown): value is McpInspectionResult {
  if (!isRecord(value)) return false

  if (value.ok === true) {
    const data = value.data
    return isRecord(data)
      && Array.isArray(data.servers)
      && data.servers.every(isMcpServerReport)
      && isStringArray(data.configErrors)
      && (data.note === null || typeof data.note === 'string')
      && typeof data.inspectedAt === 'number'
      && Number.isInteger(data.inspectedAt)
      && data.inspectedAt >= 0
  }
  return isRuntimeErrorResult(value)
}

/** 预读请求只接受显式的 `force` 布尔值；其他字段与缺字段都按契约不符处理。 */
export function isResourcePreviewRequest(value: unknown): value is ResourcePreviewRequest {
  if (!isRecord(value)) return false
  return typeof value.force === 'boolean'
    && Object.keys(value).every(key => key === 'force')
}

function isMcpConfigServer(value: unknown): value is McpConfigServer {
  if (!isRecord(value)) return false
  return typeof value.name === 'string'
    && value.name !== ''
    && typeof value.scope === 'string'
    && typeof value.source === 'string'
    && typeof value.enabled === 'boolean'
    && (value.transport === null || typeof value.transport === 'string')
    && (value.override === null || typeof value.override === 'string')
}

/** MCP 配置列举结果跨进程校验：只放行已声明的浅层字段。 */
export function isMcpConfigResult(value: unknown): value is McpConfigResult {
  if (!isRecord(value)) return false

  if (value.ok === true) {
    const data = value.data
    return isRecord(data)
      && Array.isArray(data.servers)
      && data.servers.every(isMcpConfigServer)
      && isStringArray(data.errors)
      && typeof data.globalConfigPath === 'string'
      && (data.projectConfigPath === null || typeof data.projectConfigPath === 'string')
      && typeof data.projectConfigTrusted === 'boolean'
  }
  return isRuntimeErrorResult(value)
}

/** 中止探测结果校验：只允许布尔 `aborted`。 */
export function isMcpInspectAbortResult(value: unknown): value is McpInspectAbortResult {
  if (!isRecord(value)) return false
  if (value.ok === true) {
    return isRecord(value.data) && typeof value.data.aborted === 'boolean'
  }
  return isRuntimeErrorResult(value)
}

/** MCP 命令结果与状态结果的形状一致，因此复用同一套校验。 */
export function isMcpCommandResult(value: unknown): value is McpCommandResult {
  return isMcpStatusResult(value)
}
