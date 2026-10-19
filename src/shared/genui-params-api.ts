/**
 * 定义生成式界面参数取值的固定通道、载荷类型与跨进程校验。
 *
 * 参数取值不是对话内容：它不进 session、不随工具结果回放，因此放在本机旁路文件
 * （`<userData>/genui-params.json`）里，与 `desktop-config.json` 分开。分开的理由是两者的写入频率
 * 与重要性不同：参数是高频变化、可再生的小缓存，配置文件装着项目列表这类关键记录，混在一起会把
 * 整文件写入的风险与频率放大到项目记录上。
 *
 * 键是界面标识 `documentId`，不带会话、项目与分支：同一份界面在 fork / rewind 之后仍然只有一份取值，
 * 与渲染端内存状态的口径一致。`revision` 随记录一起保存，供渲染端判断能否把旧取值迁移到新版声明上。
 *
 * 这里是纯类型与纯校验，不依赖 Electron、不读文件；文件读写由主进程的存储层负责。
 */
import type { DesktopError } from './desktop-api'
import { GENUI_MAX_PARAMS, GENUI_MAX_PARAM_TEXT_CHARS } from './genui-api'
import type { GenuiParamValue } from './genui-api'

export const GENUI_PARAMS_GET_CHANNEL = 'desktop:genui-params-get'
export const GENUI_PARAMS_SAVE_CHANNEL = 'desktop:genui-params-save'
export const GENUI_PARAMS_CLEAR_CHANNEL = 'desktop:genui-params-clear'

/**
 * 磁盘记录条数上限；与渲染端内存条目上限同值。
 * 超出按 `updatedAt` 淘汰最旧的一条，避免长会话把文件堆成无界增长。
 */
export const MAX_GENUI_PARAM_RECORDS = 500

/**
 * 磁盘记录的有效期：超过这么久没被写入的记录在载入时直接丢弃。
 * 取值远大于渲染端迁移有效期 `PARAM_INHERIT_TTL_MS`——短有效期会把「上次调好的值」变成噪音，
 * 而真正的过期判定由界面改版时的迁移规则负责，这里只兜住早已无关的旧界面。
 */
export const GENUI_PARAM_RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 文件字节上限；超限整体重建，不做逐条裁剪，避免在损坏文件上做无效功。 */
export const MAX_GENUI_PARAMS_FILE_BYTES = 1024 * 1024

/** 单个界面最多保存的参数项数；与协议参数上限同值，多出来的项按非法丢弃。 */
export const MAX_GENUI_PARAM_RECORD_VALUES = GENUI_MAX_PARAMS

/** 参数键（协议参数 id）长度上限；只拒绝明显异常的值。 */
export const MAX_GENUI_PARAM_KEY_CHARS = 32

/** 文本参数取值的长度上限；与协议同值，防止旧版本文本无限留档。 */
export const MAX_GENUI_PARAM_TEXT_VALUE_CHARS = GENUI_MAX_PARAM_TEXT_CHARS

/** 一份界面的取值记录。 */
export interface GenuiParamRecord {
  /** 保存时的文档版本；载入后由渲染端判断能否按参数 id 迁移到新版声明上。 */
  readonly revision: number
  /** 最近一次写入时间（毫秒时间戳）；载入时据此丢弃超期记录，写满上限时据此淘汰。 */
  readonly updatedAt: number
  /** 参数 id 到取值的映射；只保留布尔、有限数字与长度受限的字符串。 */
  readonly values: Readonly<Record<string, GenuiParamValue>>
}

/** 全部记录：键是界面标识 `documentId`。 */
export type GenuiParamRecordMap = Readonly<Record<string, GenuiParamRecord>>

/** 读取结果：成功给全量映射，失败带可展示原因。 */
export type GenuiParamsGetResult =
  | { readonly ok: true; readonly data: GenuiParamRecordMap }
  | { readonly ok: false; readonly error: DesktopError }

/** 保存请求：`record` 为 null 表示删除该界面的记录。 */
export interface GenuiParamSaveRequest {
  readonly documentId: string
  readonly record: GenuiParamRecord | null
}

/** 保存结果：成功回传主进程确认后的单条记录（删除时为 null）。 */
export type GenuiParamsSaveResult =
  | { readonly ok: true; readonly data: GenuiParamRecord | null }
  | { readonly ok: false; readonly error: DesktopError }

