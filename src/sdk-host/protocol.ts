/** SDK 宿主内部生命周期、目标授权、日志读取与交互契约；不引入 SDK，不开放任意调用或凭据快照。 */
import { isExtensionDialogResponseInput, projectExtensionUiRequest } from '../shared/extension-ui-api'
import { parseImageAnnotations } from '../shared/image-annotation'
import type { ImageAnnotationDocument } from '../shared/image-annotation'
import {
  COMPACT_INSTRUCTIONS_MAX_CHARS,
  isCapabilitiesResult, isMcpCommandResult, isMcpStatusResult, isOutputRate, isProjectionBatch,
  isProjectionResult, isResourcesResult, isRuntimeDiagnosticsResult, isSessionUsage, isHistoryQuery, isHistoryData
} from '../shared/runtime-api'
import type { ExtensionDialogResponseInput } from '../shared/extension-ui-api'
import type {
  AgentCapabilities, McpStatus, OutputRate, PiResources, ProjectionBatch, ProjectionSnapshot,
  RuntimeDiagnostics, SessionUsage, HistoryQuery, HistoryData
} from '../shared/runtime-api'

export const SDK_HOST_PROTOCOL_VERSION = 8
/**
 * `hostId` 是主进程注册表分配的应用级运行身份；宿主不能自行编号，重启后也不会复用旧值。
 */
interface HostEnvelope { readonly version: typeof SDK_HOST_PROTOCOL_VERSION; readonly hostId: number }
interface RequestEnvelope extends HostEnvelope { readonly requestId: string }

/** 路径引用仅供主进程核对，页面仍只能使用既有受限接口。 */
export type SdkSessionReference =
  | { readonly kind: 'new' }
  | { readonly kind: 'id'; readonly sessionId: string }
  | { readonly kind: 'file'; readonly sessionFile: string }

/**
 * 主进程授权结果：目标，以及主进程注册表为该次绑定分配的应用级绑定代际。
 * 代际只在主进程分配，宿主不得自行编号，旧代际的动作与事件都不允许命中新绑定。
 */
export interface SdkSessionAuthorization {
  readonly target: SdkSessionTarget
  readonly generation: number
}

/** 主进程授权的目标；fileStamp 是只读身份线索，不是持久化配置或跨应用写锁。 */
export interface SdkSessionTarget {
  readonly projectPath: string
  readonly sessionDir: string
  readonly sessionId: string | null
  readonly sessionFile: string | null
  readonly fileStamp: string | null
  readonly trusted: boolean
  /** 是否注册生成式 UI 内置扩展；由主进程按用户开关给出，宿主只负责据此决定注册与否。 */
  readonly genui: boolean
}

/**
 * 会话日志读取目标：主进程已复核归属与文件戳的会话文件，以及要读的历史查询。
 * 日志读取只解析出当前分支的历史（页、轮次或原文续段），不建立 AgentSession，也不加载技能、扩展与 MCP，
 * 因此不携带信任与生成式 UI 开关；它不能用来提交任何写操作。
 */
export interface SdkLogTarget {
  readonly projectPath: string
  readonly sessionId: string
  readonly sessionFile: string
  readonly fileStamp: string
  readonly query: HistoryQuery
}

/** 宿主内 MCP 动作；与页面契约 `McpCommandAction` 同集合，enable/disable 不在范围内。 */
export type SdkMcpCommandAction = 'login' | 'logout' | 'reconnect'

/** 宿主向主进程申请执行的浏览器操作判别联合。 */
export type SdkBrowserOperation =
  | { readonly kind: 'snapshot' }
  | { readonly kind: 'get-content' }
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'click'; readonly refId: number }
  | { readonly kind: 'fill'; readonly refId: number; readonly text: string }
  | { readonly kind: 'press'; readonly key: string }
  | { readonly kind: 'scroll'; readonly deltaX?: number; readonly deltaY?: number }

/** 主进程返回给宿主的浏览器操作结果。 */
export type SdkBrowserOperationResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: string; readonly notBound?: boolean; readonly paused?: boolean }

