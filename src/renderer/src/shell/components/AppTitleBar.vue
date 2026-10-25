<!-- 全宽顶部栏：自绘窗口标题栏，呈现侧栏开关、应用名、当前会话与项目、Runtime 状态与右侧面板开关；macOS 预留原生红绿灯位。模型选择已下沉到输入坞。
     会话簇的第一行是对话导航入口：显示当前读到的那一轮与其位置（第几轮/共几轮），点开是一个浮层面板，
     按新的在前列出本会话每一轮的用户输入（序号、摘要、发送时间、含几个生成式界面），选中后由消息区按既有定位规则滚动。
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

/**
 * 浮层里的展示行：在入口基础上补真实轮次序号（按正文顺序从 1 起）。
 * 序号只用于展示，跳转仍以 `id` 为准。
 */
interface ChatNavRow extends ChatNavEntry {
  readonly ordinal: number
}

/** 当前所在轮的摘要；正文尚未算出位置时为空，触发键退回会话标题。 */
const activeEntry = computed(() => (
  navEntries.value.find(entry => entry.id === navActiveId.value) ?? null
))
/**
 * 展示顺序：新的在前。降序与正文阅读顺序相反，面板头必须写明，否则用户会以为列表坏了；
 * 序号取真实轮次，用户据此知道自己跳到的是第几轮、离最新还有几轮。
 */
const displayEntries = computed<readonly ChatNavRow[]>(() => (
  navEntries.value.map((entry, index) => ({ ...entry, ordinal: index + 1 })).reverse()
))
/** 当前轮在全部轮次里的位置（1 起）；没有当前轮时为空，触发键就不显示位置小标。 */
const activeOrdinal = computed(() => (
  activeEntry.value === null ? null : navEntries.value.indexOf(activeEntry.value) + 1
))
/**
 * 触发键显示当前所在轮；没有可跳转轮次时退回会话标题，入口仍在但点开是空态。
 * 浮层按新的在前排列，键盘上下键的方向也按这个顺序：向上更新、向下更旧。
 */
const triggerLabel = computed(() => activeEntry.value?.label ?? sessionTitle.value)
const triggerTitle = computed(() => (
  navEntries.value.length === 0
    ? `${sessionTitle.value}；本会话还没有可跳转的对话轮次`
    : `${activeEntry.value?.label ?? sessionTitle.value}；点击查看本会话的对话导航，新的在前`
))

