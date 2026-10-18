<!--
  单个终端标签的 xterm 视图：一个会话对应一个终端实例，非活动标签只隐藏不销毁。

  挂载时创建 xterm 并按容器测量尺寸后同步给主进程；容器尺寸变化（窗口、面板拖拽）经防抖重新测量。
  输出由 store 分发到这里，xterm 写完这一段后回报已消费的字符数，主进程据此释放背压额度。
  颜色取自主题令牌，暗色随 prefers-color-scheme 自动切换，与界面其余部分同一套令牌。

  渲染器：WebGL 只在标签可见期间持有，切走即释放 GPU 上下文、切回重建，隐藏标签不占上下文，
  多标签时不会因超出浏览器上下文上限被淘汰成空白画面；上下文丢失或窗口从隐藏恢复时降级/重建
  渲染器并强制整屏重绘，终端实例与进程都不受影响。

  安全与习惯：终端输出只作为文本写入 xterm，不解析 HTML；链接点击只复制地址，不打开浏览器（页面没有
  打开任意地址的权限，只有认证流程能经主进程打开 URL）；多行粘贴先确认，避免一次误粘贴直接执行命令。

  落点：右侧面板的文件行拖到本面板时，把该文件的绝对路径写入本终端（不回车，只补一个空格），
  由用户自己接着补命令；绝对路径经主进程解析，这里只做载荷归属校验与转义。
  右键：在指针位置打开快捷命令菜单（xterm 自身不改右键默认行为，这里只追加菜单）；
  菜单数据与动作都由页面传入与处理，本视图不读写配置。
