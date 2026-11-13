/** 记忆设置 IPC：校验调用者与参数，转发给唯一所有者；不提供路径、命令或批准参数。 */
import type { IpcMainInvokeEvent } from 'electron'
import {
  MEMORY_ENABLED_CHANNEL,
  MEMORY_INITIALIZE_CHANNEL,
  MEMORY_PROFILE_READ_CHANNEL,
  MEMORY_READ_CHANNEL,
  MEMORY_STATUS_CHANNEL,
  isMemoryInitializeRequest,
  isMemoryPreference,
  isMemoryProfileReadRequest,
  isMemoryReadRequest
} from '../../shared/memory-api'
import type { MemoryProfileReadResult, MemoryReadResult, MemoryResult } from '../../shared/memory-api'
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

  /** 正文读取只接受真实记录 ID：不提供关键词、路径或数量扫描入口。 */
  handle(MEMORY_READ_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<MemoryReadResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isMemoryReadRequest(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '记录读取只接受 1 至 50 个真实记录 ID。' } }
      }
      return memoryManager.readRecords(args[0].ids)
    })

  /** 画像读取只接受固定领域枚举：不提供按 ID、关键词或数量的扫描入口。 */
  handle(MEMORY_PROFILE_READ_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<MemoryProfileReadResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isMemoryProfileReadRequest(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '画像读取只接受一个固定领域。' } }
      }
      return memoryManager.readProfiles(args[0].domain)
    })
}
