/**
 * 页面启动编排：按固定顺序初始化各展示 Store，并在页面卸载时按相反依赖顺序释放。
 *
 * 顺序本身是约束而不是习惯：会话身份要在运行状态之前就绪（`session-view` 紧随 `runtime`），
 * 终端状态要在项目就绪后立刻接回事件，标签状态又依赖项目与终端清单。改动顺序会丢事件或读出空清单。
 * 释放只覆盖自建订阅的 Store，纯展示状态的 Store 没有监听器，不需要释放。
 *
 * 项目切换与打开结束引起的标签补提交也在这里：读标签侧给出的打开意图，交给会话 Store 的 `openIntent`。
 * 这里只管生命周期、补读与打开意图的提交，不持有布局状态，也不渲染任何内容。
 */
import { onMounted, onUnmounted, watch } from 'vue'
import { flushGenuiParamPersistence, initializeGenuiParamPersistence } from '../genui/param-persistence'
import { useDesktopStore } from './stores/desktop'
import { useExtensionUiStore } from '../sessions/stores/extension-ui'
import { usePreferencesStore } from '../preferences/stores/preferences'
import { useProjectStore } from '../projects/stores/project'
import { useQuickCommandsStore } from '../preferences/stores/quick-commands'
import { useResourceStore } from '../resources/stores/resource'
import { useRuntimeStore } from '../sessions/stores/runtime'
import { useSessionRunsStore } from '../sessions/stores/session-runs'
import { useSessionStore } from '../sessions/stores/session'
import { useSessionViewStore } from '../sessions/stores/session-view'
import { useTerminalStore } from '../workspace/stores/terminal'
import { useUpdatesStore } from '../updates/stores/updates'
import { useWorkspaceTabsStore } from '../workspace/stores/workspace-tabs'
import { registerSessionTabState } from '../workspace/stores/session-tab-bridge'

export function useAppStartup(): void {
  /**
   * 标签侧经注册的只读视图读取会话状态：标签模块不 import 会话 Store，打开链才不构成模块环。
   * 提供者在首次读取时才实例化会话 Store，因此这里的注册必须先于任何标签动作。
   */
  registerSessionTabState(() => {
    const session = useSessionStore()
    return {
      get opening() { return session.opening },
      get openingProjectPath() { return session.openingProjectPath },
      get actionError() { return session.actionError },
      get awaitingTrust() { return session.awaitingTrust },
      get awaitingInterrupt() { return session.awaitingInterrupt },
      get loadedSessionIds() { return session.loadedSessionIds },
      sessionsOf: projectPath => session.sessionsOf(projectPath),
      // 延迟读取，避免标签与输入状态在 Store 初始化期间互相实例化。
      hasPendingPrompt: (projectPath, tabKey) => useSessionViewStore().hasPendingPrompt(projectPath, tabKey),
      waitForOpenActions: () => session.waitForOpenActions(),
      invalidateOpenSelection: () => session.invalidateOpenSelection()
    }
  })

  const desktopStore = useDesktopStore()
  const extensionStore = useExtensionUiStore()
  const preferencesStore = usePreferencesStore()
  const projectStore = useProjectStore()
  const quickCommandsStore = useQuickCommandsStore()
  const resourceStore = useResourceStore()
  const runtimeStore = useRuntimeStore()
  const sessionStore = useSessionStore()
  const sessionRunsStore = useSessionRunsStore()
  const sessionViewStore = useSessionViewStore()
  const terminalStore = useTerminalStore()
  const updatesStore = useUpdatesStore()
  const workspaceTabsStore = useWorkspaceTabsStore()

  /** 前台切换不再结束任何运行实例；这里只在项目上下文变化后补读该项目的会话列表（其他项目已读过的分片不受影响）。 */
  watch(() => projectStore.currentProject, (project, previous) => {
    if (project?.path === previous?.path) return
    if (project === null) return
    void sessionStore.ensureLoaded(project.path, true)
  })

  /**
   * Pi 新建会话只分配身份，会话文件到首次写入才创建，「新建」返回的列表快照可能不含当前会话。
   * 运行时报告这一轮已有消息落盘（不再流式）时补读一次列表，让侧栏用真实文件条目替换占位条目。
   */
  watch(
    () => {
      const info = runtimeStore.view.phase === 'ready' ? runtimeStore.view.snapshot.info : null
      return {
        sessionId: info?.sessionId ?? null,
        messageCount: info?.messageCount ?? 0,
        streaming: info?.isStreaming ?? false
      }
    },
    (info) => {
      if (info.streaming || info.messageCount === 0) return
      void sessionStore.reconcileCurrentSession(info.sessionId)
    }
  )

  /** 页面关闭或重载前把待写的参数落盘；`pagehide` 是卸载阶段还能发起 IPC 的时机。 */
  function onPageHide(): void {
    void flushGenuiParamPersistence()
  }

  onMounted(() => {
    void desktopStore.initialize()
    void extensionStore.initialize()
    void preferencesStore.initialize()
    void projectStore.initialize()
    void quickCommandsStore.initialize()
    void resourceStore.initialize()
    void runtimeStore.initialize()
    // 会话身份要在运行状态到达之前就绪，因此紧随 Runtime 之后初始化。
    sessionViewStore.initialize()
    void sessionStore.initialize()
    void sessionRunsStore.initialize()
    // 终端状态要在项目就绪后立即接回：它先订阅事件再按项目列清单，避免重挂载期间的下发丢失。
    terminalStore.initialize()
    // 标签状态依赖项目与终端清单，放在两者之后初始化，进入项目时才能补出空对话标签。
    workspaceTabsStore.initialize()
    // 标签只在会话状态变化后声明打开意图，提交统一交给会话能力：
    // 项目切换后补回对话标签的前台，以及一次打开结束后仍未接上实例时重试。
    watch(() => projectStore.currentProject?.path ?? null, (projectPath) => {
      const intent = workspaceTabsStore.onProjectChanged(projectPath)
      if (intent !== null) void sessionStore.openIntent(intent)
    }, { immediate: true, flush: 'sync' })
    watch(() => sessionStore.opening, (opening) => {
      if (opening) return
      const intent = workspaceTabsStore.chatFocusIntent()
      if (intent !== null) void sessionStore.openIntent(intent)
    }, { flush: 'post' })
    void updatesStore.initialize()
    // 界面参数的本机记录：只做冷启动补齐，晚到也不会盖掉用户刚调的取值。
    void initializeGenuiParamPersistence()
    window.addEventListener('pagehide', onPageHide)
  })

  onUnmounted(() => {
    window.removeEventListener('pagehide', onPageHide)
    extensionStore.dispose()
    resourceStore.dispose()
    runtimeStore.dispose()
    sessionViewStore.dispose()
    sessionRunsStore.dispose()
    terminalStore.dispose()
    workspaceTabsStore.dispose()
    updatesStore.dispose()
  })
}
