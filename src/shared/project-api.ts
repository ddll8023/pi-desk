/** 只定义 Project 目录选择、列表与切换 IPC 的固定通道、结果类型与跨进程响应校验。 */
import type { DesktopErrorCode } from './desktop-api'

export const PROJECT_CHOOSE_DIRECTORY_CHANNEL = 'desktop:project-choose-directory'
export const PROJECT_LIST_CHANNEL = 'desktop:project-list'
export const PROJECT_SET_CURRENT_CHANNEL = 'desktop:project-set-current'

/** 项目基础属性；`path` 是主进程归一化后的规范绝对路径，`lastOpenedAt` 是纪元毫秒。 */
export interface Project {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly lastOpenedAt: number
}

/** 目录选择结果；`null` 表示用户取消，取消不是失败。 */
export interface ProjectPathSelection {
  readonly path: string
  readonly name: string
}

/** `storageNotice` 非空表示本地配置被降级处理（损坏已备份或暂时不可读），界面应如实提示。 */
export interface ProjectList {
  readonly projects: readonly Project[]
  readonly currentProjectId: string | null
  readonly storageNotice: string | null
}

/** 只有渲染端已取得用户确认时才允许 `allowInterrupt`；主进程不接受隐式中断。 */
export interface ProjectSetCurrentRequest {
  readonly path: string
  readonly allowInterrupt: boolean
}

export type ProjectErrorCode =
  | DesktopErrorCode
  | 'INVALID_PROJECT_PATH'
  | 'PROJECT_SWITCH_BLOCKED'
  | 'PROJECT_STORAGE_FAILED'

export interface ProjectError {
  readonly code: ProjectErrorCode
  readonly message: string
}

export type ProjectPathResult =
  | { readonly ok: true; readonly data: ProjectPathSelection | null }
  | { readonly ok: false; readonly error: ProjectError }

export type ProjectListResult =
  | { readonly ok: true; readonly data: ProjectList }
  | { readonly ok: false; readonly error: ProjectError }

export interface ProjectApi {
  /** 打开系统目录选择器；返回归一化后的目录，取消时为 `null`。 */
  readonly chooseProjectDirectory: () => Promise<ProjectPathResult>
  readonly listProjects: () => Promise<ProjectListResult>
  /** 把目录设为当前项目；`allowInterrupt` 为真表示用户已确认可以停止运行中的操作。 */
  readonly setCurrentProject: (path: string, allowInterrupt: boolean) => Promise<ProjectListResult>
}

// 与 desktop-api.ts 的共享错误码保持一致，再追加 Project 专有错误码。
const PROJECT_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED',
  'INVALID_PROJECT_PATH',
  'PROJECT_SWITCH_BLOCKED',
  'PROJECT_STORAGE_FAILED'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 名称允许为空字符串，由主进程按路径末段补齐；其他字段必须完整可用。 */
export function isProject(value: unknown): value is Project {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && value.id !== ''
    && typeof value.name === 'string'
    && typeof value.path === 'string'
    && value.path !== ''
    && typeof value.lastOpenedAt === 'number'
    && Number.isFinite(value.lastOpenedAt)
}

function isProjectPathSelection(value: unknown): value is ProjectPathSelection {
  if (!isRecord(value)) return false
  return typeof value.path === 'string'
    && value.path !== ''
    && typeof value.name === 'string'
    && value.name !== ''
}

export function isProjectList(value: unknown): value is ProjectList {
  if (!isRecord(value)) return false
  if (!Array.isArray(value.projects) || !value.projects.every(isProject)) return false
  if (value.currentProjectId !== null && typeof value.currentProjectId !== 'string') return false
  return value.storageNotice === null || typeof value.storageNotice === 'string'
}

function isProjectErrorResult(value: Record<string, unknown>): boolean {
  if (value.ok !== false || !isRecord(value.error)) return false
  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && PROJECT_ERROR_CODES.includes(code)
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isProjectPathResult(value: unknown): value is ProjectPathResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return value.data === null || isProjectPathSelection(value.data)
  return isProjectErrorResult(value)
}

export function isProjectListResult(value: unknown): value is ProjectListResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isProjectList(value.data)
  return isProjectErrorResult(value)
}