-->
<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import type { IDisposable, ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { TERMINAL_DIMENSION_MAX, TERMINAL_DIMENSION_MIN, TERMINAL_WRITE_MAX_CHARS } from '../../../shared/terminal-api'
import type { TerminalSessionInfo } from '../../../shared/terminal-api'
import type { QuickCommand, QuickCommandScope } from '../../../shared/quick-commands-api'
import { copyText } from '../clipboard'
import { hasProjectEntryDragData, projectEntryInsertText, readProjectEntryDragData } from '../project-entry-drag'
import { resolveProjectEntryPath } from '../services/project-file'
import { resizeTerminal, writeTerminal } from '../services/terminal'
import { useProjectStore } from '../stores/project'
import { useTerminalStore } from '../stores/terminal'
import AppButton from './ui/AppButton.vue'
import QuickCommandMenu from './QuickCommandMenu.vue'

const props = defineProps<{
  readonly session: TerminalSessionInfo
  /** 是否为当前显示的标签；隐藏的终端保持挂载，只是不接收焦点。 */
  readonly active: boolean
  /** 当前可用的快捷命令；顺序由页面决定（项目命令在前，全局命令在后）。 */
  readonly quickCommands: readonly QuickCommand[]
  /** 当前项目路径；为空时快捷菜单的项目级入口禁用。 */
  readonly projectPath: string | null
}>()

const emit = defineEmits<{
  runCommand: [command: QuickCommand]
  editCommand: [command: QuickCommand]
  removeCommand: [command: QuickCommand]
  addCommand: [scope: QuickCommandScope]
  manageCommands: []
}>()

const terminalStore = useTerminalStore()
const projectStore = useProjectStore()
/** 当前项目名：快捷菜单的项目组标题用它；项目不在列表里时为空，由菜单退回「当前项目」。 */
const projectName = computed(() => (
  projectStore.projects.find((project) => project.path === props.projectPath)?.name ?? null
))
const container = ref<HTMLDivElement | null>(null)
/** 待确认的多行粘贴；非空时终端上方显示确认条。 */
const pendingPaste = ref<{ readonly text: string; readonly lines: number } | null>(null)
/** 一次性提示（复制链接结果、插入路径结果等）；到点自动消失。 */
const notice = ref<string | null>(null)
/** 是否有本应用的文件拖动悬停在本面板上；只用于高亮，不改变终端尺寸。 */
const dropActive = ref(false)
/** 快捷命令菜单；右键时在指针位置打开。 */
const commandMenu = ref<InstanceType<typeof QuickCommandMenu> | null>(null)

/** 回滚缓冲行数；与 Orca 同量级，足够翻回构建日志。 */
const SCROLLBACK_LINES = 5000
/** 超过这个行数的粘贴需要确认，避免多行命令被直接执行。 */
const PASTE_CONFIRM_LINES = 3
/** 尺寸测量防抖：拖拽面板时只按最终尺寸同步一次。 */
const FIT_DEBOUNCE_MS = 100
const NOTICE_MS = 2500

/** 暗色下的 16 色：与界面令牌同一色系（青蓝强调、低饱和语义色），不用 xterm 默认高饱和配色。 */
const DARK_ANSI: ITheme = {
  black: '#1b2530',
  red: '#d4736f',
  green: '#7fb27a',
  yellow: '#d3b06e',
  blue: '#6f9fd8',
  magenta: '#b48ad4',
  cyan: '#5fb3c4',
  white: '#c8d3dc',
  brightBlack: '#3d4d5c',
  brightRed: '#e08d88',
  brightGreen: '#9cc796',
  brightYellow: '#e3c78d',
  brightBlue: '#8fb8e6',
  brightMagenta: '#c9a6e0',
  brightCyan: '#7cc7d6',
  brightWhite: '#e6eef5'
}

/** 浅色下的 16 色：压低亮度以保证在浅底上的对比度。 */
const LIGHT_ANSI: ITheme = {
  black: '#2b3843',
  red: '#a4373a',
  green: '#2f6d3a',
  yellow: '#8a6116',
  blue: '#2c5f9e',
  magenta: '#7b4a9c',
  cyan: '#1f6b7a',
  white: '#d5dde3',
  brightBlack: '#5b6b78',
  brightRed: '#c25a5d',
  brightGreen: '#4a8b55',
  brightYellow: '#a87c26',
  brightBlue: '#3f7cbf',
  brightMagenta: '#9663b8',
  brightCyan: '#2f8496',
  brightWhite: '#f2f6f8'
}

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let webglAddon: WebglAddon | null = null
/** 本次挂载已判定 WebGL 不可用（创建失败或上下文丢失），后续一律用默认 DOM 渲染器。 */
let webglBlocked = false
let stopInput: IDisposable | null = null
let stopTitle: IDisposable | null = null
let resizeObserver: ResizeObserver | null = null
let themeQuery: MediaQueryList | null = null
let fitTimer: number | null = null
let noticeTimer: number | null = null

onMounted(() => {
  mountTerminal()
})

onBeforeUnmount(() => {
  unmountTerminal()
})

/**
 * 切到本标签时重建 WebGL 渲染器、按当前尺寸重排、整屏重绘并取得焦点；隐藏期间测不出尺寸，因此不能提前同步。
 * 切走时释放 GPU 上下文，避免多个隐藏终端各自占着一个上下文。
 */
watch(() => props.active, (active) => {
  if (!active) {
    detachWebgl()
    return
  }
  void nextTick(() => {
    if (!props.active) return
    attachWebgl()
    fitNow()
    refreshTerminal()
    term?.focus()
  })
})

/**
 * 有文本插入本终端（拖入文件路径、菜单里的「插入到终端」、运行快捷命令）时把焦点收回来：
 * 触发这些动作的焦点原本在文件行、菜单或查找框上，不收回的话用户接着敲的命令会落到别处。
 */
watch(() => terminalStore.insertFocus, (focus) => {
  if (!props.active || focus === null || focus.id !== props.session.id) return
  term?.focus()
})

function mountTerminal(): void {
  const host = container.value
  if (host === null) return

  const terminal = new Terminal({
    fontFamily: readFontFamily(host),
    fontSize: 13,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: SCROLLBACK_LINES,
    theme: readTheme(host)
  })
  terminal.open(host)

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(new WebLinksAddon((_event, uri) => {
    void copyLink(uri)
  }))

  stopInput = terminal.onData((data) => {
    void sendInput(data)
  })
  stopTitle = terminal.onTitleChange((title) => {
    terminalStore.applyTerminalTitle(props.session.id, title)
  })
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey) || event.altKey) return true
    if (event.key.toLowerCase() !== 'c') return true
    const selection = terminal.getSelection()
    // 有选中内容时按复制处理，不把 Ctrl+C 当成中断发给终端。
    if (selection === '') return true
    void copyText(selection)
    return false
  })

  // 输出交给本视图，写完这一段再回报消费量，主进程据此继续下发。
  terminalStore.registerWriter(props.session.id, (event, consumed) => {
    terminal.write(event.chunk, consumed)
  })

  term = terminal
  // 渲染器要在 term 赋值之后才挂：attachWebgl 通过 term 读写渲染器。
  if (props.active) attachWebgl()
  // 捕获阶段拦粘贴：多行粘贴要先确认，不能让 xterm 自己先把它写进终端。
  host.addEventListener('paste', onPaste, true)
  resizeObserver = new ResizeObserver(() => scheduleFit())
  resizeObserver.observe(host)
  themeQuery = window.matchMedia('(prefers-color-scheme: dark)')
  themeQuery.addEventListener('change', applyTheme)
  document.addEventListener('visibilitychange', onDocumentVisibilityChange)

  fitNow()
  // 字体可能还没就绪，就绪后重新测一次，避免用回退字体的度量算出偏小的尺寸。
  void document.fonts.ready.then(() => scheduleFit())
  if (props.active) terminal.focus()
}

