/** 记忆设置 IPC：校验调用者与参数，转发给唯一所有者；不提供路径、命令或批准参数。 */
import type { IpcMainInvokeEvent } from 'electron'
import {
  MEMORY_ENABLED_CHANNEL,
  MEMORY_INITIALIZE_CHANNEL,
  MEMORY_STATUS_CHANNEL,
  isMemoryInitializeRequest,
  isMemoryPreference
} from '../../shared/memory-api'
import type { MemoryResult } from '../../shared/memory-api'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import { memoryManager } from '../services'

export function registerMemoryHandlers(pageUrl: string): void {
  handle(MEMORY_STATUS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<MemoryResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '记忆状态读取不接受参数。' } }
      }
      return memoryManager.snapshot()
    })

  handle(MEMORY_ENABLED_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<MemoryResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isMemoryPreference(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '记忆开关只接受一个布尔值。' } }
      }
      return memoryManager.setEnabled(args[0])
    })

  handle(MEMORY_INITIALIZE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<MemoryResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isMemoryInitializeRequest(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '记忆库创建只接受一个 IANA 时区。' } }
      }
      return memoryManager.initialize(args[0])
    })
}
