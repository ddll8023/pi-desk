/**
 * 沙箱桥接的唯一暴露点：把各域 Api 合并成一个扁平对象挂到 `window.desktop`。
 *
 * 只做合并与暴露，不含任何 channel 调用、载荷重建或响应校验——这些都在同目录的域文件里：
 * `desktop`（应用信息与外链）、`projects`（项目与项目文件）、`sessions`（会话与运行状态）、
 * `runtime`（Runtime、模型能力、资源与 MCP）、`terminal`（终端与守护进程）、`git`（源代码管理）、
 * `preferences`（界面偏好与快捷命令）、`providers`（认证、供应商与 Pi 默认模型）、
 * `updates`（版本检查与更新）、`trust`（Project Trust）、`genui`（生成式界面参数与 Extension UI）、
 * `lan-remote`（局域网访问控制与设备授权）、`browser`（受限网页截图、元素选择与取消）。
 *
 * 不暴露 Electron、任意 channel 或系统能力；沙箱不能 require 拆分模块，构建侧保持单产物。
 */
import { contextBridge } from 'electron'
import type { DesktopApi } from '../shared/desktop-api'
import type { BrowserCaptureApi } from '../shared/browser-api'
import type { BrowserSessionApi } from '../shared/browser-session-api'
import { browserApi } from './browser'
import type { ProjectApi } from '../shared/project-api'
import type { ProjectFileApi } from '../shared/project-file-api'
import type { SessionApi } from '../shared/session-api'
import type { SessionRunApi } from '../shared/session-run-api'
import type { RuntimeApi } from '../shared/runtime-api'
import type { TerminalApi } from '../shared/terminal-api'
import type { PreferencesApi } from '../shared/preferences-api'
import type { QuickCommandsApi } from '../shared/quick-commands-api'
import type { GenuiParamsApi } from '../shared/genui-params-api'
import type { PiSettingsApi } from '../shared/pi-settings-api'
import type { TrustApi } from '../shared/trust-api'
import type { ExtensionUiApi } from '../shared/extension-ui-api'
import type { AuthApi } from '../shared/auth-api'
import type { ModelsConfigApi } from '../shared/models-config-api'
import type { UpdatesApi } from '../shared/updates-api'
import type { GitApi } from '../shared/git-api'
import type { LanRemoteApi } from '../shared/lan-remote-api'
import { desktopApi } from './desktop'
import { genuiApi } from './genui'
import { gitApi } from './git'
import { preferencesApi } from './preferences'
import { projectsApi } from './projects'
import { providersApi } from './providers'
import { runtimeApi } from './runtime'
import { sessionsApi } from './sessions'
import { terminalApi } from './terminal'
import { trustApi } from './trust'
import { updatesApi } from './updates'
import { lanRemoteApi } from './lan-remote'

/** 合并后的桥接对象：各域键互不重叠，平铺后仍是页面看到的同一份 `DesktopApi` 契约。 */
const desktop: BrowserCaptureApi & BrowserSessionApi & DesktopApi & RuntimeApi & ProjectApi & ProjectFileApi & SessionApi & SessionRunApi & TerminalApi & PreferencesApi & QuickCommandsApi & GenuiParamsApi & PiSettingsApi & TrustApi & ExtensionUiApi & AuthApi & ModelsConfigApi & UpdatesApi & GitApi & LanRemoteApi = {
  ...desktopApi,
  ...browserApi,
  ...projectsApi,
  ...sessionsApi,
  ...runtimeApi,
  ...terminalApi,
  ...gitApi,
  ...preferencesApi,
  ...providersApi,
  ...updatesApi,
  ...trustApi,
  ...genuiApi,
  ...lanRemoteApi
}

contextBridge.exposeInMainWorld('desktop', desktop)
