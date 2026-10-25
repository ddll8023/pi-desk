/** 局域网控制的沙箱桥接：固定通道、逐字段重建请求和结果校验，不暴露网络服务或证书私钥。 */
import { ipcRenderer } from 'electron'
import {
  LAN_REMOTE_CONTROL_CHANNEL, LAN_REMOTE_STATE_EVENT, isLanControlRequest, isLanControlResult, isLanRemoteState
} from '../shared/lan-remote-api'
import type { LanControlRequest, LanRemoteApi } from '../shared/lan-remote-api'

function plainRequest(request: LanControlRequest): LanControlRequest {
  switch (request.action) {
    case 'start': return { action: 'start', address: request.address, port: request.port }
    case 'pair': return { action: 'pair', projectIds: [...request.projectIds] }
    case 'grant': return { action: 'grant', deviceId: request.deviceId, projectIds: [...request.projectIds] }
    case 'revoke': return { action: 'revoke', deviceId: request.deviceId }
    default: return { action: request.action }
  }
}
export const lanRemoteApi: LanRemoteApi = {
  async controlLanRemote(request) {
    if (!isLanControlRequest(request)) return { ok: false, error: { code: 'INVALID_REQUEST', message: '局域网控制参数无效。' } }
    const response: unknown = await ipcRenderer.invoke(LAN_REMOTE_CONTROL_CHANNEL, plainRequest(request))
    return isLanControlResult(response) ? response : { ok: false, error: { code: 'INVALID_RESPONSE', message: '桌面接口返回了无法识别的局域网状态。' } }
  },
  onLanRemoteStateChanged(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      if (isLanRemoteState(value)) listener(value)
    }
    ipcRenderer.on(LAN_REMOTE_STATE_EVENT, receive)
    return () => ipcRenderer.removeListener(LAN_REMOTE_STATE_EVENT, receive)
  }
}
