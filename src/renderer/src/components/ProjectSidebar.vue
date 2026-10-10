<!-- 项目与会话导航：项目添加经信任确认、移除仅影响 Desktop 记录；会话切换复用主进程中断保护。项目行的操作菜单经 Teleport 浮到 body，既不挤占列表高度也不被侧栏裁剪；路径只展示末尾两段，完整路径由 title 承担。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, ref } from 'vue'
import { useAnchoredPopup } from '../anchored-popup'
import { useProjectStore } from '../stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import type { Project } from '../../../shared/project-api'
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
const { view: sessionView, sessions, actionError: sessionActionError, opening } = storeToRefs(sessionStore)

const projectBusy = computed(() => choosing.value || switching.value)
const runtimeInfo = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const currentSessionId = computed(() => runtimeInfo.value?.sessionId ?? null)
const sessionBusy = computed(() => opening.value || sessionView.value.phase === 'loading')

/** 项目的「…」操作菜单：同一时刻只开一个，锚点与浮层位置交给共用的锚定浮层。 */
const MENU_WIDTH = 144
const menuProject = ref<Project | null>(null)
const anchoredMenu = useAnchoredPopup({
  width: MENU_WIDTH,
  align: 'end',
  onClose: () => {
    menuProject.value = null
  }
})
const {
  trigger: menuTrigger,
  popup: menuPopup,
  isOpen: menuOpen,
  position: menuPosition
} = anchoredMenu
const menuProjectId = computed(() => (
  menuProject.value === null ? undefined : `project-actions-${menuProject.value.id}`
))
const menuStyle = computed(() => ({
  left: `${menuPosition.value.left}px`,
  top: `${menuPosition.value.top}px`,
  width: `${menuPosition.value.width}px`,
  maxHeight: `${menuPosition.value.maxHeight}px`
}))

function selectSavedProject(path: string): void {
  if (path === projectStore.currentProject?.path) {
    emit('closeSidebar')
    return
  }
  void projectStore.select(path, false)
  emit('closeSidebar')
}

function chooseProject(): void {
  void projectStore.choose()
  emit('closeSidebar')
}

function openSavedSession(sessionId: string): void {
  if (sessionId === currentSessionId.value) return
  void sessionStore.open(sessionId, false)
  emit('closeSidebar')
}

function createSession(): void {
  // 闲置或已关闭时空白聊天已可用；不要仅因点击入口而启动 Pi。
  if (runtimeView.value.phase !== 'idle' && runtimeView.value.phase !== 'closed') {
    void sessionStore.open(null, false)
  }
  emit('closeSidebar')
}

function formatUpdatedAt(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** 侧栏宽度有限，路径只保留末尾两段；完整路径由 title 承担，分隔符风格保持原样。 */
const PATH_TAIL_SEGMENTS = 2

function shortenPath(path: string): string {
  const separators = [...path.matchAll(/[\\/]/g)]
  const cut = separators.at(-PATH_TAIL_SEGMENTS)
  if (cut === undefined) return path
  return `…${path.slice(cut.index)}`
}

/** 打开或收起某一行的菜单；锚点用 ⋯ 按钮本身，菜单因此贴着按钮右缘展开。 */
function toggleProjectMenu(project: Project, event: MouseEvent): void {
  if (menuProject.value?.id === project.id) {
    closeProjectMenu()
    return
  }
  const element = event.currentTarget
  if (!(element instanceof HTMLElement)) return
  menuProject.value = project
  menuTrigger.value = element
  anchoredMenu.open()
}

/** 收起菜单并把焦点还给 ⋯ 按钮；紧接着要开确认弹层时不要抢焦点。 */
function closeProjectMenu(restoreFocus = false): void {
  const wasOpen = anchoredMenu.close()
  if (restoreFocus && wasOpen) void nextTick(() => menuTrigger.value?.focus())
}

function requestProjectRemoval(): void {
  const project = menuProject.value
  closeProjectMenu()
  if (project !== null) emit('removeProject', project)
}

function projectInitial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'
}

function projectColorIndex(id: string): number {
  let hash = 0
  for (const character of id) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0
  }
  return hash % 6
}
</script>

