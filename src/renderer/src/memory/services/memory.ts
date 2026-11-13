/** 记忆域的受限桥接：设置页用开关、状态与首次创建，会话卡片用按记录 ID 的正文读取；不向页面开放路径或命令。 */
import { isMemoryReadResult, isMemoryResult } from '../../../../shared/memory-api'
import type {
  MemoryInitializeRequest, MemoryPreference, MemoryReadRequest, MemoryReadResult, MemoryResult
} from '../../../../shared/memory-api'

interface MemoryBridge {
  readonly getMemoryStatus: () => Promise<unknown>
  readonly setMemoryEnabled: (request: MemoryPreference) => Promise<unknown>
  readonly initializeMemory: (request: MemoryInitializeRequest) => Promise<unknown>
  readonly readMemoryRecords?: (request: MemoryReadRequest) => Promise<unknown>
}

function bridge(): MemoryBridge | null {
  const value = window.desktop as Partial<MemoryBridge> | undefined
  if (value === undefined || typeof value.getMemoryStatus !== 'function'
    || typeof value.setMemoryEnabled !== 'function' || typeof value.initializeMemory !== 'function') return null
  return value as MemoryBridge
}

function unavailable(): MemoryResult {
  return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '当前环境没有桌面记忆接口。' } }
}

async function call(work: (target: MemoryBridge) => Promise<unknown>): Promise<MemoryResult> {
  const target = bridge()
  if (target === null) return unavailable()
  try {
    const response = await work(target)
    if (!isMemoryResult(response)) {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: '记忆接口返回了不符合契约的结果。' } }
    }
    return response
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : '记忆接口调用失败。' } }
  }
}

export function loadMemoryStatus(): Promise<MemoryResult> {
  return call(target => target.getMemoryStatus())
}

/**
 * 按真实记录 ID 读取正文：只供会话内已注入条目展开，不提供搜索或扫描入口。
 * 与设置页的 `MemoryResult` 分开校验，避免把两种载荷混成一种。
 */
export async function readMemoryRecords(ids: readonly string[]): Promise<MemoryReadResult> {
  const target = bridge()
  if (target === null || typeof target.readMemoryRecords !== 'function') {
    return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '当前环境没有桌面记忆接口。' } }
  }
  try {
    const response = await target.readMemoryRecords({ ids })
    if (!isMemoryReadResult(response)) {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: '记录读取返回了不符合契约的结果。' } }
    }
    return response
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : '记录读取失败。' } }
  }
}

export function setMemoryEnabled(enabled: boolean): Promise<MemoryResult> {
  return call(target => target.setMemoryEnabled({ enabled: enabled === true }))
}

export function initializeMemory(timezone: string): Promise<MemoryResult> {
  return call(target => target.initializeMemory({ timezone }))
}
