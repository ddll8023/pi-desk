/** 手机访问设置的受限桌面调用；显式重建普通载荷，桥接失败保留原始原因，不持有证书或设备凭证。 */
import type { LanControlData, LanControlRequest, LanRemoteState, LanResult } from '../../../../shared/lan-remote-api'

function plain(request: LanControlRequest): LanControlRequest {
  switch (request.action) {
    case 'start': return { action: 'start', address: request.address, port: request.port }
    case 'pair': return { action: 'pair', projectIds: [...request.projectIds] }
    case 'grant': return { action: 'grant', deviceId: request.deviceId, projectIds: [...request.projectIds] }
    case 'revoke': return { action: 'revoke', deviceId: request.deviceId }
    default: return { action: request.action }
  }
}
export async function controlLanRemote(request: LanControlRequest): Promise<LanResult<LanControlData>> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.controlLanRemote !== 'function') {
    return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开设置。' } }
  }
  try { return await bridge.controlLanRemote(plain(request)) } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: { code: 'BRIDGE_CALL_FAILED', message: `局域网桥接调用失败：${detail}` } }
  }
}
export function subscribeLanRemote(listener: (state: LanRemoteState) => void): () => void {
  try { return window.desktop?.onLanRemoteStateChanged(listener) ?? (() => {}) } catch { return () => {} }
}
