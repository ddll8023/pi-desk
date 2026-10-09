/** 声明浏览器构建环境与可缺失的受限桌面桥接，不向渲染端引入 Node 全局能力。 */
/// <reference types="vite/client" />

import type { DesktopApi } from '../../shared/desktop-api'
import type { AuthApi } from '../../shared/auth-api'
import type { ExtensionUiApi } from '../../shared/extension-ui-api'
import type { PreferencesApi } from '../../shared/preferences-api'
import type { ProjectApi } from '../../shared/project-api'
import type { RuntimeApi } from '../../shared/runtime-api'
import type { SessionApi } from '../../shared/session-api'
import type { TrustApi } from '../../shared/trust-api'

declare global {
  interface Window {
    readonly desktop?: DesktopApi & RuntimeApi & ProjectApi & SessionApi & PreferencesApi & TrustApi & ExtensionUiApi & AuthApi
  }
}

export {}
