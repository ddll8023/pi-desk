/** 局域网手机访问契约：扫码、后台会话、无路径命令候选与受限压缩；设备凭证摘要不进入响应。 */
import { COMPACT_INSTRUCTIONS_MAX_CHARS, isHistoryData, isHistoryQuery, isProjectionResult, isPromptResult, isRuntimeStatus, isRuntimeTarget } from './runtime-api'
import type { HistoryData, HistoryQuery, PiResourceEntry, ProjectionSnapshot, PromptResult, RuntimeStatus, RuntimeTarget } from './runtime-api'
import { isExtensionDialogResponseInput, isExtensionUiSnapshot } from './extension-ui-api'
import type { ExtensionDialogResponseInput, ExtensionUiSnapshot } from './extension-ui-api'
import { isSessionListResult, MAX_SESSION_WINDOW } from './session-api'
import type { SessionSummary } from './session-api'

export const LAN_REMOTE_CONTROL_CHANNEL = 'desktop:lan-remote-control'
export const LAN_REMOTE_STATE_EVENT = 'desktop:lan-remote-state'
export const LAN_REMOTE_PROTOCOL_VERSION = 2
export const LAN_REMOTE_MAX_DEVICES = 16
export const LAN_REMOTE_MAX_MESSAGE_CHARS = 64_000

