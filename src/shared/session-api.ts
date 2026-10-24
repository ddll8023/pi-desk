/**
 * 只定义 Pi Session 列表（按项目、按窗口）、打开、重新加载、删除与历史读取 IPC 的固定通道、请求与结果类型及跨进程响应校验。
 * 历史读取按会话寻址：页面只给项目、会话与历史查询，绑定与否由主进程判定，页面不传运行实例与绑定代际。
 * 列表不分页追加而是逐页扩展窗口：每次请求都返回"最近 limit 条"，响应可直接整体替换页面已有的窗口，
 * 两次请求之间列表发生重排、新增或删除时不会产生重复行或空洞；窗口大小由页面决定，主进程只校验范围。
 */
import { isHistoryData, isHistoryQuery } from './runtime-api'
import type { HistoryData, HistoryQuery, RuntimeErrorCode } from './runtime-api'

export const SESSION_LIST_CHANNEL = 'desktop:session-list'
export const SESSION_OPEN_CHANNEL = 'desktop:session-open'
/** 重新加载 Pi 资源：在同一 SDK 宿主进程内重建该会话的 services，并尽量恢复当前会话；`allowInterrupt` 与会话打开同义。 */
export const SESSION_RELOAD_CHANNEL = 'desktop:session-reload'
/** 删除会话：删除该会话的 JSONL 文件，被运行实例占用时先按 `allowInterrupt` 收敛占用；不可恢复。 */
export const SESSION_DELETE_CHANNEL = 'desktop:session-delete'
/**
 * 会话历史读取：按会话身份返回历史页、轮次页或原文续段。
 * 页面只给项目与会话，不传运行实例与绑定代际：已由运行实例接管时由绑定路径作答，
 * 未接管时由日志解析作答；两条路径返回同一套消息身份，页面不必区分来源。
 */
export const SESSION_HISTORY_CHANNEL = 'desktop:session-history'

/** 会话列表首屏条数与每次“加载更多”的增量；侧栏与选择弹层共用同一分页口径。 */
export const SESSION_PAGE_SIZE = 30

/** 列表窗口上界：页面最多加载这么多条，避免无界读取与无界渲染。 */
export const MAX_SESSION_WINDOW = 200

/**
 * 会话列表请求：显式给出要读取的项目路径与窗口大小。侧栏按项目树展示会话，列表读取不再隐式取当前项目；
 * 主进程只接受已添加项目的规范绝对路径，页面不能借它读取任意目录。
 * `limit` 是"最近 limit 条"的窗口上界，页面按自己的加载进度逐页扩大；主进程不记录页面已加载到第几页。
 */
export interface SessionListRequest {
  readonly projectPath: string
  readonly limit: number
}

/** 路径长度上限；与界面偏好中的路径字段同口径，只拒绝明显异常的值。 */
const MAX_PROJECT_PATH_LENGTH = 4096

/** 列表窗口校验：只接受 1..MAX_SESSION_WINDOW 的整数，避免页面要求无界读取；主进程与契约校验共用同一口径。 */
export function isSessionListWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= 1 && value <= MAX_SESSION_WINDOW
}

/** 列表请求只放行非空的项目路径与合法窗口大小，不接受多余字段。 */
export function isSessionListRequest(value: unknown): value is SessionListRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'projectPath' && key !== 'limit')) return false
  const { projectPath } = value
  return typeof projectPath === 'string'
    && projectPath !== ''
    && projectPath.length <= MAX_PROJECT_PATH_LENGTH
    && isSessionListWindow(value.limit)
}

/** 删除请求同样只放行非空且有界的项目路径与会话 id，外加显式中断确认布尔值。 */
export function isSessionDeleteRequest(value: unknown): value is SessionDeleteRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'projectPath' && key !== 'sessionId'
    && key !== 'allowInterrupt' && key !== 'listLimit')) return false
  const { projectPath, sessionId, allowInterrupt } = value
  return typeof projectPath === 'string'
    && projectPath !== ''
    && projectPath.length <= MAX_PROJECT_PATH_LENGTH
    && typeof sessionId === 'string'
    && sessionId !== ''
    && sessionId.length <= 255
    && typeof allowInterrupt === 'boolean'
    && isSessionListWindow(value.listLimit)
}

