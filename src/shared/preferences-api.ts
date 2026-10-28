/** 定义界面偏好、对话页模型展示偏好、快捷发送短语、扩展自动更新开关与生成式 UI 开关的受限 IPC；窗口状态由主进程独占，不经过 IPC。 */
import type { DesktopErrorCode } from './desktop-api'
import type { ModelIdentity } from './runtime-api'
import { isModelIdentity } from './runtime-api'

export const PREFERENCES_GET_CHANNEL = 'desktop:preferences-get'
export const PREFERENCES_SET_UI_CHANNEL = 'desktop:preferences-set-ui'
export const PREFERENCES_GET_MODEL_DISPLAY_CHANNEL = 'desktop:preferences-get-model-display'
export const PREFERENCES_SET_MODEL_DISPLAY_CHANNEL = 'desktop:preferences-set-model-display'
export const PREFERENCES_GET_QUICK_SEND_CHANNEL = 'desktop:preferences-get-quick-send'
export const PREFERENCES_SET_QUICK_SEND_CHANNEL = 'desktop:preferences-set-quick-send'
export const PREFERENCES_GET_AUTO_UPDATE_CHANNEL = 'desktop:preferences-get-auto-update'
export const PREFERENCES_SET_AUTO_UPDATE_CHANNEL = 'desktop:preferences-set-auto-update'
export const PREFERENCES_GET_GENUI_CHANNEL = 'desktop:preferences-get-genui'
export const PREFERENCES_SET_GENUI_CHANNEL = 'desktop:preferences-set-genui'

/** 主题三档取值，与 Electron `nativeTheme.themeSource` 状态机一一对应；默认跟随系统。 */
export type UiTheme = 'system' | 'light' | 'dark'

const UI_THEMES: readonly UiTheme[] = ['system', 'light', 'dark']

export function isUiTheme(value: unknown): value is UiTheme {
  return typeof value === 'string' && UI_THEMES.includes(value as UiTheme)
}

/**
 * Markdown 文件的默认视图：只决定新打开标签的初始模式，不改变已打开标签的当前视图。
 * 默认预览：阅读是打开 Markdown 的主要用途，源码编辑再切换。
 */
export type MarkdownDefaultView = 'preview' | 'code'

const MARKDOWN_DEFAULT_VIEWS: readonly MarkdownDefaultView[] = ['preview', 'code']

export function isMarkdownDefaultView(value: unknown): value is MarkdownDefaultView {
  return typeof value === 'string' && MARKDOWN_DEFAULT_VIEWS.includes(value as MarkdownDefaultView)
}

/**
 * 终端链接打开模式：
 * - `ask`：点击普通链接时弹出操作气泡供用户选择（默认）
 * - `browser`：直接在工作区内置浏览器标签中打开
 * - `system`：直接在系统默认外部浏览器中打开
 */
export type TerminalLinkOpenMode = 'ask' | 'browser' | 'system'

const TERMINAL_LINK_OPEN_MODES: readonly TerminalLinkOpenMode[] = ['ask', 'browser', 'system']

export function isTerminalLinkOpenMode(value: unknown): value is TerminalLinkOpenMode {
  return typeof value === 'string' && TERMINAL_LINK_OPEN_MODES.includes(value as TerminalLinkOpenMode)
}

/** 侧栏展开状态的上限；超出按最早记录丢弃，避免配置文件无界增长。 */
export const MAX_EXPANDED_PROJECTS = 50

/**
 * 右侧面板宽度默认值与存储边界。
 * 默认宽度按“能容下两层目录名加图标”取值；边界只拒绝明显异常的宽度，实际拖拽范围由界面再收紧。
 */
export const DEFAULT_RIGHT_PANEL_WIDTH = 350
export const MIN_RIGHT_PANEL_WIDTH = 240
export const MAX_RIGHT_PANEL_WIDTH = 720