export interface LanStoredDevice {
  readonly id: string
  readonly name: string
  readonly tokenHash: string
  readonly createdAt: number
  readonly expiresAt: number
}
export type LanDevice = Omit<LanStoredDevice, 'tokenHash'>
export interface LanRemoteState {
  readonly phase: 'stopped' | 'starting' | 'running' | 'stopping'
  readonly origin: string | null
  readonly origins: readonly string[]
  readonly serverId: string | null
  readonly devices: readonly LanDevice[]
  readonly lastError: string | null
}
export type LanResult<T> = { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export type LanControlRequest =
  | { readonly action: 'state' | 'start' | 'stop' | 'pair' }
  | { readonly action: 'revoke'; readonly deviceId: string }
export type LanControlData =
  | { readonly kind: 'state'; readonly state: LanRemoteState }
  | { readonly kind: 'pairing'; readonly url: string; readonly expiresAt: number; readonly serverId: string }
export interface LanRemoteApi {
  readonly controlLanRemote: (request: LanControlRequest) => Promise<LanResult<LanControlData>>
  readonly onLanRemoteStateChanged: (listener: (state: LanRemoteState) => void) => () => void
}
export interface LanSessionRef {
  readonly projectId: string
  readonly sessionId: string
}
export interface LanSessionTarget extends LanSessionRef {
  readonly target: RuntimeTarget & { readonly runtimeId: number }
}
export type LanOperation =
  | { readonly operation: 'projects' }
  | { readonly operation: 'sessions'; readonly projectId: string; readonly limit: number }
  | { readonly operation: 'commandPreview'; readonly projectId: string; readonly force: boolean }
  | ({ readonly operation: 'commands' } & LanSessionTarget)
  | ({ readonly operation: 'compact'; readonly instructions: string | null } & LanSessionTarget)
  | ({ readonly operation: 'history'; readonly query: HistoryQuery } & LanSessionRef)
  | ({ readonly operation: 'open' } & LanSessionRef)
  | { readonly operation: 'create'; readonly projectId: string; readonly message: string }
  | ({ readonly operation: 'snapshot' | 'abort' } & LanSessionTarget)
  | ({ readonly operation: 'prompt'; readonly message: string } & LanSessionTarget)
  | ({ readonly operation: 'respond'; readonly dialogId: string; readonly response: ExtensionDialogResponseInput } & LanSessionTarget)
export interface LanRequest {
  /** 与 Cookie 实际认证身份一致；重新配对后禁止旧写请求换一个去重命名空间执行。 */
  readonly deviceId: string
  readonly serverId: string
  readonly requestId: string
  readonly command: LanOperation
}

export function isLanRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function hasLanKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
export function isLanIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 255
}
export function isLanStoredDevice(value: unknown): value is LanStoredDevice {
  return isLanRecord(value) && isLanIdentifier(value.id)
    && typeof value.name === 'string' && value.name.trim() !== '' && value.name.length <= 80
    && typeof value.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(value.tokenHash)
    && typeof value.createdAt === 'number' && Number.isSafeInteger(value.createdAt) && value.createdAt > 0
    && typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt) && value.expiresAt > value.createdAt
}
/** 仅识别私有、链路本地和回环 IPv4，不把代理转发头当作局域网来源。 */
export function isLanAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false
  const parts = value.split('.').map(Number)
  if (parts.some(part => part < 0 || part > 255) || parts.join('.') !== value) return false
  const [first, second] = parts
  return first === 10 || first === 127 || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168) || (first === 169 && second === 254)
}
/** 自动生成的局域网 HTTP 根地址，不接受域名、代理来源或带凭证的地址。 */
export function isLanOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && isLanAddress(url.hostname) && url.origin === value
      && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === ''
  } catch { return false }
}
export function isLanControlRequest(value: unknown): value is LanControlRequest {
  if (!isLanRecord(value)) return false
  switch (value.action) {
    case 'state': case 'start': case 'stop': case 'pair': return hasLanKeys(value, ['action'])
    case 'revoke': return hasLanKeys(value, ['action', 'deviceId']) && isLanIdentifier(value.deviceId)
    default: return false
  }
}
export function isLanSessionTarget(value: unknown): value is LanSessionTarget {
  return isLanRecord(value) && isLanIdentifier(value.projectId) && isLanIdentifier(value.sessionId)
    && isRuntimeTarget(value.target) && value.target.runtimeId !== null
}
export function isLanRequest(value: unknown): value is LanRequest {
  if (!isLanRecord(value) || !hasLanKeys(value, ['deviceId', 'serverId', 'requestId', 'command'])
    || !isLanIdentifier(value.deviceId) || !isLanIdentifier(value.serverId) || !isLanIdentifier(value.requestId) || !isLanRecord(value.command)) return false
  const command = value.command
  switch (command.operation) {
    case 'projects': return hasLanKeys(command, ['operation'])
    case 'sessions': return hasLanKeys(command, ['operation', 'projectId', 'limit']) && isLanIdentifier(command.projectId)
      && typeof command.limit === 'number' && Number.isInteger(command.limit) && command.limit >= 1 && command.limit <= MAX_SESSION_WINDOW
    case 'history': return hasLanKeys(command, ['operation', 'projectId', 'sessionId', 'query'])
      && isLanIdentifier(command.projectId) && isLanIdentifier(command.sessionId) && isHistoryQuery(command.query)
    case 'open': return hasLanKeys(command, ['operation', 'projectId', 'sessionId'])
      && isLanIdentifier(command.projectId) && isLanIdentifier(command.sessionId)
    case 'create': return hasLanKeys(command, ['operation', 'projectId', 'message']) && isLanIdentifier(command.projectId)
      && typeof command.message === 'string' && command.message.trim() !== '' && command.message.length <= LAN_REMOTE_MAX_MESSAGE_CHARS
    case 'commandPreview': return hasLanKeys(command, ['operation', 'projectId', 'force'])
      && isLanIdentifier(command.projectId) && typeof command.force === 'boolean'
    case 'commands': case 'snapshot': case 'abort': return hasLanKeys(command, ['operation', 'projectId', 'sessionId', 'target']) && isLanSessionTarget(command)
    case 'compact': return hasLanKeys(command, ['operation', 'projectId', 'sessionId', 'target', 'instructions'])
      && isLanSessionTarget(command) && (command.instructions === null
        || (typeof command.instructions === 'string' && command.instructions.length <= COMPACT_INSTRUCTIONS_MAX_CHARS))
    case 'prompt': return hasLanKeys(command, ['operation', 'projectId', 'sessionId', 'target', 'message'])
      && isLanSessionTarget(command) && typeof command.message === 'string'
      && command.message.trim() !== '' && command.message.length <= LAN_REMOTE_MAX_MESSAGE_CHARS
    case 'respond': return hasLanKeys(command, ['operation', 'projectId', 'sessionId', 'target', 'dialogId', 'response'])
      && isLanSessionTarget(command) && isLanIdentifier(command.dialogId) && isExtensionDialogResponseInput(command.response)
    default: return false
  }
}
export function isLanRemoteState(value: unknown): value is LanRemoteState {
  if (!isLanRecord(value) || typeof value.phase !== 'string'
    || !['stopped', 'starting', 'running', 'stopping'].includes(value.phase)) return false
  return (value.origin === null || isLanOrigin(value.origin))
    && Array.isArray(value.origins) && value.origins.every(isLanOrigin)
    && (value.origin === null || value.origins.includes(value.origin))
    && (value.serverId === null || isLanIdentifier(value.serverId))
    && (value.lastError === null || typeof value.lastError === 'string')
    && Array.isArray(value.devices) && value.devices.length <= LAN_REMOTE_MAX_DEVICES && value.devices.every(entry =>
      isLanRecord(entry) && isLanIdentifier(entry.id) && typeof entry.name === 'string'
      && typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
      && typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) && !Object.hasOwn(entry, 'tokenHash'))
}
export function isLanControlResult(value: unknown): value is LanResult<LanControlData> {
  if (!isLanRecord(value)) return false
  if (value.ok === false) return isLanRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string'
  if (value.ok !== true || !isLanRecord(value.data)) return false
  const data = value.data
  if (data.kind === 'state') return isLanRemoteState(data.state)
  return data.kind === 'pairing' && typeof data.url === 'string' && isLanIdentifier(data.serverId)
    && typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt)
}

