<!--
  项目与会话两级树形导航：项目是一级节点，会话是各自项目的子节点，两个项目可以同时展开。

  只编排现有展示动作：展开状态来自界面偏好，会话列表按项目懒读取，运行状态来自主进程登记；
  切换项目、打开会话与新建会话都交给 store，组件自身不做归属判断（归属由 sidebar-tree.ts 计算）。
  单击项目行 = 设为当前项目并展开，chevron 只控制展开折叠；项目右侧提供新建会话入口，
  更多操作与详情通过悬停菜单或右键菜单完成。展开折叠用 grid-template-rows 过渡，不测高、无脚本动画。

  单个项目的会话列表有高度上限（见 --sidebar-session-list-max-height）：超出部分在该项目内滚动，
  一个项目不会占满整个侧栏；上限带来当前会话可能落在可视区外，因此展开、切项目、切会话后
  会把当前会话滚进视野。

  会话列表是“最近 N 条”的分页窗口（首屏一页，滚动到底或点“加载更多”再取一页，上限见 MAX_SESSION_WINDOW）：
  一个项目的会话再多也不会一次性读入与渲染；分页状态来自 store，组件只负责触发加载与展示入口。
  当前会话的占位行只用于确实尚未落盘的会话（由运行状态给出），不再用“不在已加载窗口里”判断。
-->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { LayoutGroup, Motion, useReducedMotion } from 'motion-v'
import type { Options } from 'motion-v'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAnchoredPopup } from '../anchored-popup'
import { SESSION_RUN_LABELS, buildSidebarTree } from '../sidebar-tree'
import type { SidebarProjectNode, SidebarSessionRow } from '../sidebar-tree'
import { MAX_SESSION_WINDOW } from '../../../shared/session-api'
import { usePreferencesStore } from '../stores/preferences'
import { useProjectStore } from '../stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import { useSessionRunsStore } from '../stores/session-runs'
import { useWorkspaceTabsStore } from '../stores/workspace-tabs'
import type { SessionRunBadge } from '../stores/session-runs'
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
  /** 闲置态的新建会话：由外层建立对话标签并聚焦输入框，这里只转发目标项目。 */
  requestNewSession: [projectPath: string]
  deleteSession: [projectPath: string, session: SessionSummary]
}>()

const projectStore = useProjectStore()
const preferencesStore = usePreferencesStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const sessionRunsStore = useSessionRunsStore()
const workspaceTabsStore = useWorkspaceTabsStore()
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
const { actionError: sessionActionError, opening, deleting } = storeToRefs(sessionStore)

const projectBusy = computed(() => choosing.value || switching.value)
const sessionBusy = computed(() => opening.value || deleting.value)
/** 当前会话身份；宿主已回收（挂起）时仍指向同一会话，选中项不会因此消失。 */
const currentSessionId = computed(() => runtimeStore.foregroundSessionId)

/**
 * 活动对话标签展示的会话；行点击已一律走打开链，菜单的「当前会话」按同一个口径判定，
 * 避免活动标签是终端时菜单把已经在看的会话锁成不可点。
 */
const activeSessionId = computed(() => workspaceTabsStore.activeSessionId)

/**
 * 确实尚未落盘的当前会话身份：新建会话到首次写入之间 Pi 只分配身份，还没有会话文件。
 * 判据与主进程的空会话释放一致（消息数为 0），所以已落盘的历史会话即使不在已加载窗口里，
 * 也不会被误判成“尚未落盘”而多出一条占位行。
 */
const unsavedSessionId = computed<string | null>(() => {
  const view = runtimeView.value
  if (view.phase !== 'ready') return null
  const info = view.snapshot.info
  if (info === null || info.sessionId === null || info.messageCount > 0) return null
  return info.sessionId
})

/** 相对时间的刻度：一分钟一次即可，不参与消息区的 500ms 计时。 */
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null