/** 右侧面板的页签：文件树与源代码管理共用同一列，同一时刻只显示一个。 */
export type RightPanelTab = 'files' | 'source-control'

const RIGHT_PANEL_TABS: readonly RightPanelTab[] = ['files', 'source-control']

export function isRightPanelTab(value: unknown): value is RightPanelTab {
  return typeof value === 'string' && RIGHT_PANEL_TABS.includes(value as RightPanelTab)
}

/** 路径长度上限；只用于拒绝明显异常的值，不做真实路径校验。 */
const MAX_STORED_PATH_LENGTH = 4096

/**
 * 界面偏好的路径字段只接受绝对路径：Windows 盘符或 POSIX 根开头。
 * 共享模块同时被主进程与沙箱页面加载，因此不引入 `node:path`。
 */
function isAbsolutePathLike(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)
}

/** Desktop 自己的界面偏好；不复制 Pi settings，也不保存单个消息块的临时开合状态。 */
export interface UiPreferences {
  readonly sidebarCollapsed: boolean
  readonly theme: UiTheme
  /**
   * 侧栏中保持展开的项目路径。顺序不参与展示：项目顺序始终取项目列表本身，
   * 这里只记录哪些项目展开过，切换项目或重启应用后仍能保持。
   */
  readonly expandedProjects: readonly string[]
  /** 右侧面板是否展开；默认关，聊天区是主界面，不默认占用宽度。 */
  readonly rightPanelOpen: boolean
  /** 右侧面板宽度（像素）；不按项目区分，面板宽度对同一窗口只有一个值。 */
  readonly rightPanelWidth: number
  /** 右侧面板当前页签；切换页签只换内容，不改宽度与开合状态。 */
  readonly rightPanelTab: RightPanelTab
  /** Markdown 文件新标签的默认视图；已打开的标签保持它自己的当前视图。 */
  readonly markdownDefaultView: MarkdownDefaultView
  /** 终端点击链接时的打开方式；默认弹窗询问。 */
  readonly terminalLinkOpenMode: TerminalLinkOpenMode
}

/** 右侧面板宽度是否在存储边界内；非整数与越界值一律拒绝。 */
export function isRightPanelWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= MIN_RIGHT_PANEL_WIDTH && value <= MAX_RIGHT_PANEL_WIDTH
}

/** 界面偏好的形状校验；主进程与页面共用同一份判定，多余字段、越界或不完整的载荷一律拒绝。 */
export function isUiPreferences(value: unknown): value is UiPreferences {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => (
    key === 'sidebarCollapsed' || key === 'theme' || key === 'expandedProjects'
      || key === 'rightPanelOpen' || key === 'rightPanelWidth' || key === 'rightPanelTab'
      || key === 'markdownDefaultView' || key === 'terminalLinkOpenMode'
  ))) return false
  if (typeof value.sidebarCollapsed !== 'boolean' || !isUiTheme(value.theme)) return false
  if (typeof value.rightPanelOpen !== 'boolean' || !isRightPanelWidth(value.rightPanelWidth)) return false
  if (!isRightPanelTab(value.rightPanelTab)) return false
  if (!isMarkdownDefaultView(value.markdownDefaultView)) return false
  if (!isTerminalLinkOpenMode(value.terminalLinkOpenMode)) return false
  if (!Array.isArray(value.expandedProjects) || value.expandedProjects.length > MAX_EXPANDED_PROJECTS) {
    return false
  }
  return value.expandedProjects.every((path) => (
    typeof path === 'string' && path !== '' && path.length <= MAX_STORED_PATH_LENGTH && isAbsolutePathLike(path)
  ))
}

/** 复用桌面错误码；界面偏好本地先生效，模型展示偏好保存成功后才提交。 */
export type PreferencesErrorCode = DesktopErrorCode

export interface PreferencesError {
  readonly code: PreferencesErrorCode
  readonly message: string
}

