/**
 * 工作区标签状态：按项目分组的对话、终端、文件与浏览器标签，活动标签、标签顺序与标题覆盖。
 *
 * 标签是页面内的展示编排：活动的对话标签就是前台运行实例，其余对话标签由后台分片留底，
 * 因此切标签就是切前台；切项目换一组标签（对话、终端、文件与浏览器一起换），每个项目各自记住上次的活动标签。
 * 会话尚未绑定时，活动标签可以先展示该会话的日志历史；`/new` 的空白视图独立于旧实例状态，
 * 原实例结束后才允许首次发送，新会话实际绑定前不因标签聚焦预建宿主。
 * 标签只计算打开意图（`ChatOpenIntent`），实际提交由会话能力（`session.openIntent`）与外层编排执行，
 * 标签侧不反向调用会话的打开动作。
 * 顺序、活动标签、对话与文件标签的重命名、以及「有新回复」标记只留在内存里，不跨应用重启恢复；
 * 项目切换时不自动补建空对话标签。终端标签的命名是例外：它交给守护进程随会话记录落盘。
 *
 * 标签键是页面内编号，只在渲染端有效：对话标签记会话身份与它承载的运行实例，终端标签记终端标识，
 * 文件标签记一个编号（路径与编辑状态由 `project-editor` 持有），浏览器标签记一个唯一键（页面与导航状态由 `browserStore` 持有）。
 * 终端清单是主进程的真相，因此终端标签按清单派生（已消失的不再展示、新出现的追加到末尾）；对话、文件与浏览器标签需要在这里登记。
 * 文件标签只能由打开文件产生，不进入「新建」菜单；脏文件或含未交付批注的浏览器关闭前先确认，确认后才丢弃对应内容。
 * 后台实例回复结束时给它的对话标签打「有新回复」标记，切到该标签即清除。
 * 新建对话的入口分两类：标签条与侧栏新建一个对话标签，`/new` 则在当前标签内就地替换
 * （结束原实例、清空会话身份与重命名，标签位置与顺序不变）。
 * 快捷命令的运行目标也是标签：每次都新开一个终端标签再写入，不复用当前活动终端。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { WatchStopHandle } from 'vue'
import type { SessionRunState } from '../../../../shared/session-run-api'
import type { QuickCommand } from '../../../../shared/quick-commands-api'
import type { TerminalSessionInfo } from '../../../../shared/terminal-api'
import { BLANK_PAGE_URL, BROWSER_KEY_PREFIX, DEFAULT_BROWSER_TITLE } from '../../../../shared/browser-api'
import { useBrowserStore } from '../../browser/stores/browser'
import { useBrowserAnnotationsStore } from '../../browser/stores/browser-annotations'
import { useProjectStore } from '../../projects/stores/project'
import { useProjectEditorStore } from '../../editor/stores/project-editor'
import type { FileEditorMode, FileEditorRecord } from '../../editor/stores/project-editor'
import { useRuntimeStore } from '../../sessions/stores/runtime'
import { useSessionRunsStore } from '../../sessions/stores/session-runs'
import { sessionTabState } from './session-tab-bridge'
import { useTerminalStore } from './terminal'

/** 对话标签键前缀；终端标签键是 `term:<终端标识>`，文件标签键是 `file:<编号>`，浏览器标签键是 `browser:<随机标识>`。 */
const CHAT_KEY_PREFIX = 'chat:'
const TERMINAL_KEY_PREFIX = 'term:'
const FILE_KEY_PREFIX = 'file:'
/** 原位新建的输入身份；与 SDK 会话身份分开，避免旧实例收尾清掉新草稿。 */
export const NEW_CHAT_INPUT_PREFIX = 'new-chat:'

/** 可通过「新建」菜单主动创建的类型；文件标签只能由打开文件产生，不在新建入口里。 */
export type WorkspaceTabKind = 'chat' | 'terminal' | 'browser'

/** 当前项目打开的内置浏览器标签模型。 */
export interface OpenBrowserTab {
  readonly key: string
  readonly projectPath: string
}

/**
 * 一次「把某个对话标签的实例切到前台」的打开意图。
 *
 * 标签侧只计算「该打开哪个会话、落到哪个标签」，实际提交由会话能力完成（`session.openIntent`），
 * 因此标签不再反向调用会话的打开动作。
 */
export interface ChatOpenIntent {
  readonly projectPath: string
  readonly tabKey: string
  readonly sessionId: string | null
  readonly allowInterrupt: boolean
}

/**
 * 原位新建结果：`started` 表示原标签已重置且新草稿就绪，不表示 SDK 已启动；`already-new` 是本来就空；
 * `refused` 表示结束未确认，保留标签与新草稿，执行状态以主进程报告为准；`busy` 是已有生命周期动作；
 * `unavailable` 是没有可替换的活动对话标签。
 */
export type NewChatInTabOutcome = 'started' | 'already-new' | 'refused' | 'busy' | 'unavailable'

interface NewChatInTabResult {
  readonly outcome: NewChatInTabOutcome
  readonly intent: ChatOpenIntent | null
}

/** 新建失败保留输入身份供重试；绑定后保留映射，供暂时卸载的输入框取回草稿。 */
interface NewChatState {
  readonly projectPath: string
  readonly inputKey: string
  readonly phase: 'closing' | 'draft' | 'binding' | 'failed' | 'bound'
  readonly error: string | null
  readonly sessionId: string | null
  readonly runId: number | null
}

/** 标签绑定实际会话与实例；是否空白单独记录，不用列表刷新进度充当身份。 */
interface ChatTabRecord {
  readonly sessionId: string | null
  readonly runId: number | null
  readonly hasMessages: boolean
}

