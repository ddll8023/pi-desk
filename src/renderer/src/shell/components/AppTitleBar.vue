<!-- 全宽顶部栏：自绘窗口标题栏，呈现侧栏开关、应用名、当前会话与项目、Runtime 状态与右侧面板开关；macOS 预留原生红绿灯位。模型选择已下沉到输入坞。
     会话簇的第一行是对话内跳转入口：显示当前读到的那一轮，点开按文本列出本会话每一轮用户输入，选中后由消息区按既有定位规则滚动。
     设置页模式：两个面板都不渲染，两个开关随之隐藏，左侧是返回对话入口。 -->
<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useDesktopStore } from '../stores/desktop'
import { useProjectStore } from '../../projects/stores/project'
import { useChatNavigationStore } from '../../sessions/stores/chat-navigation'
import type { ChatNavEntry } from '../../sessions/stores/chat-navigation'
import { useRuntimeStore } from '../../sessions/stores/runtime'
import { useSessionStore } from '../../sessions/stores/session'
import { useSessionViewStore } from '../../sessions/stores/session-view'
import { useAnchoredPopup } from '../../ui/anchored-popup'
import AppButton from '../../ui/AppButton.vue'

defineProps<{
  readonly sidebarCollapsed: boolean
  readonly rightPanelOpen: boolean
  /** 界面偏好尚未读取完成时禁止切换，避免与存储状态互相覆盖；两个开关共用。 */
  readonly sidebarToggleDisabled: boolean
  /** 设置页模式：两个面板都不渲染，面板开关无对象，改为展示返回对话入口。 */
  readonly settingsMode: boolean
}>()

const emit = defineEmits<{
  toggleSidebar: []
  toggleRightPanel: []
  exitSettings: []
}>()

const desktopStore = useDesktopStore()
const projectStore = useProjectStore()
const chatNavigationStore = useChatNavigationStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const sessionViewStore = useSessionViewStore()
const { connection } = storeToRefs(desktopStore)
const { currentProject } = storeToRefs(projectStore)
const { view: runtimeView } = storeToRefs(runtimeStore)
const { sessions } = storeToRefs(sessionStore)
const { entries: navEntries, activeId: navActiveId } = storeToRefs(chatNavigationStore)

/** macOS 用 hiddenInset 保留原生红绿灯，顶部栏左侧要让出它们占的宽度；其他平台不需要。 */
const reservesTrafficLights = computed(() => (
  connection.value.status === 'ready' && connection.value.info.platform === 'darwin'
))

const runtimeInfo = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const sessionId = computed(() => runtimeInfo.value?.sessionId ?? null)
const currentSession = computed(() => (
  sessionId.value === null
    ? null
    : sessions.value.find((session) => session.sessionId === sessionId.value) ?? null
))
const sessionTitle = computed(() => {
  if (currentSession.value?.preview) return currentSession.value.preview
  if (sessionId.value !== null) return `会话 ${sessionId.value.slice(0, 8)}`
  return currentProject.value === null ? '未选择项目' : '新会话'
})
const runtimeStatus = computed(() => {
  const runtime = runtimeView.value
  if (runtime.phase === 'starting') return { label: 'Pi 启动中', kind: 'pending' }
  if (runtime.phase === 'stopping') return { label: 'Pi 关闭中', kind: 'pending' }
  if (runtime.phase === 'failed') return { label: 'Pi 异常', kind: 'error' }
  if (runtime.phase === 'ready' && runtime.snapshot.info?.isStreaming === true) {
    return { label: 'Agent 运行中', kind: 'active' }
  }
  if (runtime.phase === 'ready') return { label: 'Pi 就绪', kind: 'ready' }
  return { label: 'Pi 未启动', kind: 'idle' }
})
const projectPath = computed(() => currentProject.value?.path ?? '尚未选择项目')

/** 当前所在轮的摘要；正文尚未算出位置时为空，触发键退回会话标题。 */
const activeEntry = computed(() => (
  navEntries.value.find(entry => entry.id === navActiveId.value) ?? null
))
/**
 * 触发键显示当前所在轮；没有可跳转轮次时退回会话标题，入口仍在但点开是空态。
 * 入口列表按正文顺序排列（与消息区一致），键盘上下键的方向与正文滚动同向。
 */
const triggerLabel = computed(() => activeEntry.value?.label ?? sessionTitle.value)
const triggerTitle = computed(() => (
  navEntries.value.length === 0
    ? `${sessionTitle.value}；本会话还没有可跳转的对话轮次`
    : `${activeEntry.value?.label ?? sessionTitle.value}；点击查看本会话的对话跳转列表`
))

