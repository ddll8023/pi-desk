<!--
  右侧面板文件行的操作菜单：打开、以另一种视图打开 Markdown、插入到终端、复制路径、复制文件名与在系统文件管理器中显示。

  菜单由文件树行按需打开（右键或键盘菜单键），锚点就是那一行，定位、翻转与收边都交给共用的锚定浮层；
  样式直接复用侧栏菜单的类，与左侧项目/会话菜单同一套令牌与层级。动作都只派发一次：
  「打开」把项目内相对路径交给工作区文件标签（Markdown 按设置里的默认视图打开）；Markdown 额外提供
  一个与默认视图相反的入口（默认预览时是「以源码模式打开」，反之亦然）；「插入到终端」写入当前活动终端
  （活动标签不是终端时禁用并写明原因），复制与显示所需的绝对路径一律经主进程解析，页面不自行拼接路径。
  复制、插入与显示动作的成败用面板内的一次性提示回报；打开动作的结果由文件标签自己展示。
-->
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { ProjectDirectoryEntryKind } from '../../../../shared/project-file-api'
import { useAnchoredPopup } from '../../ui/anchored-popup'
import { copyText } from '../../ui/clipboard'
import { isMarkdownPath } from '../file-language'
import { projectEntryInsertText } from '../../ui/project-entry-drag'
import { resolveProjectEntryPath, revealProjectEntry } from '../services/project-file'
import { useDesktopStore } from '../../shell/stores/desktop'
import { usePreferencesStore } from '../../preferences/stores/preferences'
import type { FileEditorMode } from '../stores/project-editor'
import { useTerminalStore } from '../../workspace/stores/terminal'
import { useWorkspaceTabsStore } from '../../workspace/stores/workspace-tabs'
import AppButton from '../../ui/AppButton.vue'

/** 菜单指向的条目；只保留展示与动作需要的最小信息。 */
interface FileTreeMenuTarget {
  readonly path: string
  readonly name: string
  readonly kind: ProjectDirectoryEntryKind
}

/** 动作结果的一次性提示；由文件树在面板内展示，不在这里自行渲染。 */
interface FileTreeMenuNotice {
  readonly text: string
  readonly tone: 'muted' | 'error'
}

const emit = defineEmits<{
  notice: [notice: FileTreeMenuNotice]
}>()

const desktopStore = useDesktopStore()
const preferencesStore = usePreferencesStore()
const terminalStore = useTerminalStore()
const workspaceTabsStore = useWorkspaceTabsStore()

/** 菜单宽度：按最长文案「在资源管理器中显示」留位。 */
const MENU_WIDTH = 208

const target = ref<FileTreeMenuTarget | null>(null)
/** 打开菜单的那一行；关闭时把焦点还给它。 */
let anchor: HTMLElement | null = null

const menu = useAnchoredPopup({
  width: MENU_WIDTH,
  align: 'start',
  onClose: () => {
    target.value = null
    anchor = null
  }
})
const { trigger: menuTrigger, popup: menuPopup, isOpen: menuOpen, position: menuPosition, open: openPopup, close: closePopup } = menu
/** 落点直接取共用锚定工具的结果：浮层高度由工具按实测值参与定位，调用点不再自行补偿。 */
const menuStyle = computed(() => {
  const position = menuPosition.value
  return {
    left: `${position.left}px`, top: `${position.top}px`,
    width: `${position.width}px`, maxHeight: `${position.maxHeight}px`
  }
})

/** 当前活动终端；活动标签不是终端或终端已消失时为空，「插入到终端」据此禁用。 */
const activeTerminal = computed(() => {
  const id = workspaceTabsStore.activeTerminalId
  if (id === null) return null
  return terminalStore.sessions.find(session => session.id === id) ?? null
})
const insertHint = computed(() => (
  activeTerminal.value === null
    ? '当前标签不是终端，先切到一个终端标签'
    : '把绝对路径插入当前终端，不回车执行'
))
/** 各平台的文案：macOS 是访达，Windows 是资源管理器，其余归为所在文件夹。 */
const revealLabel = computed(() => {
  const connection = desktopStore.connection
  const platform = connection.status === 'ready' ? connection.info.platform : ''
  if (platform === 'darwin') return '在访达中显示'
  if (platform === 'win32') return '在资源管理器中显示'
  return '打开所在文件夹'
})

