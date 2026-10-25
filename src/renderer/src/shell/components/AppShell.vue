<!--
  应用外壳骨架：顶部栏跨整窗，主体按「侧栏 + 工作区 + 右侧面板」三列排布。

  这里只负责布局与响应式呈现：窄窗口下侧栏改为浮层并用遮罩退出，桌面端折叠偏好来自界面偏好 Store，
  两者互不覆盖。设置页打开时不渲染侧栏与右侧面板（它自己的左栏就是导航）。
  折叠与响应式只改变布局，不触碰任何业务生命周期；工作区内部结构由 WorkspaceView 承担。
-->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
/** 侧栏新建入口的聚焦请求；自增一次即一次请求，不表示执行会话已建立。 */
const composerFocusToken = ref(0)
let narrowWindowQuery: MediaQueryList | null = null
const bodyElement = ref<HTMLElement | null>(null)
const bodyWidth = ref(window.innerWidth)
const sidebarOccupiedWidth = ref(0)
let layoutObserver: ResizeObserver | null = null

/** 工作区保留 320px；另扣除工作区两侧与右面板外侧的三段 8px 留白。 */
const rightPanelAvailableWidth = computed(() => Math.max(
  0,
  bodyWidth.value - (isNarrowWindow.value ? 0 : sidebarOccupiedWidth.value) - 320 - 24
))

/** 按实际侧栏占宽计算，折叠过渡期间也逐帧跟随，不抢占中间工作区。 */
function updateLayoutWidth(): void {
  const body = bodyElement.value
  if (body === null) return
  bodyWidth.value = body.clientWidth
  const sidebar = body.querySelector<HTMLElement>(':scope > .app-sidebar')
  if (sidebar === null) {
    sidebarOccupiedWidth.value = 0
    return
  }
  const style = window.getComputedStyle(sidebar)
  sidebarOccupiedWidth.value = sidebar.getBoundingClientRect().width
    + Number.parseFloat(style.marginLeft) + Number.parseFloat(style.marginRight)
}

function observeBodyLayout(): void {
  const body = bodyElement.value
  if (body === null || layoutObserver === null) return
  layoutObserver.disconnect()
  layoutObserver.observe(body)
  const sidebar = body.querySelector<HTMLElement>(':scope > .app-sidebar')
  if (sidebar !== null) layoutObserver.observe(sidebar)
  updateLayoutWidth()
}

// 两侧栏按偏好就绪与设置页状态挂载，需要重新接入实际存在的侧栏元素。
watch([preferencesReady, settingsOpen], observeBodyLayout, { flush: 'post' })

/** 窄窗口临时展开侧栏，不覆盖用户保存的桌面端折叠偏好。 */
function onNarrowWindowChange(event: MediaQueryListEvent): void {
  isNarrowWindow.value = event.matches
  if (!event.matches) mobileSidebarOpen.value = false
}

const sidebarCollapsedForLayout = computed(() => (
  isNarrowWindow.value ? !mobileSidebarOpen.value : sidebarCollapsed.value
))

/** 侧栏新建先选定对话标签，有打开意图时交给会话能力提交，再请求输入框聚焦。 */
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
  layoutObserver = new ResizeObserver(updateLayoutWidth)
  observeBodyLayout()
})

onUnmounted(() => {
  narrowWindowQuery?.removeEventListener('change', onNarrowWindowChange)
  layoutObserver?.disconnect()
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

    <div ref="bodyElement" class="app-body">
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

      <main class="app-workspace" :class="{ 'is-workspace': !settingsOpen }">
        <SettingsView v-if="settingsOpen" />
        <div v-show="!settingsOpen" class="flex min-h-0 min-w-0 flex-1 flex-col">
          <WorkspaceView :composer-focus-token="composerFocusToken" />
        </div>
      </main>

      <!-- 右侧面板在非设置页常驻挂载；折叠只改变布局，不触碰文件树的读取缓存与 Runtime 生命周期。 -->
      <RightPanel
        v-if="preferencesReady && !settingsOpen"
        :collapsed="!rightPanelOpen"
        :available-width="rightPanelAvailableWidth"
      />
    </div>
  </div>
</template>
