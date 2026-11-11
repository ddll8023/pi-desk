/**
 * 专家资源管理（设置页）的固定通道、请求与结果类型及跨进程响应校验。
 *
 * 只管「把内置专家派生成本地可编辑副本」「删除自定义专家」「快速模式会剔除哪些用户级技能」三件事；
 * 专家清单与加载诊断复用会话域的 `desktop:session-experts`，不在这里复制第二份读取。
 * 错误码独立成族：写盘失败与清单读取失败是不同故障，页面据此分开提示。
 */
import { isExpertId } from './session-api'

/** 把内置专家复制成自定义目录下的派生副本；副本立即出现在清单里。 */
export const EXPERTS_DERIVE_CHANNEL = 'desktop:expert-derive'
/** 删除一份自定义专家；内置专家只读，不能通过这条通道删除。 */
export const EXPERTS_DELETE_CHANNEL = 'desktop:expert-delete'
/** 快速模式下会被剔除的用户级技能标识；名单与宿主实际过滤同源。 */
export const EXPERTS_FAST_MODE_CHANNEL = 'desktop:expert-fast-mode'

export type ExpertErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR'
  | 'INVALID_RESPONSE'
  | 'BRIDGE_UNAVAILABLE'
  /** 要派生的内置专家不在随包清单里（清单未重建或被移除）。 */
  | 'BUILTIN_NOT_FOUND'
  /** 目标不是可删除的自定义专家：内置、不存在或目录里还有别的文件。 */
  | 'NOT_USER_EXPERT'

export interface ExpertError {
  readonly code: ExpertErrorCode
  readonly message: string
}

export interface ExpertDeriveRequest {
  /** 要派生的内置专家标识。 */
  readonly builtinId: string
}

export type ExpertDeriveResult =
  | { readonly ok: true; readonly data: { readonly expertId: string } }
  | { readonly ok: false; readonly error: ExpertError }

export interface ExpertDeleteRequest {
  readonly expertId: string
}

export type ExpertDeleteResult =
  | { readonly ok: true; readonly data: { readonly expertId: string } }
  | { readonly ok: false; readonly error: ExpertError }

export type FastModeExclusionsResult =
  | { readonly ok: true; readonly data: { readonly skillIds: readonly string[] } }
  | { readonly ok: false; readonly error: ExpertError }

export interface ExpertApi {
  /** 派生一份内置专家；返回新副本的标识，同名占用时由主进程顺延编号。 */
  readonly deriveExpert: (request: ExpertDeriveRequest) => Promise<ExpertDeriveResult>
  /** 删除一份自定义专家；内置专家与仍带其他文件的目录会被拒绝。 */
  readonly deleteExpert: (request: ExpertDeleteRequest) => Promise<ExpertDeleteResult>
  /** 读取快速模式会剔除的用户级技能；只反映目录里实际存在的那些，可以为空。 */
  readonly listFastModeExclusions: () => Promise<FastModeExclusionsResult>
}

const EXPERT_ERROR_CODES: readonly string[] = [
  'FORBIDDEN', 'INVALID_REQUEST', 'INTERNAL_ERROR', 'INVALID_RESPONSE', 'BRIDGE_UNAVAILABLE',
  'BUILTIN_NOT_FOUND', 'NOT_USER_EXPERT'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExpertFailure(value: Record<string, unknown>): boolean {
  if (value.ok !== false || !isRecord(value.error)) return false
  const { code, message } = value.error
  return typeof code === 'string' && EXPERT_ERROR_CODES.includes(code) && typeof message === 'string'
}

/** 派生请求只放行一个合法专家标识，多余字段直接拒绝。 */
export function isExpertDeriveRequest(value: unknown): value is ExpertDeriveRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => key !== 'builtinId')) return false
  return isExpertId(value.builtinId)
}

export function isExpertDeleteRequest(value: unknown): value is ExpertDeleteRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => key !== 'expertId')) return false
  return isExpertId(value.expertId)
}

export function isExpertDeriveResult(value: unknown): value is ExpertDeriveResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isExpertFailure(value)
  return value.ok === true && isRecord(value.data) && isExpertId(value.data.expertId)
}

export function isExpertDeleteResult(value: unknown): value is ExpertDeleteResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isExpertFailure(value)
  return value.ok === true && isRecord(value.data) && isExpertId(value.data.expertId)
}

export function isFastModeExclusionsResult(value: unknown): value is FastModeExclusionsResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isExpertFailure(value)
  if (value.ok !== true || !isRecord(value.data)) return false
  return Array.isArray(value.data.skillIds) && value.data.skillIds.every(item => typeof item === 'string')
}
