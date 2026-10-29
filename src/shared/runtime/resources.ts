/** Pi 资源与 MCP 契约：资源清单、资源预读、诊断，以及 MCP 状态、探测、配置与命令。 */

import { COMPACT_INSTRUCTIONS_MAX_CHARS } from './status'
import type { PromptDisposition, PromptResult, RuntimeCompactRequest, RuntimeDiagnosticsResult, RuntimeError, RuntimeInfo, RuntimeResult, RuntimeRewindRequest, RuntimeRewindResult, RuntimeSetModelRequest, RuntimeState, RuntimeStatus, RuntimeTarget } from './status'
import type { AgentCapabilities, CapabilitiesResult, ModelIdentity, ModelSummary } from './models'
import type { ContextUsage, ExtensionErrorEntry, HistoryChunk, HistoryData, HistoryQuery, MessageGeneration, MessageUsage, OutputRate, ProjectionBatch, ProjectionBlock, ProjectionBlockKind, ProjectionCompaction, ProjectionMessage, ProjectionResult, ProjectionSnapshot, ProjectionUpdate, SessionActivity, SessionUsage, ToolArgSummaryEntry, ToolDiff, ToolDiffLine, ToolDiffLineKind, ToolExecution, ToolExecutionPhase, ToolExecutionTextKind, ToolNonTextPart } from './projection'
import { isGenuiPayload } from '../genui-api'
import { parseImageAnnotationAttachments } from '../image-annotation'


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
    && (value.imageAnnotations === undefined || (value.role === 'user'
      && parseImageAnnotationAttachments(value.imageAnnotations) !== null))
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
/** 非负整数计数；带类型谓词，让后续比较不用再收窄一次。 */
function isCount(value: unknown): value is number {
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
