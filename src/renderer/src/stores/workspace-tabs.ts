/**
 * 工作区标签状态：按项目分组的对话与终端标签、活动标签、标签顺序与标题覆盖。
 *
 * 标签是页面内的展示编排：活动的对话标签就是前台运行实例，其余对话标签由后台分片留底，
 * 因此切标签就是切前台；切项目换一组标签（对话与终端一起换），每个项目各自记住上次的活动标签。
 * 顺序、活动标签、重命名与「有新回复」标记只留在内存里，不跨应用重启恢复：重启后每个项目回到一个空对话标签。
 *
 * 标签键是页面内编号，只在渲染端有效：对话标签记会话身份与它承载的运行实例，终端标签记终端标识。
 * 终端清单是主进程的真相，因此终端标签按清单派生（已消失的不再展示、新出现的追加到末尾），
 * 只有对话标签需要在这里登记；同一项目内至多保留一个未落盘的新对话标签。
 * 后台实例回复结束时给它的对话标签打「有新回复」标记，切到该标签即清除。
 * 新建对话的入口分两类：标签条与侧栏新建一个对话标签，`/new` 则在当前标签内就地替换
 * （结束原实例、清空会话身份与重命名，标签位置与顺序不变）。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { WatchStopHandle } from 'vue'
import type { SessionRunState } from '../../../shared/session-run-api'
import type { TerminalSessionInfo } from '../../../shared/terminal-api'
import { useProjectStore } from './project'
import { useRuntimeStore } from './runtime'
import { useSessionRunsStore } from './session-runs'
import { useSessionStore } from './session'
import { useTerminalStore } from './terminal'

/** 对话标签键前缀；终端标签键是 `term:<终端标识>`。 */
const CHAT_KEY_PREFIX = 'chat:'
const TERMINAL_KEY_PREFIX = 'term:'

/** 标签类型：对话标签承载一个会话运行实例，终端标签承载一个终端进程。 */
export type WorkspaceTabKind = 'chat' | 'terminal'

/**
 * 在当前标签内就地新建对话的结果：`started` 是已完成就地替换；`already-new` 是本来就空、没有可结束的实例；
 * `refused` 是结束原实例未确认（标签与会话原样保留）；`busy` 是另一会话正在打开；
 * `unavailable` 是没有可替换的活动对话标签。
 */
export type NewChatInTabOutcome = 'started' | 'already-new' | 'refused' | 'busy' | 'unavailable'

/** 一个对话标签的页面内记录；会话身份在首次落盘前为空，运行实例身份随打开与回收变化。 */
interface ChatTabRecord {
  readonly sessionId: string | null
  readonly runId: number | null
}

/** 标签的展示模型：标题与提示都已解析，标签条只负责渲染与派发意图。 */
export interface WorkspaceTabView {
  readonly id: string
  readonly kind: WorkspaceTabKind
  readonly title: string
  readonly tooltip: string
  /** 终端标签的运行状态；对话标签没有这个概念。 */
  readonly terminalStatus: 'running' | 'exited' | null
  /** 该对话标签的实例已结束本轮回复，而用户还没切到过它；终端标签始终为假。 */
  readonly unseenCompletion: boolean
}

