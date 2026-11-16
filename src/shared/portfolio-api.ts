/**
 * 作品库的共享契约：条目与素材的数据形状、页面与主进程之间的固定通道、写入上限与运行时校验。
 *
 * 作品库是用户级全局资产，目录推导与文件读写只在主进程发生；这里不引入 `node:` 模块，
 * 因为同一份契约也会被 preload 与渲染层打包。页面只能传作品 ID 与库内相对路径，
 * 不能传任意绝对路径，也不能传图片数据。
 */

/** 读取作品清单。 */
export const PORTFOLIO_LIST_CHANNEL = 'desktop:portfolio-list'
/** 读取单件作品详情。 */
export const PORTFOLIO_READ_CHANNEL = 'desktop:portfolio-read'
/** 把作品目录移入系统废纸篓。 */
export const PORTFOLIO_DELETE_CHANNEL = 'desktop:portfolio-delete'
/** 只改作品名称，不移动目录。 */
export const PORTFOLIO_RENAME_CHANNEL = 'desktop:portfolio-rename'
/** 从内置浏览器截取封面，由主进程落盘。 */
export const PORTFOLIO_CAPTURE_COVER_CHANNEL = 'desktop:portfolio-capture-cover'
/** 用系统默认程序打开库内素材。 */
export const PORTFOLIO_OPEN_ASSET_CHANNEL = 'desktop:portfolio-open-asset'

/** 作品名称长度上限。 */
export const PORTFOLIO_NAME_MAX_CHARS = 100
/** 适用场景长度上限。 */
export const PORTFOLIO_SCENE_MAX_CHARS = 200
/** 设计要点长度上限。 */
export const PORTFOLIO_POINTS_MAX_CHARS = 8_000
/** 单个快照文件大小上限。 */
export const PORTFOLIO_SNAPSHOT_FILE_MAX_BYTES = 20 * 1024 * 1024
/** 单件作品素材合计大小上限。 */
export const PORTFOLIO_ASSET_TOTAL_MAX_BYTES = 64 * 1024 * 1024
/** 单次登记允许附带的快照文件数上限。 */
export const PORTFOLIO_SNAPSHOT_MAX_FILES = 20

/** 素材类型：封面图或源文件副本。 */
export type PortfolioAssetKind = 'cover' | 'snapshot'

/** 一件作品登记的素材；`path` 是库内相对路径，也是读取素材的唯一依据。 */
export interface PortfolioAsset {
  readonly kind: PortfolioAssetKind
  readonly path: string
  /** 登记时刻的原始来源路径，只作溯源；原文件变更或删除不影响库内作品。 */
  readonly sourcePath: string | null
  readonly bytes: number
}

/** 作品来源：项目名、项目路径、会话标识与登记日期，仅作溯源，允许失效。 */
export interface PortfolioSource {
  readonly project: string
  readonly path: string
  readonly sessionId: string | null
  readonly date: string
}

/** 清单条目：只含列表需要的字段，要点以摘要形式给出。 */
export interface PortfolioEntry {
  readonly id: string
  readonly name: string
  readonly scene: string
  readonly pointsSummary: string
  readonly assetCount: number
  readonly hasCover: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

/** 单件作品全量：要点全文、全部素材与来源。 */
export interface PortfolioDetail extends PortfolioEntry {
  readonly points: string
  readonly assets: readonly PortfolioAsset[]
  readonly sources: readonly PortfolioSource[]
}

/** 通道结果：失败原因由主进程给出，页面不自造文案。 */
export type PortfolioResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string }

export type PortfolioListResult = PortfolioResult<{ readonly entries: readonly PortfolioEntry[] }>
export type PortfolioDetailResult = PortfolioResult<{ readonly entry: PortfolioDetail }>
/** 增删改只回最新条目快照，页面据此刷新列表而不重读全库。 */
export type PortfolioMutationResult = PortfolioResult<{ readonly entry: PortfolioEntry | null }>
export type PortfolioOpenAssetResult = PortfolioResult<null>

export interface PortfolioIdRequest { readonly id: string }
export interface PortfolioRenameRequest { readonly id: string; readonly name: string }
export interface PortfolioOpenAssetRequest { readonly id: string; readonly path: string }

/** 作品标识：`w_` 前缀加 26 位 Crockford base32，同时是目录名。 */
const PORTFOLIO_ID_PATTERN = /^w_[0-9A-HJKMNP-TV-Z]{26}$/

