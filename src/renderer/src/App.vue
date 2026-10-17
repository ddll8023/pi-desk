<!-- 主界面外壳：编排工作区标签组（对话、终端与文件面板）、项目两阶段添加/移除确认、会话删除确认、快捷命令的新增/编辑/删除与运行、信任与中断对话框、版本更新提示、视图切换、侧栏「新建」到输入坞的聚焦请求、新建会话落盘后的会话列表补读及各展示 Store 生命周期。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useDesktopStore } from './stores/desktop'
import { useExtensionUiStore } from './stores/extension-ui'
import { usePreferencesStore } from './stores/preferences'
import { useProjectStore } from './stores/project'
import { useQuickCommandsStore } from './stores/quick-commands'
import { useResourceStore } from './stores/resource'
import { useRuntimeStore } from './stores/runtime'
import { useSessionStore } from './stores/session'
import { useSessionRunsStore } from './stores/session-runs'
import { useSessionViewStore } from './stores/session-view'
import { useSettingsStore } from './stores/settings'
import { useTerminalStore } from './stores/terminal'
import { useTrustStore } from './stores/trust'
import { useUpdatesStore } from './stores/updates'
import { useWorkspaceTabsStore } from './stores/workspace-tabs'
import type { Project } from '../../shared/project-api'
import type { QuickCommand, QuickCommandScope } from '../../shared/quick-commands-api'
import type { SessionSummary } from '../../shared/session-api'
import AppTitleBar from './components/AppTitleBar.vue'
import ChatMessageList from './components/ChatMessageList.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import ExtensionDialog from './components/ExtensionDialog.vue'
import ExtensionNotificationBar from './components/ExtensionNotificationBar.vue'
import FileEditorView from './components/FileEditorView.vue'
import PromptComposer from './components/PromptComposer.vue'
import ProjectSidebar from './components/ProjectSidebar.vue'
import QuickCommandDialog from './components/QuickCommandDialog.vue'
import RightPanel from './components/RightPanel.vue'
import SessionActivityBar from './components/SessionActivityBar.vue'
import SessionPickerDialog from './components/SessionPickerDialog.vue'
import SettingsView from './components/SettingsView.vue'
import TerminalView from './components/TerminalView.vue'
import TrustDialog from './components/TrustDialog.vue'
import UpdateNoticeDialog from './components/UpdateNoticeDialog.vue'
import WorkspaceTabBar from './components/WorkspaceTabBar.vue'
import AppButton from './components/ui/AppButton.vue'

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
const workspaceTabsStore = useWorkspaceTabsStore()
const { currentProject, pendingAddition, pendingAdditionDecision } = storeToRefs(projectStore)
const { awaitingInterrupt, pendingReload, pendingSessionId } = storeToRefs(sessionStore)
const { sidebarCollapsed, rightPanelOpen, ready: preferencesReady } = storeToRefs(preferencesStore)
const settingsStore = useSettingsStore()
const trustStore = useTrustStore()
const updatesStore = useUpdatesStore()
/** 设置页是否占据工作区；打开时侧栏、右侧面板与标签组都不渲染。 */
const { open: settingsOpen } = storeToRefs(settingsStore)
const projectToRemove = ref<Project | null>(null)
/** 待确认删除的会话：项目路径加摘要；确认后以 allowInterrupt 提交，取消不改动任何文件。 */
const sessionToRemove = ref<{ readonly projectPath: string; readonly session: SessionSummary } | null>(null)

