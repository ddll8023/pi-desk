<!-- 主界面外壳：组合顶栏、项目侧栏与聊天/设置主内容区，负责视图切换、各展示 Store 初始化、项目变化后的会话列表刷新，以及运行中切换与项目信任对话框；同时承载 Extension 的对话、通知与 widget 展示。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useDesktopStore } from './stores/desktop'
import { useExtensionUiStore } from './stores/extension-ui'
import { usePreferencesStore } from './stores/preferences'
import { useProjectStore } from './stores/project'
import { useResourceStore } from './stores/resource'
import { useRuntimeStore } from './stores/runtime'
import { useSessionStore } from './stores/session'
import { useTrustStore } from './stores/trust'
import AppTopBar from './components/AppTopBar.vue'
import ChatMessageList from './components/ChatMessageList.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import ExtensionDialog from './components/ExtensionDialog.vue'
import ExtensionNotificationBar from './components/ExtensionNotificationBar.vue'
import PromptComposer from './components/PromptComposer.vue'
import ProjectSidebar from './components/ProjectSidebar.vue'
import SessionPickerDialog from './components/SessionPickerDialog.vue'
import SettingsView from './components/SettingsView.vue'
import TrustDialog from './components/TrustDialog.vue'

const desktopStore = useDesktopStore()
const extensionStore = useExtensionUiStore()
const preferencesStore = usePreferencesStore()
const projectStore = useProjectStore()
const resourceStore = useResourceStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const { currentProject, pendingPath } = storeToRefs(projectStore)
const { awaitingInterrupt, pendingReload, pendingSessionId } = storeToRefs(sessionStore)
const { sidebarCollapsed, ready: preferencesReady } = storeToRefs(preferencesStore)
const trustStore = useTrustStore()
const currentView = ref<'chat' | 'settings'>('chat')

/** Extension widget 按放置位置拆分；空 lines 的条目不会出现在主进程快照中。 */
const widgetsAbove = computed(() => extensionStore.widgets.filter((w) => w.placement === 'aboveEditor'))
const widgetsBelow = computed(() => extensionStore.widgets.filter((w) => w.placement === 'belowEditor'))

/** 主进程拒绝未确认的切换后，由用户在这里确认可以中断正在运行的操作。 */
const projectConfirmDetail = computed(() => pendingPath.value ?? '')
const sessionConfirmDetail = computed(() => {
  if (pendingReload.value) return '重新加载 Pi 资源（重启 Runtime，保留当前会话）'
  return pendingSessionId.value === null ? '新建会话' : `会话 ${pendingSessionId.value.slice(0, 8)}`
})
const sessionConfirmTitle = computed(() => (
  pendingReload.value ? '停止运行中的操作并重新加载资源？' : '停止运行中的操作并切换会话？'
))
const sessionConfirmDescription = computed(() => (
  pendingReload.value
    ? 'Pi 只在 Runtime 启动时读取 Skills、Prompt Templates、MCP 配置与 Extension，因此重新加载需要重启；已提交的内容不会重放。'
    : '切换会话会先停止当前 Agent 操作，已提交的内容不会重放。'
))
const sessionConfirmLabel = computed(() => (pendingReload.value ? '停止并重新加载' : '停止并切换'))

function confirmProjectSwitch(): void {
  const path = pendingPath.value
  if (path === null) return
  void projectStore.select(path, true)
}

function cancelProjectSwitch(): void {
  projectStore.cancelPending()
}

function confirmSessionSwitch(): void {
  sessionStore.confirmPending()
}

function cancelSessionSwitch(): void {
  sessionStore.cancelPending()
}

/** 信任决定保存后重试被拦截的会话打开；取消则清空待确认目标。 */
function onTrustResolved(): void {
  if (!sessionStore.awaitingTrust) return
  void sessionStore.retryPendingAfterTrust()
}

function onTrustCancelled(): void {
  sessionStore.cancelPending()
}

/** 切换项目已由主进程结束旧 Runtime，这里只刷新会话列表。 */
watch(currentProject, (project, previous) => {
  if (project?.path === previous?.path) return
  void sessionStore.refresh()
})

onMounted(() => {
  void desktopStore.initialize()
  void extensionStore.initialize()
  void preferencesStore.initialize()
  void projectStore.initialize()
  void resourceStore.initialize()
  void runtimeStore.initialize()
  void sessionStore.initialize()
})

onUnmounted(() => {
  extensionStore.dispose()
  resourceStore.dispose()
  runtimeStore.dispose()
})
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden">
    <AppTopBar
      :sidebar-collapsed="sidebarCollapsed"
      :sidebar-toggle-disabled="!preferencesReady"
      @toggle-sidebar="preferencesStore.toggleSidebar()"
    />

    <div class="flex min-h-0 flex-1">
      <!-- 偏好读取完成后才挂载项目侧栏，避免首帧闪烁；折叠状态由 class 驱动滑出动画，组件保持挂载。 -->
      <ProjectSidebar
        v-if="preferencesReady"
        :settings-active="currentView === 'settings'"
        @toggle-settings="currentView = currentView === 'settings' ? 'chat' : 'settings'"
      />

      <main class="flex min-w-0 flex-1 flex-col">
        <SettingsView v-if="currentView === 'settings'" />
        <template v-else>
          <ExtensionNotificationBar />
          <ChatMessageList />
          <!-- Widget 放置语义与官方子协议一致：aboveEditor 在输入区上方，belowEditor 在下方。 -->
          <div v-for="widget in widgetsAbove" :key="widget.placement" class="px-4 py-2 sm:px-6">
            <pre class="widget-block">{{ widget.lines.join('\n') }}</pre>
          </div>
          <PromptComposer />
          <div v-for="widget in widgetsBelow" :key="widget.placement" class="px-4 py-2 sm:px-6">
            <pre class="widget-block">{{ widget.lines.join('\n') }}</pre>
          </div>
        </template>
      </main>
    </div>

    <!-- 模态弹层统一经 Teleport 渲染到 body，全部落在根堆叠上下文；组件常驻挂载，进出由内部 Transition 驱动。 -->
    <Teleport to="body">
      <ConfirmDialog
        :open="pendingPath !== null"
        title="停止运行中的操作并切换项目？"
        description="切换项目会先停止当前 Agent 操作，已提交的内容不会重放。"
        :detail="projectConfirmDetail"
        confirm-label="停止并切换"
        @confirm="confirmProjectSwitch"
        @cancel="cancelProjectSwitch"
      />

      <ConfirmDialog
        :open="awaitingInterrupt"
        :title="sessionConfirmTitle"
        :description="sessionConfirmDescription"
        :detail="sessionConfirmDetail"
        :confirm-label="sessionConfirmLabel"
        @confirm="confirmSessionSwitch"
        @cancel="cancelSessionSwitch"
      />

      <TrustDialog @decided="onTrustResolved" @cancelled="onTrustCancelled" />

      <!-- /resume 与会话 chip 共用的会话选择弹层。 -->
      <SessionPickerDialog :open="sessionStore.showSessionPicker" @close="sessionStore.closeSessionPicker()" />

      <!-- Extension 对话一次只展示队首；队列由 store 持有，回应后自动滑到下一条。 -->
      <ExtensionDialog />
    </Teleport>
  </div>
</template>