/** 手机仅接收已登记项目的显示身份与运行状态，不接收主机绝对路径。 */
export type LanProjectActiveState = 'running' | 'waiting'
export interface LanProjectSummary {
  readonly id: string
  readonly name: string
  readonly activeState?: LanProjectActiveState | null
  readonly activeCount?: number
  readonly activeSessionId?: string | null
}
export interface LanProjects { readonly projects: readonly LanProjectSummary[] }
export interface LanSessionActiveInfo {
  readonly sessionId: string
  readonly state: LanProjectActiveState
}
export interface LanSessions {
  readonly projectId: string
  readonly sessions: readonly SessionSummary[]
  readonly remaining: number
  readonly skipped: number
  readonly limit: number
  readonly activeSessions?: readonly LanSessionActiveInfo[]
}
export interface LanConnectionInfo {
  readonly serverId: string
  readonly protocolVersion: number
  readonly deviceId: string
}
export interface LanPairResult {
  readonly serverId: string
  readonly protocolVersion: number
  readonly device: LanDevice
}
/** 手机候选只包含补全需要的显示字段，不携带资源路径或正文。 */
export type LanCommandEntry = Pick<PiResourceEntry, 'kind' | 'name' | 'description'>
export interface LanCommands {
  readonly projectId: string
  readonly sessionId: string | null
  readonly runtimeId: number | null
  readonly entries: readonly LanCommandEntry[]
  /** 预读没有截断信息；仅绑定资源清单报告是否被截断。 */
  readonly truncated: boolean | null
}
export interface LanOpenedSession extends LanSessionRef { readonly target: RuntimeTarget }
/** 创建与首条消息共用去重身份；即使消息被拒绝，也交回已创建会话，避免重试时重复创建。 */
export interface LanCreatedSession extends LanOpenedSession { readonly prompt: PromptResult }
export interface LanHistory extends LanSessionRef { readonly data: HistoryData }
export interface LanSnapshot {
  readonly status: RuntimeStatus
  readonly projection: ProjectionSnapshot
  readonly interaction: ExtensionUiSnapshot
}
export interface LanInvalidation { readonly code: string; readonly message: string }

