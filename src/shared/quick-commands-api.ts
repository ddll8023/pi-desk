/**
 * 定义快捷命令的固定通道、载荷类型与跨进程校验。
 *
 * 快捷命令是一份用户自己维护的清单：每条命令有一个展示标签、一段终端命令文本、是否追加回车立即执行，
 * 以及作用范围（全局，或某个项目）。作用范围用项目规范路径表达，与 Project Trust 同一套键；
 * 运行目标是终端，不涉及 Runtime、会话与信任流程。
 *
 * 保存是整份清单替换：主进程按 id 去重、补齐缺失或重复的 id，并把条数、标签长度与命令文本长度收敛到上限。
 * 页面提交前做同样的规范化，因此用户看到的顺序与条数就是实际保存的内容。
 */
import type { PreferencesError } from './preferences-api'

export const QUICK_COMMANDS_GET_CHANNEL = 'desktop:quick-commands-get'
export const QUICK_COMMANDS_SET_CHANNEL = 'desktop:quick-commands-set'

/** 命令条数上限；超出按提交顺序截断，避免配置文件无界增长。 */
export const MAX_QUICK_COMMANDS = 50
/** 标签长度上限；标签只用于菜单与清单展示。 */
export const MAX_QUICK_COMMAND_LABEL_LENGTH = 40
/** 命令文本长度上限；按 UTF-16 码元计，与终端写入口径一致。 */
export const MAX_QUICK_COMMAND_TEXT_LENGTH = 2000
/** 命令标识长度上限；只拒绝明显异常的值，真实唯一性由主进程保证。 */
export const MAX_QUICK_COMMAND_ID_LENGTH = 128
/** 项目路径长度上限；只拒绝明显异常的值，是否为已登记项目由页面与主进程各自核对。 */
export const MAX_QUICK_COMMAND_PATH_LENGTH = 4096

/** 作用范围：`global` 在所有项目可用，`project` 只在 `projectPath` 对应的项目可用。 */
export type QuickCommandScope = 'global' | 'project'

/** 一条快捷命令；`projectPath` 只在 `project` 范围下有值，全局命令为 null。 */
export interface QuickCommand {
  readonly id: string
  readonly label: string
  readonly command: string
  /** 为真时写入终端后补一个回车立即执行；为假只插入文本，由用户自己确认。 */
  readonly appendEnter: boolean
  readonly scope: QuickCommandScope
  readonly projectPath: string | null
}

/** 快捷命令清单；数组顺序即菜单与设置页的展示顺序。 */
export interface QuickCommandsPreference {
  readonly commands: readonly QuickCommand[]
}

export type QuickCommandsResult =
  | { readonly ok: true; readonly data: QuickCommandsPreference }
  | { readonly ok: false; readonly error: PreferencesError }

export interface QuickCommandsApi {
  /** 读取快捷命令清单；配置缺失或非法时主进程返回空清单。 */
  readonly getQuickCommands: () => Promise<QuickCommandsResult>
  /** 保存快捷命令清单；返回主进程规范化后的清单，不修改 Pi 配置。 */
  readonly setQuickCommands: (preference: QuickCommandsPreference) => Promise<QuickCommandsResult>
}

// 与 preferences-api.ts 的共享错误码保持一致；快捷命令不追加专有错误码。
const QUICK_COMMANDS_ERROR_CODES: readonly string[] = [
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

/**
 * 项目路径字段只接受绝对路径：Windows 盘符或 POSIX 根开头。
 * 共享模块同时被主进程与沙箱页面加载，因此不引入 `node:path`。
 */
function isAbsolutePathLike(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)
}

/** 作用范围只接受两个字面量；其他取值一律拒绝。 */
export function isQuickCommandScope(value: unknown): value is QuickCommandScope {
  return value === 'global' || value === 'project'
}

/**
 * 单条命令的形状校验：拒绝多余字段、越界长度与非法的范围组合。
 * 文本只在这里判空与判长，trim 与 id 补齐由主进程存储层完成。
 */
export function isQuickCommand(value: unknown): value is QuickCommand {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => (
    key === 'id' || key === 'label' || key === 'command'
      || key === 'appendEnter' || key === 'scope' || key === 'projectPath'
  ))) return false
  if (typeof value.id !== 'string' || value.id === '' || value.id.length > MAX_QUICK_COMMAND_ID_LENGTH) return false
  if (typeof value.label !== 'string' || value.label.length > MAX_QUICK_COMMAND_LABEL_LENGTH) return false
  if (typeof value.command !== 'string' || value.command === ''
    || value.command.length > MAX_QUICK_COMMAND_TEXT_LENGTH) return false
  if (typeof value.appendEnter !== 'boolean') return false
  if (!isQuickCommandScope(value.scope)) return false
  if (value.scope === 'global') return value.projectPath === null
  return typeof value.projectPath === 'string' && value.projectPath !== ''
    && value.projectPath.length <= MAX_QUICK_COMMAND_PATH_LENGTH && isAbsolutePathLike(value.projectPath)
}

/** 清单请求的形状校验：只允许 `commands` 字段，条数不超过上限。 */
export function isQuickCommandsPreference(value: unknown): value is QuickCommandsPreference {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'commands')) return false
  return Array.isArray(value.commands)
    && value.commands.length <= MAX_QUICK_COMMANDS
    && value.commands.every((command) => isQuickCommand(command))
}

/** 与偏好结果同一形状：成功返回已确认的清单，失败保留主进程错误。 */
export function isQuickCommandsResult(value: unknown): value is QuickCommandsResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isQuickCommandsPreference(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false
  return typeof value.error.message === 'string'
    && typeof value.error.code === 'string'
    && QUICK_COMMANDS_ERROR_CODES.includes(value.error.code)
}