/**
 * 会话摘要只读会话文件的元数据：`createdAt` 来自文件头部的时间戳，`updatedAt` 是文件最后修改
 * 时间（纪元毫秒），`preview` 是有界读取得到的首条用户消息文本（已剔除 Pi 注入的 `[Image: …]` 标记行与
 * `/skill:` 展开的技能块，空白折叠为单个空格），取不到时为 null。
 *
 * `forkedFromSessionId` 是回退（Pi 的 fork）产生的来源会话 id：回退会新建会话文件并保留原文件，
 * 两个文件都留在同一目录里；列表把分叉链折叠为最新一条，来源会话只在分叉来源标注里出现。
 *
 * 列表是窗口而不是全量：主进程按最近修改时间排序后只读取窗口内的文件，因此窗口外的会话既没有摘要，
 * 也没有参与归属校验；`remaining` 是窗口外的文件数上界，只用于表达"还有更多可加载"。
 */
export interface SessionSummary {
  readonly sessionId: string
  readonly createdAt: string
  readonly updatedAt: number
  readonly sizeBytes: number
  readonly preview: string | null
  readonly forkedFromSessionId: string | null
}

export interface SessionList {
  readonly sessions: readonly SessionSummary[]
  /**
   * 无法读取或不属于该项目的文件数：stat 失败覆盖整个分组目录，解析失败只覆盖本次窗口内的文件；
   * 界面按"已加载部分"如实提示，不承诺它是整目录的完整统计。
   */
  readonly skipped: number
  /**
   * 本次窗口之外仍未读取的会话文件数，是"还有更多可加载"的上界；
   * 其中可能含无法解析或不属于该项目的文件，所以不能当作有效会话数展示。
   */
  readonly remaining: number
  /** 本次返回的窗口上界，等于请求中的 `limit`；页面据此确定自己的加载进度。 */
  readonly limit: number
  /**
   * 本次实际读取的项目路径；等于请求中的路径，未选择项目时不可能出现（列表请求必须带项目）。
   * 页面据此把结果归入对应项目的分片，不把旧项目的列表当成新项目的。
   */
  readonly projectPath: string | null
}

/**
 * `sessionId` 为 null 表示新建会话；`allowInterrupt` 只有用户已确认时才为真。
 * 打开只确认实际实例与会话身份，不回传会话列表：列表由独立的窗口读取维护，
 * 否则一次切换就要等整目录扫描，热切换被磁盘读取代价拖住。
 */
export interface SessionOpenRequest {
  readonly projectPath: string
  readonly sessionId: string | null
  readonly allowInterrupt: boolean
}

/** 打开请求固定项目归属，不允许在异步信任检查后重新解释当前项目。 */
export function isSessionOpenRequest(value: unknown): value is SessionOpenRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => !['projectPath', 'sessionId', 'allowInterrupt'].includes(key))) return false
  return typeof value.projectPath === 'string' && value.projectPath.trim() !== ''
    && value.projectPath.length <= MAX_PROJECT_PATH_LENGTH
    && (value.sessionId === null || (typeof value.sessionId === 'string'
      && value.sessionId.trim() !== '' && value.sessionId.length <= 255))
    && typeof value.allowInterrupt === 'boolean'
}

/**
 * 删除会话请求：显式给出会话所属项目路径与会话 id；项目必须是已添加项目，会话必须属于该项目。
 * `allowInterrupt` 只有用户已确认时才为真：目标会话正被运行实例占用且在途工作未完成时，
 * 只有确认过中断才允许释放占用并删除。
 * `listLimit` 是删除后回传列表的窗口上界：页面按已加载深度提交，删除不会把列表塌回首屏。
 */
