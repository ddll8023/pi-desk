/** 记忆域的受限桥接：设置页用开关、状态、首次创建、画像／风格列表与保存（画像保存回执带被剔除的失效来源条数），会话卡片用按记录 ID、按领域与按风格 ID 的正文读取和候选保存；不向页面开放路径或命令。 */
import {
  isMemoryProfileListResult, isMemoryProfileReadResult, isMemoryProfileSaveResult, isMemoryReadResult,
  isMemoryResult, isMemorySaveResult, isMemoryStyleListResult, isMemoryStyleReadResult, isMemoryStyleSaveResult
} from '../../../../shared/memory-api'
import type {
  MemoryInitializeRequest, MemoryPreference, MemoryProfileDomain, MemoryProfileListResult, MemoryProfileReadResult,
  MemoryProfileSaveRequest, MemoryProfileSaveResult, MemoryReadRequest, MemoryReadResult, MemoryResult,
  MemorySaveCandidatesRequest, MemorySaveResult, MemoryStyleListResult, MemoryStyleReadRequest, MemoryStyleReadResult,
  MemoryStyleSaveRequest, MemoryStyleSaveResult
} from '../../../../shared/memory-api'

interface MemoryBridge {
  readonly getMemoryStatus: () => Promise<unknown>
  readonly setMemoryEnabled: (request: MemoryPreference) => Promise<unknown>
  readonly initializeMemory: (request: MemoryInitializeRequest) => Promise<unknown>
  readonly readMemoryRecords?: (request: MemoryReadRequest) => Promise<unknown>
  readonly readMemoryProfiles?: (request: { readonly domain: MemoryProfileDomain }) => Promise<unknown>
  readonly readMemoryStyles?: (request: MemoryStyleReadRequest) => Promise<unknown>
  readonly readMemoryProfilesList?: () => Promise<unknown>
  readonly readMemoryStylesList?: () => Promise<unknown>
  readonly saveMemoryProfile?: (request: MemoryProfileSaveRequest) => Promise<unknown>
  readonly saveMemoryStyle?: (request: MemoryStyleSaveRequest) => Promise<unknown>
  readonly saveMemoryCandidates?: (request: MemorySaveCandidatesRequest) => Promise<unknown>
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

/**
 * 按领域读取画像正文：只供注入卡片展开画像条目，领域是固定枚举。
 * 与记录读取分开校验：两者的数据形状与失败语义不同。
 */
export async function readMemoryProfiles(domain: MemoryProfileDomain): Promise<MemoryProfileReadResult> {
  const target = bridge()
  if (target === null || typeof target.readMemoryProfiles !== 'function') {
    return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '当前环境没有桌面记忆接口。' } }
  }
  try {
    const response = await target.readMemoryProfiles({ domain })
    if (!isMemoryProfileReadResult(response)) {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: '画像读取返回了不符合契约的结果。' } }
    }
    return response
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : '画像读取失败。' } }
  }
}

/**
 * 按真实风格 ID 读取要点与全部原句：只供注入卡片展开风格条目，不提供按名称或关键词的扫描。
 * 与记录、画像读取分开校验：三者数据形状与失败语义不同。
 */
export async function readMemoryStyles(ids: readonly string[]): Promise<MemoryStyleReadResult> {
  const target = bridge()
  if (target === null || typeof target.readMemoryStyles !== 'function') {
    return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '当前环境没有桌面记忆接口。' } }
  }
  try {
    const response = await target.readMemoryStyles({ ids })
    if (!isMemoryStyleReadResult(response)) {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: '风格读取返回了不符合契约的结果。' } }
    }
    return response
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : '风格读取失败。' } }
  }
}

export function setMemoryEnabled(enabled: boolean): Promise<MemoryResult> {
  return call(target => target.setMemoryEnabled({ enabled: enabled === true }))
}

/**
 * 保存记忆候选卡片上勾选并编辑后的候选：只转发项目路径与候选，归属与计划由主进程处理。
 * 与读取分开校验：保存回执的数据形状与失败语义不同，不把两种载荷混成一种。
 */
export async function saveMemoryCandidates(request: MemorySaveCandidatesRequest): Promise<MemorySaveResult> {
  const target = bridge()
  if (target === null || typeof target.saveMemoryCandidates !== 'function') {
    return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '当前环境没有桌面记忆接口。' } }
  }
  try {
    const response = await target.saveMemoryCandidates(request)
    if (!isMemorySaveResult(response)) {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: '候选保存返回了不符合契约的结果。' } }
    }
    return response
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : '候选保存失败。' } }
  }
}

export function initializeMemory(timezone: string): Promise<MemoryResult> {
  return call(target => target.initializeMemory({ timezone }))
}

/**
 * 设置页画像列表：一次取全部画像，用于展示与编辑；不按关键词、ID 或数量扫描。
 */
export async function loadMemoryProfiles(): Promise<MemoryProfileListResult> {
  const target = bridge()
  if (target === null || typeof target.readMemoryProfilesList !== 'function') {
    return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '当前环境没有桌面记忆接口。' } }
  }
  try {
    const response = await target.readMemoryProfilesList()
    if (!isMemoryProfileListResult(response)) {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: '画像列表返回了不符合契约的结果。' } }
    }
    return response
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : '画像列表读取失败。' } }
  }
}

/** 设置页风格列表：一次取全部风格与原句样本。 */
export async function loadMemoryStyles(): Promise<MemoryStyleListResult> {
  const target = bridge()
  if (target === null || typeof target.readMemoryStylesList !== 'function') {
    return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '当前环境没有桌面记忆接口。' } }
  }
  try {
    const response = await target.readMemoryStylesList()
    if (!isMemoryStyleListResult(response)) {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: '风格列表返回了不符合契约的结果。' } }
    }
    return response
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : '风格列表读取失败。' } }
  }
}

/** 画像保存：保存即「新版本替换旧条目」，领域与来源由调用方按原条目传入。 */
export async function saveMemoryProfile(request: MemoryProfileSaveRequest): Promise<MemoryProfileSaveResult> {
  const target = bridge()
  if (target === null || typeof target.saveMemoryProfile !== 'function') {
    return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '当前环境没有桌面记忆接口。' } }
  }
  try {
    const response = await target.saveMemoryProfile(request)
    if (!isMemoryProfileSaveResult(response)) {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: '画像保存返回了不符合契约的结果。' } }
    }
    return response
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : '画像保存失败。' } }
  }
}

/** 风格保存：未指定替换时同名按合并，指定替换（含本条自身）时按覆盖。 */
export async function saveMemoryStyle(request: MemoryStyleSaveRequest): Promise<MemoryStyleSaveResult> {
  const target = bridge()
  if (target === null || typeof target.saveMemoryStyle !== 'function') {
    return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '当前环境没有桌面记忆接口。' } }
  }
  try {
    const response = await target.saveMemoryStyle(request)
    if (!isMemoryStyleSaveResult(response)) {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: '风格保存返回了不符合契约的结果。' } }
    }
    return response
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : '风格保存失败。' } }
  }
}