export function isLanEnvelope<T>(value: unknown, accepts: (data: unknown) => data is T): value is LanResult<T> {
  if (!isLanRecord(value)) return false
  if (value.ok === false) return isLanInvalidation(value.error)
  return value.ok === true && accepts(value.data)
}
export function isLanInvalidation(value: unknown): value is LanInvalidation {
  return isLanRecord(value) && typeof value.code === 'string' && typeof value.message === 'string'
}
export function isLanDevice(value: unknown): value is LanDevice {
  return isLanRecord(value) && !Object.hasOwn(value, 'tokenHash')
    && isLanStoredDevice({ ...value, tokenHash: '0'.repeat(64) })
}
export function isLanProjects(value: unknown): value is LanProjects {
  return isLanRecord(value) && Array.isArray(value.projects)
    && value.projects.every(project => isLanRecord(project) && isLanIdentifier(project.id) && typeof project.name === 'string'
      && (project.activeState === undefined || project.activeState === null || project.activeState === 'running' || project.activeState === 'waiting')
      && (project.activeCount === undefined || (typeof project.activeCount === 'number' && Number.isSafeInteger(project.activeCount) && project.activeCount >= 0))
      && (project.activeSessionId === undefined || project.activeSessionId === null || isLanIdentifier(project.activeSessionId)))
}
export function isLanSessions(value: unknown): value is LanSessions {
  return isLanRecord(value) && isLanIdentifier(value.projectId)
    && isSessionListResult({ ok: true, data: { sessions: value.sessions, remaining: value.remaining,
      skipped: value.skipped, limit: value.limit, projectPath: null } })
    && (value.activeSessions === undefined || (Array.isArray(value.activeSessions) && value.activeSessions.every(entry =>
      isLanRecord(entry) && isLanIdentifier(entry.sessionId) && (entry.state === 'running' || entry.state === 'waiting'))))
}
export function isLanConnectionInfo(value: unknown): value is LanConnectionInfo {
  return isLanRecord(value) && isLanIdentifier(value.serverId) && isLanIdentifier(value.deviceId)
    && typeof value.protocolVersion === 'number' && Number.isSafeInteger(value.protocolVersion)
}
export function isLanPairResult(value: unknown): value is LanPairResult {
  return isLanRecord(value) && isLanIdentifier(value.serverId) && isLanDevice(value.device)
    && typeof value.protocolVersion === 'number' && Number.isSafeInteger(value.protocolVersion)
}
export function isLanCommands(value: unknown): value is LanCommands {
  if (!isLanRecord(value) || !isLanIdentifier(value.projectId)
    || (value.truncated !== null && typeof value.truncated !== 'boolean')) return false
  const identity = (value.sessionId === null && value.runtimeId === null)
    || (isLanIdentifier(value.sessionId) && typeof value.runtimeId === 'number' && Number.isSafeInteger(value.runtimeId) && value.runtimeId > 0)
  return identity && Array.isArray(value.entries) && value.entries.every(entry => isLanRecord(entry)
    && hasLanKeys(entry, ['kind', 'name', 'description'])
    && (entry.kind === 'skill' || entry.kind === 'prompt' || entry.kind === 'extension')
    && typeof entry.name === 'string' && entry.name.trim() !== ''
    && (entry.description === null || typeof entry.description === 'string'))
}
export function isLanOpenedSession(value: unknown): value is LanOpenedSession {
  return isLanRecord(value) && isLanIdentifier(value.projectId) && isLanIdentifier(value.sessionId) && isRuntimeTarget(value.target)
}
export function isLanCreatedSession(value: unknown): value is LanCreatedSession {
  return isLanOpenedSession(value) && isLanRecord(value) && isPromptResult(value.prompt)
    && (value.target.runtimeId !== null || !value.prompt.ok)
}
export function isLanHistory(value: unknown): value is LanHistory {
  return isLanRecord(value) && isLanIdentifier(value.projectId) && isLanIdentifier(value.sessionId) && isHistoryData(value.data)
}
export function isLanSnapshot(value: unknown): value is LanSnapshot {
  return isLanRecord(value) && isRuntimeStatus(value.status)
    && isProjectionResult({ ok: true, data: value.projection }) && isExtensionUiSnapshot(value.interaction)
}
