/** 手机访问控制与远程会话白名单契约：仅支持可信 HTTPS 代理接入，设备凭证摘要不进入响应。 */
import { isHistoryData, isHistoryQuery, isProjectionResult, isRuntimeStatus, isRuntimeTarget } from './runtime-api'
import type { HistoryData, HistoryQuery, ProjectionSnapshot, RuntimeStatus, RuntimeTarget } from './runtime-api'
import { isExtensionDialogResponseInput, isExtensionUiSnapshot } from './extension-ui-api'
import type { ExtensionDialogResponseInput, ExtensionUiSnapshot } from './extension-ui-api'
import { isSessionListResult, MAX_SESSION_WINDOW } from './session-api'
import type { SessionSummary } from './session-api'

export const LAN_REMOTE_CONTROL_CHANNEL = 'desktop:lan-remote-control'
export const LAN_REMOTE_STATE_EVENT = 'desktop:lan-remote-state'
export const LAN_REMOTE_PROTOCOL_VERSION = 1
export const LAN_REMOTE_MAX_DEVICES = 16
export const LAN_REMOTE_MAX_PROJECTS = 50
export const LAN_REMOTE_MAX_MESSAGE_CHARS = 64_000

export interface LanStoredDevice {
  readonly id: string
  readonly name: string
  readonly tokenHash: string
  readonly projectIds: readonly string[]
  readonly createdAt: number
  readonly expiresAt: number
}
export type LanDevice = Omit<LanStoredDevice, 'tokenHash'>
export interface LanStartOptions {
  readonly publicOrigin: string
  readonly port: number
}
export interface LanRemoteState {
  readonly phase: 'stopped' | 'starting' | 'running' | 'stopping'
  readonly localOrigin: string | null
  readonly origin: string | null
  readonly serverId: string | null
  readonly devices: readonly LanDevice[]
  readonly lastError: string | null
}
export type LanResult<T> = { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export type LanControlRequest =
  | { readonly action: 'state' | 'stop' }
  | ({ readonly action: 'start' } & LanStartOptions)
  | { readonly action: 'pair'; readonly projectIds: readonly string[] }
  | { readonly action: 'revoke'; readonly deviceId: string }
  | { readonly action: 'grant'; readonly deviceId: string; readonly projectIds: readonly string[] }
export type LanControlData =
  | { readonly kind: 'state'; readonly state: LanRemoteState }
  | { readonly kind: 'pairing'; readonly url: string; readonly expiresAt: number }
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
  | ({ readonly operation: 'history'; readonly query: HistoryQuery } & LanSessionRef)
  | ({ readonly operation: 'open' } & LanSessionRef)
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
export function isLanProjectIds(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= LAN_REMOTE_MAX_PROJECTS
    && value.every(isLanIdentifier) && new Set(value).size === value.length
}
export function isLanStoredDevice(value: unknown): value is LanStoredDevice {
  return isLanRecord(value) && isLanIdentifier(value.id)
    && typeof value.name === 'string' && value.name.trim() !== '' && value.name.length <= 80
    && typeof value.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(value.tokenHash)
    && isLanProjectIds(value.projectIds)
    && typeof value.createdAt === 'number' && Number.isSafeInteger(value.createdAt) && value.createdAt > 0
    && typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt) && value.expiresAt > value.createdAt
}
/** 只接受 HTTPS 来源根地址；不接收凭证、路径前缀或重定向配置，也不发起网络探测。 */
export function isLanPublicOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value || /[\s\\]/.test(value)) return false
  try {
    const url = new URL(value)
    return /^https:\/\/[^/?#]+\/?$/i.test(value) && url.protocol === 'https:' && url.hostname !== ''
      && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === ''
  } catch { return false }
}
export function isLanControlRequest(value: unknown): value is LanControlRequest {
  if (!isLanRecord(value)) return false
  switch (value.action) {
    case 'state': case 'stop': return hasLanKeys(value, ['action'])
    case 'start': return hasLanKeys(value, ['action', 'publicOrigin', 'port']) && isLanPublicOrigin(value.publicOrigin)
      && typeof value.port === 'number' && Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535
    case 'pair': return hasLanKeys(value, ['action', 'projectIds']) && isLanProjectIds(value.projectIds) && value.projectIds.length > 0
    case 'revoke': return hasLanKeys(value, ['action', 'deviceId']) && isLanIdentifier(value.deviceId)
    case 'grant': return hasLanKeys(value, ['action', 'deviceId', 'projectIds'])
      && isLanIdentifier(value.deviceId) && isLanProjectIds(value.projectIds)
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
    case 'snapshot': case 'abort': return hasLanKeys(command, ['operation', 'projectId', 'sessionId', 'target']) && isLanSessionTarget(command)
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
  return (value.localOrigin === null || typeof value.localOrigin === 'string')
    && (value.origin === null || isLanPublicOrigin(value.origin))
    && (value.serverId === null || isLanIdentifier(value.serverId))
    && (value.lastError === null || typeof value.lastError === 'string')
    && Array.isArray(value.devices) && value.devices.length <= LAN_REMOTE_MAX_DEVICES && value.devices.every(entry =>
      isLanRecord(entry) && isLanIdentifier(entry.id) && typeof entry.name === 'string' && isLanProjectIds(entry.projectIds)
      && typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
      && typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) && !Object.hasOwn(entry, 'tokenHash'))
}
export function isLanControlResult(value: unknown): value is LanResult<LanControlData> {
  if (!isLanRecord(value)) return false
  if (value.ok === false) return isLanRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string'
  if (value.ok !== true || !isLanRecord(value.data)) return false
  const data = value.data
  if (data.kind === 'state') return isLanRemoteState(data.state)
  return data.kind === 'pairing' && typeof data.url === 'string' && typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt)
}

