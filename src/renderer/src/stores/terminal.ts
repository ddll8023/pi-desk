/**
 * 终端状态：按项目分组的终端清单、标题与错误提示。
 *
 * 终端进程只在主进程，这里只保存展示副本：清单在项目内分组，切换项目就换一组，与项目/会话的
 * 语义一致；标签顺序与活动标签由工作区标签状态负责（见 workspace-tabs），关闭终端只关闭那一个终端，
 * 不影响其他项目仍在运行的终端。
 *
 * 输出分发按「是否已挂载终端视图」分流：当前项目的终端都保持挂载的 xterm 实例（非活动标签只是隐藏），
 * 输出交给它并在 xterm 写完这一段后回报已消费字符数；终端刚建立、视图还没挂载的短暂窗口先暂存再回放，
 * 不丢首个提示符；不在当前项目里的终端没有接收方，直接确认丢弃，避免主进程为它保留在途额度而被背压卡住。
 *
 * 标题分两类：默认标题来自主进程（shell 名），终端程序通过 OSC 标题上报时在用户未重命名前覆盖它；
 * 用户重命名后不再被覆盖。标题只留在页面内，不写回主进程。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { WatchStopHandle } from 'vue'
import type { TerminalDataEvent, TerminalExitEvent, TerminalSessionInfo } from '../../../shared/terminal-api'
import {
  acknowledgeTerminalData,
  closeTerminal as closeTerminalBridge,
  createTerminal as createTerminalBridge,
  listTerminals,
  subscribeTerminalEvents,
  writeTerminal
} from '../services/terminal'
import { useProjectStore } from './project'

/** 终端创建时的初始尺寸；真实尺寸在终端视图挂载后按容器测量并同步。 */
const INITIAL_COLS = 80
const INITIAL_ROWS = 24

/** 数据消费回调：终端视图在 xterm 写完这一段后调用，主进程据此释放背压额度。 */
type TerminalWriter = (event: TerminalDataEvent, consumed: () => void) => void

/** 尚无视图时暂存的输出上限；只为「终端已建、视图尚未挂载」的短暂窗口服务。 */
const MAX_PENDING_OUTPUT_CHARS = 256 * 1024

