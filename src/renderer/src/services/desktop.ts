/** 作为渲染端唯一桌面调用入口，将桥接缺失与通信异常转换为安全的展示结果。 */
import type { AppInfoResult } from '../../../shared/desktop-api'

export async function getAppInfo(): Promise<AppInfoResult> {
  try {
    const bridge = window.desktop
    if (!bridge || typeof bridge.getAppInfo !== 'function') {
      return {
        ok: false,
        error: {
          code: 'BRIDGE_UNAVAILABLE',
          message: '桌面桥接不可用，请通过 Electron 打开此页面。'
        }
      }
    }
    return await bridge.getAppInfo()
  } catch {
    return {
      ok: false,
      error: { code: 'BRIDGE_CALL_FAILED', message: '桌面桥接调用失败，可以重试连接。' }
    }
  }
}