/** 当前项目路径；终端、快捷命令、文件树与文件标签都用它作为上下文。 */
const projectPath = computed(() => currentProject.value?.path ?? null)
/** 当前项目可用的快捷命令：项目命令在前，全局命令在后。 */
const quickCommandsForProject = computed(() => quickCommandsStore.commandsForProject(projectPath.value))
/** 快捷命令保存失败的原因；由工作区提示条展示，关闭后不再重复。 */
const quickCommandError = computed(() => (
  quickCommandsStore.view.phase === 'error' ? quickCommandsStore.view.error : null
))
/** 快捷命令编辑弹窗：null 表示新增，非空表示编辑该条。 */
const commandEditorTarget = ref<QuickCommand | null>(null)
const commandEditorOpen = ref(false)
const commandEditorScope = ref<QuickCommandScope>('global')
const commandEditorProjectPath = ref<string | null>(null)
/** 待确认删除的快捷命令；确认后提交整份清单。 */
const commandToRemove = ref<QuickCommand | null>(null)
const additionTrustStatus = computed(() => {
  const candidate = pendingAddition.value
  if (candidate === null || candidate.trustStatus.resources.length === 0
    || candidate.trustStatus.decision !== null || pendingAdditionDecision.value !== null) return null
  return candidate.trustStatus
})
const isNarrowWindow = ref(window.matchMedia('(max-width: 799px)').matches)
const mobileSidebarOpen = ref(false)
/** 侧栏「新建」在闲置态的聚焦请求；自增一次即一次请求，输入坞只看这个值。 */
const composerFocusToken = ref(0)
let narrowWindowQuery: MediaQueryList | null = null

/** 窄窗口临时展开侧栏，不覆盖用户保存的桌面端折叠偏好。 */
function onNarrowWindowChange(event: MediaQueryListEvent): void {
  isNarrowWindow.value = event.matches
  if (!event.matches) mobileSidebarOpen.value = false
}

const sidebarCollapsedForLayout = computed(() => (
  isNarrowWindow.value ? !mobileSidebarOpen.value : sidebarCollapsed.value
))

/** 侧栏「新建」在闲置态只建立标签并聚焦输入框，不启动 Pi；会话由首次发送创建。 */
async function onRequestNewSession(projectPath: string): Promise<void> {
  // 输入坞在对话标签里：先切到该标签，否则聚焦发生在隐藏面板上，用户看不到光标。
  await workspaceTabsStore.openNewChatTab(projectPath)
  composerFocusToken.value += 1
}

function toggleSidebar(): void {
  if (isNarrowWindow.value) {
    mobileSidebarOpen.value = !mobileSidebarOpen.value
    return
  }
  preferencesStore.toggleSidebar()
}

function closeMobileSidebar(): void {
  if (isNarrowWindow.value) mobileSidebarOpen.value = false
}

/** Extension widget 按放置位置拆分；空 lines 的条目不会出现在主进程快照中。 */
const widgetsAbove = computed(() => extensionStore.widgets.filter((w) => w.placement === 'aboveEditor'))
const widgetsBelow = computed(() => extensionStore.widgets.filter((w) => w.placement === 'belowEditor'))

const sessionConfirmDetail = computed(() => {
  if (pendingReload.value) return '重新加载 Pi 资源（重建会话服务，保留当前会话）'
  return pendingSessionId.value === null ? '新建会话' : `会话 ${pendingSessionId.value.slice(0, 8)}`
})
const sessionConfirmTitle = computed(() => (
  pendingReload.value ? '停止运行中的操作并重新加载资源？' : '停止运行中的操作并切换会话？'
))
const sessionConfirmDescription = computed(() => (
  pendingReload.value
    ? 'Pi 在会话建立或重载时读取 Skills、Prompt Templates、MCP 配置与 Extension，因此重新加载需要重建会话服务；已提交的内容不会重放。'
    : '切换会话会先停止当前 Agent 操作，已提交的内容不会重放。'
))
const sessionConfirmLabel = computed(() => (pendingReload.value ? '停止并重新加载' : '停止并切换'))

/** 版本更新提示的「查看详情」：关掉提示并直接落到设置页的「版本与更新」分节，由它展示完整版本清单。 */
function onUpdateDetails(): void {
  updatesStore.dismissNotice()
  settingsStore.openSettings('version')
}

/** 菜单里运行一条命令：目标终端由标签状态决定（活动终端，没有就新建），失败留在终端提示条里。 */
function runQuickCommand(command: QuickCommand): void {
  void workspaceTabsStore.runQuickCommand(command)
}

/** 编辑一条命令：范围与项目取命令自身的值，弹窗里仍可改。 */
function editQuickCommand(command: QuickCommand): void {
  commandEditorTarget.value = command
  commandEditorScope.value = command.scope
  commandEditorProjectPath.value = command.projectPath
  commandEditorOpen.value = true
}

