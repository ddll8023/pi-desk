/** 只定义 Runtime 启停、状态、Prompt 提交、中止、可用模型读取、Pi 资源与诊断读取、MCP 状态、MCP 服务器探测与 MCP 登录/退出/重连命令、安全启动、消息/工具投影 IPC 的固定通道、事件名、结果类型与跨进程响应校验。 */
import type { DesktopErrorCode } from './desktop-api'

export const RUNTIME_START_CHANNEL = 'desktop:runtime-start'
export const RUNTIME_STOP_CHANNEL = 'desktop:runtime-stop'
export const RUNTIME_STATUS_CHANNEL = 'desktop:runtime-status'
export const RUNTIME_PROMPT_CHANNEL = 'desktop:runtime-prompt'
export const RUNTIME_ABORT_CHANNEL = 'desktop:runtime-abort'
export const RUNTIME_PROJECTION_CHANNEL = 'desktop:runtime-projection'
export const RUNTIME_PROJECTION_ACK_CHANNEL = 'desktop:runtime-projection-ack'
export const RUNTIME_CAPABILITIES_CHANNEL = 'desktop:runtime-capabilities'
/** 只读：读取当前代际已加载的 Pi 资源清单（`get_commands` 投影）。 */
export const RUNTIME_RESOURCES_CHANNEL = 'desktop:runtime-resources'
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
/** 安全模式启动：零参数，主进程用最近一次启动意图并固定传 `--no-extensions`。 */
export const RUNTIME_START_SAFE_CHANNEL = 'desktop:runtime-start-safe'
/** 主进程到渲染进程的单向状态通知，payload 是 RuntimeStatus。 */
export const RUNTIME_STATUS_EVENT = 'desktop:runtime-status-changed'
/** 主进程到渲染进程的单向投影批次通知，payload 是 ProjectionBatch。 */
export const RUNTIME_PROJECTION_EVENT = 'desktop:runtime-projection-changed'

/** 启动请求只接受项目目录；其他启动参数一律不接受。 */
export interface RuntimeStartRequest {
  readonly projectPath: string
}

/**
 * `idle` 且 `runtimeId` 非空表示上一次 Runtime 已正常关闭；
 * `runtimeId` 仍为 null 表示从未启动。`failed` 表示异常退出或启动失败。
 */
export type RuntimeState = 'idle' | 'starting' | 'ready' | 'stopping' | 'failed'

/** 只投影页面需要的会话信息，不搬运 Pi 的完整状态或消息。 */
export interface RuntimeInfo {
  /** 当前模型的 provider 与 id；图片附件能力按模型目录精确匹配。 */
  readonly modelProvider: string | null
  readonly modelId: string | null
  readonly sessionId: string | null
  readonly messageCount: number
  readonly isStreaming: boolean
}

export interface RuntimeStatus {
  readonly state: RuntimeState
  readonly runtimeId: number | null
  readonly info: RuntimeInfo | null
  readonly lastError: string | null
}

export type RuntimeErrorCode =
  | DesktopErrorCode
  | 'INVALID_PROJECT_PATH'
  | 'RUNTIME_ALREADY_RUNNING'
  | 'RUNTIME_NOT_READY'
  | 'RUNTIME_SPAWN_FAILED'
  | 'RUNTIME_EXITED'
  | 'RUNTIME_TIMEOUT'
  | 'RUNTIME_PROTOCOL_ERROR'
  | 'PROMPT_REJECTED'
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

/** prompt 结果只表达请求被接受、排队或被处理，不等待 Agent 执行结束。 */
export type PromptResult =
  | { readonly ok: true; readonly data: { readonly disposition: PromptDisposition } }
  | { readonly ok: false; readonly error: RuntimeError }

/** 投影只重建页面要展示的内容块；诊断不进入内容块投影，用户消息图片以附件描述块表达，工具结果以独立工具条目表达。 */
export type ProjectionBlockKind = 'text' | 'thinking' | 'toolcall'

/** 块的 `text` 是当前完整内容；`truncated` 表示已按展示上限截断。 */
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
  readonly text: string
  readonly textKind: ToolExecutionTextKind
  readonly textTruncated: boolean
  /** 结束结果中的非文本内容块总数；与 `nonTextParts` 的条数可能不同。 */
  readonly nonTextBlocks: number
  /** 非文本内容块描述，条数有上限；界面按描述标示类型与大小。 */
  readonly nonTextParts: readonly ToolNonTextPart[]
  /** 文件变更展示数据；null 表示无可信来源，不伪造 Diff。 */
  readonly diff: ToolDiff | null
}

/** `id` 由 Desktop 生成，不冒充 Pi 消息字段。 */
export interface ProjectionMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly blocks: readonly ProjectionBlock[]
  readonly timestamp: number | null
  readonly stopReason: string | null
  readonly errorMessage: string | null
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

