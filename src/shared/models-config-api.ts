/**
 * 第三方自定义供应商（Pi 的 `<agent-dir>/models.json`）管理的受限 IPC 契约：只定义固定通道、
 * 快照与请求形状、长度边界与跨进程响应校验，不含任何凭据内容。
 *
 * 凭据边界：供应商条目回传渲染端之前，`apiKey` 与 `headers` 的值一律替换为哨兵文本；
 * 保存时把等于哨兵的值按位置还原为磁盘上已有的值。真实密钥不进入 IPC 载荷、日志或错误文本。
 */
import type { DesktopErrorCode } from './desktop-api'

/** 零参数：读取 models.json 的供应商条目快照（密钥已替换为哨兵）。 */
export const MODELS_CONFIG_GET_CHANNEL = 'desktop:models-config-get'
/** 只接受 `{ providerId, json }`：新增或整体替换一个供应商条目。 */
export const MODELS_CONFIG_SAVE_PROVIDER_CHANNEL = 'desktop:models-config-save-provider'
/** 只接受 `{ providerId }`：删除一个供应商条目。 */
export const MODELS_CONFIG_DELETE_PROVIDER_CHANNEL = 'desktop:models-config-delete-provider'

/**
 * 密钥占位文本。页面看到的 `apiKey` 与 `headers` 值都是它；保存时主进程按位置换回磁盘上的原值，
 * 因此页面既能展示完整条目，又不需要接触凭据。用户直接把它写成字面值会被还原为原值。
 */
export const MODELS_CONFIG_SECRET_SENTINEL = '__PI_DESK_PRESERVED_SECRET__'

/** 供应商 ID 的长度上限；只限制形状，合法性由 Pi 判定。 */
export const MODELS_CONFIG_MAX_PROVIDER_ID_CHARS = 128
/** 单个供应商条目的 JSON 文本长度上限；超限按参数拒绝，不静默截断。 */
export const MODELS_CONFIG_MAX_JSON_CHARS = 256 * 1024
/** 快照里的供应商条目数量上限；超出只展示前若干条，不伪装成完整清单。 */
export const MODELS_CONFIG_MAX_PROVIDERS = 500

/** 一个供应商条目的展示投影；`json` 里的密钥已替换为哨兵。 */
export interface ModelsConfigProvider {
  readonly id: string
  /** 条目的 JSON 文本，保留缩进，供原始 JSON 编辑区直接编辑。 */
  readonly json: string
  /** 条目是否声明了非空的 apiKey；只报告有无，不含内容。 */
  readonly hasApiKey: boolean
  /** 条目里形状可识别的模型数量；不代表模型在 Pi 里可用。 */
  readonly modelCount: number
}

/** models.json 的供应商快照；文件不存在与文件损坏保持区分。 */
export interface ModelsConfigSnapshot {
  /** 实际读取的文件路径，供界面标注来源。 */
  readonly filePath: string
  /** 文件是否存在；不存在表示还没有任何自定义供应商，保存时会创建。 */
  readonly exists: boolean
  readonly providers: readonly ModelsConfigProvider[]
  /**
   * 文件存在但无法读取或解析时的原因；非空时 `providers` 为空，
   * 并且本次会话拒绝任何写入，避免用空内容覆盖用户的文件。
   */
  readonly parseError: string | null
  /** 条目数超过上限被省略；不伪装成完整清单。 */
  readonly truncated: boolean
}

export type ModelsConfigErrorCode = DesktopErrorCode

export interface ModelsConfigError {
  readonly code: ModelsConfigErrorCode
  readonly message: string
}

export type ModelsConfigResult =
  | { readonly ok: true; readonly data: ModelsConfigSnapshot }
  | { readonly ok: false; readonly error: ModelsConfigError }

/** 保存请求：`json` 是单个供应商条目的 JSON 文本；`providerId` 决定它在 providers 里的键。 */
export interface ModelsConfigSaveRequest {
  readonly providerId: string
  readonly json: string
}

export interface ModelsConfigDeleteRequest {
  readonly providerId: string
}

export interface ModelsConfigApi {
  /** 读取供应商快照；每次调用都重新读盘，并把它作为后续保存的比对基线。 */
  readonly getModelsConfig: () => Promise<ModelsConfigResult>
  /** 新增或整体替换一个供应商条目；返回写入后的快照，不修改 Pi 的其他配置。 */
  readonly saveModelsConfigProvider: (request: ModelsConfigSaveRequest) => Promise<ModelsConfigResult>
  /** 删除一个供应商条目；条目不存在时不写文件，直接返回当前快照。 */
  readonly deleteModelsConfigProvider: (request: ModelsConfigDeleteRequest) => Promise<ModelsConfigResult>
}

// 与 desktop-api.ts 的共享错误码保持一致；本契约不追加专有错误码。
const MODELS_CONFIG_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxChars
}

function isProvider(value: unknown): value is ModelsConfigProvider {
  if (!isRecord(value)) return false
  if (!isBoundedString(value.id, MODELS_CONFIG_MAX_PROVIDER_ID_CHARS)) return false
  if (typeof value.json !== 'string' || value.json.length > MODELS_CONFIG_MAX_JSON_CHARS) return false
  if (typeof value.hasApiKey !== 'boolean') return false
  if (typeof value.modelCount !== 'number' || !Number.isInteger(value.modelCount)) return false
  return value.modelCount >= 0
}

/** 快照校验：`parseError` 非空时允许 `providers` 为空，其余情况逐项校验。 */
export function isModelsConfigSnapshot(value: unknown): value is ModelsConfigSnapshot {
  if (!isRecord(value)) return false
  if (typeof value.filePath !== 'string' || value.filePath === '') return false
  if (typeof value.exists !== 'boolean') return false
  if (typeof value.truncated !== 'boolean') return false
  if (value.parseError !== null && typeof value.parseError !== 'string') return false
  return Array.isArray(value.providers)
    && value.providers.length <= MODELS_CONFIG_MAX_PROVIDERS
    && value.providers.every(isProvider)
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isModelsConfigResult(value: unknown): value is ModelsConfigResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isModelsConfigSnapshot(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && MODELS_CONFIG_ERROR_CODES.includes(code)
}

/** 保存请求校验：拒绝多余字段，超长 JSON 直接拒绝而不是截断。 */
export function isModelsConfigSaveRequest(value: unknown): value is ModelsConfigSaveRequest {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'providerId' || key === 'json')) return false
  return isBoundedString(value.providerId, MODELS_CONFIG_MAX_PROVIDER_ID_CHARS)
    && typeof value.json === 'string'
    && value.json.length <= MODELS_CONFIG_MAX_JSON_CHARS
}

export function isModelsConfigDeleteRequest(value: unknown): value is ModelsConfigDeleteRequest {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'providerId')) return false
  return isBoundedString(value.providerId, MODELS_CONFIG_MAX_PROVIDER_ID_CHARS)
}
