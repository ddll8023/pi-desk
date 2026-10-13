<!-- 项目与会话侧栏：紧凑导航、共享选中背景与锚定操作浮层；只编排现有展示动作，不改变存储、信任或 Runtime 切换流程。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { LayoutGroup, Motion, useReducedMotion } from 'motion-v'
import type { Options } from 'motion-v'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useAnchoredPopup } from '../anchored-popup'
import { useProjectStore } from '../stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import type { Project } from '../../../shared/project-api'
import type { SessionSummary } from '../../../shared/session-api'
import AppButton from './ui/AppButton.vue'

const props = defineProps<{
  readonly settingsActive: boolean
  readonly sidebarCollapsed: boolean
  readonly mobileOpen: boolean
}>()

const emit = defineEmits<{
  toggleSettings: []
  closeSidebar: []
  removeProject: [project: Project]
  requestNewSession: []
}>()

const projectStore = useProjectStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const {
  view: projectView,
  projects,
  currentProjectId,
  choosing,
  switching,
  storageNotice: projectStorageNotice,
  actionError: projectActionError
} = storeToRefs(projectStore)
const { view: runtimeView } = storeToRefs(runtimeStore)
const {
  view: sessionView, sessions, skipped, truncated, actionError: sessionActionError, opening
} = storeToRefs(sessionStore)

const projectBusy = computed(() => choosing.value || switching.value)
const runtimeInfo = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const currentSessionId = computed(() => runtimeInfo.value?.sessionId ?? null)
/**
 * 当前会话尚未出现在磁盘列表里（Pi 新建会话的会话文件到首次写入才创建）时，用运行时身份造一条占位条目，
 * 保证正在对话的会话在侧栏可见；文件出现后由真实摘要接管。
 */
const unsavedCurrentSession = computed<SessionSummary | null>(() => {
  const sessionId = currentSessionId.value
  if (sessionId === null || sessions.value.some((session) => session.sessionId === sessionId)) return null
  return {
    sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: Date.now(),
    sizeBytes: 0,
    preview: null
  }
})
const visibleSessions = computed<readonly SessionSummary[]>(() => (
  unsavedCurrentSession.value === null ? sessions.value : [unsavedCurrentSession.value, ...sessions.value]
))
function isUnsavedCurrent(session: SessionSummary): boolean {
  return session.sessionId === currentSessionId.value && unsavedCurrentSession.value !== null
}
const sessionBusy = computed(() => opening.value || sessionView.value.phase === 'loading')
const prefersReducedMotion = useReducedMotion()
const selectionTransition = computed<NonNullable<Options['transition']>>(() => ({
  type: 'tween', duration: prefersReducedMotion.value ? 0 : 0.25,
  ease: [0.22, 1, 0.36, 1]
}))

/** 大批读取和跨项目替换不做逐条入场；只让小规模增删及同一列表重排参与过渡。 */
const projectListMotion = ref(false)
const sessionListMotion = ref(false)
let sessionListProjectId = currentProjectId.value

function isSmallListChange(previous: readonly string[], next: readonly string[]): boolean {
  if (previous.length === 0 || next.length === 0) return false
  const previousIds = new Set(previous)
  const nextIds = new Set(next)
  const changed = previous.filter(id => !nextIds.has(id)).length
    + next.filter(id => !previousIds.has(id)).length
  return changed <= 2
}

watch(projects, (next, previous) => {
  projectListMotion.value = isSmallListChange(previous.map(p => p.id), next.map(p => p.id))
}, { flush: 'sync' })
watch(visibleSessions, (next, previous) => {
  sessionListMotion.value = sessionListProjectId === currentProjectId.value
    && isSmallListChange(previous.map(s => s.sessionId), next.map(s => s.sessionId))
  sessionListProjectId = currentProjectId.value
}, { flush: 'sync' })

/** 项目与会话共用一个浮层；详情来自现有摘要，不新增会话修改或删除能力。 */
type MenuTarget =
  | { kind: 'project'; project: Project }
  | { kind: 'session'; session: SessionSummary }