export type SdkHostFailureCode =
  | 'SDK_LOAD_FAILED' | 'AGENT_DIR_MISMATCH' | 'HOST_NOT_READY'
  | 'INVALID_SESSION_TARGET' | 'TRUST_REQUIRED' | 'SESSION_NOT_FOUND'
  | 'SESSION_BUSY' | 'STALE_SESSION' | 'SESSION_OPERATION_CONFLICT'
  | 'SESSION_CREATE_FAILED' | 'SESSION_BIND_FAILED' | 'SESSION_CLOSE_FAILED'
  | 'SESSION_RECOVERY_REQUIRED' | 'AUTHORIZATION_FAILED' | 'INTERACTION_INVALID'

/** bound 只表示内部绑定完成，绝不代表历史已同步或页面可提交。 */
export interface SdkSessionStatus {
  readonly phase: 'empty' | 'preparing' | 'bound' | 'invalid' | 'blocked' | 'failed'
  /** 主进程注册表分配的应用级绑定代际；未绑定时为 null。 */
  readonly bindingId: number | null
  readonly activityVersion: number
  readonly operationId: string | null
  readonly projectPath: string | null
  readonly sessionId: string | null
  readonly sessionFile: string | null
  readonly isIdle: boolean
  readonly isCompacting: boolean
  readonly pendingMessages: number
  readonly isBashRunning: boolean
  readonly waitingDialogs: number
  readonly needsHostRebuild: boolean
  readonly lastError: SdkHostFailureCode | null
  /** 活动会话的模型身份；未绑定或官方尚未选定模型时为 null。 */
  readonly modelProvider: string | null
  readonly modelId: string | null
  /** 投影中当前展示的消息条数；未绑定时为 0。 */
  readonly messageCount: number
  /** 会话累计用量；官方统计未取到时为 null，不用全零冒充。 */
  readonly usage: SessionUsage | null
  /** 输出速率；未结算到有效值时为 null。 */
  readonly rate: OutputRate
}

/** 无活动会话的初始副本，不意味着宿主或模型服务已经建立。 */
export function emptySdkSessionStatus(): SdkSessionStatus {
  return { phase: 'empty', bindingId: null, activityVersion: 0, operationId: null,
    projectPath: null, sessionId: null, sessionFile: null, isIdle: true, isCompacting: false,
    pendingMessages: 0, isBashRunning: false, waitingDialogs: 0, needsHostRebuild: false, lastError: null,
    modelProvider: null, modelId: null, messageCount: 0, usage: null, rate: { average: null } }
}

/** 调用方固定的宿主与绑定身份，防止进程重建后编号重用导致旧动作穿透。 */
export interface SdkSessionIdentity {
  readonly hostId: number | null
  readonly bindingId: number | null
}

export interface SdkInterruptConfirmation {
  readonly bindingId: number
  readonly activityVersion: number
}
export type SdkSessionAction = 'new' | 'open' | 'reload' | 'release'
export type SdkSessionRequest = RequestEnvelope & {
  readonly type: 'session'
  readonly action: SdkSessionAction
  readonly expectedBindingId: number | null
  readonly interrupt: SdkInterruptConfirmation | null
  readonly target: SdkSessionTarget | null
}