/** 手机仅接收已授权项目的显示身份，不接收主机绝对路径。 */
export interface LanProjectSummary { readonly id: string; readonly name: string }
export interface LanProjects { readonly projects: readonly LanProjectSummary[] }
export interface LanSessions {
  readonly projectId: string
  readonly sessions: readonly SessionSummary[]
  readonly remaining: number
  readonly skipped: number
  readonly limit: number
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
export interface LanOpenedSession extends LanSessionRef { readonly target: RuntimeTarget }
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
  return isLanRecord(value) && Array.isArray(value.projects) && value.projects.length <= LAN_REMOTE_MAX_PROJECTS
    && value.projects.every(project => isLanRecord(project) && isLanIdentifier(project.id) && typeof project.name === 'string')
}
export function isLanSessions(value: unknown): value is LanSessions {
  return isLanRecord(value) && isLanIdentifier(value.projectId)
    && isSessionListResult({ ok: true, data: { sessions: value.sessions, remaining: value.remaining,
      skipped: value.skipped, limit: value.limit, projectPath: null } })
}
export function isLanConnectionInfo(value: unknown): value is LanConnectionInfo {
  return isLanRecord(value) && isLanIdentifier(value.serverId) && isLanIdentifier(value.deviceId)
    && typeof value.protocolVersion === 'number' && Number.isSafeInteger(value.protocolVersion)
}
export function isLanPairResult(value: unknown): value is LanPairResult {
  return isLanRecord(value) && isLanIdentifier(value.serverId) && isLanDevice(value.device)
    && typeof value.protocolVersion === 'number' && Number.isSafeInteger(value.protocolVersion)
}
export function isLanOpenedSession(value: unknown): value is LanOpenedSession {
  return isLanRecord(value) && isLanIdentifier(value.projectId) && isLanIdentifier(value.sessionId) && isRuntimeTarget(value.target)
}
export function isLanHistory(value: unknown): value is LanHistory {
  return isLanRecord(value) && isLanIdentifier(value.projectId) && isLanIdentifier(value.sessionId) && isHistoryData(value.data)
}
export function isLanSnapshot(value: unknown): value is LanSnapshot {
  return isLanRecord(value) && isRuntimeStatus(value.status)
    && isProjectionResult({ ok: true, data: value.projection }) && isExtensionUiSnapshot(value.interaction)
}