/** 侧栏树：项目顺序取项目列表本身，展开状态、会话归属与分页状态都由构建函数决定。 */
const nodes = computed<readonly SidebarProjectNode[]>(() => buildSidebarTree({
  projects: projects.value,
  currentProjectPath: projectStore.currentProject?.path ?? null,
  expandedProjects: preferencesStore.expandedProjects,
  sessionsOf: sessionStore.sessionsOf,
  viewOf: sessionStore.viewOf,
  countsOf: sessionStore.countsOf,
  loadingMoreOf: sessionStore.loadingMoreOf,
  runs: sessionRunsStore.runs,
  foregroundSessionId: currentSessionId.value,
  unsavedSessionId: unsavedSessionId.value,
  now: now.value
}))

/** 展开的项目懒读取会话列表；已读过或正在读取的项目会被 store 直接跳过。 */
watch(nodes, (list) => {
  for (const node of list) {
    if (node.expanded) void sessionStore.ensureLoaded(node.project.path)
  }
}, { immediate: true })

/** 当前项目始终展开：手动折叠后再次成为当前项目时会重新展开。 */
watch(() => projectStore.currentProject?.path ?? null, (path) => {
  if (path !== null && !preferencesStore.isProjectExpanded(path)) preferencesStore.setProjectExpanded(path, true)
}, { immediate: true })

/**
 * 每个项目的会话列表滚动容器：列表有高度上限，超出部分在项目内滚动。
 * 登记在组件本地，只用于把当前会话滚进视野，不进全局状态。
 */
const sessionScrollers = new Map<string, HTMLElement>()

function registerSessionScroller(projectId: string, element: unknown): void {
  if (element instanceof HTMLElement) sessionScrollers.set(projectId, element)
  else sessionScrollers.delete(projectId)
}

/** 触底判定留出的余量：滚动到接近底部就开始取下一页，不让用户等在白底上。 */
const LOAD_MORE_THRESHOLD = 24

function atSessionListBottom(projectId: string): boolean {
  const scroller = sessionScrollers.get(projectId)
  if (scroller === undefined) return false
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - LOAD_MORE_THRESHOLD
}

/**
 * 逐页扩大某个项目的会话窗口，直到列表不再触底、没有更多或已达窗口上限。
 * 每轮至少扩大一页，因此不会无界循环；读取失败时窗口不再变化，用 `loadedLimit` 记下的进度直接退出。
 * 刚展开时列表只有首屏，若大部分文件都被跳过、行数填不满容器，这里会继续取下一页。
 */
async function loadMoreUntilFilled(projectPath: string, projectId: string): Promise<void> {
  let loadedLimit = -1
  for (;;) {
    const state = sessionStore.countsOf(projectPath)
    if (state.remaining <= 0 || sessionStore.windowFullOf(projectPath) || state.limit === loadedLimit) return
    loadedLimit = state.limit
    await sessionStore.loadMore(projectPath)
    await nextTick()
    if (!atSessionListBottom(projectId)) return
  }
}

/** 会话列表滚到接近底部时自动取下一页；没有更多时 `loadMore` 自己会跳过。 */
function onSessionScroll(node: SidebarProjectNode): void {
  if (!atSessionListBottom(node.project.id)) return
  void loadMoreUntilFilled(node.project.path, node.project.id)
}

/** “加载更多”入口：与触底自动加载同一条路径，只是由用户显式触发。 */
function requestMoreSessions(node: SidebarProjectNode): void {
  void loadMoreUntilFilled(node.project.path, node.project.id)
}

/**
 * 当前会话可见性：会话列表有高度上限，长列表里当前会话可能被挡在可视区外，
 * 用户在侧栏看不到自己在哪一条。展开、切项目、切会话后把它滚进视野，位置已可见时不动。
 */