export type SdkHostRequest =
  | (RequestEnvelope & { readonly type: 'initialize'; readonly agentDir: string })
  | (RequestEnvelope & { readonly type: 'shutdown' })
  | SdkSessionRequest
  | (RequestEnvelope & { readonly type: 'session-abort'; readonly bindingId: number })
  /** 提交只表达是否被接受；本轮结束不属于提交响应。 */
  | (RequestEnvelope & { readonly type: 'prompt'; readonly bindingId: number; readonly message: string;
      readonly images: readonly { readonly type: 'image'; readonly data: string; readonly mimeType: string;
        readonly annotations?: ImageAnnotationDocument }[] })
  | (RequestEnvelope & { readonly type: 'set-model'; readonly bindingId: number; readonly provider: string;
      readonly modelId: string })
  /** 回退只回退对话分支；目标由官方条目 ID 定位，不接受任意条目或会话路径。 */
  | (RequestEnvelope & { readonly type: 'rewind'; readonly bindingId: number; readonly messageId: string })
  /** 手动压缩当前会话上下文；说明可选，结果由投影中的压缩记录表达。 */
  | (RequestEnvelope & { readonly type: 'compact'; readonly bindingId: number; readonly instructions: string | null })
  /** 能力清单只读当前绑定会话的模型目录；不创建会话，也不建立第二个模型容器。 */
  | (RequestEnvelope & { readonly type: 'capabilities'; readonly bindingId: number })
  /** 资源清单只读当前绑定会话内存中已加载的扩展命令、提示词与技能；不重新扫描磁盘。 */
  | (RequestEnvelope & { readonly type: 'resources'; readonly bindingId: number })
  /** 诊断只读当前绑定会话的创建期诊断与已收集的 Extension 运行时错误；不新建执行上下文。 */
  | (RequestEnvelope & { readonly type: 'diagnostics'; readonly bindingId: number })
  /** MCP 状态只读固定命令 `/mcp` 的 notify 捕获结果；命令文本不接受页面传入。 */
  | (RequestEnvelope & { readonly type: 'mcp-status'; readonly bindingId: number })
  /** MCP 登录/退出/重连：动作与服务器名由主进程校验后拼成固定命令。 */
  | (RequestEnvelope & { readonly type: 'mcp-command'; readonly bindingId: number;
      readonly action: SdkMcpCommandAction; readonly serverName: string })
  /** 投影快照是渲染端重同步的唯一基准；引用条目 ID 由官方会话树给出。 */
  | (RequestEnvelope & { readonly type: 'projection-snapshot'; readonly bindingId: number })
  | (RequestEnvelope & { readonly type: 'history'; readonly bindingId: number; readonly sessionId: string; readonly query: HistoryQuery })
  | (RequestEnvelope & { readonly type: 'projection-ack'; readonly bindingId: number; readonly seq: number })
  | (RequestEnvelope & { readonly type: 'session-log'; readonly target: SdkLogTarget })
  | (RequestEnvelope & { readonly type: 'ui-response'; readonly bindingId: number;
      readonly dialogId: string; readonly response: ExtensionDialogResponseInput })
  | (RequestEnvelope & { readonly type: 'authorization-result'; readonly bindingId: number | null;
      readonly target: SdkSessionTarget | null; readonly error: SdkHostFailureCode | null;
      readonly generation: number | null })
  | (RequestEnvelope & { readonly type: 'browser-operation-result'; readonly bindingId: number;
      readonly result: SdkBrowserOperationResult })

export type SdkHostFrame =
  | (RequestEnvelope & { readonly type: 'ready'; readonly agentDir: string; readonly sdkVersion: string })
  | (RequestEnvelope & { readonly type: 'closed' })
  | (RequestEnvelope & { readonly type: 'failed'; readonly code: SdkHostFailureCode })
  | (RequestEnvelope & { readonly type: 'session-result'; readonly seq: number; readonly status: SdkSessionStatus;
      readonly cancelled: boolean })
  | (RequestEnvelope & { readonly type: 'projection-result'; readonly projection: ProjectionSnapshot })
  | (RequestEnvelope & { readonly type: 'history-result'; readonly data: HistoryData })
  | (RequestEnvelope & { readonly type: 'log-result'; readonly data: HistoryData })
  | (RequestEnvelope & { readonly type: 'prompt-result'; readonly disposition: 'started' | 'queued' | 'handled' })
  | (RequestEnvelope & { readonly type: 'rewind-result'; readonly cancelled: boolean;
      readonly text: string | null })
  | (RequestEnvelope & { readonly type: 'compact-result' })
  | (RequestEnvelope & { readonly type: 'capabilities-result'; readonly capabilities: AgentCapabilities })
  | (RequestEnvelope & { readonly type: 'resources-result'; readonly resources: PiResources })
  | (RequestEnvelope & { readonly type: 'diagnostics-result'; readonly diagnostics: RuntimeDiagnostics })
  | (RequestEnvelope & { readonly type: 'mcp-status-result'; readonly status: McpStatus })
  | (RequestEnvelope & { readonly type: 'mcp-command-result'; readonly status: McpStatus })
  | (RequestEnvelope & { readonly type: 'ack-result' })
  | (RequestEnvelope & { readonly type: 'ui-result' })

