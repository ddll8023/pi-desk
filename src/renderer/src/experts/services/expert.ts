/** 专家设置页的受限桥接：清单复用 sessions 域，派生、读取、保存与删除走专家域；不向页面暴露任何文件路径写权限。 */
import { isSessionExpertsResult } from '../../../../shared/session-api'
import type { SessionExpertsResult } from '../../../../shared/session-api'
import {
  isExpertDeleteResult,
  isExpertDeriveResult,
  isExpertEditableDefinitionResult,
  isExpertSaveResult,
  isFastModeExclusionsResult
} from '../../../../shared/experts-api'
import type {
  ExpertDeleteResult,
  ExpertDeriveResult,
  ExpertReadResult,
  ExpertSaveRequest,
  ExpertSaveResult,
  FastModeExclusionsResult
} from '../../../../shared/experts-api'

interface ExpertBridge {
  readonly listSessionExperts: () => Promise<unknown>
  readonly deriveExpert: (request: { readonly builtinId: string }) => Promise<unknown>
  readonly readExpertDefinition: (request: { readonly expertId: string }) => Promise<unknown>
  readonly saveExpert: (request: ExpertSaveRequest) => Promise<unknown>
  readonly deleteExpert: (request: { readonly expertId: string }) => Promise<unknown>
  readonly listFastModeExclusions: () => Promise<unknown>
}

function bridge(): ExpertBridge | null {
  const value = window.desktop as Partial<ExpertBridge> | undefined
  if (value === undefined
    || typeof value.listSessionExperts !== 'function'
    || typeof value.deriveExpert !== 'function'
    || typeof value.readExpertDefinition !== 'function'
    || typeof value.saveExpert !== 'function'
    || typeof value.deleteExpert !== 'function'
    || typeof value.listFastModeExclusions !== 'function') return null
  return value as ExpertBridge
}

/** 桥接缺失或响应不合契约时的固定失败结果；先声明类型，避免对象字面量的 code 被拓成 string。 */
const LIST_FALLBACK: SessionExpertsResult = {
  ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '无法读取专家清单。' }
}
const DERIVE_FALLBACK: ExpertDeriveResult = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '派生请求没有送达主进程。' }
}
const DELETE_FALLBACK: ExpertDeleteResult = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '删除请求没有送达主进程。' }
}
const EXCLUSIONS_FALLBACK: FastModeExclusionsResult = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '无法读取快速模式剔除清单。' }
}
const READ_FALLBACK: ExpertReadResult = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '读取请求没有送达主进程。' }
}
const SAVE_FALLBACK: ExpertSaveResult = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '保存请求没有送达主进程。' }
}

async function call<Result>(
  work: (target: ExpertBridge) => Promise<unknown>,
  validate: (value: unknown) => value is Result,
  fallback: Result
): Promise<Result> {
  const target = bridge()
  if (target === null) return fallback
  try {
    const response = await work(target)
    return validate(response) ? response : fallback
  } catch {
    return fallback
  }
}

export function listExperts(): Promise<SessionExpertsResult> {
  return call(
    target => target.listSessionExperts(),
    isSessionExpertsResult,
    LIST_FALLBACK
  )
}

export function deriveExpert(builtinId: string): Promise<ExpertDeriveResult> {
  return call(
    target => target.deriveExpert({ builtinId }),
    isExpertDeriveResult,
    DERIVE_FALLBACK
  )
}

export function deleteExpert(expertId: string): Promise<ExpertDeleteResult> {
  return call(
    target => target.deleteExpert({ expertId }),
    isExpertDeleteResult,
    DELETE_FALLBACK
  )
}

export function readExpertDefinition(expertId: string): Promise<ExpertReadResult> {
  return call(
    target => target.readExpertDefinition({ expertId }),
    isExpertEditableDefinitionResult,
    READ_FALLBACK
  )
}

export function saveExpert(request: ExpertSaveRequest): Promise<ExpertSaveResult> {
  return call(
    target => target.saveExpert(request),
    isExpertSaveResult,
    SAVE_FALLBACK
  )
}

export function listFastModeExclusions(): Promise<FastModeExclusionsResult> {
  return call(
    target => target.listFastModeExclusions(),
    isFastModeExclusionsResult,
    EXCLUSIONS_FALLBACK
  )
}