watch(
  [currentSessionId, currentProjectId, () => preferencesStore.expandedProjects],
  async () => {
    await nextTick()
    const projectId = currentProjectId.value
    if (projectId === null) return
    const scroller = sessionScrollers.get(projectId)
    const active = scroller?.querySelector<HTMLElement>('.sidebar-tree-row.is-active')
    if (scroller === undefined || active === null || active === undefined) return
    const area = scroller.getBoundingClientRect()
    const row = active.getBoundingClientRect()
    if (row.top >= area.top && row.bottom <= area.bottom) return
    active.scrollIntoView({ block: 'nearest' })
  },
  { flush: 'post' }
)

const prefersReducedMotion = useReducedMotion()
const selectionTransition = computed<NonNullable<Options['transition']>>(() => ({
  type: 'tween', duration: prefersReducedMotion.value ? 0 : 0.25,
  ease: [0.22, 1, 0.36, 1]
}))

/** 大批读取和跨项目替换不做逐条入场；只让小规模增删及同一列表重排参与过渡。 */
const projectListMotion = ref(false)

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

function childrenId(node: SidebarProjectNode): string {
  return `sidebar-sessions-${node.project.id}`
}

function isCurrentProject(node: SidebarProjectNode): boolean {
  return node.project.id === currentProjectId.value
}

/** 该项目当前是否有可显示的会话行；读取中或刷新失败都不应把已有列表顶掉。 */
function hasSessionRows(node: SidebarProjectNode): boolean {
  return node.sessions.length > 0 || node.unboundRuns.length > 0
}

function isCurrentSession(node: SidebarProjectNode, session: SessionSummary): boolean {
  return isCurrentProject(node) && session.sessionId === currentSessionId.value
}

/** 运行状态点颜色；只用设计令牌，与通知/危险/强调语义一致。 */
const SESSION_RUN_DOT_CLASSES: Record<SessionRunBadge, string> = {
  unconfirmed: 'bg-desk-danger',
  failed: 'bg-desk-danger',
  waiting: 'bg-desk-warning',
  running: 'bg-desk-accent',
  ready: 'bg-desk-line-strong',
  suspended: 'bg-desk-line-strong',
  transitioning: 'bg-desk-line-strong'
}

/**
 * 「正在执行」是唯一随时间变化的状态，静止的点看不出还在工作。
 * 这里保持 6px 单点 + animate-pulse：状态色点族（failed/waiting/ready）共用同一形状，
 * 换成三点会破坏形状一致，运行提示的形态区分只在消息区表达。
 */
function runDotClass(badge: SessionRunBadge): string {
  const tone = SESSION_RUN_DOT_CLASSES[badge]
  return badge === 'running' ? `${tone} animate-pulse motion-reduce:animate-none` : tone
}

