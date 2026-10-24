<!--
  工作区视图：标签条、操作失败提示条与面板层（对话、终端、文件三类面板叠放在同一区域）。

  面板层只显示活动标签，隐藏用 visibility 而不是 display：面板始终保持真实尺寸，
  输入框量高与终端尺寸测量在隐藏状态下也成立。运行中终端跨项目保留视图，
  退出终端仅在查看时恢复画面；文件面板各自保持挂载，切回来仍是同一份编辑内容与撤销历史。
  标签与命令的意图在这里转交工作区标签、快捷命令与设置三个 Store；需要打开会话时取标签给出的打开意图，交给会话 Store 提交。本组件不判断归属。
-->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import ChatMessageList from '../../sessions/components/ChatMessageList.vue'
import ExtensionNotificationBar from '../../sessions/components/ExtensionNotificationBar.vue'
import FileEditorView from '../../editor/components/FileEditorView.vue'
import PromptComposer from '../../sessions/components/PromptComposer.vue'
import SessionActivityBar from '../../sessions/components/SessionActivityBar.vue'
import TerminalView from '../../workspace/components/TerminalView.vue'
import WorkspaceTabBar from '../../workspace/components/WorkspaceTabBar.vue'
import { useExtensionUiStore } from '../../sessions/stores/extension-ui'
import { useProjectStore } from '../../projects/stores/project'
import { useQuickCommandsStore } from '../../preferences/stores/quick-commands'
import { useSessionRunsStore } from '../../sessions/stores/session-runs'
import { useSessionStore } from '../../sessions/stores/session'
import { useSettingsStore } from '../stores/settings'
import { useTerminalStore } from '../../workspace/stores/terminal'
import { useWorkspaceTabsStore } from '../../workspace/stores/workspace-tabs'
import type { ChatOpenIntent, WorkspaceTabKind } from '../../workspace/stores/workspace-tabs'
import AppButton from '../../ui/AppButton.vue'
import type { QuickCommand, QuickCommandScope } from '../../../../shared/quick-commands-api'
import type { TerminalSessionInfo } from '../../../../shared/terminal-api'

const props = defineProps<{
  /** 侧栏「新建」发出的聚焦请求计数；自增即请求一次，输入坞只看这个值。 */
  readonly composerFocusToken: number
}>()

const extensionStore = useExtensionUiStore()
const projectStore = useProjectStore()
const quickCommandsStore = useQuickCommandsStore()
const sessionStore = useSessionStore()
const sessionRunsStore = useSessionRunsStore()
const settingsStore = useSettingsStore()
const terminalStore = useTerminalStore()
const workspaceTabsStore = useWorkspaceTabsStore()
const { currentProject } = storeToRefs(projectStore)
const { open: settingsOpen } = storeToRefs(settingsStore)

/** 当前项目路径；终端、快捷命令、文件树与文件标签都用它作为上下文。 */
const projectPath = computed(() => currentProject.value?.path ?? null)
/** 当前项目可用的快捷命令：项目命令在前，全局命令在后。 */
const quickCommandsForProject = computed(() => quickCommandsStore.commandsForProject(projectPath.value))
/** 快捷命令保存失败的原因；由工作区提示条展示，关闭后不再重复。 */
const quickCommandError = computed(() => (
  quickCommandsStore.view.phase === 'error' ? quickCommandsStore.view.error : null
))

/** 对话面板可见条件：绑定身份已匹配，或当前标签已有该会话的日志历史。 */
const chatVisible = computed(() => (
  workspaceTabsStore.isChatReady || workspaceTabsStore.isChatLogPreview
))

/** 后台运行终端仍保持挂载，但不能接收焦点与菜单交互。 */
function isTerminalActive(session: TerminalSessionInfo): boolean {
  return !settingsOpen.value && session.projectPath === projectPath.value
    && workspaceTabsStore.activeTab === workspaceTabsStore.terminalTabId(session.id)
}
/** 冷会话连空面板也不创建，避免历史记录数量继续扩大 DOM。 */
const mountedTerminalSessions = computed(() => terminalStore.sessions.filter((session) => (
  session.status === 'running' || isTerminalActive(session)
)))

/** Extension widget 按放置位置拆分；空 lines 的条目不会出现在主进程快照中。 */
const widgetsAbove = computed(() => extensionStore.widgets.filter((w) => w.placement === 'aboveEditor'))
const widgetsBelow = computed(() => extensionStore.widgets.filter((w) => w.placement === 'belowEditor'))

/** 打开意图统一在这里提交：标签侧只算「打开哪个会话、落到哪个标签」，会话能力负责实际打开。 */
function submitOpen(intent: ChatOpenIntent | null): void {
  if (intent !== null) void sessionStore.openIntent(intent)
}

async function onSelectTab(key: string): Promise<void> {
  submitOpen(await workspaceTabsStore.activateTab(key))
}

async function onCloseTab(key: string): Promise<void> {
  submitOpen(await workspaceTabsStore.requestClose(key))
}

/** 新建入口：对话标签走空对话入口并提交打开，终端标签仍由标签 store 建终端。 */
async function onCreateTab(kind: WorkspaceTabKind): Promise<void> {
  if (kind === 'chat') {
    submitOpen(await workspaceTabsStore.openNewChatTab())
    return
  }
  await workspaceTabsStore.createTerminalTab()
}

/** 重新打开当前对话标签：标签未接上实例时重新提交打开意图。 */
async function onReopenChat(): Promise<void> {
  const key = workspaceTabsStore.activeTab
  if (key !== null) submitOpen(await workspaceTabsStore.activateTab(key))
}

