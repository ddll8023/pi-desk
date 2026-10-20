/**
 * 终端状态：按项目分组的终端清单、标题、快照与错误提示。
 *
 * 终端进程由独立守护进程持有，应用退出后继续运行；这里只保存展示副本：清单在项目内分组，切换项目
 * 就换一组，与项目/会话的语义一致；标签顺序与活动标签由工作区标签状态负责（见 workspace-tabs），
 * 关闭终端只关闭那一个终端，不影响其他项目仍在运行的终端。
 *
 * 重新挂载时先取画面快照再接实时输出：快照带 `seq`（该终端累计已下发字符数），实时数据带 `seqEnd`，
 * 因此快照已覆盖的实时段可以直接丢弃，既不会重复也不会丢段。视图挂载前的输出仍然先缓冲再回放，
 * 回放时同样按 `seq` 过滤。
 *
 * 标题分两类：默认标题来自守护进程（shell 名），终端程序通过 OSC 标题上报时在用户未重命名前覆盖它；
 * 用户重命名后不再被覆盖。标题只留在页面内，不写回守护进程。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { WatchStopHandle } from 'vue'
import type {
  TerminalDaemonStatus,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSessionInfo,
  TerminalSessionSnapshot
} from '../../../shared/terminal-api'
import {
  acknowledgeTerminalData,
  closeAllTerminals as closeAllTerminalsBridge,
  closeTerminal as closeTerminalBridge,
  createTerminal as createTerminalBridge,
  fetchTerminalSnapshots,
  getTerminalDaemonStatus,
  listTerminals,
  stopStaleTerminalDaemon as stopStaleTerminalDaemonBridge,
  subscribeTerminalDaemonStatus,
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
  /** 已挂载的终端视图；后台项目的存活终端也保持接收输出。 */
  const writers = new Map<string, TerminalWriter>()
  /** 每个终端的当前画面快照；视图挂载时先写它，再回放之后的实时输出。 */
  const snapshots = ref<Record<string, TerminalSessionSnapshot>>({})
  /** 守护进程状态；设置页据此展示常驻会话与旧版本守护进程提示。 */
  const daemonStatus = ref<TerminalDaemonStatus | null>(null)
  /** 当前项目里尚未挂载视图的终端输出：终端建立到视图挂载之间不能丢掉提示符。 */
  const pendingOutput = new Map<string, TerminalDataEvent[]>()
  const pendingOutputChars = new Map<string, number>()
  /**
   * 最近一次把文本插入终端的信号：终端视图据此把焦点交给该终端。
   * 用自增序号而不是终端标识，连续插入同一个终端也能再次触发焦点。
   */
  const insertFocus = ref<{ readonly id: string; readonly seq: number } | null>(null)
  let insertFocusSeq = 0
  let disposeEvents: (() => void) | null = null
  let disposeDaemonStatus: (() => void) | null = null
  let stopProjectWatch: WatchStopHandle | null = null
  let mutationVersion = 0
  const loadVersions = new Map<string, number>()
  const pendingExits = new Map<string, number>()
  let loadingCount = 0

  const currentProjectPath = computed(() => projectStore.currentProject?.path ?? null)

  /**
   * 先订阅输出与退出，再接回全部存活终端；项目切换只改变可见性，不重新建立终端。
   * 项目移除只清对应记录，守护进程负责终止它的进程树。
   * 清单之后取一次快照：快照比实时数据更权威，页面重挂载后靠它还原滚动历史。
   */
  function initialize(): void {
    if (disposeEvents === null) {
      disposeEvents = subscribeTerminalEvents({ onData: dispatchData, onExit: applyExit })
    }
    if (disposeDaemonStatus === null) {
      disposeDaemonStatus = subscribeTerminalDaemonStatus((status) => {
        const wasConnected = daemonStatus.value?.connected === true
        daemonStatus.value = status
        // 守护进程重新连上（崩溃重启、应用重启）：清单与快照都可能变了，重新拉一次再接回。
        if (status.connected && !wasConnected) {
          void (async () => {
            await ensureLoaded(null)
            await refreshSnapshots()
          })()
        }
      })
    }
    if (stopProjectWatch !== null) return
    void (async () => {
      await ensureLoaded(null)
      await refreshSnapshots()
    })()
    stopProjectWatch = watch(() => projectStore.projects.map(project => project.path), paths => {
      if (projectStore.view.phase !== 'ready') return
      const alive = new Set(paths)
      const kept = sessions.value.filter(session => alive.has(session.projectPath))
      if (kept.length === sessions.value.length) return
      mutationVersion += 1
      sessions.value = kept
      pruneLocalState()
    }, { immediate: true })
  }

  /** 页面卸载时释放事件订阅；终端本身留在守护进程，重新挂载后再列一次并取快照即可接回。 */
  function dispose(): void {
    disposeEvents?.()
    disposeEvents = null
    disposeDaemonStatus?.()
    disposeDaemonStatus = null
    stopProjectWatch?.()
    stopProjectWatch = null
    writers.clear()
    pendingOutput.clear()
    pendingOutputChars.clear()
    pendingExits.clear()
    mutationVersion += 1
    loadVersions.clear()
  }

  /** 读取某个项目的终端清单并替换该项目在本地的副本；失败只提示，不清空已有标签。 */
  async function ensureLoaded(projectPath: string | null): Promise<void> {
    const key = projectPath ?? '*'
    const version = (loadVersions.get(key) ?? 0) + 1
    loadVersions.set(key, version)
    const mutation = mutationVersion
    loadingCount += 1
    try {
      const result = await listTerminals(projectPath)
      if (loadVersions.get(key) !== version) return
      if (!result.ok) {
        error.value = result.error.message
        return
      }
      // 列表截取后发生过创建、关闭或退出时，旧快照不能覆盖新状态。
      if (mutation !== mutationVersion) {
        await ensureLoaded(projectPath)
        return
      }
      const alive = new Set(projectStore.projects.map(project => project.path))
      const list = result.data.sessions.filter(session => projectStore.view.phase !== 'ready' || alive.has(session.projectPath))
        .map(session => pendingExits.has(session.id)
          ? { ...session, status: 'exited' as const, exitCode: pendingExits.get(session.id) ?? null }
          : session)
      sessions.value = projectPath === null ? list
        : [...sessions.value.filter(session => session.projectPath !== projectPath), ...list]
      pruneLocalState()
    } finally {
      loadingCount -= 1
    }
  }

  /** 清理已不存在的终端留下的本地状态：标题、重命名标记、快照与待回放输出。 */
  function pruneLocalState(): void {
    const alive = new Set(sessions.value.map((session) => session.id))
    const nextTitles: Record<string, string> = {}
    for (const [id, title] of Object.entries(titles.value)) {
      if (alive.has(id)) nextTitles[id] = title
    }
    titles.value = nextTitles
    const nextSnapshots: Record<string, TerminalSessionSnapshot> = {}
    for (const [id, snapshot] of Object.entries(snapshots.value)) {
      if (alive.has(id)) nextSnapshots[id] = snapshot
    }
    snapshots.value = nextSnapshots
    for (const id of [...renamed]) {
      if (!alive.has(id)) renamed.delete(id)
    }
    for (const id of [...pendingOutput.keys()]) {
      if (alive.has(id) || creating.value) continue
      pendingOutput.delete(id)
      pendingOutputChars.delete(id)
    }
    for (const id of pendingExits.keys()) {
      if (!alive.has(id) && !creating.value) pendingExits.delete(id)
    }
  }

  /** 在当前项目内新建终端并返回它的标识；失败时保留原因供界面提示，不建立标签。 */
  async function createTerminal(projectPath: string | null = currentProjectPath.value): Promise<string | null> {
    if (projectPath === null) {
      error.value = '先选择项目，再新建终端。'
      return null
    }
    if (creating.value) return null
    creating.value = true
    mutationVersion += 1
    error.value = null
    try {
      const result = await createTerminalBridge({ projectPath, cols: INITIAL_COLS, rows: INITIAL_ROWS })
      if (!result.ok) {
        error.value = result.error.message
        return null
      }
      if (projectStore.view.phase === 'ready' && !projectStore.projects.some(project => project.path === projectPath)) {
        await closeTerminalBridge(result.data.id)
        return null
      }
      const exitCode = pendingExits.get(result.data.id)
      const session = exitCode === undefined ? result.data
        : { ...result.data, status: 'exited' as const, exitCode }
      sessions.value = [...sessions.value.filter(entry => entry.id !== session.id), session]
      return session.id
    } finally {
      mutationVersion += 1
      creating.value = false
      pruneLocalState()
    }
  }

  /** 关闭一个终端并收敛它的进程树；关闭失败时终端保留在清单里，由调用方决定是否收起标签。 */
  async function closeTerminal(id: string): Promise<void> {
    mutationVersion += 1
    const result = await closeTerminalBridge(id)
    mutationVersion += 1
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

  /**
   * 登记已挂载的终端视图；同一终端重复挂载时以最后一次为准，并把挂载前的输出补给它。
   * 已经被快照覆盖的段不再回放，否则接回时会把同一段输出写两遍。
   */
  function registerWriter(id: string, writer: TerminalWriter): void {
    writers.set(id, writer)
    const buffered = pendingOutput.get(id)
    if (buffered === undefined) return
    pendingOutput.delete(id)
    pendingOutputChars.delete(id)
    const snapshot = snapshots.value[id]
    for (const event of buffered) {
      if (snapshot !== undefined && event.seqEnd <= snapshot.seq) continue
      // 这些数据在守护进程侧已经确认过，回放时不再重复确认。
      writer(event, () => {})
    }
  }

  function unregisterWriter(id: string): void {
    writers.delete(id)
  }

  /**
   * 输出按终端身份分发，不按前台项目过滤；已存在或正在建立的终端在挂载前先留住输出。
   * 快照已覆盖的段直接确认并丢弃：它已经在画面里，再写一遍会重复。
   */
  function dispatchData(event: TerminalDataEvent): void {
    const snapshot = snapshots.value[event.id]
    if (snapshot !== undefined && event.seqEnd <= snapshot.seq) {
      acknowledgeTerminalData(event.id, event.chars)
      return
    }
    const writer = writers.get(event.id)
    if (writer !== undefined) {
      writer(event, () => acknowledgeTerminalData(event.id, event.chars))
      return
    }
    const session = sessions.value.find((entry) => entry.id === event.id)
    if (session !== undefined || creating.value || loadingCount > 0) bufferOutput(event)
    acknowledgeTerminalData(event.id, event.chars)
  }

  /** 暂存挂载前的输出；超出上限时丢弃最早的块，只为短暂窗口服务。 */
  function bufferOutput(event: TerminalDataEvent): void {
    const events = pendingOutput.get(event.id) ?? []
    events.push(event)
    let total = (pendingOutputChars.get(event.id) ?? 0) + event.chars
    while (total > MAX_PENDING_OUTPUT_CHARS && events.length > 1) {
      const dropped = events.shift()
      if (dropped !== undefined) total -= dropped.chars
    }
    pendingOutput.set(event.id, events)
    pendingOutputChars.set(event.id, total)
  }

  /** 退出事件只更新展示状态；终端记录保留到用户关闭标签。 */
  function applyExit(event: TerminalExitEvent): void {
    mutationVersion += 1
    if (creating.value || loadingCount > 0) pendingExits.set(event.id, event.exitCode)
    sessions.value = sessions.value.map((session): TerminalSessionInfo => (
      session.id === event.id ? { ...session, status: 'exited', exitCode: event.exitCode } : session
    ))
  }

  /** 记录一条可展示的失败原因；用于写入被拒绝、粘贴过大等由界面发现的问题。 */
  function reportError(message: string): void {
    error.value = message
  }

  /**
   * 把一段文本按原样写入终端，是否追加回车、补引号或空格都由调用方决定：
   * 右侧面板插入文件路径与快捷命令运行都走这里。失败只记录原因，由工作区的提示条展示；
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

  /** 取一次画面快照并整体替换；失败只提示，保留已有快照。 */
  async function refreshSnapshots(): Promise<void> {
    const result = await fetchTerminalSnapshots()
    if (!result.ok) {
      error.value = result.error.message
      return
    }
    const next: Record<string, TerminalSessionSnapshot> = {}
    for (const snapshot of result.data.snapshots) next[snapshot.id] = snapshot
    snapshots.value = next
  }

  /** 取某个终端的快照；视图挂载时先写它，再回放之后的实时输出。 */
  function takeSnapshot(id: string): TerminalSessionSnapshot | null {
    return snapshots.value[id] ?? null
  }

  /** 关闭全部终端（含其他项目）；成功后清空本地副本，由调用方决定标签去向。 */
  async function closeAllTerminals(): Promise<void> {
    mutationVersion += 1
    const result = await closeAllTerminalsBridge()
    mutationVersion += 1
    if (!result.ok) {
      error.value = result.error.message
      return
    }
    sessions.value = []
    snapshots.value = {}
    pruneLocalState()
  }

  /** 读取守护进程状态；失败只记录原因，不清空已有状态。 */
  async function refreshDaemonStatus(): Promise<void> {
    const result = await getTerminalDaemonStatus()
    if (!result.ok) {
      error.value = result.error.message
      return
    }
    daemonStatus.value = result.data
  }

  /** 结束旧版本守护进程；成功后刷新状态，让提示消失。 */
  async function stopStaleDaemon(): Promise<void> {
    const result = await stopStaleTerminalDaemonBridge()
    if (!result.ok) {
      error.value = result.error.message
      return
    }
    await refreshDaemonStatus()
  }

  function clearError(): void {
    error.value = null
  }

  return {
    sessions,
    titles,
    error,
    creating,
    insertFocus,
    snapshots,
    daemonStatus,
    initialize,
    dispose,
    createTerminal,
    closeTerminal,
    closeAllTerminals,
    renameTerminal,
    applyTerminalTitle,
    registerWriter,
    unregisterWriter,
    reportError,
    insertText,
    refreshSnapshots,
    takeSnapshot,
    refreshDaemonStatus,
    stopStaleDaemon,
    clearError
  }
})