/**
 * 打开菜单：锚定被右键的那一行并把焦点交给第一项；已在打开时先收起再展开，
 * 否则锚定工具会因为「已经展开」而跳过重新定位，菜单会停在上一行旁边。
 */
function openMenu(next: FileTreeMenuTarget, anchorElement: HTMLElement): void {
  closePopup()
  target.value = next
  anchor = anchorElement
  menuTrigger.value = anchorElement
  openPopup()
  void nextTick(() => {
    if (!menuOpen.value) return
    const first = menuPopup.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    if (first) first.focus()
    else menuPopup.value?.focus()
  })
}

/** 收起菜单；明确的键盘关闭才把焦点还给那一行，点击外部收起不抢占焦点。 */
function closeMenu(restoreFocus = false): void {
  const element = anchor
  const wasOpen = closePopup()
  if (restoreFocus && wasOpen) {
    void nextTick(() => {
      if (element?.isConnected) element.focus()
    })
  }
}

defineExpose({ open: openMenu, close: closeMenu })

/** 文件类条目才提供打开动作；目录、符号链接与其他特殊文件只能复制/显示。 */
const canOpen = computed(() => target.value?.kind === 'file')
/** 只有 Markdown 文件提供「以另一种视图打开」；其余文件本来就默认进源码。 */
const markdownTarget = computed(() => (
  target.value !== null && target.value.kind === 'file' && isMarkdownPath(target.value.path)
))
/** 与设置里的默认视图相反的那一档：默认预览时给源码入口，反之给预览入口。 */
const alternateMode = computed<FileEditorMode>(() => (
  preferencesStore.markdownDefaultView === 'preview' ? 'code' : 'preview'
))
const alternateLabel = computed(() => (
  alternateMode.value === 'code' ? '以源码模式打开' : '以预览模式打开'
))
const alternateTitle = computed(() => (
  alternateMode.value === 'code' ? '以源码模式打开 Markdown（默认打开为预览）' : '以预览模式打开 Markdown（默认打开为源码）'
))

/** 打开文件：交给工作区文件标签，已打开时聚焦已有标签。 */
function openEntry(): void {
  const entry = target.value
  closeMenu()
  if (entry === null || entry.kind !== 'file') return
  workspaceTabsStore.openFileTab(entry.path)
}

/** 以与默认视图相反的视图打开；默认视图由设置页决定，这里只给显式覆盖入口。 */
function openMarkdownAlternate(): void {
  const entry = target.value
  closeMenu()
  if (entry === null || entry.kind !== 'file') return
  workspaceTabsStore.openFileTab(entry.path, alternateMode.value)
}

/** 插入到当前活动终端：绝对路径由主进程解析，写入只补一个空格，不隐式回车。 */
function insertIntoTerminal(): void {
  const entry = target.value
  const session = activeTerminal.value
  closeMenu()
  if (entry === null || session === null) return
  void runInsert(entry, session)
}

async function runInsert(entry: FileTreeMenuTarget, session: { readonly id: string; readonly shell: string }): Promise<void> {
  const resolved = await resolveProjectEntryPath(entry.path)
  if (!resolved.ok) {
    emitNotice(resolved.error.message, 'error')
    return
  }
  await terminalStore.insertText(session.id, projectEntryInsertText(session.shell, resolved.data.absolutePath))
  emitNotice(`已插入到终端：${entry.name}`, 'muted')
}

function copyRelativePath(): void {
  const entry = target.value
  closeMenu()
  if (entry === null) return
  void runCopy(entry.path, `已复制相对路径：${entry.path}`)
}