/** 跳转浮层：宽度固定、贴住触发键左缘，浮层内部自己滚动，不撑高顶部栏。 */
const activeIndex = ref(0)
const anchoredPopup = useAnchoredPopup({
  width: 420,
  minWidth: 320,
  maxHeightCap: 460,
  // 收起时（含点击外部）把高亮重置，下次打开重新落在当前轮。
  onClose: () => { activeIndex.value = 0 }
})
const { trigger, popup, isOpen: expanded, position: popupPosition } = anchoredPopup
const listbox = ref<HTMLElement | null>(null)
const entryElements = new Map<string, HTMLElement>()
const listboxId = `chat-nav-list-${useId()}`

const popupStyle = computed(() => ({
  left: `${popupPosition.value.left}px`,
  top: `${popupPosition.value.top}px`,
  width: `${popupPosition.value.width}px`,
  maxHeight: `${popupPosition.value.maxHeight}px`
}))

function setEntryElement(id: string, element: unknown): void {
  if (element instanceof HTMLElement) entryElements.set(id, element)
  else entryElements.delete(id)
}

/** 打开时把高亮落在当前轮上：用户多半想跳到相邻的一轮，而不是每次从第一条开始翻。 */
function resetActiveIndex(): void {
  const currentIndex = navEntries.value.findIndex(entry => entry.id === navActiveId.value)
  activeIndex.value = currentIndex >= 0 ? currentIndex : 0
}

function scrollActiveEntryIntoView(): void {
  const entry = navEntries.value[activeIndex.value]
  if (entry !== undefined) entryElements.get(entry.id)?.scrollIntoView({ block: 'nearest' })
}
function focusActiveEntry(): void {
  const entry = navEntries.value[activeIndex.value]
  if (entry !== undefined) entryElements.get(entry.id)?.focus()
}

function openPopup(): void {
  if (expanded.value) return
  resetActiveIndex()
  anchoredPopup.open()
  // 条目要等浮层挂载后才有焦点对象；高亮项拿到焦点后方向键与 Enter 都在列表内完成。
  void nextTick(() => {
    if (navEntries.value.length > 0) focusActiveEntry()
    else listbox.value?.focus()
    scrollActiveEntryIntoView()
  })
}

function closePopup(restoreFocus = false): void {
  const wasOpen = anchoredPopup.close()
  if (restoreFocus && wasOpen) void nextTick(() => trigger.value?.focus())
}

function togglePopup(): void {
  if (expanded.value) closePopup()
  else openPopup()
}

function moveActive(direction: -1 | 1): void {
  const count = navEntries.value.length
  if (count === 0) return
  const start = activeIndex.value < 0 ? (direction === 1 ? -1 : 0) : activeIndex.value
  activeIndex.value = (start + direction + count) % count
  void nextTick(() => {
    focusActiveEntry()
    scrollActiveEntryIntoView()
  })
}

function moveToBoundary(boundary: 'first' | 'last'): void {
  const count = navEntries.value.length
  if (count === 0) return
  activeIndex.value = boundary === 'first' ? 0 : count - 1
  void nextTick(() => {
    focusActiveEntry()
    scrollActiveEntryIntoView()
  })
}

/** 选中一轮：把意图交给消息区（折叠轮由它先展开再定位），收起浮层并把焦点还给触发键。 */
function chooseEntry(entry: ChatNavEntry): void {
  chatNavigationStore.requestJump(sessionViewStore.key, entry.id)
  closePopup(true)
}

/** 键盘上下键在列表内部自己移动高亮，不让焦点落到条目上，避免与触发键的回车语义重叠。 */
function onListKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    moveToBoundary(event.key === 'Home' ? 'first' : 'last')
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    const entry = navEntries.value[activeIndex.value]
    if (entry !== undefined) chooseEntry(entry)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closePopup(true)
    return
  }
  if (event.key === 'Tab') {
    closePopup()
    void nextTick(() => trigger.value?.focus())
  }
}

/** 条目收到焦点就同步高亮：鼠标点选与键盘移动用的是同一个高亮值。 */function onEntryFocus(index: number): void {
  activeIndex.value = index
}

/**
 * 列表挂载或更新后把高亮项滚进可视范围：长会话里当前轮往往不在前几条。
 * 列表容器本身不接管焦点（键盘事件由高亮条目冒泡上来），因此这里只管滚动。
 */
function onListRef(element: unknown): void {
  listbox.value = element instanceof HTMLElement ? element : null
  if (listbox.value === null) return
  scrollActiveEntryIntoView()
}

/** 列表随正文变化（新的一轮、历史回读）时保持高亮在范围内；当前会话没有入口就收起浮层。 */
watch(navEntries, () => {
  if (!expanded.value) return
  if (navEntries.value.length === 0) {
    closePopup(true)
    return
  }
  if (activeIndex.value >= navEntries.value.length) activeIndex.value = navEntries.value.length - 1
})
</script>

