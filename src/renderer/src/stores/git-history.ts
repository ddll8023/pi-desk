/**
 * 提交历史的展示状态：提交列表（可翻页）、单个提交的详情、提交内文件差异。
 *
 * 三层结构对应界面上的三次点击：列表 → 提交详情 → 文件差异。层级由状态本身表达（`detail` / `fileSelection`
 * 是否有值），不再另存一个 level 字段，避免两者不一致。
 *
 * 每次读取都带序号：翻页、切过滤路径、连点提交都可能同时在飞，过期响应一律丢弃。
 * 历史只在用户打开「历史」视图时才读；提交成功后会重置，让新提交立刻出现在最上面。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { DesktopError } from '../../../shared/desktop-api'
import type { GitCommitDetail, GitCommitFile, GitCommitSummary, GitTextDiff } from '../../../shared/git-api'
import { getGitCommitDetail, getGitCommitDiff, getGitHistory, getGitHistoryPage } from '../services/git'

type Phase = 'idle' | 'loading' | 'ready' | 'error'

export const useGitHistoryStore = defineStore('git-history', () => {
  const commits = ref<readonly GitCommitSummary[]>([])
  const hasMore = ref(false)
  const upstreamName = ref<string | null>(null)
  const aheadCount = ref(0)
  /** 当前过滤路径；null 表示整仓库。 */
  const filterPath = ref<string | null>(null)
  const phase = ref<Phase>('idle')
  const error = ref<DesktopError | null>(null)
  const loadingMore = ref(false)

  const detail = ref<GitCommitDetail | null>(null)
  const detailPhase = ref<Phase>('idle')
  const detailError = ref<DesktopError | null>(null)

  const fileSelection = ref<{ readonly path: string; readonly oldPath?: string } | null>(null)
  const diff = ref<GitTextDiff | null>(null)
  const diffPhase = ref<Phase>('idle')
  const diffError = ref<DesktopError | null>(null)

  let listSeq = 0
  let detailSeq = 0
  let diffSeq = 0

  const isOpen = computed(() => phase.value !== 'idle')
  const canLoadMore = computed(() => hasMore.value && !loadingMore.value && phase.value === 'ready')
  /** 列表里是否有未推送的提交；用于页头提示「↑N 未推送」。 */
  const unpushedCount = computed(() => commits.value.filter((commit) => !commit.pushed).length)

  function resetList(): void {
    listSeq += 1
    commits.value = []
    hasMore.value = false
    upstreamName.value = null
    aheadCount.value = 0
    phase.value = 'idle'
    error.value = null
    loadingMore.value = false
    resetDetail()
  }

  function resetDetail(): void {
    detailSeq += 1
    diffSeq += 1
    detail.value = null
    detailPhase.value = 'idle'
    detailError.value = null
    fileSelection.value = null
    diff.value = null
    diffPhase.value = 'idle'
    diffError.value = null
  }

  /** 打开历史（可带过滤路径）；重复打开同一路径时重新读第一页，内容可能已经变化。 */
  async function open(path: string | null = null): Promise<void> {
    filterPath.value = path
    resetDetail()

    const ticket = ++listSeq
    phase.value = commits.value.length === 0 ? 'loading' : phase.value
    const result = await getGitHistory(path ?? undefined)
    if (ticket !== listSeq) return

    if (!result.ok) {
      error.value = result.error
      phase.value = 'error'
      return
    }
    commits.value = result.data.commits
    hasMore.value = result.data.hasMore
    upstreamName.value = result.data.upstreamName
    aheadCount.value = result.data.aheadCount
    phase.value = 'ready'
    error.value = null
  }

  /** 继续读更早的提交；失败只提示，不影响已加载的部分。 */
  async function loadMore(): Promise<void> {
    if (!canLoadMore.value) return
    loadingMore.value = true
    const ticket = listSeq
    const result = await getGitHistoryPage(commits.value.length, filterPath.value)
    loadingMore.value = false
    if (ticket !== listSeq) return

    if (!result.ok) {
      error.value = result.error
      return
    }
    commits.value = [...commits.value, ...result.data.commits]
    hasMore.value = result.data.hasMore
    error.value = null
  }

  /** 打开一个提交的详情（改动文件清单）。 */
  async function selectCommit(commit: GitCommitSummary): Promise<void> {
    fileSelection.value = null
    diff.value = null
    diffPhase.value = 'idle'
    detail.value = null
    detailError.value = null
    detailPhase.value = 'loading'

    const ticket = ++detailSeq
    const result = await getGitCommitDetail(commit.oid)
    if (ticket !== detailSeq) return

    if (!result.ok) {
      detailError.value = result.error
      detailPhase.value = 'error'
      return
    }
    detail.value = result.data
    detailPhase.value = 'ready'
  }

  /** 打开提交内某个文件的差异；重命名条目带上原路径，原内容才取得到。 */
  async function selectFile(file: GitCommitFile): Promise<void> {
    const current = detail.value
    if (current === null) return

    fileSelection.value = { path: file.path, ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }) }
    diff.value = null
    diffError.value = null
    diffPhase.value = 'loading'

    const ticket = ++diffSeq
    const result = await getGitCommitDiff(current.oid, file.path, file.oldPath)
    if (ticket !== diffSeq) return

    if (!result.ok) {
      diffError.value = result.error
      diffPhase.value = 'error'
      return
    }
    diff.value = result.data
    diffPhase.value = 'ready'
  }

  /** 从文件差异回到提交详情。 */
  function backToDetail(): void {
    diffSeq += 1
    fileSelection.value = null
    diff.value = null
    diffPhase.value = 'idle'
    diffError.value = null
  }

  /** 从提交详情回到列表。 */
  function backToList(): void {
    resetDetail()
  }

  return {
    commits,
    hasMore,
    upstreamName,
    aheadCount,
    filterPath,
    phase,
    error,
    loadingMore,
    detail,
    detailPhase,
    detailError,
    fileSelection,
    diff,
    diffPhase,
    diffError,
    isOpen,
    canLoadMore,
    unpushedCount,
    open,
    loadMore,
    selectCommit,
    selectFile,
    backToDetail,
    backToList,
    resetList
  }
})