const MENU_WIDTH = 232
const menuTarget = ref<MenuTarget | null>(null)
const menuHeight = ref(0)
let menuResizeObserver: ResizeObserver | null = null
const anchoredMenu = useAnchoredPopup({
  width: MENU_WIDTH,
  align: 'end',
  onClose: () => { menuTarget.value = null }
})
const {
  trigger: menuTrigger, popup: menuPopup, isOpen: menuOpen, position: menuPosition
} = anchoredMenu
/** 共用锚定工具按高度上限向上定位；短浮层用实际高度补偿，仍限制在视窗内。 */
const menuStyle = computed(() => {
  const position = menuPosition.value
  const anchor = menuTrigger.value?.getBoundingClientRect()
  const proposedTop = menuHeight.value > 0 && anchor && position.top < anchor.top
    ? position.top + position.maxHeight - menuHeight.value : position.top
  const top = Math.max(8, Math.min(proposedTop, window.innerHeight - menuHeight.value - 8))
  return {
    left: `${position.left}px`, top: `${top}px`,
    width: `${position.width}px`, maxHeight: `${position.maxHeight}px`
  }
})

watch([menuPopup, menuOpen], ([popup, open]) => {
  menuResizeObserver?.disconnect()
  menuResizeObserver = null
  if (popup === null || !open) return
  menuHeight.value = popup.offsetHeight
  menuResizeObserver = new ResizeObserver(() => { menuHeight.value = popup.offsetHeight })
  menuResizeObserver.observe(popup)
}, { flush: 'post' })
onBeforeUnmount(() => menuResizeObserver?.disconnect())

function selectSavedProject(path: string): void {
  closeMenu()
  if (path === projectStore.currentProject?.path) {
    emit('closeSidebar')
    return
  }
  void projectStore.select(path, false)
  emit('closeSidebar')
}

function chooseProject(): void {
  closeMenu()
  void projectStore.choose()
  emit('closeSidebar')
}

function openSavedSession(sessionId: string): void {
  closeMenu()
  if (sessionId === currentSessionId.value) return
  void sessionStore.open(sessionId, false)
  emit('closeSidebar')
}

function createSession(): void {
  closeMenu()
  // 闲置或已关闭时空白聊天已可用：不因点击入口启动 Pi，只请外层把焦点交给输入框。
  if (runtimeView.value.phase !== 'idle' && runtimeView.value.phase !== 'closed') {
    void sessionStore.open(null, false)
  } else {
    emit('requestNewSession')
  }
  emit('closeSidebar')
}

function sessionTitle(session: SessionSummary): string {
  return session.preview?.trim() || (isUnsavedCurrent(session) ? '当前会话' : '未命名会话')
}

/** 尚未落盘的当前会话没有文件时间，显示进行中而不是伪造时间。 */
function sessionMeta(session: SessionSummary): string {
  return isUnsavedCurrent(session) ? '进行中' : formatUpdatedAt(session.updatedAt)
}

function formatUpdatedAt(timestamp: number, full = false): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', {
    ...(full ? { year: 'numeric' as const } : {}),
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 路径展示末尾两段，兼容两种目录分隔符；完整路径仍在项目条目与操作浮层中可读。 */
function shortenPath(path: string): string {
  const separators = [...path.matchAll(/[\\/]/g)]
  const cut = separators.at(-2)
  return cut === undefined ? path : `…${path.slice(cut.index)}`
}

function isProjectMenuOpen(id: string): boolean {
  return menuOpen.value && menuTarget.value?.kind === 'project' && menuTarget.value.project.id === id
}

function isSessionMenuOpen(id: string): boolean {
  return menuOpen.value && menuTarget.value?.kind === 'session' && menuTarget.value.session.sessionId === id
}

/** 右键及键盘菜单始终锚定行内的操作按钮，不依赖鼠标坐标或另外一套定位逻辑。 */
function openMenu(target: MenuTarget, event: MouseEvent | KeyboardEvent, toggle = false): void {
  if (target.kind === 'project' ? projectBusy.value : sessionBusy.value) return
  const host = event.currentTarget
  if (!(host instanceof HTMLElement)) return
  const trigger = host.matches('[data-sidebar-menu-trigger]')
    ? host : host.querySelector<HTMLElement>('[data-sidebar-menu-trigger]')
  if (trigger === null) return
  if (toggle && menuTrigger.value === trigger && menuOpen.value) {
    closeMenu(true)
    return
  }
  anchoredMenu.close()
  menuHeight.value = 0
  menuTarget.value = target
  menuTrigger.value = trigger
  anchoredMenu.open()
  void nextTick(() => {
    if (!menuOpen.value) return
    // 同一帧切换两条记录可能复用浮层节点；主动量算避免依赖一次未发生的 resize 通知。
    menuHeight.value = menuPopup.value?.offsetHeight ?? 0
    const first = menuPopup.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    if (first) first.focus()
    else menuPopup.value?.focus()
  })
}