async function onNewChatTab(): Promise<void> {
  submitOpen(await workspaceTabsStore.openNewChatTab())
}

/** 菜单里运行一条命令：每次新开一个终端标签再写入，失败留在终端提示条里。 */
function runQuickCommand(command: QuickCommand): void {
  void workspaceTabsStore.runQuickCommand(command)
}

/** 编辑一条命令：范围与项目取命令自身的值，弹窗里仍可改。 */
function editQuickCommand(command: QuickCommand): void {
  quickCommandsStore.openEditor(command, command.scope, command.projectPath)
}

/** 新增一条命令：范围来自菜单入口，项目默认取当前项目。 */
function addQuickCommand(scope: QuickCommandScope): void {
  quickCommandsStore.openEditor(null, scope, projectPath.value)
}

function requestCommandRemoval(command: QuickCommand): void {
  quickCommandsStore.requestRemoval(command)
}

/** 菜单里的「管理快捷命令…」直接落到设置页对应分节。 */
function openCommandSettings(): void {
  settingsStore.openSettings('quick-commands')
}
</script>

<template>
  <WorkspaceTabBar
    :tabs="workspaceTabsStore.tabs"
    :active-tab="workspaceTabsStore.activeTab"
    :creating="terminalStore.creating"
    :quick-commands="quickCommandsForProject"
    :project-path="projectPath"
    :project-name="currentProject?.name ?? null"
    @select="onSelectTab"
    @close="onCloseTab"
    @create="onCreateTab"
    @rename="workspaceTabsStore.renameTab"
    @move="workspaceTabsStore.moveTab"
    @run-command="runQuickCommand"
    @edit-command="editQuickCommand"
    @remove-command="requestCommandRemoval"
    @add-command="addQuickCommand"
    @manage-commands="openCommandSettings"
  />

  <p v-if="sessionStore.actionError !== null" class="workspace-notice" role="alert">
    <span class="min-w-0 flex-1">{{ sessionStore.actionError.message }}</span>
    <AppButton variant="unstyled" class="workspace-notice-close" aria-label="关闭提示" @click="sessionStore.actionError = null">关闭</AppButton>
  </p>

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
      :class="{ 'is-hidden': !chatVisible }"
      :inert="settingsOpen || !chatVisible"
      :aria-hidden="settingsOpen || !chatVisible"
      :aria-busy="chatVisible && sessionStore.opening"
    >
      <ExtensionNotificationBar />
      <!-- 会话活动摘要条：本会话读过与改过的文件、调用的 Skill、MCP 与插件工具；折叠成一行，明细是浮层，一次只列一类，不占消息区高度。 -->
      <SessionActivityBar />
      <ChatMessageList />
      <!-- Widget 放置语义与官方子协议一致：aboveEditor 在输入区上方，belowEditor 在下方。 -->
      <div v-for="widget in widgetsAbove" :key="widget.placement" class="px-4 py-2 sm:px-6">
        <pre class="chat-column mx-auto widget-block">{{ widget.lines.join('\n') }}</pre>
      </div>
      <PromptComposer :focus-token="props.composerFocusToken" :active="!settingsOpen && workspaceTabsStore.isChatReady" />
      <div v-for="widget in widgetsBelow" :key="widget.placement" class="px-4 py-2 sm:px-6">
        <pre class="chat-column mx-auto widget-block">{{ widget.lines.join('\n') }}</pre>
      </div>
    </div>

    <!-- 运行中终端跨项目保留视图；退出终端仅在查看时恢复画面，切走释放 xterm。 -->
    <div
      v-for="session in mountedTerminalSessions"
      :key="session.id"
      class="workspace-pane"
      :class="{ 'is-hidden': !isTerminalActive(session) }"
      :inert="!isTerminalActive(session)"
      :aria-hidden="!isTerminalActive(session)"
    >
      <TerminalView
        :session="session"
        :active="isTerminalActive(session)"
        :quick-commands="quickCommandsStore.commandsForProject(session.projectPath)"
        :project-path="session.projectPath"
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
      <FileEditorView :tab-key="file.key" :active="!settingsOpen && workspaceTabsStore.activeTab === file.key" />
    </div>

    <!-- 目标内容尚不可展示（身份不匹配、没有日志历史、或正在切项目）时才占位：其余情况直接展示缓存或日志历史。 -->
    <div v-if="workspaceTabsStore.isChatActive && !chatVisible" class="workspace-pane" :aria-busy="sessionStore.opening">
      <div class="empty-state flex-1 justify-center" role="status">
        <p class="empty-state-title">{{ sessionStore.opening || projectStore.switching ? '正在切换会话…' : '当前标签尚未连接到会话' }}</p>
        <p v-if="sessionStore.actionError" class="empty-state-text">{{ sessionStore.actionError.message }}</p>
        <AppButton
          v-if="!sessionStore.opening && !sessionStore.awaitingTrust && !sessionStore.awaitingInterrupt"
          variant="primary" :disabled="projectStore.switching"
          @click="onReopenChat"
        >重新打开</AppButton>
      </div>
    </div>

    <!-- 没有活动标签（例如关掉了全部对话标签）时的空状态：新建入口是唯一动作。 -->
    <div v-if="workspaceTabsStore.activeTab === null" class="workspace-pane">
      <div class="empty-state flex-1 justify-center">
        <p class="empty-state-title">当前项目没有打开的标签</p>
        <p class="empty-state-text">新建一个对话标签开始工作，或从左侧打开一条历史会话。</p>
        <div class="mt-2 flex flex-wrap items-center justify-center gap-2">
          <AppButton variant="primary" @click="onNewChatTab">新建对话</AppButton>
        </div>
      </div>
    </div>
  </div>
</template>
