<!-- 主界面外壳：组合顶栏、可折叠会话栏、消息区与 Prompt 区，负责各展示 Store 的初始化、项目变化后的会话列表刷新，以及运行中切换的确认对话框。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useDesktopStore } from './stores/desktop'
import { usePreferencesStore } from './stores/preferences'
import { useProjectStore } from './stores/project'
import { useRuntimeStore } from './stores/runtime'
import { useSessionStore } from './stores/session'
import AppTopBar from './components/AppTopBar.vue'
import ChatMessageList from './components/ChatMessageList.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import PromptComposer from './components/PromptComposer.vue'
import SessionSidebar from './components/SessionSidebar.vue'

const desktopStore = useDesktopStore()
const preferencesStore = usePreferencesStore()
const projectStore = useProjectStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const { currentProject, pendingPath } = storeToRefs(projectStore)
const { awaitingInterrupt, pendingSessionId } = storeToRefs(sessionStore)
const { sidebarCollapsed, ready: preferencesReady } = storeToRefs(preferencesStore)

/** 主进程拒绝未确认的切换后，由用户在这里确认可以中断正在运行的操作。 */
const projectConfirmDetail = computed(() => pendingPath.value ?? '')
const sessionConfirmDetail = computed(() => (
  pendingSessionId.value === null ? '新建会话' : `会话 ${pendingSessionId.value.slice(0, 8)}`
))

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

/** 切换项目已由主进程结束旧 Runtime，这里只刷新会话列表。 */
watch(currentProject, (project, previous) => {
  if (project?.path === previous?.path) return
  void sessionStore.refresh()
})

onMounted(() => {
  void desktopStore.initialize()
  void preferencesStore.initialize()
  void projectStore.initialize()
  void runtimeStore.initialize()
  void sessionStore.initialize()
})

onUnmounted(() => {
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
      <!-- 偏好读取完成后才按存储状态渲染 Sidebar，避免首帧闪动。 -->
      <SessionSidebar v-if="preferencesReady && !sidebarCollapsed" />

      <main class="flex min-w-0 flex-1 flex-col">
        <ChatMessageList />
        <PromptComposer />
      </main>
    </div>

    <ConfirmDialog
      v-if="pendingPath !== null"
      title="停止运行中的操作并切换项目？"
      description="切换项目会先停止当前 Agent 操作，已提交的内容不会重放。"
      :detail="projectConfirmDetail"
      confirm-label="停止并切换"
      @confirm="confirmProjectSwitch"
      @cancel="cancelProjectSwitch"
    />

    <ConfirmDialog
      v-if="awaitingInterrupt"
      title="停止运行中的操作并切换会话？"
      description="切换会话会先停止当前 Agent 操作，已提交的内容不会重放。"
      :detail="sessionConfirmDetail"
      confirm-label="停止并切换"
      @confirm="confirmSessionSwitch"
      @cancel="cancelSessionSwitch"
    />
  </div>
</template>