/** 明确的键盘关闭才恢复焦点；点击外部或打开确认弹层不抢占新目标的焦点。 */
function closeMenu(restoreFocus = false): void {
  const trigger = menuTrigger.value
  const wasOpen = anchoredMenu.close()
  if (restoreFocus && wasOpen) {
    void nextTick(() => {
      if (!props.sidebarCollapsed && trigger?.isConnected) trigger.focus()
    })
  }
}

function onRowKeydown(target: MenuTarget, event: KeyboardEvent): void {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
  event.preventDefault()
  event.stopPropagation()
  openMenu(target, event)
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeMenu(true)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const buttons = Array.from(menuPopup.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  if (buttons.length === 0) return
  event.preventDefault()
  const current = buttons.findIndex(button => button === document.activeElement)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[index]?.focus()
}

function onMenuFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget
  if (next instanceof Node && (menuPopup.value?.contains(next) || menuTrigger.value?.contains(next))) return
  // 点击可选取的只读详情时，浏览器可能把焦点移到 body；保留浮层并让 Escape 仍可用。
  if (next === null) {
    void nextTick(() => {
      if (menuOpen.value) menuPopup.value?.focus({ preventScroll: true })
    })
    return
  }
  closeMenu()
}

function requestProjectRemoval(): void {
  const target = menuTarget.value
  closeMenu()
  if (target?.kind === 'project') emit('removeProject', target.project)
}

watch(() => props.sidebarCollapsed, collapsed => {
  if (collapsed) closeMenu()
})
watch(currentProjectId, () => closeMenu())
watch([projects, sessions], () => {
  const target = menuTarget.value
  if (target?.kind === 'project' && !projects.value.some(p => p.id === target.project.id)) closeMenu()
  if (target?.kind === 'session' && !sessions.value.some(s => s.sessionId === target.session.sessionId)) closeMenu()
})
</script>