export interface SessionDeleteRequest {
  readonly projectPath: string
  readonly sessionId: string
  readonly allowInterrupt: boolean
  readonly listLimit: number
}

/**
 * 历史读取请求：显式给出项目、会话身份与历史查询。主进程复核项目已登记、文件归属该项目后才读，
 * 因此页面既不能借它读任意文件，也不能借它越过信任或占用判定去执行任何东西。
 */
export interface SessionHistoryRequest {
  readonly projectPath: string
  readonly sessionId: string
  readonly query: HistoryQuery
}

/**
 * 历史读取结果：`data` 是该会话当前分支的历史，与绑定后的权威投影使用同一套消息身份。
 * 未绑定时的结果只是展示副本：发送、回退与压缩仍以绑定是否完成为准。
 */
export interface SessionHistoryData {
  readonly projectPath: string
  readonly sessionId: string
  readonly data: HistoryData
}

export type SessionHistoryResult =
  | { readonly ok: true; readonly data: SessionHistoryData }
  | { readonly ok: false; readonly error: SessionError }

/** 历史读取请求只放行非空有界的项目路径、会话 id 与已声明的历史查询。 */
export function isSessionHistoryRequest(value: unknown): value is SessionHistoryRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'projectPath' && key !== 'sessionId' && key !== 'query')) return false
  const { projectPath, sessionId, query } = value
  return typeof projectPath === 'string' && projectPath !== ''
    && projectPath.length <= MAX_PROJECT_PATH_LENGTH
    && typeof sessionId === 'string' && sessionId !== '' && sessionId.length <= 255
    && isHistoryQuery(query)
}

/** 历史读取结果接受任何已声明的历史响应；轮次页与原文续段与绑定路径的读取同形。 */
export function isSessionHistoryResult(value: unknown): value is SessionHistoryResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isSessionFailure(value)
  if (value.ok !== true || !isRecord(value.data)) return false
  const data = value.data
  return typeof data.projectPath === 'string' && data.projectPath !== ''
    && typeof data.sessionId === 'string' && data.sessionId !== ''
    && isHistoryData(data.data)
}

/** 复用 Runtime 错误码族，只追加 Session 专有错误码。 */
export type SessionErrorCode = RuntimeErrorCode | 'SESSION_NOT_FOUND' | 'SESSION_SWITCH_BLOCKED'

/** 打开会话可能被 Project Trust 拦截，错误码集合与 Runtime 族同步维护。 */
const SESSION_EXTRA_ERROR_CODES: readonly string[] = [
  'SESSION_NOT_FOUND',
  'SESSION_SWITCH_BLOCKED'
]

export interface SessionError {
  readonly code: SessionErrorCode
  readonly message: string
}

export type SessionListResult =
  | { readonly ok: true; readonly data: SessionList }
  | { readonly ok: false; readonly error: SessionError }

/**
 * 打开结果固定实际实例与会话身份，标签绑定不依赖前台事件和请求响应的到达顺序。
 * 结果不含会话列表：列表读取失败与打开失败是两件事，不能因为过滤目录读不出来就把已经完成的切换报成失败。
 * `projectPath` 是主进程复核后的实际归属项目，页面据此丢弃迟到或错项目的结果。
 */
export interface SessionOpenData {
  readonly projectPath: string
  readonly runId: number
  readonly openedSessionId: string | null
}

export type SessionOpenResult =
  | { readonly ok: true; readonly data: SessionOpenData }
  | { readonly ok: false; readonly error: SessionError }

/** 删除会话成功时同样返回删除后的列表快照（窗口取请求里的 `listLimit`）；失败时不改变任何文件与占用。 */
export type SessionDeleteResult =
  | { readonly ok: true; readonly data: SessionList }
  | { readonly ok: false; readonly error: SessionError }

