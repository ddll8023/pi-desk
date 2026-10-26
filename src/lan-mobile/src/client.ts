/** 手机网络入口：同源访问局域网 HTTP 服务，扫码自动登记与 Cookie 认证；写请求保留原身份且不自动重发。 */
import {
  isLanConnectionInfo, isLanEnvelope, isLanOrigin, isLanPairResult, isLanRequest, isLanSessionTarget, LAN_REMOTE_PROTOCOL_VERSION
} from '../../shared/lan-remote-api'
import type { LanConnectionInfo, LanOperation, LanPairResult, LanRequest, LanSessionTarget } from '../../shared/lan-remote-api'

export class LanClientError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0, readonly uncertain = false) { super(message) }
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
export function requiresPairing(error: unknown): boolean {
  return error instanceof LanClientError && (error.status === 401 || error.code === 'UNAUTHENTICATED')
}
/** 网络中断或宿主未确认终态时，写请求必须保留原身份；创建响应中的首条消息也使用同一口径。 */
export function isUncertainWriteFailure(error: unknown): error is LanClientError {
  return error instanceof LanClientError && (error.status === 0 || error.status >= 500
    || ['DEVICE_CHANGED', 'SERVER_CHANGED', 'INVALID_RESPONSE', 'PAYLOAD_TOO_LARGE', 'RUNTIME_TIMEOUT', 'RUNTIME_EXITED', 'RUNTIME_PROTOCOL_ERROR'].includes(error.code))
}
function checkVersion(version: number): void {
  if (version !== LAN_REMOTE_PROTOCOL_VERSION) throw new LanClientError('PROTOCOL_MISMATCH', '手机页面与桌面协议不一致，请刷新页面；仍不一致时更新桌面应用。')
}
export function isWrite(command: LanOperation): boolean {
  return command.operation === 'open' || command.operation === 'create' || command.operation === 'prompt'
    || command.operation === 'abort' || command.operation === 'respond'
}

export class MobileClient {
  private serverId = ''
  private deviceId = ''
  async connect(signal?: AbortSignal): Promise<LanConnectionInfo> {
    const result = await this.fetchJson('/api/state', undefined, isLanConnectionInfo, signal)
    checkVersion(result.protocolVersion)
    this.serverId = result.serverId
    this.deviceId = result.deviceId
    return result
  }
  async pair(code: string, signal?: AbortSignal): Promise<LanPairResult> {
    const result = await this.fetchJson('/api/pair', { code }, isLanPairResult, signal)
    checkVersion(result.protocolVersion)
    this.serverId = result.serverId
    this.deviceId = result.device.id
    return result
  }
  prepare(command: LanOperation): LanRequest {
    if (!this.serverId) throw new LanClientError('NOT_CONNECTED', '尚未连接电脑，请先重新连接。')
    // 网络载荷也从当前编辑状态分离，之后修改草稿不能改变待重试请求的正文。
    // getRandomValues 可用于局域网 HTTP 页面，不依赖仅安全上下文可用的 randomUUID。
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
    const request: unknown = JSON.parse(JSON.stringify({ deviceId: this.deviceId, serverId: this.serverId, requestId, command }))
    if (!isLanRequest(request)) throw new LanClientError('INVALID_REQUEST', '请求内容或目标身份无效。')
    return request
  }
  async request<T>(request: LanRequest, accepts: (data: unknown) => data is T, signal?: AbortSignal): Promise<T> {
    // 重新配对会改变服务端去重的设备键，旧请求不能携新身份再次执行。
    if (isWrite(request.command) && request.deviceId !== this.deviceId) {
      throw new LanClientError('DEVICE_CHANGED', '设备配对身份已变化，请核对原会话结果后解除保护。', 409, true)
    }
    try { return await this.fetchJson('/api/request', request, accepts, signal) } catch (error) {
      if (isWrite(request.command) && isUncertainWriteFailure(error)) {
        throw new LanClientError(error.code, `${error.message} 操作结果尚不能确认；不会自动重新发送。`, error.status, true)
      }
      throw error
    }
  }
  stream(ref: LanSessionTarget): EventSource {
    if (!isLanSessionTarget(ref)) throw new LanClientError('INVALID_REQUEST', '会话订阅身份无效。')
    const query = new URLSearchParams({ projectId: ref.projectId, sessionId: ref.sessionId,
      runId: String(ref.target.runId), runtimeId: String(ref.target.runtimeId) })
    return new EventSource(`/api/events?${query}`, { withCredentials: true })
  }

  private async fetchJson<T>(path: string, body: unknown, accepts: (data: unknown) => data is T, signal?: AbortSignal): Promise<T> {
    if (!isLanOrigin(location.origin)) throw new LanClientError('LAN_ADDRESS_REQUIRED', '请使用电脑二维码中的局域网地址连接。')
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(abort, 30_000)
    try {
      const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin', mode: 'same-origin', referrerPolicy: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
      const text = await response.text()
      if (text.length > 16 * 1024 * 1024) throw new LanClientError('PAYLOAD_TOO_LARGE', '响应过大，请在桌面查看。', response.status)
      let value: unknown
      try { value = JSON.parse(text) } catch { throw new LanClientError('INVALID_RESPONSE', '电脑返回了无法识别的响应，请重新连接。', response.status) }
      if (!isLanEnvelope(value, accepts)) throw new LanClientError('INVALID_RESPONSE', '电脑响应不符合当前协议，请刷新页面。', response.status)
      if (!value.ok) throw new LanClientError(value.error.code, value.error.message, response.status)
      if (!response.ok) throw new LanClientError('HTTP_ERROR', `电脑请求失败（${response.status}）。`, response.status)
      return value.data
    } catch (error) {
      if (error instanceof LanClientError) throw error
      if (controller.signal.aborted) throw new LanClientError('INTERRUPTED', signal?.aborted ? '页面操作已取消。' : '连接超时，请确认电脑上的手机访问已开启，手机和电脑连接同一网络。')
      throw new LanClientError('NETWORK_ERROR', `无法连接电脑：${errorMessage(error)}`)
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
}
