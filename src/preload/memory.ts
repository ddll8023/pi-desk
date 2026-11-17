/** 记忆域桥接：只经固定 channel 转发状态、开关、首次创建、记录正文与画像正文读取、风格要点与原句读取、画像与风格列表及保存、卡片候选保存，不开放路径或命令。 */
import { ipcRenderer } from 'electron'
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
  isMemoryProfileListResult,
  isMemoryProfileReadResult,
  isMemoryProfileSaveResult,
  isMemoryStyleListResult,
  isMemoryStyleReadResult,
  isMemoryStyleSaveResult,
  isMemoryReadResult,
  isMemoryResult,
  isMemorySaveResult
} from '../shared/memory-api'
import type {
  MemoryApi, MemoryInitializeRequest, MemoryPreference, MemoryProfileListResult, MemoryProfileReadRequest,
  MemoryProfileReadResult, MemoryProfileSaveRequest, MemoryProfileSaveResult, MemoryReadRequest, MemoryReadResult,
  MemoryResult, MemorySaveCandidatesRequest, MemorySaveResult, MemoryStyleListResult, MemoryStyleReadRequest,
  MemoryStyleReadResult, MemoryStyleSaveRequest, MemoryStyleSaveResult
} from '../shared/memory-api'

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
  },
  async readMemoryRecords(request: MemoryReadRequest): Promise<MemoryReadResult> {
    try {
      const response: unknown = await ipcRenderer.invoke(MEMORY_READ_CHANNEL, { ids: request?.ids })
      if (!isMemoryReadResult(response)) {
        return { ok: false, error: { code: 'INVALID_RESPONSE', message: '记录读取返回了不符合契约的结果。' } }
      }
      return response
    } catch (error) {
      return { ok: false, error: { code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : '记录读取失败。' } }
    }
  },
  async readMemoryProfiles(request: MemoryProfileReadRequest): Promise<MemoryProfileReadResult> {
    try {
      const response: unknown = await ipcRenderer.invoke(MEMORY_PROFILE_READ_CHANNEL, { domain: request?.domain })
      if (!isMemoryProfileReadResult(response)) {
        return { ok: false, error: { code: 'INVALID_RESPONSE', message: '画像读取返回了不符合契约的结果。' } }
      }
      return response
    } catch (error) {
      return { ok: false, error: { code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : '画像读取失败。' } }
    }
  },
  async readMemoryStyles(request: MemoryStyleReadRequest): Promise<MemoryStyleReadResult> {
    try {
      const response: unknown = await ipcRenderer.invoke(MEMORY_STYLE_READ_CHANNEL, { ids: request?.ids })
      if (!isMemoryStyleReadResult(response)) {
        return { ok: false, error: { code: 'INVALID_RESPONSE', message: '风格读取返回了不符合契约的结果。' } }
      }
      return response
    } catch (error) {
      return { ok: false, error: { code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : '风格读取失败。' } }
    }
  },
  async saveMemoryCandidates(request: MemorySaveCandidatesRequest): Promise<MemorySaveResult> {
    try {
      const response: unknown = await ipcRenderer.invoke(MEMORY_SAVE_CANDIDATES_CHANNEL,
        { projectPath: request?.projectPath, candidates: request?.candidates })
      if (!isMemorySaveResult(response)) {
        return { ok: false, error: { code: 'INVALID_RESPONSE', message: '候选保存返回了不符合契约的结果。' } }
      }
      return response
    } catch (error) {
      return { ok: false, error: { code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : '候选保存失败。' } }
    }
  },
  /** 设置页画像列表：无参数，不按关键词或 ID 扫描。 */
  async readMemoryProfilesList(): Promise<MemoryProfileListResult> {
    try {
      const response: unknown = await ipcRenderer.invoke(MEMORY_PROFILES_CHANNEL)
      if (!isMemoryProfileListResult(response)) {
        return { ok: false, error: { code: 'INVALID_RESPONSE', message: '画像列表返回了不符合契约的结果。' } }
      }
      return response
    } catch (error) {
      return { ok: false, error: { code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : '画像列表读取失败。' } }
    }
  },
  /** 设置页风格列表：无参数，返回全部风格与全部原句样本。 */
  async readMemoryStylesList(): Promise<MemoryStyleListResult> {
    try {
      const response: unknown = await ipcRenderer.invoke(MEMORY_STYLES_CHANNEL)
      if (!isMemoryStyleListResult(response)) {
        return { ok: false, error: { code: 'INVALID_RESPONSE', message: '风格列表返回了不符合契约的结果。' } }
      }
      return response
    } catch (error) {
      return { ok: false, error: { code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : '风格列表读取失败。' } }
    }
  },
  /** 画像保存：只转发字段，计划 ID、库位置与批准标志由主进程持有。 */
  async saveMemoryProfile(request: MemoryProfileSaveRequest): Promise<MemoryProfileSaveResult> {
    try {
      const response: unknown = await ipcRenderer.invoke(MEMORY_PROFILE_SAVE_CHANNEL, {
        domain: request?.domain, scope: request?.scope, basis: request?.basis,
        title: request?.title, content: request?.content,
        sourceRecordIds: request?.sourceRecordIds, replaceProfileIds: request?.replaceProfileIds
      })
      if (!isMemoryProfileSaveResult(response)) {
        return { ok: false, error: { code: 'INVALID_RESPONSE', message: '画像保存返回了不符合契约的结果。' } }
      }
      return response
    } catch (error) {
      return { ok: false, error: { code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : '画像保存失败。' } }
    }
  },
  /** 风格保存：同名且未指定替换时按合并，指定替换（含同名条目）时按覆盖。 */
  async saveMemoryStyle(request: MemoryStyleSaveRequest): Promise<MemoryStyleSaveResult> {
    try {
      const response: unknown = await ipcRenderer.invoke(MEMORY_STYLE_SAVE_CHANNEL, { styles: request?.styles })
      if (!isMemoryStyleSaveResult(response)) {
        return { ok: false, error: { code: 'INVALID_RESPONSE', message: '风格保存返回了不符合契约的结果。' } }
      }
      return response
    } catch (error) {
      return { ok: false, error: { code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : '风格保存失败。' } }
    }
  }
}