export type SdkHostEvent =
  | (HostEnvelope & { readonly type: 'session-state'; readonly seq: number; readonly status: SdkSessionStatus })
  | (HostEnvelope & { readonly type: 'ui-request'; readonly seq: number; readonly bindingId: number;
      readonly payload: Record<string, unknown> })
  | (HostEnvelope & { readonly type: 'projection-batch'; readonly seq: number; readonly bindingId: number;
      readonly batch: ProjectionBatch })
  | (HostEnvelope & { readonly type: 'entry-map'; readonly seq: number; readonly bindingId: number;
      readonly messageId: string; readonly entryId: string })
  | (HostEnvelope & { readonly type: 'ui-cancel'; readonly seq: number; readonly bindingId: number;
      readonly dialogId: string })
  | (RequestEnvelope & { readonly type: 'authorize-target'; readonly bindingId: number | null;
      readonly projectPath: string | null; readonly reference: SdkSessionReference })
  | (RequestEnvelope & { readonly type: 'browser-operation'; readonly seq: number; readonly bindingId: number;
      readonly operation: SdkBrowserOperation })

const FAILURE_CODES: readonly SdkHostFailureCode[] = [
  'SDK_LOAD_FAILED', 'AGENT_DIR_MISMATCH', 'HOST_NOT_READY', 'INVALID_SESSION_TARGET',
  'TRUST_REQUIRED', 'SESSION_NOT_FOUND', 'SESSION_BUSY', 'STALE_SESSION',
  'SESSION_OPERATION_CONFLICT', 'SESSION_CREATE_FAILED', 'SESSION_BIND_FAILED',
  'SESSION_CLOSE_FAILED', 'SESSION_RECOVERY_REQUIRED', 'AUTHORIZATION_FAILED', 'INTERACTION_INVALID'
]

/** 边界只接受对象，随后逐类拒绝未知字段。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
/** 序号与身份只接受安全整数。 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
/** 宿主与绑定身份从 1 开始。 */
function isIdentity(value: unknown): value is number { return isCount(value) && value > 0 }
/** 请求、交互和条目身份保持有界。 */
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('\0')
}
/** Node 端另外复核绝对路径及归属。 */
function isPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32_768 && !value.includes('\0')
}
/** 只接受当前消息声明的字段，不能将未知对象当成扩展参数透传。 */
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}
/** 校验共同宿主身份。 */
function isEnvelope(value: Record<string, unknown>): boolean {
  return value.version === SDK_HOST_PROTOCOL_VERSION && isIdentity(value.hostId)
}
/** 校验请求身份。 */
function isRequest(value: Record<string, unknown>): boolean {
  return isEnvelope(value) && isIdentifier(value.requestId)
}
/** 请求消息的固定公共字段。 */
function requestKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return hasKeys(value, ['version', 'hostId', 'requestId', 'type', ...keys])
}
/** 事件消息的固定公共字段。 */
function eventKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return hasKeys(value, ['version', 'hostId', 'type', 'seq', ...keys])
}
/** 预定义错误分类不携带原始异常。 */
export function isSdkHostFailureCode(value: unknown): value is SdkHostFailureCode {
  return typeof value === 'string' && FAILURE_CODES.some(code => code === value)
}
/** MCP 动作只接受契约内的三种取值。 */
function isMcpCommandActionValue(value: unknown): value is SdkMcpCommandAction {
  return value === 'login' || value === 'logout' || value === 'reconnect'
}
/** 会话引用只表达目标，不表达执行参数。 */
export function isSdkSessionReference(value: unknown): value is SdkSessionReference {
  if (!isRecord(value)) return false
  if (value.kind === 'new') return hasKeys(value, ['kind'])
  if (value.kind === 'id') return isIdentifier(value.sessionId) && hasKeys(value, ['kind', 'sessionId'])
  return value.kind === 'file' && isPath(value.sessionFile) && hasKeys(value, ['kind', 'sessionFile'])
}
/** 新建目标与恢复目标的文件、身份和读取标识必须一致存在。 */
export function isSdkSessionTarget(value: unknown): value is SdkSessionTarget {
  if (!isRecord(value) || !isPath(value.projectPath) || !isPath(value.sessionDir)
    || typeof value.trusted !== 'boolean' || typeof value.genui !== 'boolean') return false
  const targetValid = value.sessionFile === null
    ? value.sessionId === null && value.fileStamp === null
    : isPath(value.sessionFile) && isIdentifier(value.sessionId) && isIdentifier(value.fileStamp)
  return targetValid && hasKeys(value, ['projectPath', 'sessionDir', 'sessionId', 'sessionFile', 'fileStamp', 'trusted', 'genui'])
}
/** 日志目标只接受绝对路径、会话身份、文件戳与已声明的历史查询；不带信任或功能开关，避免被当成绑定目标。 */
export function isSdkLogTarget(value: unknown): value is SdkLogTarget {
  if (!isRecord(value) || !isPath(value.projectPath) || !isPath(value.sessionFile)) return false
  return isIdentifier(value.sessionId) && isIdentifier(value.fileStamp) && isHistoryQuery(value.query)
    && hasKeys(value, ['projectPath', 'sessionId', 'sessionFile', 'fileStamp', 'query'])
}

