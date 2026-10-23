<!--
  应用外壳骨架：顶部栏跨整窗，主体按「侧栏 + 工作区 + 右侧面板」三列排布。

  这里只负责布局与响应式呈现：窄窗口下侧栏改为浮层并用遮罩退出，桌面端折叠偏好来自界面偏好 Store，
  两者互不覆盖。设置页打开时不渲染侧栏与右侧面板（它自己的左栏就是导航）。
  折叠与响应式只改变布局，不触碰任何业务生命周期；工作区内部结构由 WorkspaceView 承担。
-->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import AppTitleBar from './AppTitleBar.vue'
import ProjectSidebar from '../../projects/components/ProjectSidebar.vue'
import RightPanel from './RightPanel.vue'
import SettingsView from './SettingsView.vue'
import { usePreferencesStore } from '../../preferences/stores/preferences'
import { useProjectStore } from '../../projects/stores/project'
import { useSessionStore } from '../../sessions/stores/session'
import { useSettingsStore } from '../stores/settings'
import { useWorkspaceTabsStore } from '../../workspace/stores/workspace-tabs'
import WorkspaceView from './WorkspaceView.vue'

const preferencesStore = usePreferencesStore()
const projectStore = useProjectStore()
const sessionStore = useSessionStore()
const settingsStore = useSettingsStore()
const workspaceTabsStore = useWorkspaceTabsStore()
const { sidebarCollapsed, rightPanelOpen, ready: preferencesReady } = storeToRefs(preferencesStore)
/** 设置页是否占据工作区；打开时侧栏、右侧面板与标签组都不渲染。 */
const { open: settingsOpen } = storeToRefs(settingsStore)

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
  const intent = await workspaceTabsStore.openNewChatTab(projectPath)
  if (intent !== null) void sessionStore.openIntent(intent)
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

onMounted(() => {
  narrowWindowQuery = window.matchMedia('(max-width: 799px)')
  isNarrowWindow.value = narrowWindowQuery.matches
  narrowWindowQuery.addEventListener('change', onNarrowWindowChange)
})

onUnmounted(() => {
  narrowWindowQuery?.removeEventListener('change', onNarrowWindowChange)
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
        @remove-project="projectStore.requestRemoval"
        @delete-session="sessionStore.requestRemoval"
        @request-new-session="onRequestNewSession"
      />

      <main class="app-workspace">
        <SettingsView v-if="settingsOpen" />
        <div v-show="!settingsOpen" class="flex min-h-0 min-w-0 flex-1 flex-col">
          <WorkspaceView :composer-focus-token="composerFocusToken" />
        </div>
      </main>

      <!-- 右侧面板在非设置页常驻挂载；折叠只改变布局，不触碰文件树的读取缓存与 Runtime 生命周期。 -->
      <RightPanel v-if="preferencesReady && !settingsOpen" :collapsed="!rightPanelOpen" />
    </div>
  </div>
</template>
