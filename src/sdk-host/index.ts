/** SDK 宿主入口：初始化不建立会话，内部生命周期与解除等待控制分开分派，不提供页面提交入口；日志读取与投影检查点在同一进程内共享，绑定可直接复用查看时解析出的首页。 */
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { SDK_HOST_PROTOCOL_VERSION, isSdkHostRequest } from './protocol'
import type {
  SdkBrowserOperation,
  SdkBrowserOperationResult,
  SdkHostEvent,
  SdkHostFailureCode,
  SdkHostFrame,
  SdkHostRequest,
  SdkSessionAuthorization,
  SdkSessionReference
} from './protocol'
import { loadSdkModule } from '../shared-process/runtime'
import type { SdkModule } from '../shared-process/runtime'
import { SdkSessionFailure, SdkSessionRuntime } from './session-runtime'
import { readSessionLog } from './log-reader'
import { ProjectionCheckpoints } from './projection/checkpoint'

const parentPort = process.parentPort
const INITIALIZE_WAIT_MS = 30_000
const AUTHORIZATION_WAIT_MS = 15_000
const BROWSER_OPERATION_WAIT_MS = 30_000
let hostId: number | null = null
let initializing = false
let ready = false
let closing = false
let seq = 0
let sessions: SdkSessionRuntime | null = null
/** 已加载的官方 SDK 模块：预览只需要它的解析与内存会话管理，不建立 AgentSession。 */
let sdkModule: SdkModule | null = null
/** 进程内共享检查点：首页由日志读取提供，稳定活动由运行时累计，两类状态分别校验和复用。 */
const checkpoints = new ProjectionCheckpoints()
let shutdownTask: Promise<void> | null = null
const authorizations = new Map<string, {
  readonly bindingId: number | null
  readonly timer: ReturnType<typeof setTimeout>
  readonly resolve: (authorization: SdkSessionAuthorization) => void
  readonly reject: (error: SdkSessionFailure) => void
}>()
const browserOperations = new Map<string, {
  readonly bindingId: number
  readonly timer: ReturnType<typeof setTimeout>
  readonly resolve: (result: SdkBrowserOperationResult) => void
}>()

/** 通信只发送声明的投影，原始 SDK 异常与环境变量不进入通道。 */
function send(frame: SdkHostFrame | SdkHostEvent): void { parentPort?.postMessage(frame) }
/** 错误只携带预定义分类。 */
function fail(request: SdkHostRequest, code: SdkHostFailureCode): void {
  send({ version: SDK_HOST_PROTOCOL_VERSION, hostId: request.hostId, requestId: request.requestId, type: 'failed', code })
}
/** 已固定目录只复核，不寻找替代 SDK 或另一份配置。 */
function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 反向授权只是只读目标准备；回应直接解除 Promise，不进入会话操作队列。
 * 绑定代际只能来自主进程，因此与目标一起返回，宿主不另行编号。
 */
function authorize(reference: SdkSessionReference, bindingId: number | null, projectPath: string | null): Promise<SdkSessionAuthorization> {
  const currentHostId = hostId
  if (currentHostId === null || closing || authorizations.size >= 8) return Promise.reject(new SdkSessionFailure('AUTHORIZATION_FAILED'))
  const requestId = randomUUID()
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      authorizations.delete(requestId)
      reject(new SdkSessionFailure('AUTHORIZATION_FAILED'))
    }, AUTHORIZATION_WAIT_MS)
    authorizations.set(requestId, { bindingId, timer, resolve: resolvePromise, reject })
    send({ version: SDK_HOST_PROTOCOL_VERSION, hostId: currentHostId, requestId,
      type: 'authorize-target', bindingId, projectPath, reference })
  })
}

/** 失效绑定的授权等待不能在新绑定创建后继续生效。 */
function cancelAuthorizations(bindingId?: number | null): void {
  for (const [id, pending] of authorizations) {
    if (bindingId !== undefined && pending.bindingId !== bindingId) continue
    clearTimeout(pending.timer)
    authorizations.delete(id)
    pending.reject(new SdkSessionFailure('STALE_SESSION'))
  }
  for (const [id, pending] of browserOperations) {
    if (bindingId !== undefined && bindingId !== null && pending.bindingId !== bindingId) continue
    clearTimeout(pending.timer)
    browserOperations.delete(id)
    pending.resolve({ ok: false, error: '会话已重置或换代，浏览器操作已取消。' })
  }
}