<template>
  <header class="app-titlebar">
    <!-- 红绿灯占位：只作布局留白，不接收指针事件，也不进入无障碍树。 -->
    <span v-if="reservesTrafficLights" class="app-titlebar-traffic-pad" aria-hidden="true"></span>

    <!-- 设置页没有侧栏：这个位置是返回对话入口，设置页内不另设返回按钮。 -->
    <AppButton
      v-if="settingsMode"
      variant="unstyled"
      class="app-titlebar-back"
      title="返回对话"
      @click="emit('exitSettings')"
    >
      <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m10 6-6 6 6 6M4 12h16" />
      </svg>
      返回对话
    </AppButton>

    <AppButton
      v-else
      variant="icon"
      class="app-titlebar-toggle"
      :aria-expanded="!sidebarCollapsed"
      :aria-label="sidebarCollapsed ? '展开导航栏' : '收起导航栏'"
      :title="sidebarCollapsed ? '展开导航栏' : '收起导航栏'"
      :disabled="sidebarToggleDisabled"
      @click="emit('toggleSidebar')"
    >
      <!-- 导航栏图标：外框加左列，展开时左列填实；与右侧面板开关同一套画法，左右对称。 -->
      <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect v-if="!sidebarCollapsed" x="4" y="6" width="4.4" height="12" rx="1" fill="currentColor" stroke="none" />
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M9 4v16" />
      </svg>
    </AppButton>

    <span class="app-titlebar-app-name">Pi Desktop</span>

    <!-- 会话与项目簇只描述对话上下文：设置页不显示它，也不留一个会切换会话的入口。 -->
    <div v-if="!settingsMode" class="app-titlebar-context">
      <button
        ref="trigger"
        type="button"
        class="app-titlebar-session"
        :title="triggerTitle"
        :disabled="currentProject === null"
        aria-haspopup="listbox"
        :aria-expanded="expanded"
        :aria-controls="expanded ? listboxId : undefined"
        @click="togglePopup"
        @keydown.down.prevent="openPopup"
        @keydown.esc.prevent="closePopup(true)"
      >
        <span class="app-titlebar-session-text">{{ triggerLabel }}</span>
        <svg
          class="app-titlebar-session-chevron"
          :class="{ 'is-expanded': expanded }"
          width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"
        >
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <span class="app-titlebar-project" :title="projectPath">{{ projectPath }}</span>
    </div>

    <!-- 窗口拖动区：只占控件之间的空白，控件群周围不再顺带可拖动，避免误拖与误双击最大化。 -->
    <span class="app-titlebar-drag" aria-hidden="true"></span>

    <span v-if="runtimeStatus.kind !== 'idle'" class="app-runtime-status" :class="`is-${runtimeStatus.kind}`" role="status">
      <span class="app-runtime-status-dot" aria-hidden="true"></span>
      {{ runtimeStatus.label }}
    </span>

    <AppButton
      v-if="!settingsMode"
      variant="icon"
      class="app-titlebar-toggle"
      :aria-expanded="rightPanelOpen"
      :aria-label="rightPanelOpen ? '收起右侧面板' : '展开右侧面板'"
      :title="rightPanelOpen ? '收起右侧面板' : '展开右侧面板'"
      :disabled="sidebarToggleDisabled"
      @click="emit('toggleRightPanel')"
    >
      <!-- 右侧面板图标：外框加右列，展开时右列填实；与左侧导航栏图标同一套画法，一眼看出管的是哪一侧。 -->
      <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect v-if="rightPanelOpen" x="15.6" y="6" width="4.4" height="12" rx="1" fill="currentColor" stroke="none" />
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M15 4v16" />
      </svg>
    </AppButton>

    <!-- 跳转列表：浮在标题栏之上，内部自己滚动；条目是纯文本，当前轮高亮并标出含几个生成式界面。 -->
    <Teleport to="body">
      <div v-if="expanded" ref="popup" class="chat-nav-popup" :style="popupStyle">
        <div
          :id="listboxId"
          :ref="onListRef"
          class="chat-nav-list"
          role="listbox"
          aria-label="对话跳转"
          :tabindex="navEntries.length === 0 ? 0 : -1"
          @keydown="onListKeydown"
        >
          <div
            v-for="(entry, index) in navEntries"
            :id="`chat-nav-${entry.id}`"
            :key="entry.id"
            :ref="(element) => setEntryElement(entry.id, element)"
            class="chat-nav-entry"
            :class="{
              'is-active': index === activeIndex,
              'is-current': entry.id === navActiveId
            }"
            role="option"
            :aria-selected="entry.id === navActiveId"
            tabindex="-1"
            @mousedown.prevent
            @click="chooseEntry(entry)"
            @focus="onEntryFocus(index)"
          >
            <span class="chat-nav-entry-text">{{ entry.label }}</span>
            <span v-if="entry.uiCount > 0" class="chat-nav-entry-meta">含 {{ entry.uiCount }} 个生成式界面</span>
          </div>
          <p v-if="navEntries.length === 0" class="chat-nav-empty">
            本会话还没有可跳转的对话轮次；发送第一条消息后这里会列出每一轮。
          </p>
        </div>
      </div>
    </Teleport>
  </header>
</template>