/** 重新订阅或失去同步时的唯一基准；没有活动 Runtime 时消息与工具列表为空。 */
export interface ProjectionSnapshot {
  readonly runtimeId: number | null
  readonly seq: number
  readonly messages: readonly ProjectionMessage[]
  readonly tools: readonly ToolExecution[]
  readonly truncated: boolean
  readonly droppedMessages: number
  readonly droppedTools: number
}

/** `resyncRequired` 表示增量已作废，渲染端应换取快照而不是继续应用本批更新。 */
export interface ProjectionBatch {
  readonly runtimeId: number
  readonly seq: number
  readonly updates: readonly ProjectionUpdate[]
  readonly resyncRequired: boolean
}

/** 应用确认只带已应用到的最高序号；确认失败只影响通知窗口。 */
export interface ProjectionAckRequest {
  readonly runtimeId: number
  readonly seq: number
}

export type ProjectionResult =
  | { readonly ok: true; readonly data: ProjectionSnapshot }
  | { readonly ok: false; readonly error: RuntimeError }

/** 可用模型的精简投影；仅保留 Provider 状态与图片输入判断所需字段。 */
export interface ModelSummary {
  readonly provider: string
  readonly id: string
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
 * Pi 侧资源的来源分类，与 `get_commands` 的 `source` 字段一一对应；
 * 其他来源（内置 TUI 命令等）不出现在 `get_commands` 里，也不进入页面。
 */
export type PiResourceKind = 'skill' | 'prompt' | 'extension'

/**
 * 一条已加载的 Pi 资源条目，只来自 `get_commands` 的投影。
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
 * `stderrLines` 是 Pi 输出的诊断文本（已去 ANSI、按行与长度有界），按不可信纯文本展示。
 * 技能/提示词等资源加载警告在 RPC 模式下不进入任何通道，这里也无法提供。
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

/** 只接受动作与服务器名；命令文本由主进程拼接，页面不能传入任意命令。 */
export interface McpCommandRequest {
  readonly action: McpCommandAction
  readonly serverName: string
}

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
  readonly resources: number | null
  readonly resourceTemplates: number | null
  /** 非 connected 状态下官方给出的错误文本；无错误为 null。 */
  readonly error: string | null
}

/**
 * 一次 MCP 服务器探测结果。探测是只读的：官方 CLI 只连接并读取状态，不写任何配置文件。
 * `configErrors` 是被官方跳过条目的原因文本，`note` 是项目未信任等原因的部分忽略说明。
 */
export interface McpInspection {
  readonly servers: readonly McpServerReport[]
  readonly configErrors: readonly string[]
  readonly note: string | null
}

export type McpInspectionResult =
  | { readonly ok: true; readonly data: McpInspection }
  | { readonly ok: false; readonly error: RuntimeError }

/** 中止探测的结果；`aborted` 为 false 表示当时没有进行中的探测。 */
export type McpInspectAbortResult =
  | { readonly ok: true; readonly data: { readonly aborted: boolean } }
  | { readonly ok: false; readonly error: RuntimeError }

export interface RuntimeApi {
  readonly startRuntime: (projectPath: string) => Promise<RuntimeResult>
  readonly stopRuntime: () => Promise<RuntimeResult>
  readonly getRuntimeStatus: () => Promise<RuntimeResult>
  readonly sendPrompt: (message: string, images?: readonly PromptImageInput[]) => Promise<PromptResult>
  /** 请求中止当前 Agent 操作；成功只表示 Pi 已确认取消，运行状态仍以事件流为准。 */
  readonly abortRuntime: () => Promise<RuntimeResult>
  readonly getRuntimeProjection: () => Promise<ProjectionResult>
  /** 读取当前代际的可用模型；失败原因由结果表达。 */
  readonly getRuntimeCapabilities: () => Promise<CapabilitiesResult>
  /** 读取当前代际已加载的 Pi 资源清单；清单来源是 `get_commands`，不解析 Pi 配置文件。 */
  readonly getRuntimeResources: () => Promise<ResourcesResult>
  /** 读取当前代际的启动诊断尾部与 Extension 运行时错误；无活动 Runtime 时两项都为空。 */
  readonly getRuntimeDiagnostics: () => Promise<RuntimeDiagnosticsResult>
  /** 固定请求 `/mcp` 状态；状态文本由 notify 捕获后返回，不在页面拼造。 */
  readonly readRuntimeMcpStatus: () => Promise<McpStatusResult>
  /** MCP 服务器 OAuth 登录、退出或重连；服务器名由页面给出但由主进程校验，命令文本由主进程拼出。 */
  readonly runRuntimeMcpCommand: (action: McpCommandAction, serverName: string) => Promise<McpCommandResult>
  /** MCP 服务器状态探测：零参数，主进程用当前项目与信任决定执行固定的 `pi mcp list --json`。 */
  readonly inspectRuntimeMcpServers: () => Promise<McpInspectionResult>
  /** 中止进行中的 MCP 探测；零参数，没有进行中的探测时返回 `aborted: false`。 */
  readonly abortRuntimeMcpInspection: () => Promise<McpInspectAbortResult>
  /**
   * 安全模式启动：不加载 Extension，复用最近一次启动的项目与会话；仅本次生效，不写配置。
   * 与常规启动一样先经过信任拦截（无决定时返回 `TRUST_REQUIRED`）。
   */
  readonly startRuntimeSafely: () => Promise<RuntimeResult>
  /** 确认已应用到的最高序号；即发即忘，结果不影响页面。 */
  readonly ackRuntimeProjection: (runtimeId: number, seq: number) => void
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
  'RUNTIME_ALREADY_RUNNING',
  'RUNTIME_NOT_READY',
  'RUNTIME_SPAWN_FAILED',
  'RUNTIME_EXITED',
  'RUNTIME_TIMEOUT',
  'RUNTIME_PROTOCOL_ERROR',
  'PROMPT_REJECTED',
  'RUNTIME_COMMAND_REJECTED',
  'TRUST_REQUIRED'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRuntimeState(value: unknown): value is RuntimeState {
  return value === 'idle' || value === 'starting' || value === 'ready'
    || value === 'stopping' || value === 'failed'
}

function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  if (!isRecord(value)) return false
  return (value.modelProvider === null || typeof value.modelProvider === 'string')
    && (value.modelId === null || typeof value.modelId === 'string')
    && (value.sessionId === null || typeof value.sessionId === 'string')
    && typeof value.messageCount === 'number'
    && typeof value.isStreaming === 'boolean'
}