/** 向主进程派发浏览器操作并等待结果。 */
function dispatchBrowserOperation(bindingId: number, operation: SdkBrowserOperation): Promise<SdkBrowserOperationResult> {
  const currentHostId = hostId
  if (currentHostId === null || closing) {
    return Promise.resolve({ ok: false, error: '宿主未就绪或正在关闭。' })
  }
  const requestId = randomUUID()
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      browserOperations.delete(requestId)
      resolvePromise({ ok: false, error: '浏览器操作等待超时 (30s)。' })
    }, BROWSER_OPERATION_WAIT_MS)
    browserOperations.set(requestId, { bindingId, timer, resolve: resolvePromise })
    send({
      version: SDK_HOST_PROTOCOL_VERSION,
      hostId: currentHostId,
      type: 'browser-operation',
      seq: ++seq,
      requestId,
      bindingId,
      operation
    })
  })
}

/** 官方包按需加载；只有独立的后续生命周期请求才会建立 services 与 Agent。 */
async function initialize(request: Extract<SdkHostRequest, { type: 'initialize' }>): Promise<void> {
  if (closing || initializing || hostId !== null) { fail(request, 'HOST_NOT_READY'); return }
  hostId = request.hostId
  initializing = true
  clearTimeout(initializeTimer)
  try {
    if (!isAbsolute(request.agentDir) || process.env.PI_CODING_AGENT_DIR !== request.agentDir) {
      fail(request, 'AGENT_DIR_MISMATCH'); return
    }
    const sdk = await loadSdkModule()
    if (closing) return
    sdkModule = sdk
    const actualAgentDir = sdk.getAgentDir()
    if (!isAbsolute(actualAgentDir) || !samePath(actualAgentDir, request.agentDir)) {
      fail(request, 'AGENT_DIR_MISMATCH'); return
    }
    sessions = new SdkSessionRuntime(sdk, {
      hostId: request.hostId, agentDir: actualAgentDir, authorize, checkpoints, browserOperator: dispatchBrowserOperation,
      onState: status => {
        if (status.phase === 'invalid') cancelAuthorizations(status.bindingId)
        send({ version: SDK_HOST_PROTOCOL_VERSION, hostId: request.hostId, type: 'session-state', seq: ++seq, status })
      },
      onUiRequest: (bindingId, payload) => send({ version: SDK_HOST_PROTOCOL_VERSION,
        hostId: request.hostId, type: 'ui-request', seq: ++seq, bindingId, payload }),
      onUiCancel: (bindingId, dialogId) => send({ version: SDK_HOST_PROTOCOL_VERSION,
        hostId: request.hostId, type: 'ui-cancel', seq: ++seq, bindingId, dialogId }),
      onProjectionBatch: (bindingId, batch) => send({ version: SDK_HOST_PROTOCOL_VERSION,
        hostId: request.hostId, type: 'projection-batch', seq: ++seq, bindingId, batch }),
      onEntryMap: (bindingId, messageId, entryId) => send({ version: SDK_HOST_PROTOCOL_VERSION,
        hostId: request.hostId, type: 'entry-map', seq: ++seq, bindingId, messageId, entryId })
    })
    ready = true
    send({ version: SDK_HOST_PROTOCOL_VERSION, hostId: request.hostId, requestId: request.requestId,
      type: 'ready', agentDir: actualAgentDir, sdkVersion: sdk.VERSION })
    send({ version: SDK_HOST_PROTOCOL_VERSION, hostId: request.hostId, type: 'session-state', seq: ++seq,
      status: sessions.getStatus() })
  } catch { if (!closing) fail(request, 'SDK_LOAD_FAILED') } finally { initializing = false }
}

/** 先收敛实际会话，再确认关闭；超时强制结束属于父进程的监督责任。 */
async function shutdown(request: Extract<SdkHostRequest, { type: 'shutdown' }>): Promise<void> {
  closing = true
  ready = false
  clearTimeout(initializeTimer)
  cancelAuthorizations()
  shutdownTask ??= sessions?.shutdown() ?? Promise.resolve()
  try {
    await shutdownTask
    send({ version: SDK_HOST_PROTOCOL_VERSION, hostId: request.hostId, requestId: request.requestId, type: 'closed' })
    setImmediate(() => process.exit(0))
  } catch {
    fail(request, 'SESSION_CLOSE_FAILED')
    setImmediate(() => process.exit(1))
  }
}

