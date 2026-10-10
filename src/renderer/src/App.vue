<!-- 主界面外壳：编排项目两阶段添加/移除确认、信任与中断对话框、视图切换及各展示 Store 生命周期。 -->
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
import type { Project } from '../../shared/project-api'
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
const { currentProject, pendingPath, pendingAddition, pendingAdditionDecision } = storeToRefs(projectStore)
const { awaitingInterrupt, pendingReload, pendingSessionId } = storeToRefs(sessionStore)
const { sidebarCollapsed, ready: preferencesReady } = storeToRefs(preferencesStore)
const trustStore = useTrustStore()
const currentView = ref<'chat' | 'settings'>('chat')
const projectToRemove = ref<Project | null>(null)
const additionTrustStatus = computed(() => {
  const candidate = pendingAddition.value
  if (candidate === null || candidate.trustStatus.resources.length === 0
    || candidate.trustStatus.decision !== null || pendingAdditionDecision.value !== null) return null
  return candidate.trustStatus
})
const isNarrowWindow = ref(window.matchMedia('(max-width: 799px)').matches)
const mobileSidebarOpen = ref(false)
let narrowWindowQuery: MediaQueryList | null = null

/** 窄窗口临时展开侧栏，不覆盖用户保存的桌面端折叠偏好。 */
function onNarrowWindowChange(event: MediaQueryListEvent): void {
  isNarrowWindow.value = event.matches
  if (!event.matches) mobileSidebarOpen.value = false
}

const sidebarCollapsedForLayout = computed(() => (
  isNarrowWindow.value ? !mobileSidebarOpen.value : sidebarCollapsed.value
))

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
  if (pendingAddition.value !== null) {
    void projectStore.commitAddition(true)
    return
  }
  const path = pendingPath.value
  if (path === null) return
  void projectStore.select(path, true)
}

function cancelProjectSwitch(): void {
  projectStore.cancelPending()
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

/** 切换项目已由主进程结束旧 Runtime，这里只刷新会话列表。 */
watch(currentProject, (project, previous) => {
  if (project?.path === previous?.path) return
  void sessionStore.refresh()
})

onMounted(() => {
  narrowWindowQuery = window.matchMedia('(max-width: 799px)')
  isNarrowWindow.value = narrowWindowQuery.matches
  narrowWindowQuery.addEventListener('change', onNarrowWindowChange)
  void desktopStore.initialize()
  void extensionStore.initialize()
  void preferencesStore.initialize()
  void projectStore.initialize()
  void resourceStore.initialize()
  void runtimeStore.initialize()
  void sessionStore.initialize()
})

onUnmounted(() => {
  narrowWindowQuery?.removeEventListener('change', onNarrowWindowChange)
  extensionStore.dispose()
  resourceStore.dispose()
  runtimeStore.dispose()
})
</script>

<template>
  <div class="app-layout">
    <button
      v-if="isNarrowWindow && !sidebarCollapsedForLayout"
      type="button"
      class="app-sidebar-backdrop"
      aria-label="关闭导航栏"
      @click="closeMobileSidebar"
    ></button>

    <!-- 侧栏始终挂载；折叠与响应式呈现只改变布局，不触碰 Runtime 生命周期。 -->
    <ProjectSidebar
      v-if="preferencesReady"
      :settings-active="currentView === 'settings'"
      :sidebar-collapsed="sidebarCollapsedForLayout"
      :mobile-open="isNarrowWindow && mobileSidebarOpen"
      @toggle-settings="currentView = currentView === 'settings' ? 'chat' : 'settings'; closeMobileSidebar()"
      @close-sidebar="closeMobileSidebar"
      @remove-project="requestProjectRemoval"
    />

    <main class="app-workspace">
      <AppTopBar
        :sidebar-collapsed="sidebarCollapsedForLayout"
        :sidebar-toggle-disabled="!preferencesReady"
        @toggle-sidebar="toggleSidebar"
      />
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

      <!-- /resume 与会话 chip 共用的会话选择弹层。 -->
      <SessionPickerDialog :open="sessionStore.showSessionPicker" @close="sessionStore.closeSessionPicker()" />

      <!-- Extension 对话一次只展示队首；队列由 store 持有，回应后自动滑到下一条。 -->
      <ExtensionDialog />
    </Teleport>
  </div>
</template>