function unmountTerminal(): void {
  if (fitTimer !== null) {
    window.clearTimeout(fitTimer)
    fitTimer = null
  }
  if (noticeTimer !== null) {
    window.clearTimeout(noticeTimer)
    noticeTimer = null
  }
  resizeObserver?.disconnect()
  resizeObserver = null
  themeQuery?.removeEventListener('change', applyTheme)
  themeQuery = null
  document.removeEventListener('visibilitychange', onDocumentVisibilityChange)
  container.value?.removeEventListener('paste', onPaste, true)
  stopInput?.dispose()
  stopInput = null
  stopTitle?.dispose()
  stopTitle = null
  terminalStore.unregisterWriter(props.session.id)
  detachWebgl()
  term?.dispose()
  term = null
  fitAddon = null
}

/**
 * 为当前终端挂上 WebGL 渲染器；只在标签可见时调用。
 * 创建失败（没有可用的 WebGL2）或已经判定不可用时直接返回，终端继续用默认 DOM 渲染器。
 */
function attachWebgl(): void {
  const terminal = term
  if (terminal === null || webglBlocked || webglAddon !== null) return
  try {
    const webgl = new WebglAddon()
    // 上下文丢失（GPU 进程异常、上下文被回收）后降级到 DOM 渲染器，终端实例与进程都不重建。
    webgl.onContextLoss(() => handleContextLoss())
    terminal.loadAddon(webgl)
    webglAddon = webgl
  } catch {
    webglBlocked = true
  }
}

/**
 * 释放 WebGL 渲染器与其 GPU 上下文。
 * dispose 会触发 addon 自身的回退钩子，把终端切回默认 DOM 渲染器并做一次全量重绘。
 */
function detachWebgl(): void {
  const webgl = webglAddon
  webglAddon = null
  webgl?.dispose()
}

/** 上下文丢失：本次挂载放弃 WebGL，交给 DOM 渲染器并立即重绘，不停在空白画面。 */
function handleContextLoss(): void {
  webglBlocked = true
  detachWebgl()
  refreshTerminal()
}