/** 新增一条命令：范围来自菜单入口，项目默认取当前项目。 */
function addQuickCommand(scope: QuickCommandScope): void {
  commandEditorTarget.value = null
  commandEditorScope.value = scope
  commandEditorProjectPath.value = projectPath.value
  commandEditorOpen.value = true
}

function closeCommandEditor(): void {
  commandEditorOpen.value = false
  commandEditorTarget.value = null
}

function requestCommandRemoval(command: QuickCommand): void {
  commandToRemove.value = command
}

function cancelCommandRemoval(): void {
  commandToRemove.value = null
}

/** 待确认关闭的脏文件标签；确认后才丢弃未保存修改并关闭。 */
const pendingFileClose = ref<string | null>(null)
const pendingFileCloseTitle = computed(() => (
  workspaceTabsStore.tabs.find(tab => tab.id === pendingFileClose.value)?.title ?? ''
))

/**
 * 关闭标签：有未保存修改的文件标签先确认，其余直接交给工作区标签状态。
 * 对话与终端的关闭流程不变。
 */
function onCloseTab(key: string): void {
  const tab = workspaceTabsStore.tabs.find(candidate => candidate.id === key)
  if (tab !== undefined && tab.dirty) {
    pendingFileClose.value = key
    return
  }
  void workspaceTabsStore.closeTab(key)
}

function confirmFileClose(): void {
  const key = pendingFileClose.value
  pendingFileClose.value = null
  if (key !== null) void workspaceTabsStore.closeTab(key)
}

async function confirmCommandRemoval(): Promise<void> {
  const command = commandToRemove.value
  commandToRemove.value = null
  if (command !== null) await quickCommandsStore.removeCommand(command.id)
}

/** 菜单里的「管理快捷命令…」直接落到设置页对应分节。 */
function openCommandSettings(): void {
  settingsStore.openSettings('quick-commands')
}

function requestProjectRemoval(project: Project): void {
  projectToRemove.value = project
}

function confirmProjectRemoval(): void {
  const project = projectToRemove.value
  projectToRemove.value = null
  if (project === null) return
  void projectStore.remove(project.id, true)
}

function cancelProjectRemoval(): void {
  projectToRemove.value = null
}

/** 记下待删除会话；标题与描述用现有摘要，确认后由主进程收敛占用再删文件。 */
function requestSessionRemoval(projectPath: string, session: SessionSummary): void {
  sessionToRemove.value = { projectPath, session }
}

function confirmSessionRemoval(): void {
  const target = sessionToRemove.value
  sessionToRemove.value = null
  if (target === null) return
  void sessionStore.removeSession(target.projectPath, target.session.sessionId, true)
}

function cancelSessionRemoval(): void {
  sessionToRemove.value = null
}

/** 删除确认弹层的会话名：与侧栏同一口径，优先首条用户消息预览。 */
const sessionToRemoveTitle = computed(() => {
  const preview = sessionToRemove.value?.session.preview?.trim()
  return preview !== undefined && preview !== '' ? preview : '未命名会话'
})
const isRemovingCurrentSession = computed(() => (
  sessionToRemove.value !== null
  && sessionToRemove.value.session.sessionId === runtimeStore.foregroundSessionId
))

function confirmSessionSwitch(): void {
  sessionStore.confirmPending()
}

function cancelSessionSwitch(): void {
  sessionStore.cancelPending()
}

/** 候选项目的信任决定随添加动作提交；现有 Runtime 流程则重试被拦截的会话打开。 */
function onTrustResolved(decision?: 'trusted' | 'untrusted'): void {
  if (pendingAddition.value !== null) {
    if (decision === undefined) {
      projectStore.cancelAddition()
      return
    }
    void projectStore.commitAddition(false, decision)
    return
  }
  if (sessionStore.awaitingTrust) void sessionStore.retryPendingAfterTrust()
}

function onTrustCancelled(): void {
  if (pendingAddition.value !== null) {
    projectStore.cancelAddition()
    return
  }
  sessionStore.cancelPending()
}

