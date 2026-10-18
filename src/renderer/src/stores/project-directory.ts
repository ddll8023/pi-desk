/**
 * 右侧面板文件树的展示状态：按「项目 + 目录」缓存的一层目录、展开集合、选中行与过滤结果。
 *
 * 目录列举由主进程按当前项目完成，这里只保存结果：缓存键含项目路径，因此切换项目不会命中上一个
 * 项目的同层目录，迟到的成功响应也按响应自带的项目根复核后再写入（失败响应没有项目根，只在仍是
 * 同一项目时写入）。展开集合只在内存里，不持久化：目录数量会随项目增长，没有对应的配置边界。
 * 树的可见行由 `rows` 展平输出，加载中、空目录、读取失败与截断都作为同级提示行插入，界面只需渲染一列。
 * 过滤输入非空时改由主进程的文件检索给出候选，此时不读目录、也不改变展开集合。
 *
 * 自动刷新靠主进程的目录监听：这里把「根 + 已展开的层」登记给主进程，变化回来时只重读命中的层，
 * 展开集合与选中行保持不变；变化过多或监听不可用（overflow）时退回整树重读。每层带一个读取代号，
 * 失效时自增，迟到的旧响应按代号丢弃，不会盖住刚读到的结果。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { DesktopError } from '../../../shared/desktop-api'
import { PROJECT_DIRECTORY_ENTRY_LIMIT } from '../../../shared/project-file-api'
import type {
  ProjectDirectoryChange,
  ProjectDirectoryEntry,
  ProjectDirectoryEntryKind
} from '../../../shared/project-file-api'
import {
  listProjectDirectory,
  onProjectDirectoryChanged,
  searchProjectFiles,
  watchProjectDirectories
} from '../services/project-file'
import { useProjectEditorStore } from './project-editor'
import { useProjectStore } from './project'

/** 一层目录的读取状态；失败只影响该层，其他层继续可用。 */
type DirectoryView =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly entries: readonly ProjectDirectoryEntry[]; readonly truncated: boolean }
  | { readonly phase: 'error'; readonly error: DesktopError }

/** 过滤结果的读取状态；空查询不发起检索，停留在 idle。 */
export type FileSearchView =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly entries: readonly string[] }
  | { readonly phase: 'error'; readonly error: DesktopError }

/** 树里的一行：条目行或插在目录下的提示行（加载中、空目录、读取失败、截断）。 */
export type FileTreeRow =
  | {
    readonly type: 'entry'
    readonly key: string
    readonly path: string
    readonly name: string
    readonly depth: number
    readonly kind: ProjectDirectoryEntryKind
    readonly symlink: boolean
    readonly expanded: boolean
  }
  | {
    readonly type: 'notice'
    readonly key: string
    readonly depth: number
    readonly text: string
    readonly tone: 'muted' | 'error'
  }

const IDLE_VIEW: DirectoryView = { phase: 'idle' }

/** 缓存键：项目路径与目录相对路径的组合，避免跨项目命中同层目录。 */
function cacheKey(projectPath: string, directory: string): string {
  return `${projectPath}\u0000${directory}`
}

/** 条目的父目录相对路径；根层条目回空串。 */
function parentDirectoryOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

