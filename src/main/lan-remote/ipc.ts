/** 可信桌面的手机访问控制入口：校验调用者与 HTTPS 代理配置，只分派固定控制操作。 */
import { LAN_REMOTE_CONTROL_CHANNEL, isLanControlRequest } from '../../shared/lan-remote-api'
import type { LanControlData, LanResult } from '../../shared/lan-remote-api'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import { lanRemote } from '../services'
import { LanAccessError } from './device-manager'

export function registerLanRemoteHandlers(pageUrl: string): void {
  handle(LAN_REMOTE_CONTROL_CHANNEL, async (event, ...args: unknown[]): Promise<LanResult<LanControlData>> => {
    if (!isTrustedCaller(event, pageUrl)) return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面控制局域网访问。' } }
    if (args.length !== 1 || !isLanControlRequest(args[0])) return { ok: false, error: { code: 'INVALID_REQUEST', message: '局域网控制参数无效。' } }
    const request = args[0]
    try {
      return { ok: true, data: await lanRemote.control(request) }
    } catch (error) {
      console.error('[lan-remote] 桌面控制失败：', error)
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, error: { code: error instanceof LanAccessError ? error.code : 'INTERNAL_ERROR', message: `局域网操作失败：${detail}` } }
    }
  })
}