<template>
  <aside
    class="app-sidebar"
    :class="{
      'is-collapsed': props.sidebarCollapsed,
      'is-mobile-open': props.mobileOpen
    }"
    :aria-hidden="props.sidebarCollapsed"
    :inert="props.sidebarCollapsed"
    aria-label="项目与会话导航"
  >
    <section class="project-sidebar-section-panel" aria-labelledby="project-nav-heading">
      <header class="project-sidebar-header">
        <h2 id="project-nav-heading" class="project-sidebar-heading">项目</h2>
        <AppButton
          variant="unstyled"
          class="project-sidebar-add"
          :disabled="projectBusy"
          @click="chooseProject"
        >
          {{ choosing ? '正在打开…' : '添加项目' }}
        </AppButton>
      </header>
      <div class="project-sidebar-scroll scroll-area">
        <p v-if="projectStorageNotice" role="status" class="status-notice status-notice-warn mx-2 my-2">
          {{ projectStorageNotice }}
        </p>
        <p v-if="projectActionError" role="alert" class="px-2 py-2 text-xs text-desk-danger">
          {{ projectActionError.message }}
        </p>
        <p v-if="projectView.phase === 'loading'" class="px-2 py-2 text-xs text-desk-muted">
          正在读取项目列表。
        </p>
        <div v-else-if="projectView.phase === 'error'" class="flex flex-wrap items-center gap-2 px-2 py-2">
          <p role="alert" class="text-xs text-desk-danger">{{ projectView.error.message }}</p>
          <AppButton variant="unstyled" class="icon-button" @click="projectStore.initialize()">重试</AppButton>
        </div>
        <p v-else-if="projects.length === 0" class="px-2 py-2 text-xs leading-5 text-desk-muted">
          尚无已保存的项目。
        </p>
        <TransitionGroup v-else tag="ul" class="project-sidebar-list">
          <li v-for="project in projects" :key="project.id">
            <div
              class="project-sidebar-row"
              :class="{
                'is-active': project.id === currentProjectId,
                'is-menu-open': menuOpen && menuProject?.id === project.id
              }"
            >
              <AppButton
                variant="unstyled"
                class="project-sidebar-item w-auto min-w-0 flex-1"
                :aria-current="project.id === currentProjectId ? 'true' : 'false'"
                :title="project.path"
                :disabled="projectBusy"
                @click="selectSavedProject(project.path)"
              >
                <span
                  class="project-sidebar-mark"
                  :class="`project-sidebar-mark-${projectColorIndex(project.id)}`"
                  aria-hidden="true"
                >
                  {{ projectInitial(project.name) }}
                </span>
                <span class="project-sidebar-copy">
                  <span class="project-sidebar-name">{{ project.name }}</span>
                  <span class="project-sidebar-path">{{ shortenPath(project.path) }}</span>
                </span>
              </AppButton>
              <div class="project-sidebar-actions">
                <AppButton
                  variant="ghost"
                  class="project-sidebar-menu-trigger"
                  :disabled="projectBusy"
                  :aria-label="`项目 ${project.name} 的更多操作`"
                  :aria-expanded="menuOpen && menuProject?.id === project.id"
                  :aria-controls="`project-actions-${project.id}`"
                  @click.stop="toggleProjectMenu(project, $event)"
                  @keydown.esc.stop="closeProjectMenu(true)"
                >
                  ⋯
                </AppButton>
              </div>
            </div>
          </li>
        </TransitionGroup>

        <!-- 菜单浮到 body：既不被侧栏滚动容器裁剪，也不再挤占列表高度。 -->
        <Teleport to="body">
          <Transition name="project-menu">
            <div
              v-if="menuProject !== null"
              :id="menuProjectId"
              ref="menuPopup"
              class="project-sidebar-menu"
              :style="menuStyle"
            >
              <AppButton
                variant="unstyled"
                class="project-sidebar-menu-item"
                :disabled="projectBusy"
                @click="requestProjectRemoval"
              >
                从列表移除
              </AppButton>
            </div>
          </Transition>
        </Teleport>
      </div>
    </section>

    <section class="session-sidebar-section" aria-labelledby="session-nav-heading">
      <header class="session-sidebar-header">
        <h2 id="session-nav-heading" class="project-sidebar-heading">会话</h2>
        <AppButton
          variant="unstyled"
          class="project-sidebar-add"
          :disabled="projectStore.currentProject === null || sessionBusy"
          @click="createSession"
        >
          新建
        </AppButton>
      </header>
      <div class="session-sidebar-scroll scroll-area" :aria-busy="sessionBusy">
        <p v-if="projectStore.currentProject === null" class="px-2 py-2 text-xs text-desk-muted">
          选择项目后显示会话。
        </p>
        <p v-else-if="sessionView.phase === 'loading'" role="status" class="px-2 py-2 text-xs text-desk-muted">
          正在读取会话…
        </p>
        <div v-else-if="sessionView.phase === 'error'" class="flex flex-wrap items-center gap-2 px-2 py-2">
          <p role="alert" class="text-xs text-desk-danger">{{ sessionView.error.message }}</p>
          <AppButton variant="unstyled" class="icon-button" @click="sessionStore.refresh()">重试</AppButton>
        </div>
        <p v-else-if="sessions.length === 0" class="px-2 py-2 text-xs leading-5 text-desk-muted">
          当前项目还没有已保存的会话。
        </p>
        <ul v-else class="session-sidebar-list">
          <li v-for="session in sessions" :key="session.sessionId">
            <AppButton
              variant="unstyled"
              class="session-sidebar-item"
              :class="session.sessionId === currentSessionId ? 'is-active' : ''"
              :aria-current="session.sessionId === currentSessionId ? 'true' : 'false'"
              :title="session.preview ?? `会话 ${session.sessionId}`"
              :disabled="sessionBusy"
              @click="openSavedSession(session.sessionId)"
            >
              <span class="session-sidebar-preview">
                {{ session.preview ?? `会话 ${session.sessionId.slice(0, 8)}` }}
              </span>
              <span class="session-sidebar-meta">
                <span class="font-mono">{{ session.sessionId.slice(0, 8) }}</span>
                <span>{{ formatUpdatedAt(session.updatedAt) }}</span>
              </span>
            </AppButton>
          </li>
        </ul>
        <p v-if="sessionActionError" role="alert" class="px-2 py-2 text-xs text-desk-danger">
          {{ sessionActionError.message }}
        </p>
      </div>
    </section>

    <div class="project-sidebar-footer">
      <AppButton
        variant="unstyled"
        class="project-sidebar-settings"
        :class="props.settingsActive ? 'is-active' : ''"
        :aria-current="props.settingsActive ? 'page' : undefined"
        @click="emit('toggleSettings')"
      >
        <span class="project-sidebar-settings-icon" aria-hidden="true">
          {{ props.settingsActive ? '←' : '⚙' }}
        </span>
        <span>{{ props.settingsActive ? '返回对话' : '设置' }}</span>
      </AppButton>
    </div>
  </aside>
</template>