export const useWorkspaceTabsStore = defineStore('workspace-tabs', () => {
  const projectStore = useProjectStore()
  const runtimeStore = useRuntimeStore()
  const sessionRunsStore = useSessionRunsStore()
  const sessionStore = useSessionStore()
  const terminalStore = useTerminalStore()

  /** 按项目保存的标签键顺序；数组顺序即标签顺序。 */
  const orders = ref<Readonly<Record<string, readonly string[]>>>({})
  /** 对话标签的页面内记录；键是标签键，与 `orders` 中的对话键一一对应。 */
  const chatTabs = ref<Readonly<Record<string, ChatTabRecord>>>({})
  /** 按项目记住的活动标签；记录的标签消失时由 `activeTab` 回退。 */
  const activeTabs = ref<Readonly<Record<string, string | null>>>({})
  /** 用户重命名过的标签标题；未记录时按会话摘要或终端标题展示。 */
  const renames = ref<Readonly<Record<string, string>>>({})
  /** 已结束回复但用户还没看过的对话标签键；只在内存里，不跨应用重启恢复。 */
  const unseenCompletions = ref<ReadonlySet<string>>(new Set())
  /** 上一次广播时正在执行的实例：只有由执行中变为已结束才算一轮回复完成，初始快照不产生标记。 */
  let streamingRunIds = new Set<number>()
  /** 已经自动补过空对话标签的项目；用户显式关掉全部对话标签后不再自动补回。 */
  const preparedProjects = new Set<string>()
  let nextChatTabId = 1
  let stopProjectWatch: WatchStopHandle | null = null
  let stopProjectsWatch: WatchStopHandle | null = null
  let stopRunsWatch: WatchStopHandle | null = null
  let stopSessionsWatch: WatchStopHandle | null = null

  const currentProjectPath = computed(() => projectStore.currentProject?.path ?? null)

  /** 当前项目按顺序展开后的标签键：跳过失效的对话标签与已消失的终端，新终端追加到末尾。 */
  const projectKeys = computed(() => {
    const projectPath = currentProjectPath.value
    return projectPath === null ? [] : effectiveKeys(projectPath)
  })

  /** 当前项目的标签；顺序即展示顺序。 */
  const tabs = computed<readonly WorkspaceTabView[]>(() => {
    const projectPath = currentProjectPath.value
    if (projectPath === null) return []
    return projectKeys.value.map(key => viewOf(projectPath, key))
  })

  /** 当前项目的活动标签；记录的标签已消失时回退到第一个标签，没有标签时为空。 */
  const activeTab = computed<string | null>(() => {
    const projectPath = currentProjectPath.value
    if (projectPath === null) return null
    const keys = projectKeys.value
    if (keys.length === 0) return null
    const stored = activeTabs.value[projectPath] ?? null
    return stored !== null && keys.includes(stored) ? stored : keys[0] ?? null
  })

  /** 活动标签是否是对话标签；对话面板只在此时可见。 */
  const isChatActive = computed(() => activeTab.value !== null && isChatKey(activeTab.value))

  /**
   * 活动对话标签正在展示的会话身份；活动标签是终端或该标签的实例尚未建立时为空。
   * 与 `focusChatTab` 取同一个口径（未落盘的新会话取实例报告的会话），界面据此判断会话是否已展示。
   */
  const activeSessionId = computed<string | null>(() => {
    const key = activeTab.value
    if (key === null || !isChatKey(key)) return null
    const record = chatTabs.value[key]
    if (record === undefined) return null
    return record.sessionId ?? sessionIdOfRun(record.runId)
  })

  /** 终端标签键；标签条与终端面板用同一套键判定可见性。 */
  function terminalTabId(terminalId: string): string {
    return `${TERMINAL_KEY_PREFIX}${terminalId}`
  }

  /**
   * 当前活动标签对应的终端标识；活动标签是对话或没有标签时为空。
   * 右侧面板把文件路径写入终端前用它定位目标，避免写进看不见的终端。
   */
  const activeTerminalId = computed<string | null>(() => {
    const key = activeTab.value
    return key === null ? null : terminalIdOf(key)
  })

  /**
   * 页面挂载后调用：进入项目时补一个空对话标签，并跟随运行实例列表同步标签的会话身份。
   * 先订阅、再取一次当前值，避免初始化期间漏掉已经发生的项目切换与实例变化。
   */
  function initialize(): void {
    if (stopProjectWatch === null) {
      stopProjectWatch = watch(currentProjectPath, (projectPath) => {
        if (projectPath !== null) prepareProject(projectPath)
      }, { immediate: true })
    }
    if (stopProjectsWatch === null) {
      stopProjectsWatch = watch(() => projectStore.projects.map(project => project.path), dropMissingProjects)
    }
    if (stopRunsWatch === null) {
      stopRunsWatch = watch(() => sessionRunsStore.runs, () => {
        syncRuns()
        trackCompletions()
      }, { immediate: true })
    }
    if (stopSessionsWatch === null) {
      // 会话列表刷新后重跑同步：会话落盘后标签才采纳它的身份，标题也从「新对话」换成摘要。
      stopSessionsWatch = watch(() => sessionStore.loadedSessionIds, syncRuns)
    }
  }

  /** 页面卸载时释放订阅；标签只留在内存里，重新挂载后回到一个空对话标签。 */
  function dispose(): void {
    stopProjectWatch?.()
    stopProjectWatch = null
    stopProjectsWatch?.()
    stopProjectsWatch = null
    stopRunsWatch?.()
    stopRunsWatch = null
    stopSessionsWatch?.()
    stopSessionsWatch = null
  }

  /**
   * 首次进入某个项目时补一个空对话标签：重启后回到一个空对话标签，而不是一片空白。
   * 只在本次应用运行内补一次，用户显式关掉全部对话标签后不再自动补回。
   */
  function prepareProject(projectPath: string): void {
    if (preparedProjects.has(projectPath)) return
    preparedProjects.add(projectPath)
    if (hasChatTab(projectPath)) return
    const key = createChatTab(projectPath)
    writeOrder(projectPath, [key, ...(orders.value[projectPath] ?? [])])
    setActive(projectPath, key)
  }

  /** 切换活动标签；活动对话标签对应前台实例，切过去时把该实例切到前台。 */
  async function activateTab(key: string): Promise<void> {
    const projectPath = currentProjectPath.value
    if (projectPath === null || activeTab.value === key) return
    if (!projectKeys.value.includes(key)) return
    setActive(projectPath, key)
    if (isChatKey(key)) await focusChatTab(projectPath, key)
  }

  /**
   * 新建标签：对话标签走空对话入口（同一项目只保留一个未落盘的），终端标签在当前项目内新建终端。
   * 终端创建失败时保留原因由终端 store 提示，不建立空标签。
   */
  async function createTab(kind: WorkspaceTabKind): Promise<void> {
    if (kind === 'chat') {
      await openNewChatTab()
      return
    }
    const projectPath = currentProjectPath.value
    if (projectPath === null) return
    const terminalId = await terminalStore.createTerminal()
    if (terminalId === null) return
    const key = terminalTabId(terminalId)
    appendKey(projectPath, key)
    setActive(projectPath, key)
  }

  /**
   * 新建对话标签：同一项目内至多一个未落盘的新对话标签，重复点击聚焦已有的那个。
   * Runtime 闲置时只建立标签、不提交打开请求，空对话本来就能直接输入。
   * `projectPath` 由调用方给出时按它建标签（侧栏可能刚切项目，不等切换完成也能落到正确项目）。
   */
  async function openNewChatTab(projectPath: string | null = currentProjectPath.value): Promise<void> {
    if (projectPath === null) return
    const existing = findChatKey(projectPath, null)
    if (existing !== null) {
      setActive(projectPath, existing)
      await focusChatTab(projectPath, existing)
      return
    }
    const key = createChatTab(projectPath)
    appendKey(projectPath, key)
    setActive(projectPath, key)
    if (isRuntimeIdle()) return
    await sessionStore.open(null, false, projectPath)
  }

  /**
   * 在当前活动对话标签内就地新建对话：结束该标签承载的运行实例（中断在途操作、解除占用、关闭宿主，
   * 保留会话历史文件），标签位置、顺序与活动状态不变，会话身份与用户重命名一并清除。
   * 本来就是空对话时不重建实例；另一会话正在打开时不动作，避免新建意图落到别的会话上。
   */
  async function startNewChatInTab(): Promise<NewChatInTabOutcome> {
    const projectPath = currentProjectPath.value
    const key = activeTab.value
    if (projectPath === null || key === null || !isChatKey(key)) return 'unavailable'
    const record = chatTabs.value[key]
    if (record === undefined) return 'unavailable'
    if (sessionStore.opening) return 'busy'
    const runId = resolveRunId(projectPath, key)
    // 既没有实例也没有会话身份：这个标签本来就是空对话，结束与重建都没有意义。
    if (runId === null && record.sessionId === null) return 'already-new'
    if (runId !== null && !await sessionRunsStore.close(runId)) return 'refused'
    // 就地清空：只换身份，不动标签位置与顺序；旧会话的历史文件与留底草稿都不受影响。
    chatTabs.value = { ...chatTabs.value, [key]: { sessionId: null, runId: null } }
    clearRename(key)
    setActive(projectPath, key)
    // 结束实例后前台已被清空，闲置时不必预建宿主；仍占用前台实例时才提交新会话的打开请求。
    if (isRuntimeIdle()) return 'started'
    await sessionStore.open(null, false, projectPath)
    return 'started'
  }

  /**
   * 关闭标签：对话标签结束它承载的运行实例（中断在途操作、解除占用、关闭宿主，保留会话历史文件），
   * 终端标签关掉那个终端进程。任一步失败都保留标签，避免出现「实例还在、标签已消失」。
   */
  async function closeTab(key: string): Promise<void> {
    const located = locate(key)
    if (located === null) return
    const projectPath = located.projectPath
    if (isChatKey(key)) {
      const runId = resolveRunId(projectPath, key)
      if (runId !== null && !await sessionRunsStore.close(runId)) return
      const fallback = removeKey(projectPath, key)
      forgetChatTab(key)
      if (fallback !== null && isChatKey(fallback)) await focusChatTab(projectPath, fallback)
      return
    }
    const terminalId = terminalIdOf(key)
    if (terminalId === null) return
    await terminalStore.closeTerminal(terminalId)
    if (terminalStore.sessions.some(session => session.id === terminalId)) return
    removeKey(projectPath, key)
  }

  /** 用户重命名标签：空标题清掉覆盖，回到按会话摘要或终端标题展示。 */
  function renameTab(key: string, title: string): void {
    const trimmed = title.trim()
    if (trimmed === '') {
      const next = { ...renames.value }
      delete next[key]
      renames.value = next
      return
    }
    renames.value = { ...renames.value, [key]: trimmed }
  }

  /** 把标签移动到目标位置（0 是标签组里的第一个）；越界位置收敛到合法范围。 */
  function moveTab(key: string, toIndex: number): void {
    const projectPath = currentProjectPath.value
    if (projectPath === null) return
    const keys = projectKeys.value
    const from = keys.indexOf(key)
    if (from < 0) return
    const target = Math.min(Math.max(toIndex, 0), keys.length - 1)
    if (target === from) return
    const next = [...keys]
    next.splice(from, 1)
    next.splice(target, 0, key)
    writeOrder(projectPath, next)
  }

  /**
   * 打开会话成功后的标签同步：该会话已有标签时聚焦它，否则新开一个标签并切过去。
   * 未落盘的新会话复用该项目已有的空对话标签，因此「新建会话」不会重复占用同一个实例。
   */
  function syncOpenTab(sessionId: string | null, projectPath: string): void {
    const key = findChatKey(projectPath, sessionId) ?? createChatTab(projectPath, sessionId)
    if (!(orders.value[projectPath] ?? []).includes(key)) appendKey(projectPath, key)
    bindRun(projectPath, key)
    setActive(projectPath, key)
  }

  /** 会话被删除后移除它的标签；它承载的实例已由删除链收敛，这里只清展示。 */
  function dropSession(projectPath: string, sessionId: string): void {
    for (const [key, record] of Object.entries(chatTabs.value)) {
      if (record.sessionId !== sessionId) continue
      if (!(orders.value[projectPath] ?? []).includes(key)) continue
      removeKey(projectPath, key)
      forgetChatTab(key)
    }
  }

  /** 项目从列表移除后丢掉它的标签记录；只清展示，不动任何终端或运行实例。 */
  function dropProject(projectPath: string): void {
    for (const key of orders.value[projectPath] ?? []) {
      if (isChatKey(key)) forgetChatTab(key)
    }
    const nextOrders = { ...orders.value }
    delete nextOrders[projectPath]
    orders.value = nextOrders
    const nextActive = { ...activeTabs.value }
    delete nextActive[projectPath]
    activeTabs.value = nextActive
  }

  /**
   * 展开某个项目的标签键：登记过的顺序去掉已失效的标签，再按终端清单顺序补上未登记的终端。
   * 终端清单是主进程的真相，因此终端标签不需要另外登记，重挂载接回后自动回到标签组。
   */
  function effectiveKeys(projectPath: string): readonly string[] {
    const alive = new Set(terminalStore.sessions
      .filter(session => session.projectPath === projectPath)
      .map(session => terminalTabId(session.id)))
    const keys: string[] = []
    const seen = new Set<string>()
    for (const key of orders.value[projectPath] ?? []) {
      if (seen.has(key)) continue
      if (isChatKey(key)) {
        if (chatTabs.value[key] === undefined) continue
      } else if (!alive.has(key)) {
        continue
      }
      seen.add(key)
      keys.push(key)
    }
    for (const key of alive) {
      if (seen.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
    return keys
  }

  /** 标签的展示模型：对话标签取会话摘要，终端标签取终端标题与运行状态。 */
  function viewOf(projectPath: string, key: string): WorkspaceTabView {
    if (isChatKey(key)) {
      const record = chatTabs.value[key] ?? { sessionId: null, runId: null }
      const title = titleOfChat(projectPath, key, record)
      const detail = record.sessionId === null ? '尚未落盘的新会话' : `会话 ${record.sessionId}`
      return { id: key, kind: 'chat', title, tooltip: `${title}\n${detail}`, terminalStatus: null,
        unseenCompletion: unseenCompletions.value.has(key) }
    }
    const session = terminalOf(key)
    const title = titleOfTerminal(key, session)
    return {
      id: key,
      kind: 'terminal',
      title,
      tooltip: session === null ? title : `${title}\n${session.shell}\n${session.cwd}\n${terminalStatusText(session)}`,
      terminalStatus: session === null ? null : session.status,
      unseenCompletion: false
    }
  }

  /** 对话标签标题：用户重命名优先，其次是会话摘要的首行，未落盘的新会话显示「新对话」。 */
  function titleOfChat(projectPath: string, key: string, record: ChatTabRecord): string {
    const renamed = renames.value[key]
    if (renamed !== undefined) return renamed
    if (record.sessionId === null) return '新对话'
    const summary = sessionStore.sessionsOf(projectPath)
      .find(session => session.sessionId === record.sessionId)
    const preview = summary?.preview ?? null
    return preview === null || preview === '' ? `会话 ${record.sessionId.slice(0, 8)}` : preview
  }

  /** 终端标签标题：页面内的标题（重命名或程序上报）优先，其次是主进程给的默认标题。 */
  function titleOfTerminal(key: string, session: TerminalSessionInfo | null): string {
    const renamed = renames.value[key]
    if (renamed !== undefined) return renamed
    const terminalId = terminalIdOf(key)
    const title = terminalId === null ? undefined : terminalStore.titles[terminalId]
    if (title !== undefined && title !== '') return title
    return session?.title ?? '终端'
  }

  function terminalStatusText(session: TerminalSessionInfo): string {
    return session.status === 'exited' ? `已退出（退出码 ${session.exitCode ?? 0}）` : '运行中'
  }

  function terminalOf(key: string): TerminalSessionInfo | null {
    const terminalId = terminalIdOf(key)
    if (terminalId === null) return null
    return terminalStore.sessions.find(session => session.id === terminalId) ?? null
  }

  /**
   * 把该对话标签的实例切到前台：主进程按占用或可复用实例决定是复用还是新建，渲染端只表达打开意图。
   * 标签身份取实例报告的会话（可能尚未落盘），实例尚未建立时在 Runtime 闲置下不提交请求。
   */
  async function focusChatTab(projectPath: string, key: string): Promise<void> {
    const record = chatTabs.value[key]
    if (record === undefined) return
    const sessionId = record.sessionId ?? sessionIdOfRun(record.runId)
    if (sessionId === null && record.runId === null && isRuntimeIdle()) return
    await sessionStore.open(sessionId, false, projectPath)
  }

  /** 运行实例列表变化时同步标签：未落盘的标签认领它承载的实例，实例换了会话身份（回退新建会话）时跟着走。 */
  function syncRuns(): void {
    const runs = sessionRunsStore.runs
    const next: Record<string, ChatTabRecord> = {}
    const claimed = new Set<number>()
    const items: { readonly key: string; readonly record: ChatTabRecord; readonly projectPath: string }[] = []
    for (const [key, record] of Object.entries(chatTabs.value)) {
      const located = locate(key)
      if (located === null) next[key] = record
      else items.push({ key, record, projectPath: located.projectPath })
    }
    // 先按会话身份认领：一个实例只判给一个标签，未落盘的标签再认领本项目剩下的无主实例。
    const claimedBySession = new Map<string, number>()
    for (const item of items) {
      if (item.record.sessionId === null) continue
      const found = runs.find(run => run.sessionId === item.record.sessionId && run.projectPath === item.projectPath)
      if (found === undefined) continue
      claimedBySession.set(item.key, found.runId)
      claimed.add(found.runId)
    }
    let changed = false
    for (const item of items) {
      const record = syncRecord(item.record, item.projectPath, runs, claimed, claimedBySession.get(item.key) ?? null)
      next[item.key] = record
      if (record.sessionId !== item.record.sessionId || record.runId !== item.record.runId) changed = true
    }
    if (changed) chatTabs.value = next
  }

  /**
   * 单个标签记录的同步：先跟住它已经承载的实例，实例没了再按会话身份或本项目剩下的无主实例重新认领。
   * 标签承载的实例被释放（例如空会话被收掉）时只丢实例，不留下已经不存在的会话身份。
   */
  function syncRecord(
    record: ChatTabRecord,
    projectPath: string,
    runs: readonly SessionRunState[],
    claimed: Set<number>,
    claimedRunId: number | null
  ): ChatTabRecord {
    const bound = record.runId === null ? undefined : runs.find(run => run.runId === record.runId)
    // 实例仍属于该项目时才跟着它走：被释放后项目归属会清空，不能把别的项目的新会话算到这个标签上。
    if (bound !== undefined && bound.projectPath === projectPath) {
      return { sessionId: adoptSession(record.sessionId, bound.sessionId, projectPath), runId: bound.runId }
    }
    if (record.sessionId !== null) return { sessionId: record.sessionId, runId: claimedRunId }
    const free = runs.find(run => run.projectPath === projectPath && !claimed.has(run.runId))
    if (free === undefined) return { sessionId: null, runId: null }
    claimed.add(free.runId)
    return { sessionId: adoptSession(null, free.sessionId, projectPath), runId: free.runId }
  }

  /**
   * 采纳实例报告的会话身份：实例换了会话（回退新建会话）时跟着走；实例尚未落盘的新会话保持「新对话」，
   * 因此被释放的空会话不会在标签上留下一个没有文件的会话身份。
   */
  function adoptSession(current: string | null, fromRun: string | null, projectPath: string): string | null {
    if (fromRun === null || fromRun === current) return current
    if (current !== null) return fromRun
    return sessionStore.loadedSessionIds.has(fromRun) ? fromRun : null
  }

  /** 实例当前绑定的会话身份；实例不存在或未绑定时为空。 */
  function sessionIdOfRun(runId: number | null): string | null {
    if (runId === null) return null
    return sessionRunsStore.runs.find(run => run.runId === runId)?.sessionId ?? null
  }

  /** 该对话标签当前应关联的实例身份：标签已经记下实例时以它为准，否则按会话身份查。 */
  function resolveRunId(projectPath: string, key: string): number | null {
    const record = chatTabs.value[key]
    if (record === undefined) return null
    if (record.sessionId === null) return record.runId
    return sessionRunsStore.runOfSession(projectPath, record.sessionId)?.runId ?? record.runId
  }

  /** 记下标签承载的实例身份；同一项目内未落盘的标签因此能跟随实例换会话身份。 */
  function bindRun(projectPath: string, key: string): void {
    const record = chatTabs.value[key]
    if (record === undefined) return
    const runId = resolveRunId(projectPath, key)
    if (runId === record.runId) return
    chatTabs.value = { ...chatTabs.value, [key]: { ...record, runId } }
  }

  /** 新建一个对话标签记录并返回它的键；标签本身的位置由调用方决定。 */
  function createChatTab(projectPath: string, sessionId: string | null = null): string {
    const key = `${CHAT_KEY_PREFIX}${nextChatTabId}`
    nextChatTabId += 1
    chatTabs.value = { ...chatTabs.value, [key]: { sessionId, runId: null } }
    bindRun(projectPath, key)
    return key
  }

  /** 该项目里会话身份匹配的对话标签键；未落盘的会话身份是 null，因此只会命中空对话标签。 */
  function findChatKey(projectPath: string, sessionId: string | null): string | null {
    for (const [key, record] of Object.entries(chatTabs.value)) {
      if (record.sessionId !== sessionId) continue
      if (!(orders.value[projectPath] ?? []).includes(key)) continue
      return key
    }
    return null
  }

  function hasChatTab(projectPath: string): boolean {
    return (orders.value[projectPath] ?? []).some(key => isChatKey(key) && chatTabs.value[key] !== undefined)
  }

  /** 移除标签键并返回接替它成为活动标签的那个键；没有可接替的标签时清空活动标签。 */
  function removeKey(projectPath: string, key: string): string | null {
    const keys = effectiveKeys(projectPath)
    const index = keys.indexOf(key)
    const next = (orders.value[projectPath] ?? []).filter(candidate => candidate !== key)
    writeOrder(projectPath, next)
    if (activeTabs.value[projectPath] !== key) return null
    const fallback = index < 0 ? null : keys[index - 1] ?? keys[index + 1] ?? null
    const replaced = fallback === null ? null : effectiveKeys(projectPath).includes(fallback) ? fallback : null
    setActive(projectPath, replaced)
    return replaced
  }

  /** 追加标签键到项目末尾；已在列表里时不重复追加。 */
  function appendKey(projectPath: string, key: string): void {
    const current = orders.value[projectPath] ?? []
    if (current.includes(key)) return
    writeOrder(projectPath, [...current, key])
  }

  function writeOrder(projectPath: string, keys: readonly string[]): void {
    orders.value = { ...orders.value, [projectPath]: keys }
  }

  /**
   * 记录后台标签的回复完成：实例由「执行中」变为「已结束」，且它绑定的标签不是活动标签时标记该标签。
   * 宿主失败或阶段不是运行中的不算一轮完成；活动标签用户正在看，不标记。
   */
  function trackCompletions(): void {
    const streaming = new Set<number>()
    for (const run of sessionRunsStore.runs) {
      if (run.isStreaming) {
        streaming.add(run.runId)
        continue
      }
      if (!streamingRunIds.has(run.runId)) continue
      if (run.phase !== 'running' || run.hostState === 'failed') continue
      const key = keyOfRun(run)
      if (key === null) continue
      const located = locate(key)
      if (located !== null && activeTabs.value[located.projectPath] === key) continue
      markUnseen(key)
    }
    streamingRunIds = streaming
  }

  /** 该实例当前绑定的对话标签键：先按实例身份，再按会话身份与项目顺序表匹配；没有标签时为空。 */
  function keyOfRun(run: SessionRunState): string | null {
    for (const [key, record] of Object.entries(chatTabs.value)) {
      if (record.runId === run.runId) return key
    }
    if (run.sessionId === null || run.projectPath === null) return null
    for (const [key, record] of Object.entries(chatTabs.value)) {
      if (record.sessionId !== run.sessionId) continue
      if ((orders.value[run.projectPath] ?? []).includes(key)) return key
    }
    return null
  }

  /** 标记该标签有新回复；已标记时不重复写入。 */
  function markUnseen(key: string): void {
    if (unseenCompletions.value.has(key)) return
    const next = new Set(unseenCompletions.value)
    next.add(key)
    unseenCompletions.value = next
  }

  /** 清除该标签的新回复标记；没有标记时无副作用。 */
  function clearUnseen(key: string): void {
    if (!unseenCompletions.value.has(key)) return
    const next = new Set(unseenCompletions.value)
    next.delete(key)
    unseenCompletions.value = next
  }

  function setActive(projectPath: string, key: string | null): void {
    // 用户切到该标签即视为已看过本轮回复，标记在该标签成为活动标签时清除。
    if (key !== null) clearUnseen(key)
    if (activeTabs.value[projectPath] === key) return
    activeTabs.value = { ...activeTabs.value, [projectPath]: key }
  }

  function forgetChatTab(key: string): void {
    if (chatTabs.value[key] !== undefined) {
      const nextTabs = { ...chatTabs.value }
      delete nextTabs[key]
      chatTabs.value = nextTabs
    }
    clearRename(key)
    clearUnseen(key)
  }

  /** 清除某个标签的用户重命名；该标签本来没有覆盖时无副作用。 */
  function clearRename(key: string): void {
    if (renames.value[key] === undefined) return
    const nextRenames = { ...renames.value }
    delete nextRenames[key]
    renames.value = nextRenames
  }

  /** 标签键属于哪个项目；登记过的顺序优先，未登记过顺序的终端标签按终端清单反查。 */
  function locate(key: string): { readonly projectPath: string } | null {
    for (const [projectPath, keys] of Object.entries(orders.value)) {
      if (keys.includes(key)) return { projectPath }
    }
    const terminalId = terminalIdOf(key)
    if (terminalId === null) return null
    const session = terminalStore.sessions.find(candidate => candidate.id === terminalId)
    return session === undefined ? null : { projectPath: session.projectPath }
  }

  /** 项目列表变化时丢掉已移除项目的标签；其他项目的标签不受影响。 */
  function dropMissingProjects(paths: readonly string[]): void {
    const alive = new Set(paths)
    for (const projectPath of Object.keys(orders.value)) {
      if (!alive.has(projectPath)) dropProject(projectPath)
    }
  }

  function isChatKey(key: string): boolean {
    return key.startsWith(CHAT_KEY_PREFIX)
  }

  function terminalIdOf(key: string): string | null {
    return key.startsWith(TERMINAL_KEY_PREFIX) ? key.slice(TERMINAL_KEY_PREFIX.length) : null
  }

  /** Runtime 是否闲置；闲置时不因点击标签或新建入口启动 Pi。 */
  function isRuntimeIdle(): boolean {
    const phase = runtimeStore.view.phase
    return phase === 'idle' || phase === 'closed'
  }

  return {
    tabs,
    activeTab,
    activeSessionId,
    activeTerminalId,
    isChatActive,
    terminalTabId,
    initialize,
    dispose,
    activateTab,
    createTab,
    openNewChatTab,
    startNewChatInTab,
    closeTab,
    renameTab,
    moveTab,
    syncOpenTab,
    dropSession,
    dropProject
  }
})
