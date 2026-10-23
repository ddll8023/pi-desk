/**
 * 文件预览的外部链接打开入口：渲染端唯一能要求主进程「用系统浏览器打开地址」的封装。
 *
 * 协议白名单、长度上限与凭据检查都在主进程；这里只负责把桥接缺失、调用异常与拒绝原因
 * 收敛成可展示的错误，让组件不必区分底层失败类型。
 */
import type { OpenExternalUrlResult } from '../../../../shared/desktop-api'

/** 请求主进程用系统浏览器打开一个 http(s) 地址。 */
export async function openExternalUrl(url: string): Promise<OpenExternalUrlResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.openExternalUrl !== 'function') {
    return {
      ok: false,
      error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，无法打开外部链接。' }
    }
  }
  try {
    return await bridge.openExternalUrl({ url })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: { code: 'BRIDGE_CALL_FAILED', message: `打开外部链接失败，可以重试：${detail}` }
    }
  }
}
