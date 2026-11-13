/** 声明浏览器构建环境与可缺失的受限桌面桥接，不向渲染端引入 Node 全局能力。 */
/// <reference types="vite/client" />

import type { DesktopApi } from '../../shared/desktop-api'
import type { AuthApi } from '../../shared/auth-api'
import type { ExtensionUiApi } from '../../shared/extension-ui-api'
import type { GitApi } from '../../shared/git-api'
import type { WorktreeApi } from '../../shared/worktree-api'
import type { GitCleanupApi } from '../../shared/git-cleanup-api'
import type { ModelsConfigApi } from '../../shared/models-config-api'
import type { PiSettingsApi } from '../../shared/pi-settings-api'
import type { PreferencesApi } from '../../shared/preferences-api'
import type { ProjectApi } from '../../shared/project-api'
import type { ProjectFileApi } from '../../shared/project-file-api'
import type { QuickCommandsApi } from '../../shared/quick-commands-api'
import type { RuntimeApi } from '../../shared/runtime-api'
import type { SessionApi } from '../../shared/session-api'
import type { SessionRunApi } from '../../shared/session-run-api'
import type { TerminalApi } from '../../shared/terminal-api'
import type { TrustApi } from '../../shared/trust-api'
import type { UpdatesApi } from '../../shared/updates-api'
import type { LanRemoteApi } from '../../shared/lan-remote-api'
import type { MemoryApi } from '../../shared/memory-api'
import type { UsageStatsApi } from '../../shared/usage-stats-api'
import type { AgentHomeApi } from '../../shared/agent-home-api'
import type { ExpertApi } from '../../shared/experts-api'
import type { BrowserCaptureApi } from '../../shared/browser-api'
import type { BrowserSessionApi } from '../../shared/browser-session-api'

declare global {
  interface Window {
    readonly desktop?: BrowserCaptureApi & BrowserSessionApi & DesktopApi & RuntimeApi & ProjectApi & ProjectFileApi & SessionApi & SessionRunApi & TerminalApi & PreferencesApi & QuickCommandsApi & PiSettingsApi & TrustApi & ExtensionUiApi & AuthApi & ModelsConfigApi & UpdatesApi & GitApi & WorktreeApi & GitCleanupApi & LanRemoteApi & MemoryApi & UsageStatsApi & AgentHomeApi & ExpertApi
  }
}

declare module 'vue' {
  export interface GlobalComponents {
    webview: any
  }
}

export {}