export function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  if (!isRecord(value) || !isRuntimeState(value.state)) return false
  if (value.runtimeId !== null && typeof value.runtimeId !== 'number') return false
  if (value.lastError !== null && typeof value.lastError !== 'string') return false
  return value.info === null || isRuntimeInfo(value.info)
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isRuntimeResult(value: unknown): value is RuntimeResult {
  if (!isRecord(value)) return false

  if (value.ok === true) return isRuntimeStatus(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
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
    || (value.toolName !== null && typeof value.toolName !== 'string')) return false
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

function isProjectionMessage(value: unknown): value is ProjectionMessage {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && (value.role === 'user' || value.role === 'assistant')
    && Array.isArray(value.blocks)
    && value.blocks.every(isProjectionBlock)
    && (value.timestamp === null || typeof value.timestamp === 'number')
    && (value.stopReason === null || typeof value.stopReason === 'string')
    && (value.errorMessage === null || typeof value.errorMessage === 'string')
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
    && typeof value.text === 'string'
    && isToolExecutionTextKind(value.textKind)
    && typeof value.textTruncated === 'boolean'
    && typeof value.nonTextBlocks === 'number'
    && Number.isInteger(value.nonTextBlocks)
    && value.nonTextBlocks >= 0
    && Array.isArray(value.nonTextParts)
    && value.nonTextParts.every(isToolNonTextPart)
    && isToolDiff(value.diff)
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
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 0) return false
  if (!Array.isArray(value.messages) || !value.messages.every(isProjectionMessage)) return false
  if (!Array.isArray(value.tools) || !value.tools.every(isToolExecution)) return false
  return typeof value.truncated === 'boolean'
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

function isModelSummary(value: unknown): value is ModelSummary {
  if (!isRecord(value)) return false
  return typeof value.provider === 'string'
    && value.provider !== ''
    && typeof value.id === 'string'
    && value.id !== ''
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

function isMcpCommandAction(value: unknown): value is McpCommandAction {
  return value === 'login' || value === 'logout' || value === 'reconnect'
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
  if (value.resources !== null && (typeof value.resources !== 'number' || !Number.isInteger(value.resources))) return false
  if (value.resourceTemplates !== null
    && (typeof value.resourceTemplates !== 'number' || !Number.isInteger(value.resourceTemplates))) return false
  return value.error === null || typeof value.error === 'string'
}

/** MCP 探测结果跨进程校验；服务器报告、配置错误与说明文本都只放行已声明的形状。 */
export function isMcpInspectionResult(value: unknown): value is McpInspectionResult {
  if (!isRecord(value)) return false

  if (value.ok === true) {
    const data = value.data
    return isRecord(data)
      && Array.isArray(data.servers)
      && data.servers.every(isMcpServerReport)
      && isStringArray(data.configErrors)
      && (data.note === null || typeof data.note === 'string')
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

/** 请求只校验形状；服务器名的字符集与长度由主进程校验后再拼接命令。 */
export function isMcpCommandRequest(value: unknown): value is McpCommandRequest {
  if (!isRecord(value)) return false
  return isMcpCommandAction(value.action)
    && typeof value.serverName === 'string'
    && value.serverName.length > 0
}

/** MCP 命令结果与状态结果的形状一致，因此复用同一套校验。 */
export function isMcpCommandResult(value: unknown): value is McpCommandResult {
  return isMcpStatusResult(value)
}