/** 状态是安全展示副本，不包含模型对象、工具参数、消息或认证记录。 */
export function isSdkSessionStatus(value: unknown): value is SdkSessionStatus {
  if (!isRecord(value)) return false
  return typeof value.phase === 'string' && ['empty', 'preparing', 'bound', 'invalid', 'blocked', 'failed'].includes(value.phase)
    && (value.bindingId === null || isIdentity(value.bindingId))
    && isCount(value.activityVersion)
    && (value.operationId === null || isIdentifier(value.operationId))
    && (value.projectPath === null || isPath(value.projectPath))
    && (value.sessionId === null || isIdentifier(value.sessionId))
    && (value.sessionFile === null || isPath(value.sessionFile))
    && typeof value.isIdle === 'boolean' && typeof value.isCompacting === 'boolean' && isCount(value.pendingMessages)
    && typeof value.isBashRunning === 'boolean' && isCount(value.waitingDialogs)
    && typeof value.needsHostRebuild === 'boolean'
    && (value.lastError === null || isSdkHostFailureCode(value.lastError))
    && (value.modelProvider === null || isIdentifier(value.modelProvider))
    && (value.modelId === null || isIdentifier(value.modelId))
    && isCount(value.messageCount)
    && (value.usage === null || isSessionUsage(value.usage))
    && isOutputRate(value.rate)
    && hasKeys(value, ['phase', 'bindingId', 'activityVersion', 'operationId', 'projectPath',
      'sessionId', 'sessionFile', 'isIdle', 'isCompacting', 'pendingMessages', 'isBashRunning', 'waitingDialogs',
      'needsHostRebuild', 'lastError', 'modelProvider', 'modelId', 'messageCount', 'usage', 'rate'])
}
/** 中断确认只属于一个具体绑定及执行版本。 */
function isConfirmation(value: unknown): value is SdkInterruptConfirmation | null {
  return value === null || (isRecord(value) && isIdentity(value.bindingId)
    && isCount(value.activityVersion) && hasKeys(value, ['bindingId', 'activityVersion']))
}
/** 校验主进程发往宿主的受限请求；控制回应不进入生命周期互斥队列。 */
export function isSdkHostRequest(value: unknown): value is SdkHostRequest {
  if (!isRecord(value) || !isRequest(value)) return false
  switch (value.type) {
    case 'initialize': return isPath(value.agentDir) && requestKeys(value, ['agentDir'])
    case 'shutdown': return requestKeys(value, [])
    case 'session': {
      if (typeof value.action !== 'string' || !['new', 'open', 'reload', 'release'].includes(value.action)
        || !(value.expectedBindingId === null || isIdentity(value.expectedBindingId))
        || !isConfirmation(value.interrupt)) return false
      const validTarget = value.action === 'release' ? value.target === null : isSdkSessionTarget(value.target)
      return validTarget && requestKeys(value, ['action', 'expectedBindingId', 'interrupt', 'target'])
    }
    case 'session-abort': return isIdentity(value.bindingId) && requestKeys(value, ['bindingId'])
    case 'prompt': return isIdentity(value.bindingId) && typeof value.message === 'string'
      && Array.isArray(value.images) && value.images.every(entry =>
        isRecord(entry) && entry.type === 'image' && typeof entry.data === 'string'
        && typeof entry.mimeType === 'string'
        && (entry.annotations === undefined || parseImageAnnotations(entry.annotations) !== null)
        && hasKeys(entry, ['type', 'data', 'mimeType', 'annotations']))
      && requestKeys(value, ['bindingId', 'message', 'images'])
    case 'set-model': return isIdentity(value.bindingId) && isIdentifier(value.provider)
      && isIdentifier(value.modelId) && requestKeys(value, ['bindingId', 'provider', 'modelId'])
    case 'rewind': return isIdentity(value.bindingId) && isIdentifier(value.messageId)
      && requestKeys(value, ['bindingId', 'messageId'])
    case 'compact': return isIdentity(value.bindingId) && (value.instructions === null
      || (typeof value.instructions === 'string' && value.instructions.length <= COMPACT_INSTRUCTIONS_MAX_CHARS))
      && requestKeys(value, ['bindingId', 'instructions'])
    case 'capabilities': return isIdentity(value.bindingId) && requestKeys(value, ['bindingId'])
    case 'resources': return isIdentity(value.bindingId) && requestKeys(value, ['bindingId'])
    case 'diagnostics': return isIdentity(value.bindingId) && requestKeys(value, ['bindingId'])
    case 'mcp-status': return isIdentity(value.bindingId) && requestKeys(value, ['bindingId'])
    case 'mcp-command': return isIdentity(value.bindingId) && isMcpCommandActionValue(value.action)
      && isIdentifier(value.serverName) && requestKeys(value, ['bindingId', 'action', 'serverName'])
    case 'projection-snapshot': return isIdentity(value.bindingId) && requestKeys(value, ['bindingId'])
    case 'history': return isIdentity(value.bindingId) && isIdentifier(value.sessionId) && isHistoryQuery(value.query)
      && requestKeys(value, ['bindingId', 'sessionId', 'query'])
    case 'projection-ack': return isIdentity(value.bindingId) && isCount(value.seq)
      && requestKeys(value, ['bindingId', 'seq'])
    case 'session-log': return isSdkLogTarget(value.target) && requestKeys(value, ['target'])
    case 'ui-response': return isIdentity(value.bindingId) && isIdentifier(value.dialogId)
      && isExtensionDialogResponseInput(value.response) && requestKeys(value, ['bindingId', 'dialogId', 'response'])
    case 'authorization-result': return (value.bindingId === null || isIdentity(value.bindingId))
      && ((isSdkSessionTarget(value.target) && value.error === null && isIdentity(value.generation))
        || (value.target === null && isSdkHostFailureCode(value.error) && value.generation === null))
      && requestKeys(value, ['bindingId', 'target', 'error', 'generation'])
    case 'browser-operation-result': return isIdentity(value.bindingId)
      && isSdkBrowserOperationResult(value.result) && requestKeys(value, ['bindingId', 'result'])
    default: return false
  }
}
/** 校验宿主的完成结果；生命周期失败仍另外通过状态事件报告实际对象是否有效。 */
export function isSdkHostFrame(value: unknown): value is SdkHostFrame {
  if (!isRecord(value) || !isRequest(value)) return false
  switch (value.type) {
    case 'ready': return isPath(value.agentDir) && isIdentifier(value.sdkVersion)
      && requestKeys(value, ['agentDir', 'sdkVersion'])
    case 'closed':
    case 'ack-result':
    case 'compact-result':
    case 'ui-result': return requestKeys(value, [])
    case 'failed': return isSdkHostFailureCode(value.code) && requestKeys(value, ['code'])
    case 'capabilities-result': return isCapabilitiesResult({ ok: true, data: value.capabilities })
      && requestKeys(value, ['capabilities'])
    case 'resources-result': return isResourcesResult({ ok: true, data: value.resources })
      && requestKeys(value, ['resources'])
    case 'diagnostics-result': return isRuntimeDiagnosticsResult({ ok: true, data: value.diagnostics })
      && requestKeys(value, ['diagnostics'])
    case 'mcp-status-result': return isMcpStatusResult({ ok: true, data: value.status })
      && requestKeys(value, ['status'])
    case 'mcp-command-result': return isMcpCommandResult({ ok: true, data: value.status })
      && requestKeys(value, ['status'])
    case 'rewind-result': return typeof value.cancelled === 'boolean'
      && (value.text === null || typeof value.text === 'string')
      && requestKeys(value, ['cancelled', 'text'])
    case 'prompt-result': return ['started', 'queued', 'handled'].includes(String(value.disposition))
      && requestKeys(value, ['disposition'])
    case 'history-result': return isHistoryData(value.data) && requestKeys(value, ['data'])
    case 'log-result': return isHistoryData(value.data) && requestKeys(value, ['data'])
    case 'projection-result': return isProjectionResult({ ok: true, data: value.projection })
      && requestKeys(value, ['projection'])
    case 'session-result': return isCount(value.seq) && isSdkSessionStatus(value.status) && typeof value.cancelled === 'boolean'
      && requestKeys(value, ['seq', 'status', 'cancelled'])
    default: return false
  }
}
/** 校验宿主状态、交互和反向授权请求，不接受原始 SDK 事件。 */
export function isSdkHostEvent(value: unknown): value is SdkHostEvent {
  if (!isRecord(value) || !isEnvelope(value)) return false
  if (value.type === 'authorize-target') {
    return isRequest(value) && (value.bindingId === null || isIdentity(value.bindingId))
      && (value.projectPath === null || isPath(value.projectPath)) && isSdkSessionReference(value.reference)
      && requestKeys(value, ['bindingId', 'projectPath', 'reference'])
  }
  if (value.type === 'browser-operation') {
    return isRequest(value) && isIdentity(value.seq) && isIdentity(value.bindingId)
      && isSdkBrowserOperation(value.operation) && requestKeys(value, ['seq', 'bindingId', 'operation'])
  }
  if (!isIdentity(value.seq)) return false
  if (value.type === 'session-state') return isSdkSessionStatus(value.status) && eventKeys(value, ['status'])
  if (value.type === 'entry-map') {
    return isIdentity(value.bindingId) && isIdentifier(value.messageId) && isIdentifier(value.entryId)
      && eventKeys(value, ['bindingId', 'messageId', 'entryId'])
  }
  if (value.type === 'projection-batch') {
    return isIdentity(value.bindingId) && isProjectionBatch(value.batch)
      && value.batch.runtimeId === value.bindingId && eventKeys(value, ['bindingId', 'batch'])
  }
  if (value.type === 'ui-cancel') return isIdentity(value.bindingId) && isIdentifier(value.dialogId)
    && eventKeys(value, ['bindingId', 'dialogId'])
  return value.type === 'ui-request' && isIdentity(value.bindingId) && isRecord(value.payload)
    && projectExtensionUiRequest(value.payload) !== null && eventKeys(value, ['bindingId', 'payload'])
}

