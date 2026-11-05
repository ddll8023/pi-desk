/** 记忆域桥接：只经固定 channel 转发状态、开关与首次创建，不开放路径或命令。 */
import { ipcRenderer } from 'electron'
import {
  MEMORY_ENABLED_CHANNEL,
  MEMORY_INITIALIZE_CHANNEL,
  MEMORY_STATUS_CHANNEL,
  isMemoryResult
} from '../shared/memory-api'
import type { MemoryApi, MemoryInitializeRequest, MemoryPreference, MemoryResult } from '../shared/memory-api'

async function invoke(channel: string, payload?: unknown): Promise<MemoryResult> {
  try {
    const response: unknown = await (payload === undefined
      ? ipcRenderer.invoke(channel)
      : ipcRenderer.invoke(channel, payload))
    if (!isMemoryResult(response)) {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: '记忆接口返回了不符合契约的结果。' } }
    }
    return response
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : '记忆接口调用失败。' } }
  }
}

export const memoryApi: MemoryApi = {
  async getMemoryStatus(): Promise<MemoryResult> {
    return invoke(MEMORY_STATUS_CHANNEL)
  },
  async setMemoryEnabled(request: MemoryPreference): Promise<MemoryResult> {
    return invoke(MEMORY_ENABLED_CHANNEL, { enabled: request?.enabled === true })
  },
  async initializeMemory(request: MemoryInitializeRequest): Promise<MemoryResult> {
    const timezone = request?.timezone
    if (typeof timezone !== 'string') {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: '时区必须是文本。' } }
    }
    return invoke(MEMORY_INITIALIZE_CHANNEL, { timezone })
  }
}