export const useTerminalStore = defineStore('terminal', () => {
  const projectStore = useProjectStore()
  const sessions = ref<readonly TerminalSessionInfo[]>([])
  /** 页面内的标题（用户重命名或程序上报的 OSC 标题）；未记录时用主进程给的默认标题。 */
  const titles = ref<Record<string, string>>({})
  /** 用户显式重命名过的终端；程序上报的标题不再覆盖它们。 */
  const renamed = new Set<string>()
  /** 最近一次操作的失败原因；展示后由界面关闭，不影响已建立的终端。 */
  const error = ref<string | null>(null)
  const creating = ref(false)
  /** 已挂载的终端视图；只有当前项目的终端会挂载。 */
  const writers = new Map<string, TerminalWriter>()
  /** 当前项目里尚未挂载视图的终端输出：终端建立到视图挂载之间不能丢掉提示符。 */
  const pendingOutput = new Map<string, string[]>()
  const pendingOutputChars = new Map<string, number>()
  /**
   * 最近一次把文本插入终端的信号：终端视图据此把焦点交给该终端。
   * 用自增序号而不是终端标识，连续插入同一个终端也能再次触发焦点。
   */
  const insertFocus = ref<{ readonly id: string; readonly seq: number } | null>(null)
  let insertFocusSeq = 0
  let disposeEvents: (() => void) | null = null
  let stopProjectWatch: WatchStopHandle | null = null

  const currentProjectPath = computed(() => projectStore.currentProject?.path ?? null)

  /** 当前项目的终端；顺序即主进程清单顺序，标签顺序由工作区标签状态决定。 */
  const projectSessions = computed(() => (
    sessions.value.filter((session) => session.projectPath === currentProjectPath.value)
  ))

  /**
   * 先订阅输出与退出，再按当前项目列出终端：反过来的话，重新挂载期间的下发会无人接收。
   * 项目尚未就绪时只订阅，等项目出现后由 watch 补一次读取。
   */
  function initialize(): void {
    if (disposeEvents === null) {
      disposeEvents = subscribeTerminalEvents({ onData: dispatchData, onExit: applyExit })
    }
    if (stopProjectWatch !== null) return
    stopProjectWatch = watch(currentProjectPath, (projectPath) => {
      if (projectPath === null) return
      void ensureLoaded(projectPath)
    }, { immediate: true })
  }

  /** 页面卸载时释放事件订阅；终端本身留在主进程，重新挂载后再列一次即可接回。 */
  function dispose(): void {
    disposeEvents?.()
    disposeEvents = null
    stopProjectWatch?.()
    stopProjectWatch = null
    writers.clear()
    pendingOutput.clear()
    pendingOutputChars.clear()
  }

  /** 读取某个项目的终端清单并替换该项目在本地的副本；失败只提示，不清空已有标签。 */
  async function ensureLoaded(projectPath: string): Promise<void> {
    const result = await listTerminals(projectPath)
    if (!result.ok) {
      error.value = result.error.message
      return
    }
    applySessions(projectPath, result.data.sessions)
  }

  /** 用主进程清单替换该项目的终端；其他项目的标签不受影响。 */
  function applySessions(projectPath: string, list: readonly TerminalSessionInfo[]): void {
    sessions.value = [...sessions.value.filter((session) => session.projectPath !== projectPath), ...list]
    pruneLocalState()
  }

  /** 清理已不存在的终端留下的本地状态：标题、重命名标记与待回放输出。 */
  function pruneLocalState(): void {
    const alive = new Set(sessions.value.map((session) => session.id))
    const nextTitles: Record<string, string> = {}
    for (const [id, title] of Object.entries(titles.value)) {
      if (alive.has(id)) nextTitles[id] = title
    }
    titles.value = nextTitles
    for (const id of [...renamed]) {
      if (!alive.has(id)) renamed.delete(id)
    }
    for (const id of [...pendingOutput.keys()]) {
      if (alive.has(id)) continue
      pendingOutput.delete(id)
      pendingOutputChars.delete(id)
    }
  }

  /** 在当前项目内新建终端并返回它的标识；失败时保留原因供界面提示，不建立标签。 */
  async function createTerminal(): Promise<string | null> {
    const projectPath = currentProjectPath.value
    if (projectPath === null) {
      error.value = '先选择项目，再新建终端。'
      return null
    }
    if (creating.value) return null
    creating.value = true
    error.value = null
    try {
      const result = await createTerminalBridge({ projectPath, cols: INITIAL_COLS, rows: INITIAL_ROWS })
      if (!result.ok) {
        error.value = result.error.message
        return null
      }
      sessions.value = [...sessions.value, result.data]
      return result.data.id
    } finally {
      creating.value = false
    }
  }

  /** 关闭一个终端并收敛它的进程树；关闭失败时终端保留在清单里，由调用方决定是否收起标签。 */
  async function closeTerminal(id: string): Promise<void> {
    const result = await closeTerminalBridge(id)
    if (!result.ok) {
      error.value = result.error.message
      return
    }
    sessions.value = sessions.value.filter((session) => session.id !== id)
    pruneLocalState()
  }

  /** 用户重命名：记下显式重命名，之后程序上报的标题不再覆盖。 */
  function renameTerminal(id: string, title: string): void {
    const trimmed = title.trim()
    if (trimmed === '') {
      delete titles.value[id]
      renamed.delete(id)
      titles.value = { ...titles.value }
      return
    }
    renamed.add(id)
    titles.value = { ...titles.value, [id]: trimmed }
  }

  /** 程序上报的 OSC 标题：用户重命名过就不覆盖，空标题也忽略。 */
  function applyTerminalTitle(id: string, title: string): void {
    if (renamed.has(id)) return
    const trimmed = title.trim()
    if (trimmed === '') return
    if (titles.value[id] === trimmed) return
    titles.value = { ...titles.value, [id]: trimmed }
  }

  /** 登记已挂载的终端视图；同一终端重复挂载时以最后一次为准，并把挂载前的输出补给它。 */
  function registerWriter(id: string, writer: TerminalWriter): void {
    writers.set(id, writer)
    const buffered = pendingOutput.get(id)
    if (buffered === undefined) return
    pendingOutput.delete(id)
    pendingOutputChars.delete(id)
    for (const chunk of buffered) {
      // 这些数据在主进程侧已经确认过，回放时不再重复确认。
      writer({ id, chunk, chars: chunk.length }, () => {})
    }
  }

  function unregisterWriter(id: string): void {
    writers.delete(id)
  }

  /**
   * 输出分发：有挂载的视图就交给它，否则直接确认丢弃。
   * 当前项目里尚未挂载视图的终端（刚建立、视图还没挂载）先留住这一小段输出，避免丢掉首个提示符；
   * 其他项目的终端没有接收方，直接确认，不让主进程为它们保留在途额度。
   */
  function dispatchData(event: TerminalDataEvent): void {
    const writer = writers.get(event.id)
    if (writer !== undefined) {
      writer(event, () => acknowledgeTerminalData(event.id, event.chars))
      return
    }
    const session = sessions.value.find((entry) => entry.id === event.id)
    if (session !== undefined && session.projectPath === currentProjectPath.value) bufferOutput(event)
    acknowledgeTerminalData(event.id, event.chars)
  }

  /** 暂存挂载前的输出；超出上限时丢弃最早的块，只为短暂窗口服务。 */
  function bufferOutput(event: TerminalDataEvent): void {
    const chunks = pendingOutput.get(event.id) ?? []
    chunks.push(event.chunk)
    let total = (pendingOutputChars.get(event.id) ?? 0) + event.chars
    while (total > MAX_PENDING_OUTPUT_CHARS && chunks.length > 1) {
      const dropped = chunks.shift()
      if (dropped !== undefined) total -= dropped.length
    }
    pendingOutput.set(event.id, chunks)
    pendingOutputChars.set(event.id, total)
  }

  /** 退出事件只更新展示状态；终端记录保留到用户关闭标签。 */
  function applyExit(event: TerminalExitEvent): void {
    sessions.value = sessions.value.map((session): TerminalSessionInfo => (
      session.id === event.id ? { ...session, status: 'exited', exitCode: event.exitCode } : session
    ))
  }

  /** 记录一条可展示的失败原因；用于写入被拒绝、粘贴过大等由界面发现的问题。 */
  function reportError(message: string): void {
    error.value = message
  }

  /**
   * 把一段文本写入终端但不追加回车：右侧面板把文件路径插入终端时走这里，
   * 是否补引号、补空格由调用方决定。失败只记录原因，由工作区的提示条展示；
   * 成功时发一次焦点信号，让终端视图把焦点收回去，用户可以直接接着敲命令。
   */
  async function insertText(id: string, text: string): Promise<void> {
    const result = await writeTerminal({ id, data: text })
    if (!result.ok) {
      error.value = result.error.message
      return
    }
    insertFocusSeq += 1
    insertFocus.value = { id, seq: insertFocusSeq }
  }

  function clearError(): void {
    error.value = null
  }

  return {
    sessions,
    projectSessions,
    titles,
    error,
    creating,
    insertFocus,
    initialize,
    dispose,
    createTerminal,
    closeTerminal,
    renameTerminal,
    applyTerminalTitle,
    registerWriter,
    unregisterWriter,
    reportError,
    insertText,
    clearError
  }
})