export interface SessionApi {
  /** 读取指定项目的会话列表窗口；项目必须是已添加项目，不要求它是当前项目。 */
  readonly listSessions: (request: SessionListRequest) => Promise<SessionListResult>
  /**
   * 读取某个会话当前分支的历史（页、轮次或原文续段）。会话已由运行实例接管时由绑定路径作答，
   * 未接管时由日志解析作答；结果不能用来发送、回退或改写任何东西。
   */
  readonly readSessionHistory: (request: SessionHistoryRequest) => Promise<SessionHistoryResult>
  /**
   * 打开会话；`sessionId` 为 null 表示新建，非空时必须属于显式给定的已登记项目。
   * 新建会话的默认模型由 Pi 自己的 settings.json 决定，不能在这里指定。
   * 结果只确认实际实例与会话身份，不回传会话列表：列表由 `listSessions` 按自己的窗口节奏维护。
   */
  readonly openSession: (request: SessionOpenRequest) => Promise<SessionOpenResult>
  /**
   * 重新加载 Pi 资源：在同一 SDK 宿主进程内重建该会话的 services（重新读取 Skills、Prompt Templates、
   * MCP 配置与 Extension），并尽量恢复当前会话；`allowInterrupt` 只有用户已确认时才为真。
   */
  readonly reloadSession: (allowInterrupt: boolean) => Promise<SessionOpenResult>
  /**
   * 删除会话：删除该会话的 JSONL 文件，不可恢复；会话正被运行实例占用时先收敛占用。
   * 成功时返回删除后的该会话所属项目的列表快照。
   */
  readonly deleteSession: (request: SessionDeleteRequest) => Promise<SessionDeleteResult>
}

// 与 runtime-api.ts 的共享错误码保持一致，再追加 Session 专有错误码。
const SESSION_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED',
  'INVALID_PROJECT_PATH',
  'RUNTIME_NOT_READY',
  'RUNTIME_SPAWN_FAILED',
  'RUNTIME_EXITED',
  'RUNTIME_TIMEOUT',
  'RUNTIME_PROTOCOL_ERROR',
  'RUNTIME_COMMAND_REJECTED',
  'TRUST_REQUIRED',
  ...SESSION_EXTRA_ERROR_CODES
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (!isRecord(value)) return false
  return typeof value.sessionId === 'string'
    && value.sessionId !== ''
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'number'
    && Number.isFinite(value.updatedAt)
    && typeof value.sizeBytes === 'number'
    && Number.isInteger(value.sizeBytes)
    && value.sizeBytes >= 0
    && (value.preview === null || typeof value.preview === 'string')
    && (value.forkedFromSessionId === null || typeof value.forkedFromSessionId === 'string')
}

function isSessionList(value: unknown): value is SessionList {
  if (!isRecord(value)) return false
  if (!Array.isArray(value.sessions) || !value.sessions.every(isSessionSummary)) return false
  if (value.projectPath !== null && typeof value.projectPath !== 'string') return false
  return typeof value.skipped === 'number'
    && Number.isInteger(value.skipped)
    && value.skipped >= 0
    && typeof value.remaining === 'number'
    && Number.isInteger(value.remaining)
    && value.remaining >= 0
    && isSessionListWindow(value.limit)
}

/** 失败结果只放行已声明的错误码与文案；两类结果共用同一套校验。 */
function isSessionFailure(value: Record<string, unknown>): boolean {
  if (value.ok !== false || !isRecord(value.error)) return false
  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && SESSION_ERROR_CODES.includes(code)
}

/** 打开与重载结果必须包含可绑定的实例身份与实际归属项目。 */
export function isSessionOpenResult(value: unknown): value is SessionOpenResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isSessionFailure(value)
  if (value.ok !== true) return false
  const data: unknown = value.data
  return isRecord(data)
    && typeof data.projectPath === 'string' && data.projectPath !== ''
    && typeof data.runId === 'number' && Number.isSafeInteger(data.runId) && data.runId > 0
    && (data.openedSessionId === null || typeof data.openedSessionId === 'string')
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isSessionListResult(value: unknown): value is SessionListResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isSessionList(value.data)
  return isSessionFailure(value)
}