export function isPortfolioId(value: unknown): value is string {
  return typeof value === 'string' && PORTFOLIO_ID_PATTERN.test(value)
}

/** 库内相对路径：POSIX 分隔、不允许绝对路径、不允许回退层级或空字节。 */
export function isPortfolioRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 512) return false
  if (value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** 名称与场景只接受有界非空文本；要点可以为空但必须有界。 */
export function isPortfolioText(value: unknown, maxChars: number, allowEmpty = false): value is string {
  if (typeof value !== 'string' || value.includes('\0')) return false
  const trimmed = value.trim()
  return (allowEmpty || trimmed !== '') && value.length <= maxChars
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value))
}

export function isPortfolioAsset(value: unknown): value is PortfolioAsset {
  if (!isRecord(value)) return false
  return (value.kind === 'cover' || value.kind === 'snapshot')
    && isPortfolioRelativePath(value.path)
    && (value.sourcePath === null || typeof value.sourcePath === 'string')
    && isNonNegativeInteger(value.bytes)
}

export function isPortfolioSource(value: unknown): value is PortfolioSource {
  if (!isRecord(value)) return false
  return typeof value.project === 'string'
    && typeof value.path === 'string'
    && (value.sessionId === null || typeof value.sessionId === 'string')
    && typeof value.date === 'string'
}

export function isPortfolioEntry(value: unknown): value is PortfolioEntry {
  if (!isRecord(value)) return false
  return isPortfolioId(value.id)
    && typeof value.name === 'string'
    && typeof value.scene === 'string'
    && typeof value.pointsSummary === 'string'
    && isNonNegativeInteger(value.assetCount)
    && typeof value.hasCover === 'boolean'
    && isTimestamp(value.createdAt)
    && isTimestamp(value.updatedAt)
}

export function isPortfolioDetail(value: unknown): value is PortfolioDetail {
  if (!isPortfolioEntry(value)) return false
  const detail = value as unknown as Record<string, unknown>
  return typeof detail.points === 'string'
    && Array.isArray(detail.assets) && detail.assets.every(isPortfolioAsset)
    && Array.isArray(detail.sources) && detail.sources.every(isPortfolioSource)
}

function isPortfolioResultOf<T>(
  value: unknown,
  parse: (data: unknown) => boolean
): value is PortfolioResult<T> {
  if (!isRecord(value)) return false
  if (value.ok === true) return parse(value.data) && Object.keys(value).length === 2
  return value.ok === false && typeof value.error === 'string' && Object.keys(value).length === 2
}

export function isPortfolioListResult(value: unknown): value is PortfolioListResult {
  return isPortfolioResultOf(value, data => isRecord(data)
    && Array.isArray(data.entries) && data.entries.every(isPortfolioEntry)
    && Object.keys(data).length === 1)
}

export function isPortfolioDetailResult(value: unknown): value is PortfolioDetailResult {
  return isPortfolioResultOf(value, data => isRecord(data)
    && isPortfolioDetail(data.entry)
    && Object.keys(data).length === 1)
}

export function isPortfolioMutationResult(value: unknown): value is PortfolioMutationResult {
  return isPortfolioResultOf(value, data => isRecord(data)
    && (data.entry === null || isPortfolioEntry(data.entry))
    && Object.keys(data).length === 1)
}

export function isPortfolioOpenAssetResult(value: unknown): value is PortfolioOpenAssetResult {
  return isPortfolioResultOf(value, data => data === null)
}

/** 页面桥：只暴露六条受限通道，不开放目录、文件读取或任意路径。 */
export interface PortfolioApi {
  readonly listPortfolio: () => Promise<PortfolioListResult>
  readonly readPortfolio: (request: PortfolioIdRequest) => Promise<PortfolioDetailResult>
  readonly deletePortfolio: (request: PortfolioIdRequest) => Promise<PortfolioMutationResult>
  readonly renamePortfolio: (request: PortfolioRenameRequest) => Promise<PortfolioMutationResult>
  readonly capturePortfolioCover: (request: PortfolioIdRequest) => Promise<PortfolioMutationResult>
  readonly openPortfolioAsset: (request: PortfolioOpenAssetRequest) => Promise<PortfolioOpenAssetResult>
}
