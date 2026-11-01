/** 文件树状态按工作区和相对目录缓存；监听、搜索和条目身份固定来源，切标签不重解释旧路径。 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { DesktopError } from '../../../../shared/desktop-api'
import { PROJECT_DIRECTORY_ENTRY_LIMIT } from '../../../../shared/project-file-api'
import type { ProjectDirectoryChange, ProjectDirectoryEntry, ProjectDirectoryEntryKind } from '../../../../shared/project-file-api'
import { workspaceTarget } from '../../../../shared/workspace-api'
import type { WorkspaceTarget } from '../../../../shared/workspace-api'
import { listProjectDirectory, onProjectDirectoryChanged, searchProjectFiles, watchProjectDirectories } from '../services/project-file'
import { useProjectEditorStore } from './project-editor'
import { useProjectStore } from '../../projects/stores/project'
import { useTaskWorkspacesStore } from '../../workspace/stores/task-workspaces'
import { usePreferencesStore } from '../../preferences/stores/preferences'
import { isFileExcluded } from '../file-exclude'

type DirectoryView = { readonly phase: 'idle' } | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly entries: readonly ProjectDirectoryEntry[]; readonly truncated: boolean }
  | { readonly phase: 'error'; readonly error: DesktopError }
export type FileSearchView = { readonly phase: 'idle' } | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly entries: readonly string[]; readonly target: WorkspaceTarget }
  | { readonly phase: 'error'; readonly error: DesktopError }
export type FileTreeRow = (WorkspaceTarget & {
  readonly type: 'entry'; readonly key: string; readonly path: string; readonly name: string; readonly depth: number
  readonly kind: ProjectDirectoryEntryKind; readonly symlink: boolean; readonly expanded: boolean; readonly hidden: boolean
}) | { readonly type: 'notice'; readonly key: string; readonly depth: number; readonly text: string; readonly tone: 'muted' | 'error' }
const IDLE_VIEW: DirectoryView = { phase: 'idle' }
function cacheKey(id: string, directory: string): string { return `${id}\u0000${directory}` }
function parentDirectoryOf(path: string): string { const index = path.lastIndexOf('/'); return index < 0 ? '' : path.slice(0, index) }

export const useProjectDirectoryStore = defineStore('project-directory', () => {
  const projects = useProjectStore()
  const workspaces = useTaskWorkspacesStore()
  const context = computed(() => workspaces.selected(projects.currentProject?.path ?? null))
  const views = ref<Readonly<Record<string, DirectoryView>>>({})
  const expanded = ref<Readonly<Record<string, readonly string[]>>>({})
  const selected = ref<Readonly<Record<string, string | null>>>({})
  const selectedPath = computed(() => context.value ? selected.value[context.value.id] ?? null : null)
  const filter = ref('')
  const searchView = ref<FileSearchView>({ phase: 'idle' })
  const generations = new Map<string, number>()
  let searchSequence = 0
  let switchSequence = 0
  let attached = false
  let detachWatch: (() => void) | null = null
  let stopContextWatch: (() => void) | null = null

  function setView(key: string, view: DirectoryView): void { views.value = { ...views.value, [key]: view } }
  function dropView(key: string): void {
    generations.set(key, (generations.get(key) ?? 0) + 1)
    const next = { ...views.value }; delete next[key]; views.value = next
  }
  function directoryView(workspaceId: string, directory: string): DirectoryView { return views.value[cacheKey(workspaceId, directory)] ?? IDLE_VIEW }
  function isExpanded(workspaceId: string, directory: string): boolean { return (expanded.value[workspaceId] ?? []).includes(directory) }
  async function loadLayer(workspaceId: string, directory: string, keepEntries: boolean): Promise<void> {
    const key = cacheKey(workspaceId, directory)
    const generation = (generations.get(key) ?? 0) + 1
    generations.set(key, generation)
    if (!keepEntries) setView(key, { phase: 'loading' })
    const workspace = workspaces.of(workspaceId)
    if (!workspace) { setView(key, { phase: 'error', error: { code: 'INVALID_REQUEST', message: '文件树缺少来源工作区。' } }); return }
    const result = await listProjectDirectory(directory, workspaceTarget(workspace))
    if (generations.get(key) !== generation) return
    if (!result.ok) { setView(key, { phase: 'error', error: result.error }); return }
    if (result.data.workspaceId !== workspaceId || result.data.projectPath !== workspace.projectPath) {
      setView(key, { phase: 'error', error: { code: 'INVALID_RESPONSE', message: '目录响应不属于原工作区。' } }); return
    }
    setView(key, { phase: 'ready', entries: result.data.entries, truncated: result.data.truncated })
  }
  async function ensureLoaded(workspaceId: string, directory: string): Promise<void> {
    const current = views.value[cacheKey(workspaceId, directory)]
    if (current && current.phase !== 'idle' && current.phase !== 'error') return
    await loadLayer(workspaceId, directory, false)
  }
  function toggleDirectory(workspaceId: string, directory: string): void {
    const current = expanded.value[workspaceId] ?? []
    const next = current.includes(directory) ? current.filter(item => item !== directory) : [...current, directory]
    expanded.value = { ...expanded.value, [workspaceId]: next }
    if (next.includes(directory)) void ensureLoaded(workspaceId, directory)
    syncWatch()
  }
  function select(path: string | null): void {
    if (context.value) selected.value = { ...selected.value, [context.value.id]: path }
  }
  function clearFilter(): void { filter.value = ''; searchView.value = { phase: 'idle' }; searchSequence += 1 }
  async function search(query: string): Promise<void> {
    filter.value = query
    const needle = query.trim()
    if (!needle) { clearFilter(); return }
    const workspace = context.value
    if (!workspace) return
    const ticket = ++searchSequence
    searchView.value = { phase: 'loading' }
    const target = workspaceTarget(workspace)
    const result = await searchProjectFiles(needle, target)
    if (ticket !== searchSequence || context.value?.id !== workspace.id) return
    if (!result.ok) { searchView.value = { phase: 'error', error: result.error }; return }
    if (result.data.workspaceId !== workspace.id || result.data.projectPath !== workspace.projectPath) return
    searchView.value = { phase: 'ready', entries: result.data.entries, target }
  }
  function watchedDirectories(id: string): string[] { return [...new Set(['', ...(expanded.value[id] ?? [])])] }
  function syncWatch(): void {
    const workspace = attached ? context.value : null
    void watchProjectDirectories(workspace ? watchedDirectories(workspace.id) : [], workspace ? workspaceTarget(workspace) : null)
  }
  function pruneStale(id: string): void {
    const missing = (path: string): boolean => {
      const view = directoryView(id, parentDirectoryOf(path))
      return view.phase === 'ready' && !view.entries.some(entry => entry.path === path)
    }
    const current = expanded.value[id] ?? []
    expanded.value = { ...expanded.value, [id]: current.filter(path => !missing(path)) }
    const path = selected.value[id]
    if (path && missing(path)) selected.value = { ...selected.value, [id]: null }
  }
  async function refresh(): Promise<void> {
    const workspace = context.value
    if (!workspace) return
    for (const key of Object.keys(views.value)) if (key.startsWith(`${workspace.id}\u0000`)) dropView(key)
    await Promise.all(watchedDirectories(workspace.id).map(directory => ensureLoaded(workspace.id, directory)))
    pruneStale(workspace.id)
    if (context.value?.id === workspace.id) syncWatch()
  }
  function reloadDirectory(id: string, directory: string): Promise<void> { return loadLayer(id, directory, true) }
  async function reloadLoadedDirectories(): Promise<void> {
    const workspace = context.value
    if (!workspace) return
    await Promise.all(watchedDirectories(workspace.id).map(directory => reloadDirectory(workspace.id, directory)))
    pruneStale(workspace.id)
    if (context.value?.id === workspace.id) syncWatch()
  }
  async function applyChange(change: ProjectDirectoryChange): Promise<void> {
    if (context.value?.id !== change.workspaceId || context.value.projectPath !== change.projectPath) return
    if (change.kind === 'overflow') {
      await refresh()
      useProjectEditorStore().checkAllExternal(change.projectPath, change.workspaceId)
      return
    }
    const affected = change.directories.filter(directory => views.value[cacheKey(change.workspaceId, directory)] !== undefined)
    await Promise.all(affected.map(directory => reloadDirectory(change.workspaceId, directory)))
    pruneStale(change.workspaceId)
    if (context.value?.id === change.workspaceId) syncWatch()
    useProjectEditorStore().checkChangedDirectories(change.projectPath, affected, change.workspaceId)
  }
  async function activateContext(): Promise<void> {
    const ticket = ++switchSequence
    clearFilter()
    const projectPath = projects.currentProject?.path ?? null
    if (!projectPath || workspaces.pendingProjects.includes(projectPath)) { syncWatch(); return }
    try {
      const workspace = await workspaces.ensure(projectPath)
      if (!attached || ticket !== switchSequence || projects.currentProject?.path !== projectPath) return
      if (!workspaces.selected(projectPath)) { workspaces.select(workspace); return }
      syncWatch()
      await reloadLoadedDirectories()
    } catch (error) {
      if (ticket === switchSequence) workspaces.fail(error instanceof Error ? error.message : '解析文件树工作区失败。')
    }
  }
  function initialize(): void {
    if (attached) return
    attached = true
    detachWatch = onProjectDirectoryChanged(change => { void applyChange(change) })
    stopContextWatch = watch(() => [projects.currentProject?.path ?? null, context.value?.id ?? null, context.value?.phase ?? null],
      () => { void activateContext() }, { immediate: true, flush: 'sync' })
  }
  function dispose(): void {
    attached = false; switchSequence += 1; searchSequence += 1
    stopContextWatch?.(); stopContextWatch = null
    detachWatch?.(); detachWatch = null
    void watchProjectDirectories([], null)
  }
  const rows = computed<readonly FileTreeRow[]>(() => {
    const workspace = context.value
    if (!workspace) return []
    const result: FileTreeRow[] = []
    collect(workspaceTarget(workspace), '', 0, result)
    return result
  })
  function collect(target: WorkspaceTarget, directory: string, depth: number, output: FileTreeRow[]): void {
    const id = target.workspaceId, key = cacheKey(id, directory), view = directoryView(id, directory)
    if (view.phase === 'idle' || view.phase === 'loading') { output.push(notice(`${key}\u0000loading`, depth, '正在读取…', 'muted')); return }
    if (view.phase === 'error') { output.push(notice(`${key}\u0000error`, depth, view.error.message, 'error')); return }
    if (!view.entries.length) { output.push(notice(`${key}\u0000empty`, depth, depth === 0 ? '工作区目录为空' : '此文件夹为空', 'muted')); return }
    const preferences = usePreferencesStore()
    for (const entry of view.entries) {
      const hidden = isFileExcluded(entry.path, entry.name, entry.kind === 'directory', preferences.fileExcludePatterns)
      if (hidden && !preferences.showHiddenFiles) continue
      const expandedHere = entry.kind === 'directory' && isExpanded(id, entry.path)
      output.push({ ...target, type: 'entry', key: cacheKey(id, entry.path), path: entry.path, name: entry.name,
        depth, kind: entry.kind, symlink: entry.symlink, expanded: expandedHere, hidden })
      if (expandedHere) collect(target, entry.path, depth + 1, output)
    }
    if (view.truncated) output.push(notice(`${key}\u0000truncated`, depth, `仅显示前 ${PROJECT_DIRECTORY_ENTRY_LIMIT} 项`, 'muted'))
  }
  return { context, rows, filter, searchView, selectedPath, directoryView, isExpanded, ensureLoaded, toggleDirectory,
    select, clearFilter, search, refresh, reloadDirectory, initialize, dispose }
})
function notice(key: string, depth: number, text: string, tone: 'muted' | 'error'): FileTreeRow {
  return { type: 'notice', key, depth, text, tone }
}
