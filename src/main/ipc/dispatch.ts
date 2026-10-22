/** IPC 的公共分发与载荷边界：统一注册包装（处理器抛错留 stderr 日志，但仍原样抛给调用方），以及有界标识与 MCP 服务器名校验。各业务能力从此取同一套校验，不各自复制。 */

import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { mainWindow } from '../window'

/**
 * 注册 IPC 处理器，并把处理器内部的异常记到主进程 stderr。
 *
 * Electron 只把拒绝传给调用方，主进程默认不留任何记录，页面又只看到一句通用文案，
 * 这类故障就无法从终端或界面定位。异常仍然原样抛出，不改变调用方看到的契约。
 */
export function handle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    try {
      return await listener(event, ...args)
    } catch (error) {
      console.error(`[ipc] ${channel} 处理器抛出异常：`, error)
      throw error
    }
  })
}

/** 只接受非空且长度受控的标识字符串；空字符串与超长都按参数拒绝。 */
export function isBoundedIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLength
}

/** MCP 服务器名长度上限；字符集限制保证它只能作为固定命令的一个普通参数。 */
export const MCP_SERVER_NAME_MAX_CHARS = 64

/** 服务器名只接受字母、数字、点、下划线与连字符；其他字符一律拒绝。 */
export function isMcpServerName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MCP_SERVER_NAME_MAX_CHARS
    && /^[A-Za-z0-9._-]+$/.test(value)
}

/**
 * 调用者校验：只接受唯一可信窗口主 frame 且 URL 与当前页面一致的请求。
 * 窗口引用来自 window.ts，frame 在导航或销毁过程中可能失效，任何异常都按不可信处理。
 */
export function isTrustedCaller(event: IpcMainInvokeEvent, pageUrl: string): boolean {
  const window = mainWindow
  try {
    if (window === null || window.isDestroyed() || event.sender.isDestroyed()) {
      return false
    }
    const contents = window.webContents
    const frame = event.senderFrame
    return event.sender === contents
      && frame !== null
      && frame === contents.mainFrame
      && frame.url === pageUrl
  } catch {
    // frame 在导航或销毁过程中可能失效，不能因此放宽调用者校验。
    return false
  }
}