export const useProjectDirectoryStore = defineStore('project-directory', () => {
  /** 按缓存键保存的一层目录结果；键里的项目路径保证切换项目后不会串用。 */
  const views = ref<Readonly<Record<string, DirectoryView>>>({})
  /** 按项目保存的展开目录集合；只在内存里，不写配置。 */
  const expanded = ref<Readonly<Record<string, readonly string[]>>>({})
  /** 当前选中的条目路径；只用于高亮，打开文件由文件树组件交给工作区标签处理。 */
  const selectedPath = ref<string | null>(null)
  /** 过滤输入；空串表示展示目录树。 */
  const filter = ref('')
  const searchView = ref<FileSearchView>({ phase: 'idle' })
  /** 自增序号：连续输入时只让最后一次检索的结果落地。 */
  let searchSequence = 0
  /** 每层的读取代号：失效或重读时自增，迟到的旧响应按代号丢弃。 */
  const generations = new Map<string, number>()
  /** 目录监听的取消函数与挂载标记；只在面板存在期间订阅，反复开合不累积监听。 */
  let detachWatch: (() => void) | null = null
  let attached = false

  function setView(key: string, view: DirectoryView): void {
    views.value = { ...views.value, [key]: view }
  }

  /** 丢弃一层的缓存；同时自增代号，让在途的旧读取结果作废。 */
  function dropView(key: string): void {
    generations.set(key, (generations.get(key) ?? 0) + 1)
    if (views.value[key] === undefined) return
    const next = { ...views.value }
    delete next[key]
    views.value = next
  }

  function directoryView(projectPath: string, directory: string): DirectoryView {
    return views.value[cacheKey(projectPath, directory)] ?? IDLE_VIEW
  }

  function isExpanded(projectPath: string, directory: string): boolean {
    return (expanded.value[projectPath] ?? []).includes(directory)
  }

  /**
   * 读取一层并写回结果。每次读取自增该层代号，迟到的旧响应按代号丢弃。
   * `keepEntries` 为真时（自动刷新）不切到加载态，已有条目继续显示，避免外部写入把整层刷成「正在读取」。
   */
  async function loadLayer(projectPath: string, directory: string, keepEntries: boolean): Promise<void> {
    const key = cacheKey(projectPath, directory)
    const generation = (generations.get(key) ?? 0) + 1
    generations.set(key, generation)
    if (!keepEntries) setView(key, { phase: 'loading' })
    const result = await listProjectDirectory(directory)
    // 期间该层被判定失效或重新登记：这份结果已经过期，直接丢弃。
    if ((generations.get(key) ?? 0) !== generation) return
    if (!result.ok) {
      // 失败响应不带项目根：只在仍处于同一项目时写入，避免把别的项目的失败原因挂到本项目上。
      if (useProjectStore().currentProject?.path === projectPath) {
        setView(key, { phase: 'error', error: result.error })
      } else {
        setView(key, IDLE_VIEW)
      }
      return
    }
    if (result.data.projectPath !== projectPath) {
      setView(key, IDLE_VIEW)
      return
    }
    setView(key, { phase: 'ready', entries: result.data.entries, truncated: result.data.truncated })
  }

  /**
   * 读取一层目录；已读过或正在读取的层直接跳过，同一层不会并发重复读取。
   * 成功响应按自带的项目根复核：期间前台已切到别的项目时丢弃，不写进本项目的缓存。
   */
  async function ensureLoaded(projectPath: string, directory: string): Promise<void> {
    const current = views.value[cacheKey(projectPath, directory)]
    if (current !== undefined && current.phase !== 'idle' && current.phase !== 'error') return
    await loadLayer(projectPath, directory, false)
  }

  /** 展开或折叠一层目录；展开时顺带读取该层，并把新的监听集合交给主进程。 */
  function toggleDirectory(projectPath: string, directory: string): void {
    const current = expanded.value[projectPath] ?? []
    const next = current.includes(directory)
      ? current.filter((entry) => entry !== directory)
      : [...current, directory]
    expanded.value = { ...expanded.value, [projectPath]: next }
    if (next.includes(directory)) void ensureLoaded(projectPath, directory)
    syncWatch()
  }

  /** 选中一行；只做高亮，打开文件由调用方另行处理。 */
  function select(path: string | null): void {
    selectedPath.value = path
  }

  /** 清空过滤并回到目录树；切换项目时调用，避免上一个项目的查询串作用到新项目。 */
  function clearFilter(): void {
    filter.value = ''
    searchView.value = { phase: 'idle' }
    // 自增序号让在途检索的结果失效，不再写回。
    searchSequence += 1
  }

  /** 按查询串检索文件路径；空查询直接回到目录树，不发起检索。 */
  async function search(query: string): Promise<void> {
    filter.value = query
    const needle = query.trim()
    if (needle === '') {
      clearFilter()
      return
    }

    const ticket = ++searchSequence
    searchView.value = { phase: 'loading' }
    const result = await searchProjectFiles(needle)
    if (ticket !== searchSequence) return

    if (!result.ok) {
      searchView.value = { phase: 'error', error: result.error }
      return
    }
    if (result.data.projectPath !== (useProjectStore().currentProject?.path ?? null)) {
      searchView.value = { phase: 'idle' }
      return
    }
    searchView.value = { phase: 'ready', entries: result.data.entries }
  }

  /**
   * 刷新当前项目的目录：丢弃已缓存的结果后重新读取根层与当前展开的层。
   * 只丢缓存不改变展开集合，因此刷新后可见结构保持不变；已删除的层在重读后被剪掉。
   */
  async function refresh(): Promise<void> {
    const projectPath = useProjectStore().currentProject?.path ?? null
    if (projectPath === null) return

    for (const key of Object.keys(views.value)) {
      if (key.startsWith(`${projectPath}\u0000`)) dropView(key)
    }
    const directories = ['', ...(expanded.value[projectPath] ?? [])]
    await Promise.all(directories.map((directory) => ensureLoaded(projectPath, directory)))
    pruneStale(projectPath)
    syncWatch()
  }

  /** 需要监听的层：根目录加已展开的目录；去重后交给主进程，主进程只监听这些层且不递归。 */
  function watchedDirectories(projectPath: string): string[] {
    return [...new Set(['', ...(expanded.value[projectPath] ?? [])])]
  }

  /** 把当前项目的监听集合同步给主进程；未选择项目时提交空集合，等于停掉全部监听。 */
  function syncWatch(): void {
    const projectPath = useProjectStore().currentProject?.path ?? null
    void watchProjectDirectories(projectPath === null ? [] : watchedDirectories(projectPath))
  }

  /** 重读一层（自动刷新）：保留已有条目，结果回来再整体替换，不闪加载态。 */
  function reloadDirectory(projectPath: string, directory: string): Promise<void> {
    return loadLayer(projectPath, directory, true)
  }

  /**
   * 剪掉已经不存在的展开目录与选中行：父层重读后旧条目会消失，展开集合与高亮要跟着收敛。
   * 只在该条目的父层已经读过时判断，避免把「父层没加载」误当成「条目已删除」。
   */
  function pruneStale(projectPath: string): void {
    const missing = (path: string): boolean => {
      const view = views.value[cacheKey(projectPath, parentDirectoryOf(path))]
      if (view === undefined || view.phase !== 'ready') return false
      return !view.entries.some((entry) => entry.path === path)
    }

    const current = expanded.value[projectPath] ?? []
    const kept = current.filter((directory) => !missing(directory))
    if (kept.length !== current.length) expanded.value = { ...expanded.value, [projectPath]: kept }

    const selected = selectedPath.value
    if (selected !== null && missing(selected)) selectedPath.value = null
  }

  /**
   * 静默重读根层与已展开的层：保留已有条目，用于面板重新挂载后补齐离开期间的变化。
   * 未选择项目时什么也不做；结果回来后照样收敛失效的展开目录与选中行。
   */
  async function reloadLoadedDirectories(): Promise<void> {
    const projectPath = useProjectStore().currentProject?.path ?? null
    if (projectPath === null) return
    const directories = ['', ...(expanded.value[projectPath] ?? [])]
    await Promise.all(directories.map((directory) => reloadDirectory(projectPath, directory)))
    pruneStale(projectPath)
    syncWatch()
  }

  /**
   * 处理一批目录变化：只重读命中的已加载层，保持展开集合与选中行；overflow 时整树重读。
   * 已打开的文件标签按同一批目录重新比对磁盘基线，外部改动不必等窗口重新聚焦；
   * overflow 拿不到具体目录，改成让全部已打开文件各比一次。
   */
  async function applyChange(change: ProjectDirectoryChange): Promise<void> {
    const projectPath = useProjectStore().currentProject?.path ?? null
    if (projectPath === null || change.projectPath !== projectPath) return

    if (change.kind === 'overflow') {
      await refresh()
      useProjectEditorStore().checkAllExternal(projectPath)
      return
    }

    const affected = change.directories.filter((directory) => (
      views.value[cacheKey(projectPath, directory)] !== undefined
    ))
    if (affected.length === 0) return
    await Promise.all(affected.map((directory) => reloadDirectory(projectPath, directory)))
    pruneStale(projectPath)
    syncWatch()
    useProjectEditorStore().checkChangedDirectories(projectPath, affected)
  }

  /**
   * 面板挂载时开始自动刷新：订阅主进程的目录变化，登记监听集合，并静默重读一次。
   * 重读是必需的：面板卸载期间监听已停，离开这段时间里的变化只能靠这一读补上。
   */
  function initialize(): void {
    if (attached) return
    attached = true
    detachWatch = onProjectDirectoryChanged((change) => {
      void applyChange(change)
    })
    syncWatch()
    void reloadLoadedDirectories()
  }

  /** 面板卸载时停掉订阅与监听；重新挂载会重新登记当前集合。 */
  function dispose(): void {
    if (!attached) return
    attached = false
    detachWatch?.()
    detachWatch = null
    void watchProjectDirectories([])
  }

  // 切换项目时集合整体换掉：主进程按新根重建监听，旧根的事件不再属于当前项目。
  watch(
    () => useProjectStore().currentProject?.path ?? null,
    () => syncWatch()
  )

  /** 当前项目的树行；未选择项目或根层尚未读到时为空数组。 */
  const rows = computed<readonly FileTreeRow[]>(() => {
    const projectPath = useProjectStore().currentProject?.path ?? null
    if (projectPath === null) return []

    const collected: FileTreeRow[] = []
    collect(projectPath, '', 0, collected)
    return collected
  })

  /** 递归展平一层目录；提示行与条目行同处一列，界面不需要处理嵌套结构。 */
  function collect(
    projectPath: string,
    directory: string,
    depth: number,
    collected: FileTreeRow[]
  ): void {
    const view = directoryView(projectPath, directory)
    const key = cacheKey(projectPath, directory)

    if (view.phase === 'idle' || view.phase === 'loading') {
      collected.push(notice(`${key}\u0000loading`, depth, '正在读取…', 'muted'))
      return
    }
    if (view.phase === 'error') {
      collected.push(notice(`${key}\u0000error`, depth, view.error.message, 'error'))
      return
    }
    if (view.entries.length === 0) {
      collected.push(notice(`${key}\u0000empty`, depth, depth === 0 ? '项目目录为空' : '此文件夹为空', 'muted'))
      return
    }

    for (const entry of view.entries) {
      const expandedHere = entry.kind === 'directory' && isExpanded(projectPath, entry.path)
      collected.push({
        type: 'entry',
        key: cacheKey(projectPath, entry.path),
        path: entry.path,
        name: entry.name,
        depth,
        kind: entry.kind,
        symlink: entry.symlink,
        expanded: expandedHere
      })
      if (expandedHere) collect(projectPath, entry.path, depth + 1, collected)
    }
    if (view.truncated) {
      collected.push(notice(`${key}\u0000truncated`, depth, `仅显示前 ${PROJECT_DIRECTORY_ENTRY_LIMIT} 项`, 'muted'))
    }
  }

  return {
    rows,
    filter,
    searchView,
    selectedPath,
    directoryView,
    isExpanded,
    ensureLoaded,
    toggleDirectory,
    select,
    clearFilter,
    search,
    refresh,
    initialize,
    dispose
  }
})

function notice(key: string, depth: number, text: string, tone: 'muted' | 'error'): FileTreeRow {
  return { type: 'notice', key, depth, text, tone }
}