/** 路径展示末尾两段，兼容两种目录分隔符；完整路径仍在项目行提示与操作浮层中可读。 */
function shortenPath(path: string): string {
  const separators = [...path.matchAll(/[\\/]/g)]
  const cut = separators.at(-2)
  return cut === undefined ? path : `…${path.slice(cut.index)}`
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

/** 展开折叠只改界面偏好，不改当前项目；单击项目行才会切换当前项目。 */
function toggleProject(node: SidebarProjectNode): void {
  closeMenu()
  preferencesStore.setProjectExpanded(node.project.path, !node.expanded)
}

function setProjectExpanded(node: SidebarProjectNode, expanded: boolean): void {
  if (node.expanded === expanded) return
  preferencesStore.setProjectExpanded(node.project.path, expanded)
}

function selectProject(node: SidebarProjectNode): void {
  closeMenu()
  if (!isCurrentProject(node)) void projectStore.select(node.project.path, false)
  setProjectExpanded(node, true)
  emit('closeSidebar')
}

function chooseProject(): void {
  closeMenu()
  void projectStore.choose()
  emit('closeSidebar')
}

function openSessionRow(node: SidebarProjectNode, row: SidebarSessionRow): void {
  closeMenu()
  // 点击会话一律走打开链：会话已在前台时它同样把该会话的标签切到活动，终端标签不会挡住它。
  void sessionStore.open(row.session.sessionId, false, node.project.path)
  emit('closeSidebar')
}

/** 未绑定实例只有「转当前会话」一个动作：它没有会话身份，打开请求会复用同一实例。 */
function focusUnboundRun(node: SidebarProjectNode): void {
  closeMenu()
  void sessionStore.open(null, false, node.project.path)
  emit('closeSidebar')
}

/**
 * 在指定项目新建会话：闲置时空白聊天已经可用，只切换项目并把焦点交给输入框，不因点击入口启动 Pi；
 * 已有 Runtime 时先切当前项目再新建，新会话因此始终归属被点击的项目。
 */
function createSessionIn(node: SidebarProjectNode): void {
  closeMenu()
  emit('closeSidebar')
  const phase = runtimeView.value.phase
  if (phase === 'idle' || phase === 'closed') {
    if (!isCurrentProject(node)) void projectStore.select(node.project.path, false)
    setProjectExpanded(node, true)
    // 项目切换是异步的，因此把目标项目一并交给外层，标签落到被点击的项目上而不是还在切的那个。
    emit('requestNewSession', node.project.path)
    return
  }
  void sessionStore.open(null, false, node.project.path)
}

/** 释放阻塞态会话的运行实例；只解除登记，不中断在途工作、不删除历史。 */
function retryRunRelease(target: { readonly projectPath: string; readonly session: SessionSummary }): void {
  const view = sessionRunsStore.viewOfSession(target.projectPath, target.session.sessionId)
  closeMenu()
  if (view === null) return
  void sessionRunsStore.release(view.runId)
}

/** 项目与会话共用一个浮层；详情来自现有摘要，不新增会话修改能力；删除交给根级确认弹层。 */
type MenuTarget =
  | { kind: 'project'; node: SidebarProjectNode }
  | { kind: 'session'; projectPath: string; session: SessionSummary; pending: boolean }

const MENU_WIDTH = 232
const menuTarget = ref<MenuTarget | null>(null)
const anchoredMenu = useAnchoredPopup({
  width: MENU_WIDTH,
  align: 'end',
  onClose: () => { menuTarget.value = null }
})
const {
  trigger: menuTrigger, popup: menuPopup, isOpen: menuOpen, position: menuPosition
} = anchoredMenu
/** 落点直接取共用锚定工具的结果：浮层高度由工具按实测值参与定位，调用点不再自行补偿。 */
const menuStyle = computed(() => {
  const position = menuPosition.value
  return {
    left: `${position.left}px`, top: `${position.top}px`,
    width: `${position.width}px`, maxHeight: `${position.maxHeight}px`
  }
})

function isProjectMenuOpen(id: string): boolean {
  return menuOpen.value && menuTarget.value?.kind === 'project' && menuTarget.value.node.project.id === id
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
  menuTarget.value = target
  menuTrigger.value = trigger
  anchoredMenu.open()
  void nextTick(() => {
    if (!menuOpen.value) return
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
  if (target?.kind === 'project') emit('removeProject', target.node.project)
}

/** 请求删除会话：只把目标交给根级确认弹层，真正的收敛与删除都在主进程。 */
function requestSessionDeletion(): void {
  const target = menuTarget.value
  closeMenu()
  if (target?.kind !== 'session') return
  emit('deleteSession', target.projectPath, target.session)
}

/** 浮层里的会话打开与会话行同一口径：一律走打开链，由标签状态决定聚焦已有标签还是新开。 */
function openSessionFromMenu(): void {
  const target = menuTarget.value
  closeMenu()
  if (target?.kind !== 'session') return
  void sessionStore.open(target.session.sessionId, false, target.projectPath)
  emit('closeSidebar')
}

/** 浮层里被指向的运行实例状态；非阻塞态不提供释放动作。 */
const menuRunView = computed(() => {
  const target = menuTarget.value
  if (target?.kind !== 'session') return null
  return sessionRunsStore.viewOfSession(target.projectPath, target.session.sessionId)
})

const menuRunNeedsRelease = computed(() => (
  menuRunView.value?.badge === 'unconfirmed' || menuRunView.value?.badge === 'failed'
))

/** 路径比较折叠大小写，与主进程和树的归属判定同一口径。 */
function samePath(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right
  return left.toLowerCase() === right.toLowerCase()
}

/** 会话菜单标题与会话行同一口径：优先文件里的首条用户消息。 */
function menuSessionTitle(session: SessionSummary): string {
  const preview = session.preview?.trim()
  if (preview !== undefined && preview !== '') return preview
  return session.sessionId === currentSessionId.value ? '当前会话' : '未命名会话'
}

/** 浮层里的分叉来源标题：与行内标注同一口径，折叠掉的来源会话仍能解析出标题。 */
const menuForkedFrom = computed(() => {
  const target = menuTarget.value
  if (target?.kind !== 'session') return null
  const node = nodes.value.find(candidate => samePath(candidate.project.path, target.projectPath))
  return node?.sessions.find(row => row.session.sessionId === target.session.sessionId)?.forkedFrom ?? null
})

watch(() => props.sidebarCollapsed, collapsed => {
  if (collapsed) closeMenu()
})
watch(currentProjectId, () => closeMenu())
/** 浮层指向的项目或会话从树里消失时收起，不让动作落在一个已不存在的目标上。 */
watch(nodes, (list) => {
  const target = menuTarget.value
  if (target === null) return
  if (target.kind === 'project') {
    if (!list.some(node => node.project.id === target.node.project.id)) closeMenu()
    return
  }
  const node = list.find(candidate => samePath(candidate.project.path, target.projectPath))
  if (node === undefined || !node.sessions.some(row => row.session.sessionId === target.session.sessionId)) {
    closeMenu()
  }
})

onMounted(() => {
  nowTimer = setInterval(() => { now.value = Date.now() }, 60_000)
})

onBeforeUnmount(() => {
  if (nowTimer !== null) clearInterval(nowTimer)
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
      <header class="project-sidebar-header">
        <h2 id="project-nav-heading" class="project-sidebar-heading">项目</h2>
        <AppButton variant="unstyled" class="project-sidebar-add" :disabled="projectBusy" @click="chooseProject">
          <svg class="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          <span>{{ choosing ? '正在打开…' : '添加项目' }}</span>
        </AppButton>
      </header>

      <LayoutGroup id="sidebar-tree">
        <!-- `layout-scroll` 让共享选中背景在容器滚动时仍量到正确位置。 -->
        <Motion as="div" layout-scroll class="sidebar-tree-scroll scroll-area" :aria-busy="projectBusy || projectView.phase === 'loading'">
          <p v-if="projectStorageNotice" role="status" class="sidebar-notice is-warning">{{ projectStorageNotice }}</p>
          <p v-if="projectActionError" role="alert" class="sidebar-notice is-error">{{ projectActionError.message }}</p>
          <p v-if="sessionActionError" role="alert" class="sidebar-notice is-error">{{ sessionActionError.message }}</p>
          <p v-if="sessionRunsStore.releaseError !== null" role="alert" class="sidebar-notice is-error">{{ sessionRunsStore.releaseError }}</p>

          <p v-if="projectView.phase === 'loading'" role="status" class="sidebar-empty">正在读取项目列表…</p>
          <div v-else-if="projectView.phase === 'error'" class="sidebar-empty">
            <p role="alert" class="sidebar-error">{{ projectView.error.message }}</p>
            <AppButton variant="unstyled" class="project-sidebar-add" @click="projectStore.initialize()">重试</AppButton>
          </div>
          <p v-else-if="projects.length === 0" class="sidebar-empty">尚无项目，从上方添加项目目录。</p>
          <TransitionGroup v-else name="sidebar-list" tag="ul" class="sidebar-tree" :css="projectListMotion">
            <li v-for="node in nodes" :key="node.project.id">
              <div
                class="sidebar-tree-row is-project"
                :class="{ 'is-active': isCurrentProject(node), 'is-menu-open': isProjectMenuOpen(node.project.id) }"
                @contextmenu.prevent="openMenu({ kind: 'project', node }, $event)"
                @keydown="onRowKeydown({ kind: 'project', node }, $event)"
              >
                <Motion v-if="isCurrentProject(node)" as="span" layout-id="project-selection" class="sidebar-project-rail" :initial="false" :transition="selectionTransition" aria-hidden="true" />
                <AppButton
                  variant="unstyled" class="sidebar-chevron"
                  :aria-expanded="node.expanded" :aria-controls="childrenId(node)"
                  :aria-label="`${node.expanded ? '折叠' : '展开'}项目 ${node.project.name}`"
                  :disabled="projectBusy"
                  @click="toggleProject(node)"
                  @keydown.left.prevent="setProjectExpanded(node, false)"
                  @keydown.right.prevent="setProjectExpanded(node, true)"
                >
                  <svg class="sidebar-icon sidebar-chevron-mark" :class="{ 'is-expanded': node.expanded }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                </AppButton>
                <AppButton
                  variant="unstyled" class="sidebar-tree-item is-project"
                  :aria-current="isCurrentProject(node) ? 'true' : undefined"
                  :title="`${node.project.name}\n${node.project.path}`" :disabled="projectBusy"
                  @click="selectProject(node)"
                >
                  <svg class="sidebar-project-mark sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 10h18" /></svg>
                  <span class="sidebar-tree-copy">
                    <span class="sidebar-project-name">{{ node.project.name }}</span>
                    <span class="sidebar-project-path">{{ shortenPath(node.project.path) }}</span>
                  </span>
                </AppButton>
                <span class="sidebar-row-tail">
                  <!-- 折叠时也要能看到该项目有活动：展开后由会话行自己表达。 -->
                  <span v-if="!node.expanded && node.activity !== null" class="session-run-dot" :class="runDotClass(node.activity)" aria-hidden="true" />
                  <span class="sidebar-row-actions">
                    <AppButton
                      variant="unstyled" class="sidebar-row-action"
                      :disabled="projectBusy" :aria-label="`在项目 ${node.project.name} 新建会话`"
                      @click.stop="createSessionIn(node)"
                    >
                      <svg class="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                    </AppButton>
                    <AppButton
                      variant="unstyled" class="sidebar-row-action" data-sidebar-menu-trigger
                      :disabled="projectBusy" :aria-label="`项目 ${node.project.name} 的更多操作`"
                      aria-haspopup="dialog" :aria-expanded="isProjectMenuOpen(node.project.id)"
                      :aria-controls="isProjectMenuOpen(node.project.id) ? 'sidebar-actions' : undefined"
                      @click.stop="openMenu({ kind: 'project', node }, $event, true)"
                    >
                      <svg class="sidebar-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
                    </AppButton>
                  </span>
                </span>
              </div>

              <!-- 展开折叠用 0fr→1fr 过渡；折叠后内容不可聚焦，也不进入无障碍树。 -->
              <div
                class="sidebar-tree-children"
                :class="{ 'is-expanded': node.expanded }"
                :id="childrenId(node)"
                :inert="!node.expanded"
              >
                <div class="sidebar-tree-children-inner">
                  <!-- 读取失败只在没有可显示内容时顶替列表；已有列表时错误另起一行，不让列表折叠。 -->
                  <div v-if="node.view.phase === 'error'" class="sidebar-empty is-nested">
                    <p role="alert" class="sidebar-error">{{ node.view.error.message }}</p>
                    <AppButton variant="unstyled" class="project-sidebar-add" @click="sessionStore.ensureLoaded(node.project.path, true)">重试</AppButton>
                  </div>
                  <p v-if="!hasSessionRows(node) && node.view.phase === 'loading'" role="status" class="sidebar-empty is-nested">正在读取会话…</p>
                  <p v-else-if="!hasSessionRows(node) && node.view.phase !== 'error'" class="sidebar-empty is-nested">
                    还没有保存的会话，开始对话后会显示在这里。
                  </p>
                  <ul v-if="hasSessionRows(node)" class="sidebar-session-list sidebar-session-scroll scroll-area" :ref="element => registerSessionScroller(node.project.id, element)" @scroll="onSessionScroll(node)">
                    <li v-for="row in node.sessions" :key="row.session.sessionId">
                      <div
                        class="sidebar-tree-row is-session"
                        :class="{ 'is-active': isCurrentSession(node, row.session), 'is-menu-open': isSessionMenuOpen(row.session.sessionId) }"
                        @contextmenu.prevent="openMenu({ kind: 'session', projectPath: node.project.path, session: row.session, pending: row.pending }, $event)"
                        @keydown="onRowKeydown({ kind: 'session', projectPath: node.project.path, session: row.session, pending: row.pending }, $event)"
                      >
                        <Motion v-if="isCurrentSession(node, row.session)" as="span" :layout-id="`session-selection-${node.project.id}`" class="sidebar-selection" :initial="false" :transition="selectionTransition" :style="{ borderRadius: '5px' }" aria-hidden="true" />
                        <AppButton
                          variant="unstyled" class="sidebar-tree-item is-session"
                          :aria-current="isCurrentSession(node, row.session) ? 'true' : undefined"
                          :title="row.title" :disabled="sessionBusy"
                          @click="openSessionRow(node, row)"
                        >
                          <span class="sidebar-session-title">{{ row.title }}</span>
                          <!-- 分叉来源只用字形占位，完整来源与时间一样留在操作浮层里。 -->
                          <span v-if="row.forkedFrom !== null" class="sidebar-session-fork" :title="`分叉自 ${row.forkedFrom}`" aria-hidden="true">⑂</span>
                        </AppButton>
                        <span class="sidebar-row-tail">
                          <span v-if="row.badge !== null" class="session-run-dot" :class="runDotClass(row.badge)" aria-hidden="true" />
                          <span class="sidebar-session-meta">{{ row.meta }}</span>
                          <span class="sidebar-row-actions">
                            <!-- 没有文件条目的会话只提供阻塞态的释放动作，其余信息不存在。 -->
                            <AppButton
                              v-if="!row.pending || row.needsRelease"
                              variant="unstyled" class="sidebar-row-action" data-sidebar-menu-trigger
                              :disabled="sessionBusy" :aria-label="`会话 ${row.title} 的更多操作`"
                              aria-haspopup="dialog" :aria-expanded="isSessionMenuOpen(row.session.sessionId)"
                              :aria-controls="isSessionMenuOpen(row.session.sessionId) ? 'sidebar-actions' : undefined"
                              @click.stop="openMenu({ kind: 'session', projectPath: node.project.path, session: row.session, pending: row.pending }, $event, true)"
                            >
                              <svg class="sidebar-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
                            </AppButton>
                          </span>
                        </span>
                      </div>
                    </li>
                    <!-- 尚未绑定会话的运行实例：没有会话身份也没有文件条目，单独列一行才能被看到和切回。 -->
                    <li v-for="run in node.unboundRuns" :key="`unbound-${run.runId}`">
                      <div class="sidebar-tree-row is-session">
                        <AppButton
                          variant="unstyled" class="sidebar-tree-item is-session"
                          :title="'尚未发送第一条消息的新会话'" :disabled="sessionBusy"
                          @click="focusUnboundRun(node)"
                        >
                          <span class="sidebar-session-title">未命名会话</span>
                        </AppButton>
                        <span class="sidebar-row-tail">
                          <span class="session-run-dot" :class="runDotClass(run.badge)" aria-hidden="true" />
                          <span class="sidebar-session-meta">
                            {{ run.badge === 'ready' ? '尚未发送' : SESSION_RUN_LABELS[run.badge] }}
                          </span>
                        </span>
                      </div>
                    </li>
                  </ul>
                  <p v-if="node.skipped > 0" role="status" class="sidebar-list-notice is-nested">
                    已跳过 {{ node.skipped }} 个无法读取或不属于该项目的文件。
                  </p>
                  <!-- 列表是“最近 N 条”的窗口：还有更早的会话时给一个常驻入口，滚动到底也会自动加载。 -->
                  <AppButton
                    v-if="node.remaining > 0 && !node.windowFull"
                    variant="unstyled" class="sidebar-load-more"
                    :disabled="node.loadingMore"
                    @click="requestMoreSessions(node)"
                  >
                    {{ node.loadingMore ? '正在加载…' : `还有 ${node.remaining} 条更早的会话` }}
                  </AppButton>
                  <!-- 到窗口上限后不再加载：把原因写清楚，不让入口默默失效。 -->
                  <p v-else-if="node.remaining > 0" role="status" class="sidebar-list-notice is-nested">
                    已加载最近 {{ MAX_SESSION_WINDOW }} 条会话，更早的会话未加载。
                  </p>
                </div>
              </div>
            </li>
          </TransitionGroup>
        </Motion>
      </LayoutGroup>

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
            <p class="sidebar-menu-title">{{ menuTarget.node.project.name }}</p>
            <p class="sidebar-menu-path">{{ menuTarget.node.project.path }}</p>
          </div>
          <AppButton variant="unstyled" class="project-sidebar-menu-item" :disabled="projectBusy" @click="createSessionIn(menuTarget.node)">
            新建会话
          </AppButton>
          <AppButton variant="unstyled" class="project-sidebar-menu-item is-danger" :disabled="projectBusy" @click="requestProjectRemoval">从列表移除</AppButton>
        </template>
        <template v-else>
          <div class="sidebar-menu-details">
            <p class="sidebar-menu-title">{{ menuSessionTitle(menuTarget.session) }}</p>
            <dl class="sidebar-menu-metadata">
              <dt>会话 ID</dt><dd class="sidebar-session-id">{{ menuTarget.session.sessionId }}</dd>
              <dt>最近活动</dt><dd>{{ formatUpdatedAt(menuTarget.session.updatedAt, true) }}</dd>
              <dt>文件大小</dt><dd>{{ formatSize(menuTarget.session.sizeBytes) }}</dd>
              <dt v-if="menuForkedFrom !== null">分叉自</dt><dd v-if="menuForkedFrom !== null">{{ menuForkedFrom }}</dd>
            </dl>
          </div>
          <AppButton variant="unstyled" class="project-sidebar-menu-item" :disabled="sessionBusy || menuTarget.session.sessionId === activeSessionId" @click="openSessionFromMenu">
            {{ menuTarget.session.sessionId === activeSessionId ? '当前会话' : '打开会话' }}
          </AppButton>
          <!-- 阻塞态的会话只能靠释放运行实例恢复；这里给出唯一恢复动作，失败时占用仍保留。 -->
          <AppButton
            v-if="menuRunNeedsRelease"
            variant="unstyled" class="project-sidebar-menu-item"
            :disabled="sessionRunsStore.releasing"
            @click="retryRunRelease(menuTarget)"
          >
            {{ sessionRunsStore.releasing ? '正在释放…' : '重试释放运行实例' }}
          </AppButton>
          <!-- 删除只交给根级确认弹层发起；未落盘的占位会话没有文件条目，不提供删除。 -->
          <AppButton
            v-if="!menuTarget.pending"
            variant="unstyled" class="project-sidebar-menu-item is-danger"
            :disabled="sessionBusy"
            @click="requestSessionDeletion"
          >
            删除会话
          </AppButton>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>