export type PreferencesResult =
  | { readonly ok: true; readonly data: UiPreferences }
  | { readonly ok: false; readonly error: PreferencesError }

/** 对话页模型切换器的展示偏好：要隐藏的模型；为空表示全部显示。 */
export interface ModelDisplayPreference {
  readonly hiddenModels: readonly ModelIdentity[]
}

export type ModelDisplayResult =
  | { readonly ok: true; readonly data: ModelDisplayPreference }
  | { readonly ok: false; readonly error: PreferencesError }

/** 快捷发送下拉里的短语；数组顺序即下拉展示顺序。 */
export interface QuickSendPreference {
  readonly messages: readonly string[]
}

export type QuickSendResult =
  | { readonly ok: true; readonly data: QuickSendPreference }
  | { readonly ok: false; readonly error: PreferencesError }

/**
 * 扩展自动更新开关：开启后，启动时第一次检查发现可更新的扩展就直接更新，不再等用户点击。
 * 默认关：更新会改动的包在 Runtime 重启后才生效，默认让用户自己决定何时执行。
 */
export interface AutoUpdatePreference {
  readonly enabled: boolean
}

export type AutoUpdateResult =
  | { readonly ok: true; readonly data: AutoUpdatePreference }
  | { readonly ok: false; readonly error: PreferencesError }

/**
 * 生成式 UI 开关：关闭后 SDK 宿主不再注册 ui_render / ui_patch / ui_catalog / ui_inspect，
 * 模型也就看不到这项能力。默认开：它是产品内置特性，不需要用户先发现再开启。
 * 开关只影响会话创建期，改动要重载资源后才生效；历史会话里已交付的界面仍照常渲染。
 */
export interface GenuiPreference {
  readonly enabled: boolean
}

export type GenuiResult =
  | { readonly ok: true; readonly data: GenuiPreference }
  | { readonly ok: false; readonly error: PreferencesError }

/** 快捷发送短语的默认值；配置缺失或规范化后为空时使用，主进程与页面共用同一份。 */
export const DEFAULT_QUICK_SEND_MESSAGES: readonly string[] = ['继续', '确认', '提交', '推送']

/** 快捷发送短语的数量与单条长度上限；页面编辑器与主进程校验共用。 */
export const MAX_QUICK_SEND_MESSAGES = 20
export const MAX_QUICK_SEND_MESSAGE_LENGTH = 50

export interface PreferencesApi {
  /** 读取对话页模型展示偏好；隐藏列表为空表示全部显示，不读取或修改 Pi 配置。 */
  readonly getModelDisplay: () => Promise<ModelDisplayResult>
  /** 保存对话页模型展示偏好；返回主进程确认后的结果，不修改 Pi 配置。 */
  readonly setModelDisplay: (preference: ModelDisplayPreference) => Promise<ModelDisplayResult>
  readonly getPreferences: () => Promise<PreferencesResult>
  /** 读取快捷发送短语；配置缺失或非法时主进程返回默认列表。 */
  readonly getQuickSend: () => Promise<QuickSendResult>
  /** 保存快捷发送短语；返回主进程规范化后的列表，不修改 Pi 配置。 */
  readonly setQuickSend: (preference: QuickSendPreference) => Promise<QuickSendResult>
  /** 读取扩展自动更新开关；配置缺失或非法时主进程返回关闭。 */
  readonly getAutoUpdate: () => Promise<AutoUpdateResult>
  /** 保存扩展自动更新开关；只改本应用的行为，不修改 Pi 配置。 */
  readonly setAutoUpdate: (preference: AutoUpdatePreference) => Promise<AutoUpdateResult>
  /** 读取生成式 UI 开关；配置缺失或非法时主进程返回开启。 */
  readonly getGenui: () => Promise<GenuiResult>
  /** 保存生成式 UI 开关；只改本应用是否注册这项内置能力，不修改 Pi 配置。 */
  readonly setGenui: (preference: GenuiPreference) => Promise<GenuiResult>
  /** 保存界面偏好；非法的请求由主进程重新校验并拒绝。 */
  readonly setUiPreferences: (ui: UiPreferences) => Promise<PreferencesResult>
}

