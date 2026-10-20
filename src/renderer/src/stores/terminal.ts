/** 终端展示状态：清单请求单飞，画面逐视图恢复；只转发当前代际的连续输出，不长期缓存退出会话的大画面。 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { WatchStopHandle } from 'vue'
import type { TerminalDaemonStatus, TerminalDataEvent, TerminalExitEvent, TerminalSessionInfo, TerminalSessionSnapshot } from '../../../shared/terminal-api'
import {
  acknowledgeTerminalData, closeAllTerminals as closeAllTerminalsBridge, closeTerminal as closeTerminalBridge,
  createTerminal as createTerminalBridge, fetchTerminalSnapshots, getTerminalDaemonStatus, listTerminals,
  recoverTerminal as recoverTerminalBridge, renameTerminal as renameTerminalBridge, stopStaleTerminalDaemon as stopStaleTerminalDaemonBridge,
  stopTerminalDaemon as stopTerminalDaemonBridge, subscribeTerminalDaemonStatus, subscribeTerminalEvents, writeTerminal
} from '../services/terminal'
import { useProjectStore } from './project'

type TerminalWriter = (event: TerminalDataEvent, consumed: () => void) => void
interface WriterEntry {
  readonly deliveryId: string
  readonly writer: TerminalWriter
  receivedSeq: number
  consumedSeq: number
}
export const useTerminalStore = defineStore('terminal', () => {
  const projectStore = useProjectStore()
  const sessions = ref<readonly TerminalSessionInfo[]>([])
  const titles = ref<Record<string, string>>({})
  /** 已由用户命名的终端：实时上报的 OSC 标题不再参与展示，避免盖回自定义名字。 */
  const named = new Set<string>()
  const error = ref<string | null>(null)
  const creating = ref(false)
  const daemonStatus = ref<TerminalDaemonStatus | null>(null)
  /** 重连只发出代际变更信号，画面由仍挂载的视图各自恢复。 */
  const recoveryEpoch = ref(0)
  const writers = new Map<string, WriterEntry>()
  const insertFocus = ref<{ readonly id: string; readonly seq: number } | null>(null)
  let insertFocusSeq = 0
  let disposeEvents: (() => void) | null = null
  let disposeDaemonStatus: (() => void) | null = null
  let stopProjectWatch: WatchStopHandle | null = null
  let mutationVersion = 0
  let lifetime = 0
  let loadPromise: Promise<void> | null = null
  const pendingExits = new Map<string, number>()
  const currentProjectPath = computed(() => projectStore.currentProject?.path ?? null)

  function initialize(): void {
    if (stopProjectWatch !== null) return
    disposeEvents = subscribeTerminalEvents({ onData: dispatchData, onExit: applyExit })
    disposeDaemonStatus = subscribeTerminalDaemonStatus((status) => {
      const wasConnected = daemonStatus.value?.connected === true
      daemonStatus.value = status
      if (status.connected && !wasConnected) {
        const currentLifetime = lifetime
        void ensureLoaded().then(() => { if (currentLifetime === lifetime) recoveryEpoch.value += 1 })
      }
    })
    void ensureLoaded()
    stopProjectWatch = watch(() => projectStore.projects.map((project) => project.path), (paths) => {
      if (projectStore.view.phase !== 'ready') return
      const alive = new Set(paths)
      const kept = sessions.value.filter((session) => alive.has(session.projectPath))
      if (kept.length === sessions.value.length) return
      mutationVersion += 1
      sessions.value = kept
      pruneLocalState()
    }, { immediate: true })
  }

  function dispose(): void {
    lifetime += 1
    disposeEvents?.(); disposeEvents = null
    disposeDaemonStatus?.(); disposeDaemonStatus = null
    stopProjectWatch?.(); stopProjectWatch = null
    for (const [id, entry] of writers) unregisterWriter(id, entry.deliveryId)
    pendingExits.clear()
    mutationVersion += 1
    loadPromise = null
  }

  /** 重复初始化共享同一次读取；状态变更后的旧响应重读，不递归堆积调用栈和任务。 */
  function ensureLoaded(): Promise<void> {
    if (loadPromise !== null) return loadPromise
    const currentLifetime = lifetime
    const work = (async () => {
      while (currentLifetime === lifetime) {
        const mutation = mutationVersion
        const result = await listTerminals(null)
        if (currentLifetime !== lifetime) return
        if (!result.ok) { error.value = result.error.message; return }
        if (mutation !== mutationVersion) continue
        const alive = new Set(projectStore.projects.map((project) => project.path))
        sessions.value = result.data.sessions
          .filter((session) => projectStore.view.phase !== 'ready' || alive.has(session.projectPath))
          .map((session) => pendingExits.has(session.id)
            ? { ...session, status: 'exited' as const, exitCode: pendingExits.get(session.id) ?? null } : session)
        pendingExits.clear()
        pruneLocalState()
        return
      }
    })()
    loadPromise = work
    void work.finally(() => { if (loadPromise === work) loadPromise = null })
    return work
  }

  function pruneLocalState(): void {
    const alive = new Set(sessions.value.map((session) => session.id))
    titles.value = Object.fromEntries(Object.entries(titles.value).filter(([id]) => alive.has(id)))
    for (const id of named) if (!alive.has(id)) named.delete(id)
    for (const [id, entry] of writers) if (!alive.has(id)) unregisterWriter(id, entry.deliveryId)
    for (const id of pendingExits.keys()) if (!alive.has(id) && !creating.value && loadPromise === null) pendingExits.delete(id)
  }

  async function createTerminal(projectPath: string | null = currentProjectPath.value): Promise<string | null> {
    if (projectPath === null) { error.value = '先选择项目，再新建终端。'; return null }
    // 前一次创建还在途：给可见原因，避免重复点击表现为「点了没反应」。
    if (creating.value) { error.value = '正在创建终端，请稍候。'; return null }
    creating.value = true
    mutationVersion += 1
    error.value = null
    try {
      const result = await createTerminalBridge({ projectPath, cols: 80, rows: 24 })
      if (!result.ok) { error.value = result.error.message; return null }
      if (projectStore.view.phase === 'ready' && !projectStore.projects.some((project) => project.path === projectPath)) {
        await closeTerminalBridge(result.data.id)
        return null
      }
      const exitCode = pendingExits.get(result.data.id)
      const session = exitCode === undefined ? result.data : { ...result.data, status: 'exited' as const, exitCode }
      sessions.value = [...sessions.value.filter((entry) => entry.id !== session.id), session]
      return session.id
    } finally { mutationVersion += 1; creating.value = false; pruneLocalState() }
  }

  async function closeTerminal(id: string): Promise<void> {
    mutationVersion += 1
    const result = await closeTerminalBridge(id)
    mutationVersion += 1
    if (!result.ok) { error.value = result.error.message; return }
    sessions.value = sessions.value.filter((session) => session.id !== id)
    pruneLocalState()
  }
  /** 程序上报的标题只影响未命名的终端；命名后展示一律以会话记录为准。 */
  function applyTerminalTitle(id: string, title: string): void {
    const trimmed = title.trim()
    if (named.has(id) || trimmed === '' || titles.value[id] === trimmed) return
    titles.value = { ...titles.value, [id]: trimmed }
  }

  /**
   * 给终端命名；空标题清除用户命名，刷新后回到程序上报或 shell 默认名。
   * 命名由守护进程落盘，因此重启应用后仍保留——这是它和标签重命名的区别：后者只活在页面内。
   * 成功后重读清单，以守护进程给出的展示标题为准，不在页面里自行推导优先级。
   */
  async function renameTerminal(id: string, title: string): Promise<boolean> {
    const result = await renameTerminalBridge({ id, title })
    if (!result.ok) { error.value = result.error.message; return false }
    // 命名后停用实时上报标题，并清掉已有缓存，避免盖回旧值；清除命名时重新开放。
    if (title.trim() === '') named.delete(id)
    else named.add(id)
    delete titles.value[id]
    titles.value = { ...titles.value }
    // 先重读清单再退出：清单返回的 title 已是守护进程算好的展示标题，页面不再自行推导优先级。
    await ensureLoaded()
    return true
  }

  function registerWriter(id: string, deliveryId: string, writer: TerminalWriter): void {
    const previous = writers.get(id)
    if (previous !== undefined) unregisterWriter(id, previous.deliveryId)
    writers.set(id, { deliveryId, writer, receivedSeq: 0, consumedSeq: 0 })
  }
  function unregisterWriter(id: string, deliveryId: string): void {
    if (writers.get(id)?.deliveryId !== deliveryId) return
    writers.delete(id)
    void recoverTerminalBridge({ id, deliveryId, action: 'detach' })
  }

  async function loadSnapshot(id: string, deliveryId: string): Promise<TerminalSessionSnapshot | null> {
    const entry = writers.get(id)
    if (entry?.deliveryId !== deliveryId) return null
    const result = await fetchTerminalSnapshots({ id, deliveryId })
    if (writers.get(id) !== entry) {
      void recoverTerminalBridge({ id, deliveryId, action: 'detach' })
      return null
    }
    if (!result.ok) { error.value = result.error.message; return null }
    const snapshot = result.data.snapshot
    entry.receivedSeq = snapshot.seq
    entry.consumedSeq = snapshot.seq
    if (snapshot.status === 'exited') {
      sessions.value = sessions.value.map((session) => session.id === id
        ? { ...session, status: snapshot.status, exitCode: snapshot.exitCode } : session)
    }
    return snapshot
  }
  async function finishRecovery(id: string, deliveryId: string): Promise<boolean> {
    if (writers.get(id)?.deliveryId !== deliveryId) return false
    const result = await recoverTerminalBridge({ id, deliveryId, action: 'ready' })
    if (writers.get(id)?.deliveryId !== deliveryId) return false
    if (!result.ok) {
      error.value = result.error.message
      unregisterWriter(id, deliveryId)
      return false
    }
    return true
  }

  function dispatchData(event: TerminalDataEvent): void {
    const entry = writers.get(event.id)
    if (entry?.deliveryId !== event.deliveryId) return
    if (event.seqEnd <= entry.receivedSeq) {
      acknowledgeTerminalData(event.id, event.deliveryId, entry.consumedSeq)
      return
    }
    if (event.seqEnd - event.chars !== entry.receivedSeq) {
      error.value = '终端输出进度不连续，已停止当前画面投递。'
      unregisterWriter(event.id, event.deliveryId)
      recoveryEpoch.value += 1
      return
    }
    entry.receivedSeq = event.seqEnd
    try {
      entry.writer(event, () => {
        if (writers.get(event.id) !== entry) return
        entry.consumedSeq = Math.max(entry.consumedSeq, event.seqEnd)
        acknowledgeTerminalData(event.id, event.deliveryId, entry.consumedSeq)
      })
    } catch (cause) {
      reportError(cause instanceof Error ? cause.message : '终端画面写入失败。')
      unregisterWriter(event.id, event.deliveryId)
      recoveryEpoch.value += 1
    }
  }
  function applyExit(event: TerminalExitEvent): void {
    mutationVersion += 1
    if (creating.value || loadPromise !== null) pendingExits.set(event.id, event.exitCode)
    sessions.value = sessions.value.map((session) => session.id === event.id
      ? { ...session, status: 'exited', exitCode: event.exitCode } : session)
  }
  function reportError(message: string): void { error.value = message }
  function clearError(): void { error.value = null }
  async function insertText(id: string, text: string): Promise<void> {
    const result = await writeTerminal({ id, data: text })
    if (!result.ok) { error.value = result.error.message; return }
    insertFocus.value = { id, seq: ++insertFocusSeq }
  }
  async function closeAllTerminals(): Promise<boolean> {
    error.value = null
    mutationVersion += 1
    const result = await closeAllTerminalsBridge()
    mutationVersion += 1
    if (!result.ok) { error.value = result.error.message; return false }
    sessions.value = []
    pruneLocalState()
    await refreshDaemonStatus()
    return true
  }
  async function refreshDaemonStatus(): Promise<void> {
    const result = await getTerminalDaemonStatus()
    if (!result.ok) { error.value = result.error.message; return }
    const reconnected = result.data.connected && daemonStatus.value?.connected !== true
    daemonStatus.value = result.data
    if (reconnected) { await ensureLoaded(); recoveryEpoch.value += 1 }
  }
  async function stopStaleDaemon(): Promise<boolean> {
    error.value = null
    const result = await stopStaleTerminalDaemonBridge()
    if (!result.ok) { error.value = result.error.message; return false }
    await refreshDaemonStatus()
    return true
  }
  async function stopDaemon(): Promise<boolean> {
    error.value = null
    mutationVersion += 1
    const result = await stopTerminalDaemonBridge()
    mutationVersion += 1
    if (!result.ok) { error.value = result.error.message; return false }
    sessions.value = []
    pruneLocalState()
    await refreshDaemonStatus()
    return true
  }
  return {
    sessions, titles, error, creating, insertFocus, daemonStatus, recoveryEpoch,
    initialize, dispose, createTerminal, closeTerminal, closeAllTerminals, applyTerminalTitle, renameTerminal,
    registerWriter, unregisterWriter, loadSnapshot, finishRecovery, reportError, insertText,
    refreshDaemonStatus, stopStaleDaemon, stopDaemon, clearError
  }
})