/** 跳转浮层：宽度固定、贴住触发键左缘，浮层内部自己滚动，不撑高顶部栏。 */
const highlightedId = ref<string | null>(null)
const anchoredPopup = useAnchoredPopup({
  width: 460,
  minWidth: 320,
  maxHeightCap: 520,
  // 收起时（含点击外部）清掉高亮，下次打开重新落在当前轮。
  onClose: () => { highlightedId.value = null }
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

/** 打开时把高亮落在当前轮上：用户多半想跳到相邻的一轮，而不是每次从最新一条开始翻。 */
function resetHighlight(): void {
  highlightedId.value = navActiveId.value ?? displayEntries.value[0]?.id ?? null
}

/** 滚动与焦点都按高亮行的 id 取元素：降序后新轮次插在顶部，按索引取会漂到隔壁一轮。 */
function scrollHighlightedIntoView(): void {
  const id = highlightedId.value
  if (id !== null) entryElements.get(id)?.scrollIntoView({ block: 'nearest' })
}
function focusHighlighted(): void {
  const id = highlightedId.value
  if (id !== null) entryElements.get(id)?.focus()
}

function openPopup(): void {
  if (expanded.value) return
  resetHighlight()
  anchoredPopup.open()
  // 条目要等浮层挂载后才有焦点对象；高亮项拿到焦点后方向键与 Enter 都在列表内完成。
  void nextTick(() => {
    if (displayEntries.value.length > 0) focusHighlighted()
    else listbox.value?.focus()
    scrollHighlightedIntoView()
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

/** 在展示顺序里移动高亮：向上是更新的一轮，向下是更旧的一轮，到头回绕。 */
function moveHighlight(direction: -1 | 1): void {
  const list = displayEntries.value
  const count = list.length
  if (count === 0) return
  const current = list.findIndex(entry => entry.id === highlightedId.value)
  const start = current < 0 ? (direction === 1 ? -1 : 0) : current
  const next = list[(start + direction + count) % count]
  if (next === undefined) return
  highlightedId.value = next.id
  void nextTick(() => {
    focusHighlighted()
    scrollHighlightedIntoView()
  })
}

/** Home 落最新一轮，End 落最早一轮：与列表的降序一致，不是按正文顺序。 */
function moveToBoundary(boundary: 'newest' | 'oldest'): void {
  const list = displayEntries.value
  if (list.length === 0) return
  const target = boundary === 'newest' ? list[0] : list[list.length - 1]
  if (target === undefined) return
  highlightedId.value = target.id
  void nextTick(() => {
    focusHighlighted()
    scrollHighlightedIntoView()
  })
}

/** 选中一轮：把意图交给消息区（折叠轮由它先展开再定位），收起浮层并把焦点还给触发键。 */
function chooseEntry(id: string): void {
  chatNavigationStore.requestJump(sessionViewStore.key, id)
  closePopup(true)
}

/** 键盘上下键在列表内部自己移动高亮，不让焦点落到条目上，避免与触发键的回车语义重叠。 */
function onListKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    moveHighlight(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    moveToBoundary(event.key === 'Home' ? 'newest' : 'oldest')
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (highlightedId.value !== null) chooseEntry(highlightedId.value)
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

/** 条目收到焦点就同步高亮：鼠标点选与键盘移动用的是同一个高亮值。 */
function onEntryFocus(id: string): void {
  highlightedId.value = id
}

/**
 * 列表挂载或更新后把高亮项滚进可视范围：长会话里当前轮往往不在起始位置。
 * 列表容器本身不接管焦点（键盘事件由高亮条目冒泡上来），因此这里只管滚动。
 */
function onListRef(element: unknown): void {
  listbox.value = element instanceof HTMLElement ? element : null
  if (listbox.value === null) return
  scrollHighlightedIntoView()
}

/**
 * 列表随正文变化（新的一轮、历史回读）时校高亮：高亮行被丢弃时重新落回当前轮。
 * 高亮按 id 保留，新轮次插到顶部时仍指着原来那一轮；没有入口了则收起浮层。
 */
watch(navEntries, () => {
  if (!expanded.value) return
  if (navEntries.value.length === 0) {
    closePopup(true)
    return
  }
  if (!navEntries.value.some(entry => entry.id === highlightedId.value)) resetHighlight()
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
        <span
          v-if="activeOrdinal !== null"
          class="app-titlebar-session-count"
          aria-hidden="true"
        >{{ activeOrdinal }}/{{ navEntries.length }}</span>
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

    <!-- 对话导航浮层：标题栏说明排序与轮次数，列表按新的在前排列；条目是序号 + 摘要 + 元信息，当前轮带强调条与文字标记。 -->
    <Teleport to="body">
      <Transition name="chat-nav">
        <div v-if="expanded" ref="popup" class="chat-nav-popup" :style="popupStyle">
          <div class="chat-nav-header">
            <span class="chat-nav-header-title">对话导航</span>
            <span v-if="navEntries.length > 0" class="chat-nav-header-meta">
              共 {{ navEntries.length }} 轮 · 新的在前
            </span>
          </div>
          <div
            :id="listboxId"
            :ref="onListRef"
            class="chat-nav-list"
            role="listbox"
            aria-label="对话导航"
            :tabindex="displayEntries.length === 0 ? 0 : -1"
            @keydown="onListKeydown"
          >
            <div
              v-for="row in displayEntries"
              :id="`chat-nav-${row.id}`"
              :key="row.id"
              :ref="(element) => setEntryElement(row.id, element)"
              class="chat-nav-entry"
              :class="{
                'is-active': row.id === highlightedId,
                'is-current': row.id === navActiveId
              }"
              role="option"
              :aria-selected="row.id === navActiveId"
              tabindex="-1"
              @mousedown.prevent
              @click="chooseEntry(row.id)"
              @focus="onEntryFocus(row.id)"
            >
              <span class="chat-nav-entry-ordinal" aria-hidden="true">{{ row.ordinal }}</span>
              <span class="chat-nav-entry-body">
                <span class="chat-nav-entry-text">{{ row.label }}</span>
                <span class="chat-nav-entry-meta">
                  <span v-if="row.time !== null" class="chat-nav-entry-time">{{ row.time }}</span>
                  <span v-if="row.uiCount > 0">含 {{ row.uiCount }} 个生成式界面</span>
                  <span v-if="row.id === navActiveId" class="chat-nav-entry-current">当前</span>
                </span>
              </span>
            </div>
            <p v-if="displayEntries.length === 0" class="chat-nav-empty">
              本会话还没有可跳转的对话轮次；发送第一条消息后这里会列出每一轮。
            </p>
          </div>
        </div>
      </Transition>
    </Teleport>
  </header>
</template>