// 与 desktop-api.ts 的共享错误码保持一致；界面偏好不再追加专有错误码。
const PREFERENCES_ERROR_CODES: readonly string[] = [
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

/** 隐藏模型的数量上限；只用于展示过滤，与模型身份的边界保持一致。 */
const MAX_HIDDEN_MODELS = 4096

/** 逐项复用模型身份校验，并拒绝多余字段；去重与截断由主进程存储层完成。 */
export function isModelDisplayPreference(value: unknown): value is ModelDisplayPreference {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'hiddenModels')) return false
  return Array.isArray(value.hiddenModels)
    && value.hiddenModels.length <= MAX_HIDDEN_MODELS
    && value.hiddenModels.every((model) => isModelIdentity(model))
}

/**
 * 快捷发送短语的请求形状校验：只允许 `messages` 字段，数量与单条长度不超过上限。
 * trim、空白折叠、去重与空列表兜底由主进程存储层完成；页面提交前已做同样规范化，
 * 因此这里的长度按原文判断，不在这里改写用户输入。
 */
export function isQuickSendPreference(value: unknown): value is QuickSendPreference {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'messages')) return false
  return Array.isArray(value.messages)
    && value.messages.length <= MAX_QUICK_SEND_MESSAGES
    && value.messages.every((message) => typeof message === 'string'
      && message.length <= MAX_QUICK_SEND_MESSAGE_LENGTH)
}

/** 与模型偏好同一形状：成功返回已确认的短语列表，失败保留主进程错误。 */
export function isQuickSendResult(value: unknown): value is QuickSendResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isQuickSendPreference(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false
  return typeof value.error.message === 'string'
    && typeof value.error.code === 'string'
    && PREFERENCES_ERROR_CODES.includes(value.error.code)
}

/** 与模型偏好同一形状：成功返回已确认的展示偏好，失败保留主进程错误。 */
export function isModelDisplayResult(value: unknown): value is ModelDisplayResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isModelDisplayPreference(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false
  return typeof value.error.message === 'string'
    && typeof value.error.code === 'string'
    && PREFERENCES_ERROR_CODES.includes(value.error.code)
}

/** 自动更新开关的请求形状校验：只允许 `enabled` 一个布尔字段。 */
export function isAutoUpdatePreference(value: unknown): value is AutoUpdatePreference {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'enabled')) return false
  return typeof value.enabled === 'boolean'
}

/** 与其它偏好同一形状：成功返回主进程确认后的开关状态，失败保留主进程错误。 */
export function isAutoUpdateResult(value: unknown): value is AutoUpdateResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isAutoUpdatePreference(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false
  return typeof value.error.message === 'string'
    && typeof value.error.code === 'string'
    && PREFERENCES_ERROR_CODES.includes(value.error.code)
}

/** 生成式 UI 开关的请求形状校验：只允许 `enabled` 一个布尔字段。 */
export function isGenuiPreference(value: unknown): value is GenuiPreference {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'enabled')) return false
  return typeof value.enabled === 'boolean'
}

/** 与其它偏好同一形状：成功返回主进程确认后的开关状态，失败保留主进程错误。 */
export function isGenuiResult(value: unknown): value is GenuiResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isGenuiPreference(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false
  return typeof value.error.message === 'string'
    && typeof value.error.code === 'string'
    && PREFERENCES_ERROR_CODES.includes(value.error.code)
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isPreferencesResult(value: unknown): value is PreferencesResult {
  if (!isRecord(value)) return false

  if (value.ok === true) return isUiPreferences(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && PREFERENCES_ERROR_CODES.includes(code)
}
