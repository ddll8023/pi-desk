/** 记忆设置页的受限桥接：只转发开关、状态与首次创建，不向页面开放路径或命令。 */
import { isMemoryResult } from '../../../../shared/memory-api'
import type { MemoryInitializeRequest, MemoryPreference, MemoryResult } from '../../../../shared/memory-api'

interface MemoryBridge {
  readonly getMemoryStatus: () => Promise<unknown>
  readonly setMemoryEnabled: (request: MemoryPreference) => Promise<unknown>
  readonly initializeMemory: (request: MemoryInitializeRequest) => Promise<unknown>
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

export function setMemoryEnabled(enabled: boolean): Promise<MemoryResult> {
  return call(target => target.setMemoryEnabled({ enabled: enabled === true }))
}

export function initializeMemory(timezone: string): Promise<MemoryResult> {
  return call(target => target.initializeMemory({ timezone }))
}
