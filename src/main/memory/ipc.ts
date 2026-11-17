/** 记忆域 IPC：校验调用者与参数，转发给唯一所有者（状态、开关、创建、记录／画像／风格读取、画像／风格保存与候选保存）；不提供路径、命令或批准参数。 */
import type { IpcMainInvokeEvent } from 'electron'
import {
  MEMORY_ENABLED_CHANNEL,
  MEMORY_INITIALIZE_CHANNEL,
  MEMORY_PROFILE_READ_CHANNEL,
  MEMORY_PROFILES_CHANNEL,
  MEMORY_PROFILE_SAVE_CHANNEL,
  MEMORY_STYLE_READ_CHANNEL,
  MEMORY_STYLES_CHANNEL,
  MEMORY_STYLE_SAVE_CHANNEL,
  MEMORY_READ_CHANNEL,
  MEMORY_SAVE_CANDIDATES_CHANNEL,
  MEMORY_STATUS_CHANNEL,
  isMemoryInitializeRequest,
  isMemoryPreference,
  isMemoryProfileReadRequest,
  isMemoryProfileSaveRequest,
  isMemoryStyleReadRequest,
  isMemoryStyleSaveRequest,
  isMemoryReadRequest,
  isMemorySaveCandidatesRequest
} from '../../shared/memory-api'
import type {
  MemoryProfileListResult, MemoryProfileReadResult, MemoryProfileSaveResult, MemoryReadResult, MemoryResult,
  MemorySaveResult, MemoryStyleListResult, MemoryStyleReadResult, MemoryStyleSaveResult
} from '../../shared/memory-api'
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

  /** 风格读取只接受 1..10 个真实风格 ID：不提供按名称、关键词或数量的扫描入口。 */
  handle(MEMORY_STYLE_READ_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<MemoryStyleReadResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isMemoryStyleReadRequest(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '风格读取只接受 1 至 10 个真实风格 ID。' } }
      }
      return memoryManager.readStyles(args[0].ids)
    })

  /** 候选保存只接受 1..10 条合法候选与项目路径；plan、store 与批准标志都不由页面指定。 */
  handle(MEMORY_SAVE_CANDIDATES_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<MemorySaveResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isMemorySaveCandidatesRequest(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '候选保存只接受项目路径与 1 至 10 条合法候选。' } }
      }
      return memoryManager.saveCandidates(args[0])
    })

  /** 画像列表不接受参数：设置页只需全部画像，不提供关键词、领域或 ID 的扫描参数。 */
  handle(MEMORY_PROFILES_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<MemoryProfileListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '画像列表读取不接受参数。' } }
      }
      return memoryManager.listProfiles()
    })

  /** 风格列表不接受参数：返回全部风格与原句样本，不提供关键词扫描。 */
  handle(MEMORY_STYLES_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<MemoryStyleListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '风格列表读取不接受参数。' } }
      }
      return memoryManager.listStyles()
    })

  /** 画像保存只接受完整字段；计划 ID、库位置与批准标志不由页面指定。 */
  handle(MEMORY_PROFILE_SAVE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<MemoryProfileSaveResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isMemoryProfileSaveRequest(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '画像保存只接受领域、作用域、依据、标题、正文与两份 ID 名单。' } }
      }
      return memoryManager.saveProfile(args[0])
    })

  /** 风格保存只接受 1..10 条完整风格定义；同名合并与显式覆盖由引擎判定。 */
  handle(MEMORY_STYLE_SAVE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<MemoryStyleSaveResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isMemoryStyleSaveRequest(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '风格保存只接受 1 至 10 条含原句样本的风格定义。' } }
      }
      return memoryManager.saveStyle(args[0])
    })
}