/** 浏览器操作载荷校验。 */
export function isSdkBrowserOperation(value: unknown): value is SdkBrowserOperation {
  if (!isRecord(value)) return false
  if (value.kind === 'snapshot' || value.kind === 'get-content') return hasKeys(value, ['kind'])
  if (value.kind === 'navigate') return typeof value.url === 'string' && value.url.length <= 4096 && hasKeys(value, ['kind', 'url'])
  if (value.kind === 'click') return isIdentity(value.refId) && hasKeys(value, ['kind', 'refId'])
  if (value.kind === 'fill') return isIdentity(value.refId) && typeof value.text === 'string' && hasKeys(value, ['kind', 'refId', 'text'])
  if (value.kind === 'press') return typeof value.key === 'string' && value.key.length <= 64 && hasKeys(value, ['kind', 'key'])
  if (value.kind === 'scroll') return (value.deltaX === undefined || typeof value.deltaX === 'number')
    && (value.deltaY === undefined || typeof value.deltaY === 'number') && hasKeys(value, ['kind', 'deltaX', 'deltaY'])
  return false
}

/** 浏览器操作结果校验。 */
export function isSdkBrowserOperationResult(value: unknown): value is SdkBrowserOperationResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return hasKeys(value, ['ok', 'data'])
  return value.ok === false && typeof value.error === 'string'
    && (value.notBound === undefined || typeof value.notBound === 'boolean')
    && (value.paused === undefined || typeof value.paused === 'boolean')
    && hasKeys(value, ['ok', 'error', 'notBound', 'paused'])
}