/** 标签的展示模型：标题与提示都已解析，标签条只负责渲染与派发意图。 */
export interface WorkspaceTabView {
  readonly id: string
  readonly kind: WorkspaceTabKind | 'file'
  readonly title: string
  readonly tooltip: string
  /** 终端标签的运行状态；对话与文件标签没有这个概念。 */
  readonly terminalStatus: 'running' | 'exited' | null
  /** 该对话标签的实例已结束本轮回复，而用户还没切到过它；其余标签始终为假。 */
  readonly unseenCompletion: boolean
  /** 文件标签有未保存修改；关闭前需要确认。 */
  readonly dirty: boolean
}

export const useWorkspaceTabsStore = defineStore('workspace-tabs', () => {
  const projectStore = useProjectStore()
  const runtimeStore = useRuntimeStore()
  const sessionRunsStore = useSessionRunsStore()
  const session = sessionTabState()
  const terminalStore = useTerminalStore()
  const editorStore = useProjectEditorStore()
  const browserStore = useBrowserStore()
  const browserAnnotations = useBrowserAnnotationsStore()

  /** 按项目保存的标签键顺序；数组顺序即标签顺序。 */
  const orders = ref<Readonly<Record<string, readonly string[]>>>({})
  /** 对话标签的页面内记录；键是标签键，与 `orders` 中的对话键一一对应。 */
  const chatTabs = ref<Readonly<Record<string, ChatTabRecord>>>({})
  /** 按项目记住的活动标签；记录的标签消失时由 `activeTab` 回退。 */
  const activeTabs = ref<Readonly<Record<string, string | null>>>({})
  /**
   * 用户重命名过的对话与文件标签标题；未记录时按会话摘要或文件名展示。
   * 终端标签不走这里：它的命名由守护进程随会话记录落盘。
   */
  const renames = ref<Readonly<Record<string, string>>>({})
  /** 已结束回复但用户还没看过的对话标签键；只在内存里，不跨应用重启恢复。 */
  const unseenCompletions = ref<ReadonlySet<string>>(new Set())
  /** 待确认关闭的文件或浏览器标签键；确认前保留未保存修改或未交付批注。 */
  const pendingCloseKey = ref<string | null>(null)
  /** 上一次广播时正在执行的实例：只有由执行中变为已结束才算一轮回复完成，初始快照不产生标记。 */
  let streamingRunIds = new Set<number>()
  const closingTabs = new Set<string>()
  const newChats = ref<Readonly<Record<string, NewChatState>>>({})
  const newChatRequests = new Map<string, Promise<NewChatInTabResult>>()
  let nextNewChatInputId = 0
  let runCloseTail: Promise<void> = Promise.resolve()
  let selectionVersion = 0
  let nextChatTabId = 1
  let stopProjectsWatch: WatchStopHandle | null = null
  let stopRunsWatch: WatchStopHandle | null = null
  let stopSessionsWatch: WatchStopHandle | null = null
  let stopNewChatWatch: WatchStopHandle | null = null
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

  /** 新建的展示与输入归属按原标签固定，不随旧 Runtime 的中间状态变化。 */
  const activeNewChat = computed(() => {
    const key = activeTab.value
    const state = key === null ? undefined : newChats.value[key]
    return state !== undefined && state.projectPath === currentProjectPath.value ? state : null
  })
  const isChatNewDraft = computed(() => activeNewChat.value?.phase === 'closing'
    || activeNewChat.value?.phase === 'draft' || activeNewChat.value?.phase === 'binding')
  const isChatResetting = computed(() => activeNewChat.value?.phase === 'closing')
  const isChatBinding = computed(() => activeNewChat.value?.phase === 'binding')
  const newChatInputKey = computed(() => isChatNewDraft.value ? activeNewChat.value?.inputKey ?? null : null)
  const newChatError = computed(() => activeNewChat.value?.phase === 'failed' ? activeNewChat.value.error : null)
  const newChatInputKeys = computed<ReadonlySet<string>>(() => new Set(Object.values(newChats.value).map(state => state.inputKey)))
  const newChatInputBindings = computed(() => Object.values(newChats.value).filter(state => state.phase === 'bound'))

  /** 活动标签是否是对话标签；对话面板只在此时可见。 */
  const isChatActive = computed(() => activeTab.value !== null && isChatKey(activeTab.value))

  /**
   * 共用聊天视图在活动标签与前台身份一致时即可显示，不等打开动作整体收尾。
   * 身份匹配已经说明主进程把该实例切到了前台，此时展示缓存内容不会把旧会话冒充成新会话；
   * 打开中、待确认等对写入的限制放在 `isChatInteractive`，不拿来隐藏已就绪的内容。
   */
  const isChatReady = computed(() => {
    if (isChatNewDraft.value) return false
    const key = activeTab.value
    // 可见性不看 `projectStore.switching`：切换期间活动标签已指向目标项目，身份不匹配自然不显示，
    // 而拿切换状态当可见条件会让整块面板在切换途中被迫退回等待态。
    if (key === null || !isChatKey(key)) return false
    const record = chatTabs.value[key]
    if (record === undefined) return false
    if (record.runId !== null) return record.runId === runtimeStore.foregroundRunId
    if (record.sessionId !== null) return record.sessionId === runtimeStore.foregroundSessionId
    return isRuntimeIdle()
  })

  /**
   * 活动标签是否正在展示会话日志历史：内容已经可见，但可执行会话尚未绑定。
   * 它让面板先出内容，同时不放开任何写入——`isChatInteractive` 仍要求 `isChatReady`。
   */
  const isChatLogPreview = computed(() => {
    if (isChatNewDraft.value) return false
    const key = activeTab.value
    const sessionId = runtimeStore.logSessionId
    if (sessionId === null || key === null || !isChatKey(key)) return false
    const record = chatTabs.value[key]
    if (record === undefined || record.sessionId !== sessionId) return false
    return !isChatReady.value
  })

  /**
   * 已有会话写入要求身份就绪；独立新草稿要求旧实例已经结束，且没有生命周期动作在途。
   * 新草稿只允许发起首次绑定，不把旧 Runtime 的就绪状态当作可发送目标。
   */
  const isChatInteractive = computed(() => (
    (isChatReady.value || isChatNewDraft.value) && !isChatResetting.value && !isChatBinding.value
      && !session.opening && !projectStore.switching
  ))

  /**
   * 当前项目已打开的文件记录，顺序与标签一致；文件面板按它逐个挂载，非活动面板只隐藏不卸载，
   * 因此切回来仍是同一份编辑内容与撤销历史。
   */
  const openFiles = computed<readonly FileEditorRecord[]>(() => {
    if (currentProjectPath.value === null) return []
    return projectKeys.value
      .filter(isFileKey)
      .map(key => editorStore.recordOf(key))
      .filter((record): record is FileEditorRecord => record !== null)
  })

  /**
   * 当前项目已打开的内置浏览器标签，顺序与标签条一致；各面板保持挂载以维持 DOM 与页面状态。
   */
  const openBrowsers = computed<readonly OpenBrowserTab[]>(() => {
    const projectPath = currentProjectPath.value
    if (projectPath === null) return []
    return projectKeys.value
      .filter(isBrowserKey)
      .map(key => ({ key, projectPath }))
  })

  /**
   * 活动对话标签正在展示的会话身份；活动标签是终端或文件标签、或该标签的实例尚未建立时为空。
   * 与 `focusIntent` 取同一个口径（未落盘的新会话取实例报告的会话），界面据此判断会话是否已展示。
   */
  const activeSessionId = computed<string | null>(() => {
    if (isChatNewDraft.value) return null
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
   * 页面挂载后调用：跟随运行实例与会话列表同步标签身份。
   * 项目切换与打开结束引起的补提交不在这里：它们是打开编排，由启动编排（`shell/use-app-startup.ts`）
   * 取意图后交给会话能力，标签只负责计算。
   */
  function initialize(): void {
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
      stopSessionsWatch = watch(() => session.loadedSessionIds, syncRuns)
    }
    if (stopNewChatWatch === null) {
      // 打开应答与状态推送分别到达；原位视图一直等到自己的执行目标真正可展示。
      stopNewChatWatch = watch(() => [runtimeStore.view, sessionRunsStore.runs, currentProjectPath.value, activeTab.value, newChats.value],
        settleNewChatBindings, { flush: 'sync' })
    }
  }

  /** 页面卸载时释放订阅；标签只留在内存里，重新挂载后不恢复标签。 */
  function dispose(): void {
    stopProjectsWatch?.()
    stopProjectsWatch = null
    stopRunsWatch?.()
    stopRunsWatch = null
    stopSessionsWatch?.()
    stopSessionsWatch = null
    stopNewChatWatch?.()
    stopNewChatWatch = null
    newChats.value = {}
    newChatRequests.clear()
  }

  /** 切换活动标签；活动对话标签对应前台实例，切过去时返回把它切到前台的打开意图。 */
  async function activateTab(key: string): Promise<ChatOpenIntent | null> {
    const projectPath = currentProjectPath.value
    if (projectPath === null || !projectKeys.value.includes(key)) return null
    if (activeTab.value === key && (!isChatKey(key) || isChatReady.value)) return null
    selectLocal(projectPath, key)
    return isChatKey(key) ? focusIntent(projectPath, key) : null
  }

  /**
   * 新建一个终端标签：对话标签不走这里，由 `openNewChatTab` 建立并返回打开意图。
   * 终端创建失败时保留原因由终端 store 提示，不建立空标签。
   */
  async function createTerminalTab(): Promise<string | null> {
    const projectPath = currentProjectPath.value
    if (projectPath === null) {
      terminalStore.reportError('先选择项目，再新建终端。')
      return null
    }
    const version = selectionVersion
    const terminalId = await terminalStore.createTerminal(projectPath)
    if (terminalId === null) return null
    const key = terminalTabId(terminalId)
    appendKey(projectPath, key)
    if (version === selectionVersion && currentProjectPath.value === projectPath) selectLocal(projectPath, key)
    return terminalId
  }

  /**
   * 新建一个浏览器标签：在当前项目下创建空白标签并激活。
   */
  async function openBrowserTab(initialUrl?: string): Promise<string> {
    const projectPath = currentProjectPath.value
    if (projectPath === null) return ''
    const key = `${BROWSER_KEY_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    browserStore.ensureTab(key, projectPath, initialUrl)
    appendKey(projectPath, key)
    selectLocal(projectPath, key)
    return key
  }

  /**
   * 运行一条快捷命令：每次都在当前项目新开一个终端标签再写入，不写进已有终端。
   * 不复用活动终端的原因：常驻前台命令（`vite`、`uvicorn --reload` 等）会把 PTY 一直占在前台，
   * 写进去的文本既不执行也不报错，用户看到的就是「点了没反应」；而渲染端拿不到「终端是否停在 shell 提示符」
   * 的可靠信号，无法只挑空闲终端复用，因此统一新建。代价是连点同一条命令会得到多个终端标签，由用户自行关闭。
   * 命令文本不做解析或转义（它就是要交给 shell 的输入）；`appendEnter` 为真时补一个回车立即执行。
   * 回车一律用 CR：多行命令里的 LF 在 PowerShell/PSReadLine 里不是 Enter，只当作输入缓冲里的换行，
   * 整段会被攒成一条待提交的多行输入，行的先后顺序就不再是逐条执行的顺序（例如 `cd` 反而落在后面的命令之后）。
   * 因此要执行时把每个换行都换成 CR，让每行各自成为一次提交；只插入文本时不转换，否则等于替用户按下执行。
   * 失败（没有项目、终端达到上限、写入被拒）只留在终端 store 的错误提示里，不在这里重复文案。
   */
  async function runQuickCommand(command: QuickCommand): Promise<void> {
    const text = command.appendEnter ? `${command.command.replace(/\r\n|\r|\n/g, '\r')}\r` : command.command
    const created = await createTerminalTab()
    if (created === null) return
    await terminalStore.insertText(created, text)
  }

  /**
   * 打开一个项目内文件：已打开时聚焦已有标签，否则新建文件标签并切过去。
   * 不传 `mode` 时按文件类型与设置里的默认视图决定（Markdown 取偏好，其余进源码）；传了则以该模式打开，
   * 用于右键菜单里与默认视图相反的那个入口。非 Markdown 文件会忽略预览模式。
   * `anchor` 指定 Markdown 标题：请求留在目标文件记录内，等待正文呈现后消费。
   * 读取由编辑记录异步完成，标签先出现并展示读取中状态。
   */
  function openFileTab(path: string, mode?: FileEditorMode, anchor?: string | null, expectedProjectPath?: string): void {
    const projectPath = currentProjectPath.value
    // 异步文档候选只能打开原项目，不能在切换后把同名路径解释为新项目的文件。
    if (projectPath === null || (expectedProjectPath !== undefined && expectedProjectPath !== projectPath)) return
    const key = editorStore.open(projectPath, path)
    if (mode !== undefined) editorStore.setMode(key, mode)
    if (anchor !== undefined && anchor !== null) editorStore.requestAnchor(key, anchor)
    appendKey(projectPath, key)
    selectLocal(projectPath, key)
  }

  /**
   * 新建对话标签：优先复用本项目无正式消息且无待提交输入的空白标签，否则新建；待提交标签独立保留。
   * Runtime 闲置时只建立标签、不提交打开请求，空对话本来就能直接输入；
   * 需要打开时返回意图，由调用方交给会话能力提交。
   * `projectPath` 由调用方给出时按它建标签（侧栏可能刚切项目，不等切换完成也能落到正确项目）。
   */
  async function openNewChatTab(projectPath: string | null = currentProjectPath.value): Promise<ChatOpenIntent | null> {
    if (projectPath === null) return null
    const key = findChatKey(projectPath, null) ?? createChatTab(projectPath)
    appendKey(projectPath, key)
    selectLocal(projectPath, key)
    const version = selectionVersion
    if (projectPath !== currentProjectPath.value) await projectStore.select(projectPath, false, 'session')
    if (version !== selectionVersion || projectPath !== currentProjectPath.value || !hasChatTabKey(projectPath, key)) return null
    return focusIntent(projectPath, key)
  }

  /**
   * 原位新建先展示独立空白视图，再按原标签结束实例；期间只允许编辑，首次发送才建立新会话。
   * 每个标签只运行一份结束任务，迟到结果只收敛原标签；失败恢复原会话，新草稿留待重试。
   * 恢复入口用 expected 指定原目标；建立新任务前拒绝换绑，原槽位已释放且空闲时允许恢复。
   */
  async function startNewChatInTab(expected?: {
    readonly projectPath: string
    readonly tabKey: string
    readonly runId: number
    readonly runtimeId: number | null
    readonly sessionId: string | null
  }): Promise<NewChatInTabResult> {
    const projectPath = currentProjectPath.value
    const key = activeTab.value
    if (projectPath === null || key === null || !isChatKey(key)) return { outcome: 'unavailable', intent: null }
    const record = chatTabs.value[key]
    if (record === undefined) return { outcome: 'unavailable', intent: null }
    const pending = newChatRequests.get(key)
    if (pending !== undefined) return pending
    if (session.opening || closingTabs.has(key) || newChats.value[key]?.phase === 'closing') {
      return { outcome: 'busy', intent: null }
    }
    const runId = resolveRunId(projectPath, key)
    // 恢复输入前的确认只授权原目标；同步核对期间换标签或换绑后不能结束新目标。
    if (expected !== undefined) {
      const view = runtimeStore.view
      const run = sessionRunsStore.runs.find(candidate => candidate.runId === expected.runId)
      // 切到另一标签可能已经释放空会话；仅原槽位确实空闲且无绑定时允许恢复，不能接管已换绑的实例。
      const released = run?.phase === 'idle' && run.sessionId === null && !run.isStreaming && run.waitingDialogs === 0
      const releasedTab = released && runId === null && record.sessionId === null
      if (expected.projectPath !== projectPath || expected.tabKey !== key || (expected.runId !== runId && !releasedTab)
        || (!released && (expected.sessionId !== (record.sessionId ?? sessionIdOfRun(runId))
          || (view.phase === 'ready' && view.snapshot.runId === runId && view.snapshot.runtimeId !== expected.runtimeId)))) {
        return { outcome: 'unavailable', intent: null }
      }
    }
    const previous = newChats.value[key]
    if (runId === null && record.sessionId === null && previous?.phase !== 'failed') {
      return { outcome: 'already-new', intent: null }
    }
    const state: NewChatState = {
      projectPath,
      inputKey: previous?.phase === 'failed' ? previous.inputKey : `${NEW_CHAT_INPUT_PREFIX}${++nextNewChatInputId}`,
      phase: 'closing', error: null, sessionId: record.sessionId, runId
    }
    newChats.value = { ...newChats.value, [key]: state }
    selectLocal(projectPath, key)
    const task: Promise<NewChatInTabResult> = Promise.resolve().then(async (): Promise<NewChatInTabResult> => {
      if (runId !== null && !await closeChatRun(runId)) {
        failNewChat(key, state, sessionRunsStore.closeError ?? '结束原会话未确认。')
        return { outcome: 'refused', intent: null }
      }
      if (!hasChatTabKey(projectPath, key) || newChats.value[key]?.inputKey !== state.inputKey) {
        return { outcome: 'unavailable', intent: null }
      }
      chatTabs.value = { ...chatTabs.value, [key]: { sessionId: null, runId: null, hasMessages: false } }
      clearRename(key)
      clearUnseen(key)
      newChats.value = { ...newChats.value, [key]: { ...state, phase: 'draft', sessionId: null, runId: null } }
      // 不再根据旧 Runtime 快照补开会话，也不在异步收尾时重新选择标签。
      return { outcome: 'started', intent: null }
    }).catch((error: unknown): NewChatInTabResult => {
      failNewChat(key, state, error instanceof Error ? error.message : '结束原会话失败。')
      return { outcome: 'refused', intent: null }
    }).finally(() => {
      if (newChatRequests.get(key) === task) newChatRequests.delete(key)
    })
    newChatRequests.set(key, task)
    return task
  }

  /** 只回退仍属于本次新建的标签；保留输入身份，让重试取回新草稿而非覆盖原会话输入。 */
  function failNewChat(key: string, state: NewChatState, error: string): void {
    if (!hasChatTabKey(state.projectPath, key) || newChats.value[key]?.inputKey !== state.inputKey) return
    newChats.value = { ...newChats.value, [key]: { ...state, phase: 'failed', error } }
    syncRuns()
  }

  /**
   * 关闭标签：对话标签结束它承载的运行实例（中断在途操作、解除占用、关闭宿主，保留会话历史文件），
   * 终端标签关掉那个终端进程；文件清内存编辑记录、不改动磁盘，浏览器清导航与批注状态。
   * 未保存文件修改与未交付浏览器批注的丢弃确认由 requestClose 入口处理。
   * 任一步失败都保留标签，避免出现「实例还在、标签已消失」。
   * 关闭后需要把落到的相邻对话标签切到前台时返回打开意图，由调用方提交。
   */
  async function closeTab(key: string): Promise<ChatOpenIntent | null> {
    const located = locate(key)
    if (located === null || closingTabs.has(key)) return null
    const projectPath = located.projectPath
    const keys = effectiveKeys(projectPath)
    const index = keys.indexOf(key)
    const neighbor = index < 0 ? null : keys[index - 1] ?? keys[index + 1] ?? null
    closingTabs.add(key)
    if (activeTabs.value[projectPath] === key) session.invalidateOpenSelection()
    try {
      if (isFileKey(key)) editorStore.close(key)
      else if (isBrowserKey(key)) {
        browserStore.removeTab(key)
        browserAnnotations.remove(key)
      }
      else if (isChatKey(key)) {
        // 打开尚未返回时先保留标签，等实际身份绑定后再关闭；失败时仍能保留原标签。
        await session.waitForOpenActions()
        await newChatRequests.get(key)
        const runId = resolveRunId(projectPath, key)
        if (runId !== null && !await closeChatRun(runId)) return null
      } else {
        const terminalId = terminalIdOf(key)
        if (terminalId === null) return null
        await terminalStore.closeTerminal(terminalId)
        if (terminalStore.sessions.some(session => session.id === terminalId)) return null
      }
      const fallback = removeKey(projectPath, key, neighbor)
      if (isChatKey(key)) forgetChatTab(key)
      if (projectPath === currentProjectPath.value && fallback !== null && isChatKey(fallback)) {
        return focusIntent(projectPath, fallback)
      }
      return null
    } finally {
      closingTabs.delete(key)
    }
  }

  /**
   * 关闭入口：有未保存修改的文件或未交付批注的浏览器先置待确认状态，其余直接走关闭链；
   * 关闭后需要补打开的相邻对话标签由返回值交给调用方提交。
   */
  async function requestClose(key: string): Promise<ChatOpenIntent | null> {
    const tab = tabs.value.find(candidate => candidate.id === key)
    if (tab !== undefined && (tab.dirty || (isBrowserKey(key) && browserAnnotations.hasUnsubmitted(key)))) {
      pendingCloseKey.value = key
      return null
    }
    return closeTab(key)
  }

  /** 确认丢弃未保存修改或未交付批注并关闭；标签已消失时无副作用。 */
  async function confirmPendingClose(): Promise<ChatOpenIntent | null> {
    const key = pendingCloseKey.value
    pendingCloseKey.value = null
    return key === null ? null : closeTab(key)
  }

  function cancelPendingClose(): void {
    pendingCloseKey.value = null
  }

  /** 所有标签关闭与迟到打开的清理共用一条串行关闭链，不因其他关闭忙而静默丢弃。 */
  async function closeChatRun(runId: number): Promise<boolean> {
    const pending = runCloseTail.then(async () => {
      if (sessionRunsStore.closing) {
        await new Promise<void>(resolve => {
          const stop = watch(() => sessionRunsStore.closing, closing => {
            if (closing) return
            stop()
            resolve()
          }, { flush: 'sync' })
        })
      }
      return sessionRunsStore.close(runId)
    })
    runCloseTail = pending.then(() => {}, () => {})
    return pending
  }

  /**
   * 用户重命名标签：空标题清掉覆盖，回到按会话摘要或文件名展示。
   * 终端标签走另一条路：交给守护进程落盘（重启后仍保留）。对话与文件标签的键不跨重启稳定，只能留在页面内。
   */
  function renameTab(key: string, title: string): void {
    const trimmed = title.trim()
    const terminalId = terminalIdOf(key)
    if (terminalId !== null) {
      // 终端侧命名交给守护进程：它才能随会话记录持久化。页面内不再另存覆盖，避免两份标题不一致。
      void terminalStore.renameTerminal(terminalId, trimmed)
      return
    }
    if (trimmed === '') {
      const next = { ...renames.value }
      delete next[key]
      renames.value = next
      return
    }
    renames.value = { ...renames.value, [key]: trimmed }
  }

  /** 移到原列表目标标签之前；先移除源标签，再换算插入边界。 */
  function moveTab(key: string, toIndex: number): void {
    const projectPath = currentProjectPath.value
    if (projectPath === null) return
    const keys = projectKeys.value
    const from = keys.indexOf(key)
    if (from < 0) return
    const boundary = Math.min(Math.max(toIndex, 0), keys.length)
    const target = boundary > from ? boundary - 1 : boundary
    if (target === from) return
    const next = [...keys]
    next.splice(from, 1)
    next.splice(target, 0, key)
    writeOrder(projectPath, next)
  }

  /** 仅绑定打开请求事先固定的标签；过期响应保留原实例归属，但不抢占最新选择。 */
  function syncOpenTab(
    sessionId: string | null, projectPath: string, key: string, runId: number, activate: boolean
  ): boolean {
    const record = chatTabs.value[key]
    if (record === undefined || !hasChatTabKey(projectPath, key)) return false
    const run = sessionRunsStore.runs.find(candidate => candidate.runId === runId)
    const released = run !== undefined && (run.projectPath !== projectPath
      || (run.sessionId !== null && sessionId !== null && run.sessionId !== sessionId))
    const hasMessages = record.hasMessages || (!released && run?.hasMessages === true)
      || (sessionId !== null && session.loadedSessionIds.has(sessionId))
    chatTabs.value = { ...chatTabs.value, [key]: {
      sessionId: released && !hasMessages ? null : sessionId,
      runId: released ? null : runId, hasMessages
    } }
    const newChat = newChats.value[key]
    if (!released && newChat?.phase === 'draft') {
      // 先记实际归属；当前标签继续等状态推送，后台标签只等登记身份确认。
      newChats.value = { ...newChats.value, [key]: { ...newChat, phase: 'binding', sessionId, runId } }
      settleNewChatBindings()
    }
    if (activate) setActive(projectPath, key)
    return true
  }

  /** 状态确认前保持新草稿；已切走的标签只记实际绑定，不再等待它成为前台。 */
  function settleNewChatBindings(): void {
    const view = runtimeStore.view
    let next: Record<string, NewChatState> | null = null
    for (const [key, state] of Object.entries(newChats.value)) {
      if (state.phase !== 'binding') continue
      const registered = sessionRunsStore.runs.some(run => run.runId === state.runId
        && run.projectPath === state.projectPath && run.sessionId === state.sessionId)
      if (!registered) continue
      const active = state.projectPath === currentProjectPath.value && key === activeTab.value
      const reported = runtimeStore.foregroundRunId === state.runId && (view.phase === 'ready'
        ? (view.snapshot.info?.sessionId ?? null) === state.sessionId
        : view.phase === 'failed' || view.phase === 'closed')
      if (active && !reported) continue
      next ??= { ...newChats.value }
      next[key] = { ...state, phase: 'bound' }
    }
    if (next !== null) newChats.value = next
  }

  /** 打开意图先固定标签；重试只复用原键，原标签被关闭时不另建替代标签。 */
  function prepareOpenTab(projectPath: string, sessionId: string | null, preferredKey: string | null): string | null {
    if (preferredKey !== null && !hasChatTabKey(projectPath, preferredKey)) return null
    const key = preferredKey ?? findChatKey(projectPath, sessionId) ?? createChatTab(projectPath, sessionId)
    if (closingTabs.has(key) || newChats.value[key]?.phase === 'closing' || newChats.value[key]?.phase === 'binding') return null
    appendKey(projectPath, key)
    selectionVersion += 1
    setActive(projectPath, key)
    return key
  }

  function hasChatTabKey(projectPath: string, key: string): boolean {
    return isChatKey(key) && chatTabs.value[key] !== undefined && (orders.value[projectPath] ?? []).includes(key)
  }

  /** 交付批注前后核对标签内容身份，避免原位新建导致投递到另一个对话。 */
  function annotationTargetIdentity(projectPath: string, key: string): string | null {
    if (!hasChatTabKey(projectPath, key)) return null
    const record = chatTabs.value[key]
    return JSON.stringify([record?.sessionId ?? sessionIdOfRun(record?.runId ?? null), newChats.value[key]?.inputKey ?? null])
  }

  function hasRunTab(runId: number): boolean {
    return Object.values(chatTabs.value).some(record => record.runId === runId)
  }

  function sessionIdForTab(projectPath: string, key: string): string | null {
    if (!hasChatTabKey(projectPath, key)) return null
    const record = chatTabs.value[key]
    return record?.sessionId ?? sessionIdOfRun(record?.runId ?? null)
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
      if (isBrowserKey(key)) {
        browserStore.removeTab(key)
        browserAnnotations.remove(key)
      }
    }
    editorStore.closeProject(projectPath)
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
      } else if (isFileKey(key)) {
        // 文件标签的有效性由编辑记录决定：记录被关闭后，登记过的键自然失效。
        if (editorStore.recordOf(key) === null) continue
      } else if (isBrowserKey(key)) {
        if (browserStore.tabs[key] === undefined) continue
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

  /** 标签的展示模型：对话标签取会话摘要，终端标签取终端标题与运行状态，文件标签取文件名与脏标记。 */
  function viewOf(projectPath: string, key: string): WorkspaceTabView {
    if (isChatKey(key)) {
      const record = chatTabs.value[key] ?? { sessionId: null, runId: null, hasMessages: false }
      const title = titleOfChat(projectPath, key, record)
      const newChat = newChats.value[key]
      const detail = record.sessionId === null || newChat?.phase === 'closing' || newChat?.phase === 'draft' || newChat?.phase === 'binding'
        ? '尚未落盘的新会话' : `会话 ${record.sessionId}`
      return { id: key, kind: 'chat', title, tooltip: `${title}\n${detail}`, terminalStatus: null,
        unseenCompletion: unseenCompletions.value.has(key), dirty: false }
    }
    if (isFileKey(key)) {
      const record = editorStore.recordOf(key)
      if (record === null) {
        return { id: key, kind: 'file', title: '文件', tooltip: '', terminalStatus: null,
          unseenCompletion: false, dirty: false }
      }
      return {
        id: key,
        kind: 'file',
        title: renames.value[key] ?? record.name,
        tooltip: `${record.name}\n${record.path}`,
        terminalStatus: null,
        unseenCompletion: false,
        dirty: record.dirty
      }
    }
    if (isBrowserKey(key)) {
      const record = browserStore.tabs[key]
      const title = renames.value[key] ?? record?.title ?? DEFAULT_BROWSER_TITLE
      const url = record?.url ?? BLANK_PAGE_URL
      return {
        id: key,
        kind: 'browser',
        title,
        tooltip: `${title}\n${url}`,
        terminalStatus: null,
        unseenCompletion: false,
        dirty: false
      }
    }
    const session = terminalOf(key)
    const title = titleOfTerminal(key, session)
    return {
      id: key,
      kind: 'terminal',
      title,
      tooltip: session === null ? title : `${title}\n${session.shell}\n${session.cwd}\n${terminalStatusText(session)}`,
      terminalStatus: session === null ? null : session.status,
      unseenCompletion: false,
      dirty: false
    }
  }

  /** 原位新建先显示「新对话」；其他标签依次使用重命名、会话摘要或未落盘名称。 */
  function titleOfChat(projectPath: string, key: string, record: ChatTabRecord): string {
    const newChat = newChats.value[key]
    if (newChat?.phase === 'closing' || newChat?.phase === 'draft' || newChat?.phase === 'binding') return '新对话'
    const renamed = renames.value[key]
    if (renamed !== undefined) return renamed
    if (record.sessionId === null || !record.hasMessages) return '新对话'
    const summary = session.sessionsOf(projectPath)
      .find(session => session.sessionId === record.sessionId)
    const preview = summary?.preview ?? null
    return preview === null || preview === '' ? `会话 ${record.sessionId.slice(0, 8)}` : preview
  }

  /**
   * 终端标签标题：会话记录给出的标题（用户命名 → 程序上报 → shell 默认名）。
   * 终端重命名已改由守护进程落盘，因此这里不再看页面内的 `renames`。
   */
  function titleOfTerminal(key: string, session: TerminalSessionInfo | null): string {
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
   * 该对话标签需要提交的打开意图：主进程按占用或可复用实例决定是复用还是新建，渲染端只表达意图。
   * 原位新草稿不因聚焦预建实例；其他标签取实例报告的会话，空闲时不为无身份标签提交请求。
   */
  function focusIntent(projectPath: string, key: string): ChatOpenIntent | null {
    const record = chatTabs.value[key]
    if (record === undefined) return null
    const newChat = newChats.value[key]
    if (newChat?.phase === 'closing' || newChat?.phase === 'draft' || newChat?.phase === 'binding') return null
    const sessionId = record.sessionId ?? sessionIdOfRun(record.runId)
    if (sessionId === null && record.runId === null && isRuntimeIdle()) return null
    return { projectPath, tabKey: key, sessionId, allowInterrupt: false }
  }

  /**
   * 一次打开动作结束后，若活动对话标签仍未就绪则返回重新打开的意图。
   * 打开中、项目切换中、错误未消除以及信任与中断待确认时都不提交：这些时候重新打开会抢掉用户的确认。
   */
  function chatFocusIntent(): ChatOpenIntent | null {
    const key = activeTab.value
    const projectPath = currentProjectPath.value
    if (session.opening || projectPath === null || key === null || !isChatActive.value || isChatReady.value
      || closingTabs.has(key) || session.actionError !== null || projectStore.switching
      || session.awaitingTrust || session.awaitingInterrupt) return null
    return focusIntent(projectPath, key)
  }

  /**
   * 项目切换后的标签反应：失效旧的打开选择，并在需要时返回把活动对话标签切到前台的意图。
   * 会话自己发起的项目切换（打开会话时）不能当作新的用户选择，也不重复提交打开。
   */
  function onProjectChanged(projectPath: string | null): ChatOpenIntent | null {
    const openingHere = projectStore.selectionOrigin === 'session'
      || (projectPath !== null && session.openingProjectPath === projectPath)
    if (!openingHere) session.invalidateOpenSelection()
    if (projectPath === null) return null
    const key = activeTabs.value[projectPath] ?? null
    if (openingHere || key === null || !isChatKey(key)) return null
    return focusIntent(projectPath, key)
  }

  /** 已绑定标签随实例的会话身份变化；未知实例不再由空标签猜测认领。 */
  function syncRuns(): void {
    const next: Record<string, ChatTabRecord> = {}
    let changed = false
    for (const [key, record] of Object.entries(chatTabs.value)) {
      const newChat = newChats.value[key]
      if (newChat?.phase === 'closing' || newChat?.phase === 'draft' || newChat?.phase === 'binding') {
        next[key] = record
        continue
      }
      const projectPath = locate(key)?.projectPath
      const run = sessionRunsStore.runs.find(candidate => candidate.projectPath === projectPath
        && (candidate.runId === record.runId || (record.sessionId !== null && candidate.sessionId === record.sessionId)))
      let updated: ChatTabRecord
      if (run !== undefined) {
        const sessionId = run.sessionId ?? record.sessionId
        updated = { sessionId, runId: run.runId,
          hasMessages: run.hasMessages || (sessionId === record.sessionId && record.hasMessages)
            || (sessionId !== null && session.loadedSessionIds.has(sessionId)) }
      } else {
        const hasMessages = record.hasMessages
          || (record.sessionId !== null && session.loadedSessionIds.has(record.sessionId))
        const boundKnown = record.runId === null || sessionRunsStore.runs.some(candidate => candidate.runId === record.runId)
        updated = boundKnown
          ? { sessionId: hasMessages ? record.sessionId : null, runId: null, hasMessages }
          : { ...record, hasMessages }
      }
      next[key] = updated
      if (updated.sessionId !== record.sessionId || updated.runId !== record.runId
        || updated.hasMessages !== record.hasMessages) changed = true
    }
    // 不再让空标签猜测认领“剩余实例”；首次绑定只采纳对应打开请求返回的实例身份。
    if (changed) chatTabs.value = next
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
    chatTabs.value = { ...chatTabs.value, [key]: { sessionId, runId: null, hasMessages: sessionId !== null } }
    bindRun(projectPath, key)
    return key
  }

  /**
   * 命名会话按实际身份匹配，null 则只匹配没有正式消息和待提交输入的空白标签。
   * 同一项目已有空标签时优先取活动的那个，
   * 否则新建与打开意图会落到用户看不见的那个标签上。
   */
  function findChatKey(projectPath: string, sessionId: string | null): string | null {
    const keys = orders.value[projectPath] ?? []
    const active = activeTabs.value[projectPath] ?? null
    const matches = (key: string): boolean => {
      const record = chatTabs.value[key]
      if (record === undefined) return false
      if (sessionId !== null) return record.sessionId === sessionId || sessionIdOfRun(record.runId) === sessionId
      if (session.hasPendingPrompt(projectPath, key)) return false
      const newChat = newChats.value[key]
      if (newChat?.phase === 'closing' || newChat?.phase === 'draft' || newChat?.phase === 'binding') return true
      const run = sessionRunsStore.runs.find(candidate => candidate.runId === record.runId)
      return !record.hasMessages && run?.hasMessages !== true
        && (record.sessionId === null || !session.loadedSessionIds.has(record.sessionId))
    }
    if (active !== null && keys.includes(active) && matches(active)) return active
    for (const key of keys) {
      if (matches(key)) return key
    }
    return null
  }

  /** 移除标签键并返回接替它成为活动标签的那个键；没有可接替的标签时清空活动标签。 */
  function removeKey(projectPath: string, key: string, neighbor?: string | null): string | null {
    const keys = effectiveKeys(projectPath)
    const index = keys.indexOf(key)
    const next = (orders.value[projectPath] ?? []).filter(candidate => candidate !== key)
    writeOrder(projectPath, next)
    clearRename(key)
    clearUnseen(key)
    if (activeTabs.value[projectPath] !== key) return null
    const fallback = neighbor === undefined ? (index < 0 ? null : keys[index - 1] ?? keys[index + 1] ?? null) : neighbor
    const remaining = effectiveKeys(projectPath)
    const replaced = fallback !== null && remaining.includes(fallback) ? fallback : remaining[0] ?? null
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

  /** 本地选择会使旧的异步打开意图失效，响应绑定本身不再产生新的选择。 */
  function selectLocal(projectPath: string, key: string): void {
    selectionVersion += 1
    session.invalidateOpenSelection()
    setActive(projectPath, key)
  }

  function setActive(projectPath: string, key: string | null): void {
    // 用户切到该标签即视为已看过本轮回复，标记在该标签成为活动标签时清除。
    if (key !== null) clearUnseen(key)
    if (activeTabs.value[projectPath] === key) return
    activeTabs.value = { ...activeTabs.value, [projectPath]: key }
  }

  function forgetChatTab(key: string): void {
    if (newChats.value[key] !== undefined) {
      const nextNewChats = { ...newChats.value }
      delete nextNewChats[key]
      newChats.value = nextNewChats
    }
    if (chatTabs.value[key] !== undefined) {
      const nextTabs = { ...chatTabs.value }
      delete nextTabs[key]
      chatTabs.value = nextTabs
    }
    clearRename(key)
    clearUnseen(key)
  }

  /** 清除某个对话或文件标签的用户重命名；该标签本来没有覆盖时无副作用。终端命名不在这里。 */
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

  function isFileKey(key: string): boolean {
    return key.startsWith(FILE_KEY_PREFIX)
  }

  function isBrowserKey(key: string): boolean {
    return key.startsWith(BROWSER_KEY_PREFIX)
  }

  function terminalIdOf(key: string): string | null {
    return key.startsWith(TERMINAL_KEY_PREFIX) ? key.slice(TERMINAL_KEY_PREFIX.length) : null
  }

  /** Runtime 是否闲置；闲置时不因点击标签或新建入口启动 Pi。 */
  function isRuntimeIdle(): boolean {
    const phase = runtimeStore.view.phase
    return (phase === 'idle' || phase === 'closed') && runtimeStore.foregroundSessionId === null
  }

  return {
    tabs,
    activeTab,
    activeSessionId,
    activeTerminalId,
    isChatActive,
    isChatReady,
    isChatLogPreview,
    isChatInteractive,
    isChatNewDraft,
    isChatResetting,
    isChatBinding,
    newChatInputKey,
    newChatInputKeys,
    newChatInputBindings,
    newChatError,
    openFiles,
    openBrowsers,
    openBrowserTab,
    isBrowserKey,
    terminalTabId,
    initialize,
    dispose,
    activateTab,
    createTerminalTab,
    runQuickCommand,
    openNewChatTab,
    openFileTab,
    startNewChatInTab,
    closeTab,
    requestClose,
    confirmPendingClose,
    cancelPendingClose,
    pendingCloseKey,
    chatFocusIntent,
    onProjectChanged,
    renameTab,
    moveTab,
    syncOpenTab,
    prepareOpenTab,
    hasChatTabKey,
    annotationTargetIdentity,
    hasRunTab,
    closeChatRun,
    sessionIdForTab,
    dropSession,
    dropProject
  }
})
