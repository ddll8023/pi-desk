/**
 * 右侧面板「源代码管理」的展示状态：状态快照、分组、选中条目与其差异、提交草稿。
 *
 * 核心职责：
 * 1. 拉状态并丢弃过期响应（序号令牌）：切项目、连点刷新、写操作与轮询都可能同时在飞；
 * 2. 把条目按「冲突 → 更改 → 已暂存 → 未跟踪」分组，支持单项与整组批量暂存/取消暂存/丢弃；
 * 3. 维护改动条目的扁平列表与顺序索引，支持差异视图就地快捷前后切换；
 * 4. 把写操作的结果（新的状态快照）直接落地，平滑处理当前选中项的区域流转，不再补一次读取。
 *
 * 刷新时机刻意保守：切项目、面板出现、窗口重新获得焦点、页面重新可见、用户点刷新、写操作之后，
 * 以及主进程目录监听回报「已加载的目录变了」；没有定时轮询。目录监听只覆盖已展开的层，
 * 未展开目录里的改动靠聚焦与手动刷新兜底。
 *
 * 远端操作（拉取/推送）与提交互斥：它们都会改写仓库状态，同时进行只会让两边都在等锁。
 *
 * 写操作需要项目信任（它们会执行仓库里的 filter 与 hook）：主进程回 `TRUST_REQUIRED` 时不把错误直接
 * 报给用户，而是弹出信任对话框并在决定后重试一次，与会话打开的处理方式一致。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { DesktopError } from '../../../../shared/desktop-api'
import type { GitArea, GitChangeEntry, GitDiff, GitOperationResult, GitStatus } from '../../../../shared/git-api'
import {
  commitGitStaged,
  discardGitPath,
  discardGitPaths,
  getGitDiff,
  getGitStatus,
  pullGit,
  pushGit,
  stageGitPath,
  stageGitPaths,
  unstageGitPath,
  unstageGitPaths
} from '../services/git'
import { onProjectDirectoryChanged } from '../../editor/services/project-file'
import { useProjectStore } from '../../projects/stores/project'
import { useTrustStore } from '../../projects/stores/trust'

/** 分组键：冲突单独成组，因为它需要的操作与普通改动不同。 */
export type GitGroupKey = 'conflict' | 'unstaged' | 'staged' | 'untracked'

export interface GitGroup {
  readonly key: GitGroupKey
  readonly title: string
  readonly entries: readonly GitChangeEntry[]
}

/** 状态读取阶段；`ready` 时 `status` 一定有值。 */
type GitPhase = 'idle' | 'loading' | 'ready' | 'error'
/** 差异读取阶段；与状态读取分开，避免一次 diff 失败把整个面板打成错误态。 */
type GitDiffPhase = 'idle' | 'loading' | 'ready' | 'error'

/** 焦点/可见性触发的自动刷新最短间隔：避免在多个事件同时到达时连发几次。 */
const MIN_AUTO_REFRESH_MS = 1500

const GROUP_TITLES: Readonly<Record<GitGroupKey, string>> = {
  conflict: '冲突',
  unstaged: '更改',
  staged: '已暂存的更改',
  untracked: '未跟踪文件'
}