/** 强制整屏重绘；切回标签、窗口恢复、上下文丢失后都靠它把已有内容画出来。 */
function refreshTerminal(): void {
  const terminal = term
  if (terminal === null || terminal.rows <= 0) return
  terminal.refresh(0, terminal.rows - 1)
}

/**
 * 窗口从隐藏恢复时重建渲染器：上下文可能在窗口不可见期间被静默丢弃且不派发 context loss 事件，
 * 重建一次比等下一次输出才恢复更可靠。
 */
function onDocumentVisibilityChange(): void {
  if (document.visibilityState !== 'visible' || !props.active) return
  detachWebgl()
  attachWebgl()
  refreshTerminal()
}

function scheduleFit(): void {
  if (fitTimer !== null) return
  fitTimer = window.setTimeout(() => {
    fitTimer = null
    fitNow()
  }, FIT_DEBOUNCE_MS)
}

/** 按容器测量并同步尺寸；隐藏标签与未布局完成的容器测不出有效尺寸，此时保持上一次尺寸。 */
function fitNow(): void {
  if (!props.active) return
  const terminal = term
  const addon = fitAddon
  if (terminal === null || addon === null) return
  const dimensions = addon.proposeDimensions()
  if (dimensions === undefined) return
  const cols = Math.floor(dimensions.cols)
  const rows = Math.floor(dimensions.rows)
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
  if (cols < TERMINAL_DIMENSION_MIN || rows < TERMINAL_DIMENSION_MIN) return
  if (cols > TERMINAL_DIMENSION_MAX || rows > TERMINAL_DIMENSION_MAX) return
  if (cols === terminal.cols && rows === terminal.rows) return
  try {
    addon.fit()
  } catch {
    return
  }
  void resizeTerminal({ id: props.session.id, cols: terminal.cols, rows: terminal.rows })
}

async function sendInput(data: string): Promise<void> {
  if (!props.active) return
  const result = await writeTerminal({ id: props.session.id, data })
  if (!result.ok) terminalStore.reportError(result.error.message)
}

/** 多行粘贴先确认；行数不多时交给 xterm 自己的粘贴路径处理。 */
function onPaste(event: ClipboardEvent): void {
  if (!props.active) return
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (text === '') return
  const lines = text.split('\n').length
  if (lines <= PASTE_CONFIRM_LINES) return
  event.preventDefault()
  event.stopPropagation()
  pendingPaste.value = { text, lines }
}

/** 确认粘贴：程序启用了括号粘贴模式时补上标记，让它能区分粘贴与逐键输入。 */
async function confirmPaste(): Promise<void> {
  const pending = pendingPaste.value
  pendingPaste.value = null
  if (pending === null) return
  if (pending.text.length > TERMINAL_WRITE_MAX_CHARS) {
    terminalStore.reportError(`粘贴内容过长（${pending.text.length} 字符），请分几次粘贴。`)
    return
  }
  const bracketed = term?.modes.bracketedPasteMode === true
  const payload = bracketed ? `\u001b[200~${pending.text}\u001b[201~` : pending.text
  const result = await writeTerminal({ id: props.session.id, data: payload })
  if (!result.ok) terminalStore.reportError(result.error.message)
}

/** 链接点击只复制地址：页面没有打开任意 URL 的权限，只有认证流程能经主进程打开地址。 */
async function copyLink(uri: string): Promise<void> {
  const copied = await copyText(uri)
  showNotice(copied ? `已复制链接：${uri}` : '复制链接失败。')
}

/** 只接受本应用的文件拖动：其他拖动（如系统文件）不接管，保持原有行为。 */
function onDragOver(event: DragEvent): void {
  if (!hasProjectEntryDragData(event)) return
  event.preventDefault()
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
  dropActive.value = true
}

/** 在面板内的子元素之间移动也会触发 dragleave，因此只在真正离开面板时收起高亮。 */
function onDragLeave(event: DragEvent): void {
  const next = event.relatedTarget
  if (next instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(next)) return
  dropActive.value = false
}