/** 清除结果：成功回传被删除的记录条数。 */
export type GenuiParamsClearResult =
  | { readonly ok: true; readonly data: { readonly removed: number } }
  | { readonly ok: false; readonly error: DesktopError }

export interface GenuiParamsApi {
  /** 读取全部已保存的参数记录；文件缺失或损坏时主进程按空映射返回。 */
  readonly getGenuiParams: () => Promise<GenuiParamsGetResult>
  /** 保存或删除一份界面的取值；只影响本机旁路文件。 */
  readonly saveGenuiParam: (request: GenuiParamSaveRequest) => Promise<GenuiParamsSaveResult>
  /** 清除全部已保存的参数记录；返回删除条数。 */
  readonly clearGenuiParams: () => Promise<GenuiParamsClearResult>
}

// 与 desktop-api.ts 的共享错误码保持一致；参数存储不追加专有错误码。
const GENUI_PARAMS_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED'
]

/** 界面标识：小写 UUID v4，与工具结果里的 `documentId` 同一形状。 */
const DOCUMENT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

/** 界面标识校验；主进程载入文件时也用它过滤键，不信任磁盘上的任意字符串。 */
export function isGenuiDocumentId(value: unknown): value is string {
  return typeof value === 'string' && DOCUMENT_ID_PATTERN.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 参数键：只接受协议里出现过的标识形状，避免把任意字符串写进文件。 */
const PARAM_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/

/**
 * 单个取值：布尔、有限数字，或长度受限的字符串。
 * 字符串允许空串——文本参数常态就是留空，空串也是一次真实的用户输入。
 */
function isParamValue(value: unknown): value is GenuiParamValue {
  if (typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value === 'string' && value.length <= MAX_GENUI_PARAM_TEXT_VALUE_CHARS
}

/** 一条记录的形状校验：版本与时间戳是非负安全整数，取值项数与键形状受限。 */
export function isGenuiParamRecord(value: unknown): value is GenuiParamRecord {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'revision' || key === 'updatedAt' || key === 'values')) return false
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) return false
  if (typeof value.updatedAt !== 'number' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) return false
  if (!isRecord(value.values)) return false
  const entries = Object.entries(value.values)
  if (entries.length > MAX_GENUI_PARAM_RECORD_VALUES) return false
  return entries.every(([key, item]) => (
    key.length <= MAX_GENUI_PARAM_KEY_CHARS && PARAM_KEY_PATTERN.test(key) && isParamValue(item)
  ))
}

/** 全量映射的校验：键必须是界面标识，条数不超过上限。 */
export function isGenuiParamRecordMap(value: unknown): value is GenuiParamRecordMap {
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  if (entries.length > MAX_GENUI_PARAM_RECORDS) return false
  return entries.every(([key, record]) => isGenuiDocumentId(key) && isGenuiParamRecord(record))
}

/** 保存请求的校验：只允许两个字段，`record` 为 null 即删除。 */
export function isGenuiParamSaveRequest(value: unknown): value is GenuiParamSaveRequest {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'documentId' || key === 'record')) return false
  if (typeof value.documentId !== 'string' || !isGenuiDocumentId(value.documentId)) return false
  return value.record === null || isGenuiParamRecord(value.record)
}

/** 错误对象的形状校验：码在共享错误码族里，消息是非空字符串。 */
function isDesktopError(value: unknown): value is DesktopError {
  if (!isRecord(value)) return false
  return typeof value.message === 'string' && typeof value.code === 'string'
    && GENUI_PARAMS_ERROR_CODES.includes(value.code)
}

export function isGenuiParamsGetResult(value: unknown): value is GenuiParamsGetResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isGenuiParamRecordMap(value.data)
  if (value.ok !== false) return false
  return isDesktopError(value.error)
}

export function isGenuiParamsSaveResult(value: unknown): value is GenuiParamsSaveResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return value.data === null || isGenuiParamRecord(value.data)
  if (value.ok !== false) return false
  return isDesktopError(value.error)
}

export function isGenuiParamsClearResult(value: unknown): value is GenuiParamsClearResult {
  if (!isRecord(value)) return false
  if (value.ok === true) {
    if (!isRecord(value.data)) return false
    return typeof value.data.removed === 'number' && Number.isSafeInteger(value.data.removed) && value.data.removed >= 0
  }
  if (value.ok !== false) return false
  return isDesktopError(value.error)
}