/** 前台切换不再结束任何运行实例；这里只在项目上下文变化后补读该项目的会话列表（其他项目已读过的分片不受影响）。 */
watch(currentProject, (project, previous) => {
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

onMounted(() => {
  narrowWindowQuery = window.matchMedia('(max-width: 799px)')
  isNarrowWindow.value = narrowWindowQuery.matches
  narrowWindowQuery.addEventListener('change', onNarrowWindowChange)
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
  void updatesStore.initialize()
})

onUnmounted(() => {
  narrowWindowQuery?.removeEventListener('change', onNarrowWindowChange)
  extensionStore.dispose()
  resourceStore.dispose()
  runtimeStore.dispose()
  sessionViewStore.dispose()
  sessionRunsStore.dispose()
  terminalStore.dispose()
  workspaceTabsStore.dispose()
  updatesStore.dispose()
})
</script>

<template>
  <div class="app-layout">
    <!-- 顶部栏跨整窗，位于侧栏与工作区之上；侧栏开关、会话与项目、运行状态与右侧面板开关都在这里。 -->
    <AppTitleBar
      :sidebar-collapsed="sidebarCollapsedForLayout"
      :right-panel-open="rightPanelOpen"
      :sidebar-toggle-disabled="!preferencesReady"
      :settings-mode="settingsOpen"
      @toggle-sidebar="toggleSidebar"
      @toggle-right-panel="preferencesStore.toggleRightPanel()"
      @exit-settings="settingsStore.closeSettings()"
    />

    <div class="app-body">
      <button
        v-if="isNarrowWindow && !sidebarCollapsedForLayout && !settingsOpen"
        type="button"
        class="app-sidebar-backdrop"
        aria-label="关闭导航栏"
        @click="closeMobileSidebar"
      ></button>

      <!-- 设置页打开时不渲染侧栏：它自己的左栏就是导航。折叠与响应式呈现只改变布局，不触碰 Runtime 生命周期。 -->
      <ProjectSidebar
        v-if="preferencesReady && !settingsOpen"
        :sidebar-collapsed="sidebarCollapsedForLayout"
        :mobile-open="isNarrowWindow && mobileSidebarOpen"
        @open-settings="settingsStore.openSettings(); closeMobileSidebar()"
        @close-sidebar="closeMobileSidebar"
        @remove-project="requestProjectRemoval"
        @delete-session="requestSessionRemoval"
        @request-new-session="onRequestNewSession"
      />

      <main class="app-workspace">
        <SettingsView v-if="settingsOpen" />
        <template v-else>
          <!-- 标签组：对话、终端与文件同级混排；标签按当前项目分组，切换项目就换一组。 -->
          <WorkspaceTabBar
            :tabs="workspaceTabsStore.tabs"
            :active-tab="workspaceTabsStore.activeTab"
            :creating="terminalStore.creating"
            :quick-commands="quickCommandsForProject"
            :project-path="projectPath"
            @select="workspaceTabsStore.activateTab"
            @close="onCloseTab"
            @create="workspaceTabsStore.createTab"
            @rename="workspaceTabsStore.renameTab"
            @move="workspaceTabsStore.moveTab"
            @run-command="runQuickCommand"
            @edit-command="editQuickCommand"
            @remove-command="requestCommandRemoval"
            @add-command="addQuickCommand"
            @manage-commands="openCommandSettings"
          />

          <!-- 终端操作失败只提示，不改变已建立的标签；关闭后不再重复展示。 -->
          <p v-if="terminalStore.error !== null" class="workspace-notice" role="status">
            <span class="min-w-0 flex-1">{{ terminalStore.error }}</span>
            <AppButton variant="unstyled" class="workspace-notice-close" aria-label="关闭提示" @click="terminalStore.clearError()">关闭</AppButton>
          </p>

          <!-- 快捷命令保存失败只提示，不清空已保存的清单；关闭后不再重复展示。 -->
          <p v-if="quickCommandError !== null" class="workspace-notice" role="alert">
            <span class="min-w-0 flex-1">{{ quickCommandError.message }}</span>
            <AppButton variant="unstyled" class="workspace-notice-close" aria-label="关闭提示" @click="quickCommandsStore.clearError()">关闭</AppButton>
          </p>

          <!-- 关闭标签时结束实例失败（关闭未确认）只提示：标签保留，占用仍由侧栏如实展示。 -->
          <p v-if="sessionRunsStore.closeError !== null" class="workspace-notice" role="alert">
            <span class="min-w-0 flex-1">{{ sessionRunsStore.closeError }}</span>
            <AppButton variant="unstyled" class="workspace-notice-close" aria-label="关闭提示" @click="sessionRunsStore.clearCloseError()">关闭</AppButton>
          </p>

          <!-- 面板层：对话、终端与文件面板叠放在同一区域，只显示活动标签。
               隐藏用 visibility 而不是 display：面板始终保持真实尺寸，输入框量高与终端尺寸测量在隐藏时也成立。 -->
          <div class="workspace-panes">
            <div
              class="workspace-pane"
              :class="{ 'is-hidden': !workspaceTabsStore.isChatActive }"
              :inert="!workspaceTabsStore.isChatActive"
              :aria-hidden="!workspaceTabsStore.isChatActive"
            >
              <ExtensionNotificationBar />
              <!-- 会话活动摘要条：本会话读过与改过的文件、调用的 Skill、MCP 与插件工具；折叠成一行，明细是浮层，一次只列一类，不占消息区高度。 -->
              <SessionActivityBar />
              <ChatMessageList />
              <!-- Widget 放置语义与官方子协议一致：aboveEditor 在输入区上方，belowEditor 在下方。 -->
              <div v-for="widget in widgetsAbove" :key="widget.placement" class="px-4 py-2 sm:px-6">
                <pre class="chat-column mx-auto widget-block">{{ widget.lines.join('\n') }}</pre>
              </div>
              <PromptComposer :focus-token="composerFocusToken" />
              <div v-for="widget in widgetsBelow" :key="widget.placement" class="px-4 py-2 sm:px-6">
                <pre class="chat-column mx-auto widget-block">{{ widget.lines.join('\n') }}</pre>
              </div>
            </div>

            <!-- 终端面板：当前项目的每个终端都保持挂载与尺寸，非活动标签只隐藏，切回来仍是同一屏内容。 -->
            <div
              v-for="session in terminalStore.projectSessions"
              :key="session.id"
              class="workspace-pane"
              :class="{ 'is-hidden': workspaceTabsStore.activeTab !== workspaceTabsStore.terminalTabId(session.id) }"
              :inert="workspaceTabsStore.activeTab !== workspaceTabsStore.terminalTabId(session.id)"
              :aria-hidden="workspaceTabsStore.activeTab !== workspaceTabsStore.terminalTabId(session.id)"
            >
              <TerminalView
                :session="session"
                :active="workspaceTabsStore.activeTab === workspaceTabsStore.terminalTabId(session.id)"
                :quick-commands="quickCommandsForProject"
                :project-path="projectPath"
                @run-command="runQuickCommand"
                @edit-command="editQuickCommand"
                @remove-command="requestCommandRemoval"
                @add-command="addQuickCommand"
                @manage-commands="openCommandSettings"
              />
            </div>

            <!-- 文件面板：当前项目已打开的文件各自保持挂载，非活动标签只隐藏，切回来仍是同一份编辑内容与撤销历史。 -->
            <div
              v-for="file in workspaceTabsStore.openFiles"
              :key="file.key"
              class="workspace-pane"
              :class="{ 'is-hidden': workspaceTabsStore.activeTab !== file.key }"
              :inert="workspaceTabsStore.activeTab !== file.key"
              :aria-hidden="workspaceTabsStore.activeTab !== file.key"
            >
              <FileEditorView :tab-key="file.key" :active="workspaceTabsStore.activeTab === file.key" />
            </div>

            <!-- 没有活动标签（例如关掉了全部对话标签）时的空状态：新建入口是唯一动作。 -->
            <div v-if="workspaceTabsStore.activeTab === null" class="workspace-pane">
              <div class="empty-state flex-1 justify-center">
                <p class="empty-state-title">当前项目没有打开的标签</p>
                <p class="empty-state-text">新建一个对话标签开始工作，或从左侧打开一条历史会话。</p>
                <div class="mt-2 flex flex-wrap items-center justify-center gap-2">
                  <AppButton variant="primary" @click="workspaceTabsStore.openNewChatTab()">新建对话</AppButton>
                </div>
              </div>
            </div>
          </div>
        </template>
      </main>

      <!-- 右侧面板在非设置页常驻挂载；折叠只改变布局，不触碰文件树的读取缓存与 Runtime 生命周期。 -->
      <RightPanel v-if="preferencesReady && !settingsOpen" :collapsed="!rightPanelOpen" />
    </div>

    <!-- 模态弹层统一经 Teleport 渲染到 body，全部落在根堆叠上下文；组件常驻挂载，进出由内部 Transition 驱动。 -->
    <Teleport to="body">
      <ConfirmDialog
        :open="awaitingInterrupt"
        :title="sessionConfirmTitle"
        :description="sessionConfirmDescription"
        :detail="sessionConfirmDetail"
        :confirm-label="sessionConfirmLabel"
        @confirm="confirmSessionSwitch"
        @cancel="cancelSessionSwitch"
      />

      <TrustDialog
        :addition-status="additionTrustStatus"
        @decided="onTrustResolved"
        @cancelled="onTrustCancelled"
      />

      <ConfirmDialog
        :open="projectToRemove !== null"
        title="从项目列表移除？"
        description="只移除 Pi Desktop 中的项目记录，不删除项目目录、代码或会话文件；该项目的信任决定也会清除。若它是当前项目，确认后会关闭对应 Runtime。"
        :detail="projectToRemove?.path ?? ''"
        confirm-label="移除项目"
        @confirm="confirmProjectRemoval"
        @cancel="cancelProjectRemoval"
      />

      <!-- 会话删除是破坏性操作：确认后中断该会话的在途操作、释放运行实例并删除会话文件，不可恢复。 -->
      <ConfirmDialog
        :open="sessionToRemove !== null"
        :title="`删除会话「${sessionToRemoveTitle}」？`"
        description="将永久删除该会话的历史记录文件，不可恢复。若该会话正在运行，确认后会先停止它的操作；若删除的是当前会话，聊天区会回到未发送消息的状态。"
        :detail="sessionToRemove?.session.sessionId ?? ''"
        :confirm-label="isRemovingCurrentSession ? '停止并删除' : '删除会话'"
        @confirm="confirmSessionRemoval"
        @cancel="cancelSessionRemoval"
      />

      <!-- 脏文件标签关闭前确认：确认后丢弃未保存修改并关闭，不可恢复。 -->
      <ConfirmDialog
        :open="pendingFileClose !== null"
        title="关闭文件会丢弃未保存的修改"
        description="该文件有未保存的修改，关闭标签后不可恢复。需要保留时先取消并保存。"
        :detail="pendingFileCloseTitle"
        confirm-label="丢弃并关闭"
        @confirm="confirmFileClose"
        @cancel="pendingFileClose = null"
      />

      <!-- 顶栏会话 chip 使用的会话选择弹层。 -->
      <SessionPickerDialog :open="sessionStore.showSessionPicker" @close="sessionStore.closeSessionPicker()" />

      <!-- 快捷命令的新增与编辑；保存成功才关闭，失败保留已填内容并就地提示。 -->
      <QuickCommandDialog
        :open="commandEditorOpen"
        :command="commandEditorTarget"
        :default-scope="commandEditorScope"
        :default-project-path="commandEditorProjectPath"
        @saved="closeCommandEditor"
        @cancel="closeCommandEditor"
      />

      <!-- 快捷命令删除是破坏性操作：确认后从清单里移除，不可恢复。 -->
      <ConfirmDialog
        :open="commandToRemove !== null"
        :title="`删除快捷命令「${commandToRemove?.label ?? ''}」？`"
        description="该快捷命令会从保存的清单里移除，菜单与终端右键里不再出现。"
        :detail="commandToRemove?.command ?? ''"
        confirm-label="删除"
        @confirm="confirmCommandRemoval"
        @cancel="cancelCommandRemoval"
      />

      <!-- Extension 对话一次只展示队首；队列由 store 持有，回应后自动滑到下一条。 -->
      <ExtensionDialog />

      <!-- 启动检查到更新时的只读提示；每次运行最多弹一次，手动重查不再弹。 -->
      <UpdateNoticeDialog
        :open="updatesStore.noticeOpen"
        @details="onUpdateDetails"
        @dismiss="updatesStore.dismissNotice()"
      />
    </Teleport>
  </div>
</template>