/** 落下：复核载荷仍属于当前项目，再把绝对路径插入本终端。 */
function onDrop(event: DragEvent): void {
  if (!hasProjectEntryDragData(event)) return
  event.preventDefault()
  dropActive.value = false
  const payload = readProjectEntryDragData(event)
  if (payload === null) return
  if (payload.projectPath !== (projectStore.currentProject?.path ?? null)) {
    showNotice('只能插入当前项目的文件。')
    return
  }
  void insertEntryPath(payload.path, payload.name)
}

/** 绝对路径经主进程解析后写入本终端：只补一个空格，不隐式回车。 */
async function insertEntryPath(path: string, name: string): Promise<void> {
  const resolved = await resolveProjectEntryPath(path)
  if (!resolved.ok) {
    showNotice(resolved.error.message)
    return
  }
  await terminalStore.insertText(props.session.id, projectEntryInsertText(props.session.shell, resolved.data.absolutePath))
  showNotice(`已插入路径：${name}`)
}

/**
 * 右键：阻止系统菜单后在指针位置打开快捷命令菜单。
 * xterm 自己也会处理 contextmenu（把隐藏输入框移到鼠标下），但它不阻止冒泡，因此这里仍能收到事件。
 */
function onContextMenu(event: MouseEvent): void {
  event.preventDefault()
  commandMenu.value?.openAtPoint(event.clientX, event.clientY)
}

function showNotice(message: string): void {
  notice.value = message
  if (noticeTimer !== null) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    noticeTimer = null
    notice.value = null
  }, NOTICE_MS)
}

function applyTheme(): void {
  const host = container.value
  if (host === null || term === null) return
  term.options.theme = readTheme(host)
}

function readFontFamily(element: HTMLElement): string {
  const family = getComputedStyle(element).getPropertyValue('--font-mono').trim()
  return family === '' ? 'monospace' : family
}

/** 主题从界面令牌读取，暗色随 prefers-color-scheme 切换，终端与界面共用同一套颜色。 */
function readTheme(element: HTMLElement): ITheme {
  const styles = getComputedStyle(element)
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  return {
    background: readVariable(styles, '--color-desk-canvas-sunken'),
    foreground: readVariable(styles, '--color-desk-ink'),
    cursor: readVariable(styles, '--color-desk-accent'),
    cursorAccent: readVariable(styles, '--color-desk-canvas-sunken'),
    selectionBackground: readVariable(styles, '--color-desk-accent-soft'),
    ...(dark ? DARK_ANSI : LIGHT_ANSI)
  }
}

function readVariable(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim()
}
</script>

<template>
  <div
    class="terminal-view"
    :class="{ 'is-drop-target': dropActive }"
    @contextmenu="onContextMenu"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div ref="container" class="terminal-view-host"></div>

    <div v-if="pendingPaste !== null" class="terminal-bar" role="group" aria-label="粘贴确认">
      <span class="terminal-bar-text">粘贴 {{ pendingPaste.lines }} 行到终端？</span>
      <AppButton variant="compact" @click="confirmPaste">粘贴</AppButton>
      <AppButton variant="compact" @click="pendingPaste = null">取消</AppButton>
    </div>

    <p v-else-if="notice !== null" class="terminal-bar" aria-live="polite">
      <span class="terminal-bar-text">{{ notice }}</span>
    </p>
  </div>

  <!-- 快捷命令菜单：Teleport 由组件自己完成，这里只挂载并把动作上抛给页面。 -->
  <QuickCommandMenu
    ref="commandMenu"
    :commands="props.quickCommands"
    :project-path="props.projectPath"
    :project-name="projectName"
    @run="emit('runCommand', $event)"
    @edit="emit('editCommand', $event)"
    @remove="emit('removeCommand', $event)"
    @add="emit('addCommand', $event)"
    @manage="emit('manageCommands')"
  />
</template>