function copyFileName(): void {
  const entry = target.value
  closeMenu()
  if (entry === null) return
  void runCopy(entry.name, `已复制文件名：${entry.name}`)
}

/** 绝对路径同样由主进程解析：平台分隔符与项目内包含性判定都留在主进程。 */
function copyAbsolutePath(): void {
  const entry = target.value
  closeMenu()
  if (entry === null) return
  void runCopyAbsolute(entry)
}

async function runCopyAbsolute(entry: FileTreeMenuTarget): Promise<void> {
  const resolved = await resolveProjectEntryPath(entry.path)
  if (!resolved.ok) {
    emitNotice(resolved.error.message, 'error')
    return
  }
  await runCopy(resolved.data.absolutePath, `已复制绝对路径：${resolved.data.absolutePath}`)
}

async function runCopy(text: string, successText: string): Promise<void> {
  const copied = await copyText(text)
  emitNotice(copied ? successText : '复制失败，剪贴板不可用。', copied ? 'muted' : 'error')
}

function revealInFileManager(): void {
  const entry = target.value
  closeMenu()
  if (entry === null) return
  void runReveal(entry)
}

async function runReveal(entry: FileTreeMenuTarget): Promise<void> {
  const result = await revealProjectEntry(entry.path)
  if (!result.ok) {
    emitNotice(result.error.message, 'error')
    return
  }
  emitNotice(`已在文件管理器中定位：${entry.name}`, 'muted')
}

function emitNotice(text: string, tone: 'muted' | 'error'): void {
  emit('notice', { text, tone })
}

/** 菜单内键盘：Esc 收起并还焦点，方向键与 Home/End 在菜单项间移动，Tab 只在菜单内循环。 */
function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeMenu(true)
    return
  }
  const buttons = Array.from(menuPopup.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  if (buttons.length === 0) return
  if (event.key === 'Tab') {
    event.preventDefault()
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.shiftKey
      ? (index <= 0 ? buttons.length - 1 : index - 1)
      : (index === buttons.length - 1 ? 0 : index + 1)
    buttons[next]?.focus()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[index]?.focus()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="pop-motion">
      <div
        v-if="menuOpen && target !== null"
        ref="menuPopup"
        class="project-sidebar-menu flex flex-col"
        :style="menuStyle"
        role="dialog"
        tabindex="-1"
        aria-label="文件操作"
        @keydown="onMenuKeydown"
      >
        <div class="sidebar-menu-details">
          <p class="sidebar-menu-title">{{ target.name }}</p>
          <p class="sidebar-menu-path">{{ target.path }}</p>
        </div>
        <AppButton
          variant="unstyled"
          class="project-sidebar-menu-item"
          :disabled="!canOpen"
          :title="canOpen ? '在工作区打开，可预览与编辑' : '只有普通文件可以打开'"
          @click="openEntry"
        >
          打开
        </AppButton>
        <AppButton
          v-if="markdownTarget"
          variant="unstyled"
          class="project-sidebar-menu-item"
          :title="alternateTitle"
          @click="openMarkdownAlternate"
        >
          {{ alternateLabel }}
        </AppButton>
        <AppButton
          variant="unstyled"
          class="project-sidebar-menu-item"
          :disabled="activeTerminal === null"
          :title="insertHint"
          @click="insertIntoTerminal"
        >
          插入到终端
        </AppButton>
        <AppButton variant="unstyled" class="project-sidebar-menu-item" @click="copyRelativePath">
          复制相对路径
        </AppButton>
        <AppButton variant="unstyled" class="project-sidebar-menu-item" @click="copyAbsolutePath">
          复制绝对路径
        </AppButton>
        <AppButton variant="unstyled" class="project-sidebar-menu-item" @click="copyFileName">
          复制文件名
        </AppButton>
        <AppButton variant="unstyled" class="project-sidebar-menu-item" @click="revealInFileManager">
          {{ revealLabel }}
        </AppButton>
      </div>
    </Transition>
  </Teleport>
</template>
