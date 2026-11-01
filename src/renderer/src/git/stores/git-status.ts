/** Git 展示和写操作固定工作区；提交草稿分区保留，迟到结果、信任重试和连续命令不得跨环境。 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { DesktopError } from '../../../../shared/desktop-api'
import type { GitArea, GitChangeEntry, GitDiff, GitOperationResult, GitStatus } from '../../../../shared/git-api'
import type { WorkspaceTarget } from '../../../../shared/workspace-api'
import { workspaceTarget } from '../../../../shared/workspace-api'
import { commitGitStaged, discardGitPaths, getGitDiff, getGitStatus, pullGit, pushGit, stageGitPaths, unstageGitPaths } from '../services/git'
import { onProjectDirectoryChanged } from '../../editor/services/project-file'
import { useProjectStore } from '../../projects/stores/project'
import { useTrustStore } from '../../projects/stores/trust'
import { useTaskWorkspacesStore } from '../../workspace/stores/task-workspaces'

export type GitGroupKey = 'conflict' | 'unstaged' | 'staged' | 'untracked'
export interface GitGroup { readonly key: GitGroupKey; readonly title: string; readonly entries: readonly GitChangeEntry[] }
type Phase = 'idle' | 'loading' | 'ready' | 'error'
type ActionKind = 'paths' | 'commit' | 'pull' | 'push'
const MIN_AUTO_REFRESH_MS = 1500
const TITLES: Record<GitGroupKey, string> = { conflict: '冲突', unstaged: '更改', staged: '已暂存的更改', untracked: '未跟踪文件' }

export const useGitStatusStore = defineStore('git-status', () => {
  const projects = useProjectStore(), workspaces = useTaskWorkspacesStore()
  const context = computed(() => workspaces.selected(projects.currentProject?.path ?? null))
  const status = ref<GitStatus | null>(null), phase = ref<Phase>('idle'), error = ref<DesktopError | null>(null)
  const busyPath = ref<string | null>(null), actionError = ref<DesktopError | null>(null), actionNotice = ref<string | null>(null)
  const drafts = ref<Record<string, string>>({})
  const commitMessage = computed({ get: () => drafts.value[context.value?.id ?? ''] ?? '', set: (text: string) => {
    if (context.value) drafts.value = { ...drafts.value, [context.value.id]: text }
  } })
  const committing = ref(false), remoteBusy = ref<'pull' | 'push' | null>(null), awaitingTrust = ref(false)
  const selection = ref<{ readonly path: string; readonly area: GitArea } | null>(null)
  const diff = ref<GitDiff | null>(null), diffPhase = ref<Phase>('idle'), diffError = ref<DesktopError | null>(null)
  let statusSeq = 0, diffSeq = 0, epoch = 0, lastAutoRefreshAt = 0
  let attached = false, trustingRetry = false
  let detach: (() => void) | null = null, pendingTrustRetry: (() => Promise<void>) | null = null
  let autoRefreshTimer: ReturnType<typeof setTimeout> | null = null
  const isRepository = computed(() => status.value?.isRepository === true)
  const entries = computed<readonly GitChangeEntry[]>(() => status.value?.entries ?? [])
  const hasChanges = computed(() => entries.value.length > 0)
  const stagedCount = computed(() => entries.value.filter(entry => entry.area === 'staged').length)
  const groups = computed<readonly GitGroup[]>(() => {
    const buckets: Record<GitGroupKey, GitChangeEntry[]> = { conflict: [], unstaged: [], staged: [], untracked: [] }
    for (const entry of entries.value) buckets[entry.conflictKind !== undefined ? 'conflict' : entry.area === 'staged' ? 'staged' : entry.area === 'untracked' ? 'untracked' : 'unstaged'].push(entry)
    return (['conflict', 'unstaged', 'staged', 'untracked'] as const).flatMap(key => buckets[key].length
      ? [{ key, title: TITLES[key], entries: buckets[key].sort((a, b) => a.path.localeCompare(b.path)) }] : [])
  })
  const flatEntries = computed(() => groups.value.flatMap(group => group.entries))
  const currentEntryIndex = computed(() => { const current = selection.value; return current ? flatEntries.value.findIndex(entry => entry.path === current.path && entry.area === current.area) : -1 })
  const hasNextEntry = computed(() => currentEntryIndex.value >= 0 && currentEntryIndex.value < flatEntries.value.length - 1)
  const hasPrevEntry = computed(() => currentEntryIndex.value > 0)
  function isCurrent(target: WorkspaceTarget): boolean { return projects.currentProject?.path === target.projectPath && context.value?.id === target.workspaceId }
  /** 提取纯净的目标工作区对象，避免将携带大量条目与响应式代理的 GitStatus 下发至下游与桥接层。 */
  function toTarget(target: WorkspaceTarget): WorkspaceTarget { return { projectPath: target.projectPath, workspaceId: target.workspaceId } }
  function isBusy(): boolean { return busyPath.value !== null || committing.value || remoteBusy.value !== null }
  function clearSelection(): void { diffSeq += 1; selection.value = null; diff.value = null; diffPhase.value = 'idle'; diffError.value = null }
  function applyStatus(next: GitStatus): void {
    if (!isCurrent(next)) return
    status.value = next; phase.value = 'ready'; error.value = null
    const current = selection.value
    if (current) {
      const match = next.entries.find(entry => entry.path === current.path)
      if (!match) clearSelection()
      else selection.value = { path: match.path, area: match.area }
    }
  }
  async function refresh(silent = false): Promise<void> {
    if (isBusy()) return
    const projectPath = projects.currentProject?.path
    if (!projectPath || workspaces.pendingProjects.includes(projectPath)) return
    const ticket = ++statusSeq
    if (!silent && !status.value) phase.value = 'loading'
    try {
      const workspace = await workspaces.ensure(projectPath)
      if (ticket !== statusSeq || projects.currentProject?.path !== projectPath) return
      if (!workspaces.selected(projectPath)) { workspaces.select(workspace); return }
      const target = workspaceTarget(workspace)
      if (!isCurrent(target)) return
      const result = await getGitStatus(target)
      if (ticket !== statusSeq || !isCurrent(target)) return
      if (!result.ok) { error.value = result.error; phase.value = 'error'; return }
      applyStatus(result.data)
    } catch (caught) { if (ticket === statusSeq) { error.value = { code: 'BRIDGE_CALL_FAILED', message: caught instanceof Error ? caught.message : '解析 Git 工作区失败。' }; phase.value = 'error' } }
  }
  async function select(entry: { readonly path: string; readonly area: GitArea }): Promise<void> {
    const rawTarget = status.value
    if (!rawTarget || !isCurrent(rawTarget)) return
    const target = toTarget(rawTarget)
    selection.value = { path: entry.path, area: entry.area }; diff.value = null; diffError.value = null; diffPhase.value = 'loading'
    const ticket = ++diffSeq
    const result = await getGitDiff(target, entry.path, entry.area)
    if (ticket !== diffSeq || !isCurrent(target)) return
    if (!result.ok) { diffError.value = result.error; diffPhase.value = 'error'; return }
    if (result.data.workspaceId !== target.workspaceId || result.data.projectPath !== target.projectPath) return
    diff.value = result.data; diffPhase.value = 'ready'
  }
  async function selectNext(): Promise<void> { const next = flatEntries.value[currentEntryIndex.value + 1]; if (hasNextEntry.value && next) await select(next) }
  async function selectPrevious(): Promise<void> { const previous = flatEntries.value[currentEntryIndex.value - 1]; if (hasPrevEntry.value && previous) await select(previous) }
  async function requestTrust(target: WorkspaceTarget, retry: () => Promise<void>): Promise<void> {
    if (!isCurrent(target)) return
    pendingTrustRetry = retry; awaitingTrust.value = true
    const opened = await useTrustStore().openPrompt()
    if (!isCurrent(target)) return
    if (!opened) { cancelPendingTrust(); actionError.value = { code: 'TRUST_REQUIRED', message: '请在设置里确认该项目的信任状态后重试。' } }
  }
  async function perform(target: WorkspaceTarget, path: string, run: () => Promise<GitOperationResult>, notice: string,
    kind: ActionKind = 'paths', success: () => void = () => {}): Promise<boolean> {
    if (!isCurrent(target) || isBusy()) return false
    const ticket = epoch
    statusSeq += 1
    if (kind === 'paths') busyPath.value = path
    else if (kind === 'commit') committing.value = true
    else remoteBusy.value = kind
    actionError.value = null; actionNotice.value = null
    try {
      const result = await run()
      if (ticket !== epoch || !isCurrent(target)) return false
      if (!result.ok) {
        if (result.error.code === 'TRUST_REQUIRED' && !trustingRetry) {
          await requestTrust(target, async () => { await perform(target, path, run, notice, kind, success) })
        } else actionError.value = result.error
        return false
      }
      if (result.data.workspaceId !== target.workspaceId || result.data.projectPath !== target.projectPath) return false
      applyStatus(result.data); success(); actionNotice.value = notice
      const current = selection.value
      if (current && (path === '*' || current.path === path)) await select(current)
      return true
    } finally {
      if (ticket === epoch) { if (kind === 'paths') busyPath.value = null; else if (kind === 'commit') committing.value = false; else remoteBusy.value = null }
    }
  }
  function change(paths: readonly string[], kind: 'stage' | 'unstage' | 'discard'): Promise<void> {
    const rawTarget = status.value
    if (!paths.length || !rawTarget) return Promise.resolve()
    const target = toTarget(rawTarget)
    const copied = [...paths]
    const run = kind === 'stage' ? () => stageGitPaths(target, copied) : kind === 'unstage' ? () => unstageGitPaths(target, copied) : () => discardGitPaths(target, copied)
    const label = kind === 'stage' ? '已暂存' : kind === 'unstage' ? '已取消暂存' : '已丢弃改动'
    return perform(target, copied.length === 1 ? copied[0] ?? '*' : '*', run, copied.length > 1 ? `${label} ${copied.length} 项` : label).then(() => undefined)
  }
  function stage(entry: { readonly path: string }): Promise<void> { return change([entry.path], 'stage') }
  function unstage(entry: { readonly path: string }): Promise<void> { return change([entry.path], 'unstage') }
  function discard(entry: { readonly path: string }): Promise<void> { return change([entry.path], 'discard') }
  function stagePaths(paths: readonly string[]): Promise<void> { return change(paths, 'stage') }
  function unstagePaths(paths: readonly string[]): Promise<void> { return change(paths, 'unstage') }
  function discardPaths(paths: readonly string[]): Promise<void> { return change(paths, 'discard') }
  function stageAll(): Promise<void> { return stagePaths(entries.value.filter(entry => entry.area !== 'staged').map(entry => entry.path)) }
  function unstageAll(): Promise<void> { return unstagePaths(entries.value.filter(entry => entry.area === 'staged').map(entry => entry.path)) }
  async function commit(): Promise<boolean> {
    const rawTarget = status.value, message = commitMessage.value
    if (!rawTarget) return false
    const target = toTarget(rawTarget)
    if (!message.trim()) { actionError.value = { code: 'INVALID_REQUEST', message: '提交信息不能为空。' }; return false }
    return perform(target, '*', () => commitGitStaged(target, message), '已提交', 'commit', () => {
      if (drafts.value[target.workspaceId] === message) drafts.value = { ...drafts.value, [target.workspaceId]: '' }
    })
  }
  function setCommitMessage(value: string): void { commitMessage.value = value }
  function runRemote(kind: 'pull' | 'push', target: WorkspaceTarget | null = status.value ? toTarget(status.value) : null): Promise<boolean> {
    const cleaned = target ? toTarget(target) : null
    return cleaned ? perform(cleaned, '*', () => kind === 'pull' ? pullGit(cleaned) : pushGit(cleaned), kind === 'pull' ? '已拉取' : '已推送', kind) : Promise.resolve(false)
  }
  function pull(): Promise<boolean> { return runRemote('pull') }
  function push(): Promise<boolean> { return runRemote('push') }
  async function commitAndPush(): Promise<boolean> {
    const rawTarget = status.value
    if (!rawTarget || !isCurrent(rawTarget)) return false
    const target = toTarget(rawTarget)
    if (!await commit()) {
      if (isCurrent(target) && awaitingTrust.value) pendingTrustRetry = async () => { if (isCurrent(target)) await commitAndPush() }
      return false
    }
    if (!isCurrent(target)) return false
    if (!await runRemote('push', target)) {
      if (isCurrent(target)) actionError.value = { code: 'GIT_FAILED', message: `已提交，但推送失败：${actionError.value?.message ?? '操作未完成'}` }
      return false
    }
    if (isCurrent(target)) actionNotice.value = '已提交并推送'
    return true
  }
  async function retryPendingAfterTrust(): Promise<void> {
    const retry = pendingTrustRetry; cancelPendingTrust()
    if (!retry) return
    trustingRetry = true
    try { await retry() } finally { trustingRetry = false }
  }
  function cancelPendingTrust(): void { pendingTrustRetry = null; awaitingTrust.value = false }
  function clearAutoRefreshTimer(): void { if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null } }
  function autoRefresh(): void {
    const elapsed = Date.now() - lastAutoRefreshAt
    if (elapsed >= MIN_AUTO_REFRESH_MS) { clearAutoRefreshTimer(); lastAutoRefreshAt = Date.now(); void refresh(true) }
    else if (!autoRefreshTimer) autoRefreshTimer = setTimeout(() => { autoRefreshTimer = null; lastAutoRefreshAt = Date.now(); void refresh(true) }, MIN_AUTO_REFRESH_MS - elapsed)
  }
  function reset(): void {
    epoch += 1; statusSeq += 1; clearAutoRefreshTimer(); cancelPendingTrust(); clearSelection()
    status.value = null; phase.value = 'idle'; error.value = null; actionError.value = null; actionNotice.value = null
    busyPath.value = null; committing.value = false; remoteBusy.value = null
  }
  function initialize(): void {
    if (attached) return
    attached = true
    const stop = watch(() => [projects.currentProject?.path ?? null, context.value?.id ?? null, context.value?.phase ?? null], () => { reset(); void refresh() }, { immediate: true, flush: 'sync' })
    const onFocus = (): void => autoRefresh()
    const onVisibility = (): void => { if (document.visibilityState === 'visible') autoRefresh() }
    window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onVisibility)
    const stopDirectory = onProjectDirectoryChanged(change => { if (isCurrent(change)) autoRefresh() })
    detach = () => { stop(); stopDirectory(); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisibility) }
  }
  function dispose(): void { if (!attached) return; attached = false; detach?.(); detach = null; reset() }
  return { context, status, phase, error, busyPath, actionError, actionNotice, drafts, commitMessage, committing, remoteBusy, awaitingTrust,
    selection, diff, diffPhase, diffError, isRepository, entries, hasChanges, stagedCount, groups, flatEntries, currentEntryIndex,
    hasNextEntry, hasPrevEntry, selectNext, selectPrevious, refresh, select, clearSelection, stage, unstage, discard, stagePaths, unstagePaths,
    discardPaths, stageAll, unstageAll, commit, pull, push, commitAndPush, retryPendingAfterTrust, cancelPendingTrust, setCommitMessage, initialize, dispose }
})