export const useGitStatusStore = defineStore('git-status', () => {
  const projectStore = useProjectStore()

  const status = ref<GitStatus | null>(null)
  const phase = ref<GitPhase>('idle')
  const error = ref<DesktopError | null>(null)
  /** 正在执行写操作的条目路径；同一时刻只允许一个写操作。 */
  const busyPath = ref<string | null>(null)
  const actionError = ref<DesktopError | null>(null)
  const actionNotice = ref<string | null>(null)
  const commitMessage = ref('')
  const committing = ref(false)
  /** 正在执行的远端操作；null 表示空闲。与 `committing` 互斥。 */
  const remoteBusy = ref<'pull' | 'push' | null>(null)
  /** 有写操作因项目未信任被拦下，正在等待信任决定。 */
  const awaitingTrust = ref(false)
  /** 当前查看差异的条目；null 表示面板显示列表。 */
  const selection = ref<{ readonly path: string; readonly area: GitArea } | null>(null)
  const diff = ref<GitDiff | null>(null)
  const diffPhase = ref<GitDiffPhase>('idle')
  const diffError = ref<DesktopError | null>(null)

  let statusSeq = 0
  let diffSeq = 0
  let lastAutoRefreshAt = 0
  let attached = false
  let detach: (() => void) | null = null
  /** 因未信任被拦下的写操作；信任决定后重跑一次，取消则丢弃。 */
  let pendingTrustRetry: (() => Promise<void>) | null = null
  /** 正在重跑被拦下的写操作：此时再被拒就不再弹框，直接展示原因（避免决定为未信任时反复弹框）。 */
  let trustingRetry = false

  const isRepository = computed(() => status.value?.isRepository === true)
  const entries = computed<readonly GitChangeEntry[]>(() => status.value?.entries ?? [])
  const hasChanges = computed(() => entries.value.length > 0)
  const stagedCount = computed(() => entries.value.filter((entry) => entry.area === 'staged').length)

  /** 分组：冲突优先，其余按「更改 → 已暂存 → 未跟踪」；空组不展示。 */
  const groups = computed<readonly GitGroup[]>(() => {
    const buckets: Record<GitGroupKey, GitChangeEntry[]> = {
      conflict: [],
      unstaged: [],
      staged: [],
      untracked: []
    }
    for (const entry of entries.value) {
      if (entry.conflictKind !== undefined) {
        buckets.conflict.push(entry)
        continue
      }
      if (entry.area === 'staged') buckets.staged.push(entry)
      else if (entry.area === 'untracked') buckets.untracked.push(entry)
      else buckets.unstaged.push(entry)
    }

    const order: readonly GitGroupKey[] = ['conflict', 'unstaged', 'staged', 'untracked']
    const groups: GitGroup[] = []
    for (const key of order) {
      const list = buckets[key]
      if (list.length === 0) continue
      list.sort((left, right) => left.path.localeCompare(right.path))
      groups.push({ key, title: GROUP_TITLES[key], entries: list })
    }
    return groups
  })

  /** 选中条目仍然存在时返回它，否则为 null（列表已经变了）。 */
  function selectionStillExists(): boolean {
    const current = selection.value
    if (current === null) return false
    return entries.value.some((entry) => entry.path === current.path && entry.area === current.area)
  }

  function clearSelection(): void {
    diffSeq += 1
    selection.value = null
    diff.value = null
    diffPhase.value = 'idle'
    diffError.value = null
  }

  function applyStatus(next: GitStatus): void {
    status.value = next
    phase.value = 'ready'
    error.value = null
    // 若当前有选中条目：如果该文件仍有改动但区域变化（例如由工作区暂存为已暂存），平滑保留选中并切到新区域；完全无改动则清空。
    const current = selection.value
    if (current !== null) {
      const match = next.entries.find((entry) => entry.path === current.path)
      if (match !== undefined) {
        if (match.area !== current.area) {
          selection.value = { path: match.path, area: match.area }
        }
      } else {
        clearSelection()
      }
    }
  }

  /** 读取状态；`silent` 用于焦点与可见性触发的刷新，不把已有内容切回加载态。 */
  async function refresh(silent = false): Promise<void> {
    const ticket = ++statusSeq
    if (!silent && status.value === null) phase.value = 'loading'

    const result = await getGitStatus()
    if (ticket !== statusSeq) return

    if (!result.ok) {
      error.value = result.error
      phase.value = 'error'
      return
    }
    applyStatus(result.data)
  }

  /** 打开一个条目的差异；同一路径重复点击会重新读取，内容可能已经变化。 */
  async function select(entry: { readonly path: string; readonly area: GitArea }): Promise<void> {
    selection.value = { path: entry.path, area: entry.area }
    diff.value = null
    diffError.value = null
    diffPhase.value = 'loading'

    const ticket = ++diffSeq
    const result = await getGitDiff(entry.path, entry.area)
    if (ticket !== diffSeq) return

    if (!result.ok) {
      diffError.value = result.error
      diffPhase.value = 'error'
      return
    }
    diff.value = result.data
    diffPhase.value = 'ready'
  }

  /** 所有分组按顺序展开的扁平条目列表，供差异视图快速上一个/下一个遍历。 */
  const flatEntries = computed<readonly GitChangeEntry[]>(() => {
    return groups.value.flatMap((group) => group.entries)
  })

  /** 当前查看条目在扁平列表中的下标；-1 表示未选中。 */
  const currentEntryIndex = computed(() => {
    const current = selection.value
    if (current === null) return -1
    return flatEntries.value.findIndex((entry) => entry.path === current.path && entry.area === current.area)
  })

  const hasNextEntry = computed(() => {
    const idx = currentEntryIndex.value
    return idx >= 0 && idx < flatEntries.value.length - 1
  })

  const hasPrevEntry = computed(() => {
    return currentEntryIndex.value > 0
  })

  async function selectNext(): Promise<void> {
    const idx = currentEntryIndex.value
    if (idx < 0 || idx >= flatEntries.value.length - 1) return
    const next = flatEntries.value[idx + 1]
    if (next) await select(next)
  }

  async function selectPrevious(): Promise<void> {
    const idx = currentEntryIndex.value
    if (idx <= 0) return
    const prev = flatEntries.value[idx - 1]
    if (prev) await select(prev)
  }

  /** 写操作统一入口：同一时刻只跑一个，成功后直接用返回的状态快照落地。 */
  async function runAction(
    path: string,
    run: () => Promise<GitOperationResult>,
    successNotice: string
  ): Promise<void> {
    if (busyPath.value !== null) return
    busyPath.value = path
    actionError.value = null
    actionNotice.value = null
    try {
      const result = await run()
      if (!result.ok) {
        // 未信任：记住这次操作，决定后重跑，不把「被拦下」当成失败展示。
        if (result.error.code === 'TRUST_REQUIRED' && !trustingRetry) {
          await requestTrust(() => runAction(path, run, successNotice))
          return
        }
        actionError.value = result.error
        return
      }
      applyStatus(result.data)
      actionNotice.value = successNotice
      // 选中的就是这个条目或进行了批量操作：内容变了，重新读一次差异。
      const current = selection.value
      if (current !== null && (path === '*' || current.path === path)) {
        await select(current)
      }
    } finally {
      busyPath.value = null
    }
  }

  function stage(entry: { readonly path: string }): Promise<void> {
    return runAction(entry.path, () => stageGitPath(entry.path), '已暂存')
  }

  function unstage(entry: { readonly path: string }): Promise<void> {
    return runAction(entry.path, () => unstageGitPath(entry.path), '已取消暂存')
  }

  function discard(entry: { readonly path: string }): Promise<void> {
    return runAction(entry.path, () => discardGitPath(entry.path), '已丢弃改动')
  }

  function stagePaths(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return Promise.resolve()
    if (paths.length === 1) return stage({ path: paths[0] })
    return runAction('*', () => stageGitPaths(paths), `已暂存 ${paths.length} 项更改`)
  }

  function unstagePaths(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return Promise.resolve()
    if (paths.length === 1) return unstage({ path: paths[0] })
    return runAction('*', () => unstageGitPaths(paths), `已取消暂存 ${paths.length} 项更改`)
  }

  function discardPaths(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return Promise.resolve()
    if (paths.length === 1) return discard({ path: paths[0] })
    return runAction('*', () => discardGitPaths(paths), `已丢弃 ${paths.length} 项改动`)
  }

  function stageAll(): Promise<void> {
    const paths = entries.value.filter((entry) => entry.area !== 'staged').map((entry) => entry.path)
    return stagePaths(paths)
  }

  function unstageAll(): Promise<void> {
    const paths = entries.value.filter((entry) => entry.area === 'staged').map((entry) => entry.path)
    return unstagePaths(paths)
  }

  /** 提交已暂存的改动；成功后清空草稿，失败保留草稿并把原因交给面板展示。 */
  async function commit(): Promise<boolean> {
    if (committing.value || remoteBusy.value !== null) return false
    const message = commitMessage.value
    if (message.trim() === '') {
      actionError.value = { code: 'INVALID_REQUEST', message: '提交信息不能为空。' }
      return false
    }

    committing.value = true
    actionError.value = null
    actionNotice.value = null
    try {
      const result = await commitGitStaged(message)
      if (!result.ok) {
        if (result.error.code === 'TRUST_REQUIRED' && !trustingRetry) {
          await requestTrust(() => commit().then(() => undefined))
          return false
        }
        actionError.value = result.error
        return false
      }
      applyStatus(result.data)
      commitMessage.value = ''
      actionNotice.value = '已提交'
      return true
    } finally {
      committing.value = false
    }
  }

  function setCommitMessage(value: string): void {
    commitMessage.value = value
  }

  /** 远端操作的公共流程：与提交互斥，成功后落地新状态，失败原因交给面板展示。 */
  async function runRemote(kind: 'pull' | 'push'): Promise<boolean> {
    if (remoteBusy.value !== null || committing.value) return false
    remoteBusy.value = kind
    actionError.value = null
    actionNotice.value = null
    try {
      const result = kind === 'pull' ? await pullGit() : await pushGit()
      if (!result.ok) {
        if (result.error.code === 'TRUST_REQUIRED' && !trustingRetry) {
          await requestTrust(() => runRemote(kind).then(() => undefined))
          return false
        }
        actionError.value = result.error
        return false
      }
      applyStatus(result.data)
      actionNotice.value = kind === 'pull' ? '已拉取' : '已推送'
      return true
    } finally {
      remoteBusy.value = null
    }
  }

  /** 拉取当前分支的上游；策略沿用用户自己的 git 配置。 */
  function pull(): Promise<boolean> {
    return runRemote('pull')
  }

  /** 推送当前分支；首次推送时由主进程在单远端情况下自动设置上游。 */
  function push(): Promise<boolean> {
    return runRemote('push')
  }

  /**
   * 提交并推送：提交成功后才推送，推送失败时如实告知「已提交」而不是报成整体失败。
   * 提交阶段被信任门禁拦下时，把重试换成整个「提交并推送」，避免决定后只提交不推送。
   */
  async function commitAndPush(): Promise<boolean> {
    if (committing.value || remoteBusy.value !== null) return false
    const committed = await commit()
    if (!committed) {
      if (awaitingTrust.value) pendingTrustRetry = () => commitAndPush().then(() => undefined)
      return false
    }

    const pushed = await push()
    if (!pushed) {
      const reason = actionError.value?.message ?? '原因未明'
      actionError.value = { code: 'GIT_FAILED', message: `已提交，但推送失败：${reason}` }
      return false
    }
    actionNotice.value = '已提交并推送'
    return true
  }

  /**
   * 写操作被信任门禁拦下：记住重试动作并弹出信任对话框。
   * 这里只负责「问」，决定后的重试由 `retryPendingAfterTrust` 触发（`shell/AppDialogHost.vue` 收到对话框结果时调用）。
   */
  async function requestTrust(retry: () => Promise<void>): Promise<void> {
    pendingTrustRetry = retry
    awaitingTrust.value = true
    const opened = await useTrustStore().openPrompt()
    // 弹不出对话框（例如未选择项目）时不要留着一个永远等不到的重试。
    if (!opened) {
      pendingTrustRetry = null
      awaitingTrust.value = false
      actionError.value = { code: 'TRUST_REQUIRED', message: '无法打开信任对话框，请在设置里确认该项目的信任状态后重试。' }
    }
  }

  /** 信任决定已保存：重跑被拦下的写操作。只重试一次，仍被拒时由该操作自己展示原因。 */
  async function retryPendingAfterTrust(): Promise<void> {
    const retry = pendingTrustRetry
    pendingTrustRetry = null
    awaitingTrust.value = false
    if (retry === null) return
    trustingRetry = true
    try {
      await retry()
    } finally {
      trustingRetry = false
    }
  }

  /** 放弃信任决定：丢弃被拦下的写操作，不改动任何仓库状态。 */
  function cancelPendingTrust(): void {
    pendingTrustRetry = null
    awaitingTrust.value = false
  }

  /** 焦点/可见性触发的自动刷新：按最短间隔合并，避免一次切换窗口连发多次。 */
  function autoRefresh(): void {
    const now = Date.now()
    if (now - lastAutoRefreshAt < MIN_AUTO_REFRESH_MS) return
    lastAutoRefreshAt = now
    void refresh(true)
  }

  /**
   * 面板挂载时开始跟踪：切项目立即重读，窗口重新获得焦点、页面重新可见与目录监听回报变化时静默重读。
   * 只装一次；卸载时由 `dispose` 摘掉，避免面板反复开合累积监听。
   */
  function initialize(): void {
    if (attached) return
    attached = true

    const stopProjectWatch = watch(
      () => projectStore.currentProject?.path ?? null,
      () => {
        status.value = null
        phase.value = 'idle'
        error.value = null
        actionError.value = null
        actionNotice.value = null
        commitMessage.value = ''
        // 切项目后旧项目被拦下的写操作不能再重试：信任决定是按项目记录的。
        cancelPendingTrust()
        clearSelection()
        void refresh()
      },
      { immediate: true }
    )

    const onFocus = (): void => autoRefresh()
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') autoRefresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    // 目录监听与文件树共用同一条推送：项目里的改动同样意味着这里的改动列表过期了。
    const stopDirectoryWatch = onProjectDirectoryChanged(() => autoRefresh())

    detach = () => {
      stopProjectWatch()
      stopDirectoryWatch()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }

  function dispose(): void {
    if (!attached) return
    attached = false
    detach?.()
    detach = null
  }

  return {
    status,
    phase,
    error,
    busyPath,
    actionError,
    actionNotice,
    commitMessage,
    committing,
    remoteBusy,
    awaitingTrust,
    selection,
    diff,
    diffPhase,
    diffError,
    isRepository,
    entries,
    hasChanges,
    stagedCount,
    groups,
    flatEntries,
    currentEntryIndex,
    hasNextEntry,
    hasPrevEntry,
    selectNext,
    selectPrevious,
    refresh,
    select,
    clearSelection,
    stage,
    unstage,
    discard,
    stagePaths,
    unstagePaths,
    discardPaths,
    stageAll,
    unstageAll,
    commit,
    pull,
    push,
    commitAndPush,
    retryPendingAfterTrust,
    cancelPendingTrust,
    setCommitMessage,
    initialize,
    dispose
  }
})