/** 控制请求不等待生命周期完成，否则授权、审批及中止都可能自锁。 */
async function dispatch(request: SdkHostRequest): Promise<void> {
  if (request.type === 'initialize') { await initialize(request); return }
  if (request.hostId !== hostId) { fail(request, 'HOST_NOT_READY'); return }
  if (request.type === 'shutdown') { await shutdown(request); return }
  if (request.type === 'authorization-result') {
    const pending = authorizations.get(request.requestId)
    if (pending === undefined || pending.bindingId !== request.bindingId) return
    authorizations.delete(request.requestId)
    clearTimeout(pending.timer)
    if (request.target !== null && request.error === null && request.generation !== null) {
      pending.resolve({ target: request.target, generation: request.generation })
    } else {
      pending.reject(new SdkSessionFailure(request.error ?? 'AUTHORIZATION_FAILED'))
    }
    return
  }
  if (request.type === 'browser-operation-result') {
    const pending = browserOperations.get(request.requestId)
    if (pending === undefined || pending.bindingId !== request.bindingId) return
    browserOperations.delete(request.requestId)
    clearTimeout(pending.timer)
    pending.resolve(request.result)
    return
  }
  const runtime = sessions
  if (runtime === null || (!ready && request.type !== 'ui-response' && request.type !== 'session-abort'
    && request.type !== 'projection-ack')) {
    fail(request, 'HOST_NOT_READY'); return
  }
  const envelope = { version: SDK_HOST_PROTOCOL_VERSION, hostId: request.hostId, requestId: request.requestId } as const
  switch (request.type) {
    case 'session': {
      if (closing) { fail(request, 'HOST_NOT_READY'); return }
      const result = await runtime.execute(request)
      send({ ...envelope, type: 'session-result', seq, status: runtime.getStatus(), cancelled: result.cancelled })
      return
    }
    case 'session-abort':
      await runtime.abort(request.bindingId)
      send({ ...envelope, type: 'session-result', seq, status: runtime.getStatus(), cancelled: false })
      return
    case 'prompt':
      send({ ...envelope, type: 'prompt-result',
        disposition: await runtime.submit(request.bindingId, request.message, request.images) })
      return
    case 'set-model':
      await runtime.setModel(request.bindingId, request.provider, request.modelId)
      send({ ...envelope, type: 'session-result', seq, status: runtime.getStatus(), cancelled: false })
      return
    case 'rewind': {
      const result = await runtime.rewind(request.bindingId, request.messageId)
      send({ ...envelope, type: 'rewind-result', ...result })
      return
    }
    case 'compact':
      await runtime.compact(request.bindingId, request.instructions)
      send({ ...envelope, type: 'compact-result' })
      return
    case 'capabilities':
      send({ ...envelope, type: 'capabilities-result', capabilities: runtime.capabilities(request.bindingId) })
      return
    case 'resources':
      send({ ...envelope, type: 'resources-result', resources: runtime.readResources(request.bindingId) })
      return
    case 'diagnostics':
      send({ ...envelope, type: 'diagnostics-result', diagnostics: runtime.readDiagnostics(request.bindingId) })
      return
    case 'mcp-status':
      send({ ...envelope, type: 'mcp-status-result', status: await runtime.readMcpStatus(request.bindingId) })
      return
    case 'mcp-command':
      send({ ...envelope, type: 'mcp-command-result',
        status: await runtime.runMcpCommand(request.bindingId, request.action, request.serverName) })
      return
    case 'history':
      send({ ...envelope, type: 'history-result', data: runtime.readHistory(request.bindingId, request.sessionId, request.query) })
      return
    case 'projection-snapshot': {
      const projection = runtime.getProjection(request.bindingId)
      if (projection === null) { fail(request, 'STALE_SESSION'); return }
      send({ ...envelope, type: 'projection-result', projection })
      return
    }
    case 'projection-ack':
      runtime.ackProjection(request.bindingId, request.seq)
      send({ ...envelope, type: 'ack-result' })
      return
    case 'session-log': {
      const sdk = sdkModule
      if (sdk === null) { fail(request, 'HOST_NOT_READY'); return }
      send({ ...envelope, type: 'log-result', data: await readSessionLog(sdk, request.target, checkpoints) })
      return
    }
    case 'ui-response':
      if (!runtime.respond(request.bindingId, request.dialogId, request.response)) {
        fail(request, 'INTERACTION_INVALID'); return
      }
      send({ ...envelope, type: 'ui-result' })
      return
  }
}

/** 消息先校验；异步分派只捕获安全分类，不把异常详情传播给页面。 */
function handleMessage(value: unknown): void {
  if (!isSdkHostRequest(value)) { process.exit(1); return }
  void dispatch(value).catch(error => fail(value,
    error instanceof SdkSessionFailure ? error.code : 'SESSION_CREATE_FAILED'))
}
const initializeTimer = setTimeout(() => process.exit(1), INITIALIZE_WAIT_MS)
if (parentPort === null || parentPort === undefined) { clearTimeout(initializeTimer); process.exit(1) }
else parentPort.on('message', event => handleMessage(event.data))
// 未捕获故障让监督收敛；不输出可能包含配置或凭据的原始异常。
process.on('uncaughtException', () => process.exit(1))
process.on('unhandledRejection', () => process.exit(1))