<template>
  <aside
    class="app-sidebar"
    :class="{ 'is-collapsed': props.sidebarCollapsed, 'is-mobile-open': props.mobileOpen }"
    :aria-hidden="props.sidebarCollapsed"
    :inert="props.sidebarCollapsed"
    aria-label="项目与会话导航"
  >
    <!-- 内层保持展开宽度，外层只裁剪；折叠时长标题不反复换行，滚动容器也不重建。 -->
    <div class="sidebar-content">
      <section class="project-sidebar-section-panel" aria-labelledby="project-nav-heading">
        <header class="project-sidebar-header">
          <h2 id="project-nav-heading" class="project-sidebar-heading">项目</h2>
          <AppButton variant="unstyled" class="project-sidebar-add" :disabled="projectBusy" @click="chooseProject">
            <svg class="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            <span>{{ choosing ? '正在打开…' : '添加项目' }}</span>
          </AppButton>
        </header>
        <LayoutGroup id="sidebar-projects">
          <Motion as="div" layout-scroll class="project-sidebar-scroll scroll-area" :aria-busy="projectBusy || projectView.phase === 'loading'">
            <p v-if="projectStorageNotice" role="status" class="sidebar-notice is-warning">{{ projectStorageNotice }}</p>
            <p v-if="projectActionError" role="alert" class="sidebar-notice is-error">{{ projectActionError.message }}</p>
            <p v-if="projectView.phase === 'loading'" role="status" class="sidebar-empty">正在读取项目列表…</p>
            <div v-else-if="projectView.phase === 'error'" class="sidebar-empty">
              <p role="alert" class="sidebar-error">{{ projectView.error.message }}</p>
              <AppButton variant="unstyled" class="project-sidebar-add" @click="projectStore.initialize()">重试</AppButton>
            </div>
            <p v-else-if="projects.length === 0" class="sidebar-empty">尚无项目，从上方添加项目目录。</p>
            <TransitionGroup v-else name="sidebar-list" tag="ul" class="project-sidebar-list" :css="projectListMotion">
              <li v-for="project in projects" :key="project.id">
                <div
                  class="project-sidebar-row"
                  :class="{ 'is-active': project.id === currentProjectId, 'is-menu-open': isProjectMenuOpen(project.id) }"
                  @contextmenu.prevent="openMenu({ kind: 'project', project }, $event)"
                  @keydown="onRowKeydown({ kind: 'project', project }, $event)"
                >
                  <Motion v-if="project.id === currentProjectId" as="span" layout-id="project-selection" class="sidebar-selection" :initial="false" :transition="selectionTransition" :style="{ borderRadius: '6px' }" aria-hidden="true" />
                  <AppButton
                    variant="unstyled" class="project-sidebar-item"
                    :aria-current="project.id === currentProjectId ? 'true' : undefined"
                    :title="`${project.name}\n${project.path}`" :disabled="projectBusy"
                    @click="selectSavedProject(project.path)"
                  >
                    <svg class="project-sidebar-mark sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 10h18" /></svg>
                    <span class="project-sidebar-copy">
                      <span class="project-sidebar-name">{{ project.name }}</span>
                      <span class="project-sidebar-path">{{ shortenPath(project.path) }}</span>
                    </span>
                  </AppButton>
                  <AppButton
                    variant="unstyled" class="sidebar-menu-trigger" data-sidebar-menu-trigger
                    :disabled="projectBusy" :aria-label="`项目 ${project.name} 的更多操作`"
                    aria-haspopup="dialog" :aria-expanded="isProjectMenuOpen(project.id)"
                    :aria-controls="isProjectMenuOpen(project.id) ? 'sidebar-actions' : undefined"
                    @click.stop="openMenu({ kind: 'project', project }, $event, true)"
                  >
                    <svg class="sidebar-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
                  </AppButton>
                </div>
              </li>
            </TransitionGroup>
          </Motion>
        </LayoutGroup>
      </section>

      <section class="session-sidebar-section" aria-labelledby="session-nav-heading">
        <header class="session-sidebar-header">
          <h2 id="session-nav-heading" class="project-sidebar-heading">会话</h2>
          <AppButton variant="unstyled" class="project-sidebar-add" :disabled="projectStore.currentProject === null || sessionBusy" @click="createSession">
            <svg class="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            <span>新建</span>
          </AppButton>
        </header>
        <LayoutGroup id="sidebar-sessions">
          <Motion as="div" layout-scroll class="session-sidebar-scroll scroll-area" :aria-busy="sessionBusy">
            <p v-if="projectStore.currentProject === null" class="sidebar-empty">选择项目后显示会话。</p>
            <p v-else-if="sessionView.phase === 'loading'" role="status" class="sidebar-empty">正在读取会话…</p>
            <div v-else-if="sessionView.phase === 'error'" class="sidebar-empty">
              <p role="alert" class="sidebar-error">{{ sessionView.error.message }}</p>
              <AppButton variant="unstyled" class="project-sidebar-add" @click="sessionStore.refresh()">重试</AppButton>
            </div>
            <p v-else-if="visibleSessions.length === 0" class="sidebar-empty">还没有保存的会话，开始对话后会显示在这里。</p>
            <TransitionGroup v-else name="sidebar-list" tag="ul" class="session-sidebar-list" :css="sessionListMotion">
              <li v-for="session in visibleSessions" :key="session.sessionId">
                <div
                  class="session-sidebar-row"
                  :class="{ 'is-active': session.sessionId === currentSessionId, 'is-menu-open': isSessionMenuOpen(session.sessionId) }"
                  @contextmenu.prevent="openMenu({ kind: 'session', session }, $event)"
                  @keydown="onRowKeydown({ kind: 'session', session }, $event)"
                >
                  <Motion v-if="session.sessionId === currentSessionId" as="span" :layout-id="`session-selection-${currentProjectId}`" class="sidebar-selection" :initial="false" :transition="selectionTransition" :style="{ borderRadius: '6px' }" aria-hidden="true" />
                  <AppButton
                    variant="unstyled" class="session-sidebar-item"
                    :aria-current="session.sessionId === currentSessionId ? 'true' : undefined"
                    :title="sessionTitle(session)" :disabled="sessionBusy"
                    @click="openSavedSession(session.sessionId)"
                  >
                    <span class="session-sidebar-copy">
                      <span class="session-sidebar-preview">{{ sessionTitle(session) }}</span>
                      <span class="session-sidebar-meta">{{ sessionMeta(session) }}</span>
                    </span>
                  </AppButton>
                  <AppButton
                    v-if="!isUnsavedCurrent(session)"
                    variant="unstyled" class="sidebar-menu-trigger" data-sidebar-menu-trigger
                    :disabled="sessionBusy" :aria-label="`会话 ${sessionTitle(session)} 的更多操作`"
                    aria-haspopup="dialog" :aria-expanded="isSessionMenuOpen(session.sessionId)"
                    :aria-controls="isSessionMenuOpen(session.sessionId) ? 'sidebar-actions' : undefined"
                    @click.stop="openMenu({ kind: 'session', session }, $event, true)"
                  >
                    <svg class="sidebar-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
                  </AppButton>
                </div>
              </li>
            </TransitionGroup>
            <p v-if="sessionActionError" role="alert" class="sidebar-notice is-error">{{ sessionActionError.message }}</p>
            <p v-if="projectStore.currentProject !== null && sessionView.phase === 'ready' && (skipped > 0 || truncated > 0)" role="status" class="sidebar-list-notice">
              <span v-if="skipped > 0">已跳过 {{ skipped }} 个无法读取或不属于当前项目的文件。</span>
              <span v-if="truncated > 0">另有 {{ truncated }} 条较早会话未列出。</span>
            </p>
          </Motion>
        </LayoutGroup>
      </section>

      <footer class="project-sidebar-footer">
        <AppButton
          variant="unstyled" class="project-sidebar-settings"
          :class="{ 'is-active': props.settingsActive }"
          :aria-current="props.settingsActive ? 'page' : undefined"
          @click="closeMenu(); emit('toggleSettings')"
        >
          <svg v-if="props.settingsActive" class="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 6-6 6 6 6M4 12h16" /></svg>
          <svg v-else class="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 3-.6 2.4-2 .9-2.2-.7-2 3.4 1.6 1.7v2.6L2.2 15l2 3.4 2.2-.7 2 .9L9 21h4l.6-2.4 2-.9 2.2.7 2-3.4-1.6-1.7v-2.6L19.8 9l-2-3.4-2.2.7-2-.9L13 3Z" /><circle cx="11" cy="12" r="3" /></svg>
          <span class="sidebar-footer-label">{{ props.settingsActive ? '返回对话' : '设置' }}</span>
        </AppButton>
      </footer>
    </div>
  </aside>

  <Teleport to="body">
    <Transition name="sidebar-menu">
      <div
        v-if="menuTarget !== null" id="sidebar-actions" ref="menuPopup"
        class="project-sidebar-menu" :style="menuStyle" role="dialog" tabindex="-1"
        :aria-label="menuTarget.kind === 'project' ? '项目操作' : '会话操作与信息'"
        @keydown="onMenuKeydown" @focusout="onMenuFocusOut"
      >
        <template v-if="menuTarget.kind === 'project'">
          <div class="sidebar-menu-details">
            <p class="sidebar-menu-title">{{ menuTarget.project.name }}</p>
            <p class="sidebar-menu-path">{{ menuTarget.project.path }}</p>
          </div>
          <AppButton variant="unstyled" class="project-sidebar-menu-item is-danger" :disabled="projectBusy" @click="requestProjectRemoval">从列表移除</AppButton>
        </template>
        <template v-else>
          <div class="sidebar-menu-details">
            <p class="sidebar-menu-title">{{ sessionTitle(menuTarget.session) }}</p>
            <dl class="sidebar-menu-metadata">
              <dt>会话 ID</dt><dd class="sidebar-session-id">{{ menuTarget.session.sessionId }}</dd>
              <dt>最近活动</dt><dd>{{ formatUpdatedAt(menuTarget.session.updatedAt, true) }}</dd>
              <dt>文件大小</dt><dd>{{ formatSize(menuTarget.session.sizeBytes) }}</dd>
            </dl>
          </div>
          <AppButton variant="unstyled" class="project-sidebar-menu-item" :disabled="sessionBusy || menuTarget.session.sessionId === currentSessionId" @click="openSavedSession(menuTarget.session.sessionId)">
            {{ menuTarget.session.sessionId === currentSessionId ? '当前会话' : '打开会话' }}
          </AppButton>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>
