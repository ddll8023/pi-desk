/**
 * 右侧面板文件树的展示状态：按「项目 + 目录」缓存的一层目录、展开集合、选中行与过滤结果。
 *
 * 目录列举由主进程按当前项目完成，这里只保存结果：缓存键含项目路径，因此切换项目不会命中上一个
 * 项目的同层目录，迟到的成功响应也按响应自带的项目根复核后再写入（失败响应没有项目根，只在仍是
 * 同一项目时写入）。展开集合只在内存里，不持久化：目录数量会随项目增长，没有对应的配置边界。
 * 树的可见行由 `rows` 展平输出，加载中、空目录、读取失败与截断都作为同级提示行插入，界面只需渲染一列。
 * 过滤输入非空时改由主进程的文件检索给出候选，此时不读目录、也不改变展开集合。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { DesktopError } from '../../../shared/desktop-api'
import { PROJECT_DIRECTORY_ENTRY_LIMIT } from '../../../shared/project-file-api'
import type { ProjectDirectoryEntry, ProjectDirectoryEntryKind } from '../../../shared/project-file-api'
import { listProjectDirectory, searchProjectFiles } from '../services/project-file'
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

export const useProjectDirectoryStore = defineStore('project-directory', () => {
  /** 按缓存键保存的一层目录结果；键里的项目路径保证切换项目后不会串用。 */
  const views = ref<Readonly<Record<string, DirectoryView>>>({})
  /** 按项目保存的展开目录集合；只在内存里，不写配置。 */
  const expanded = ref<Readonly<Record<string, readonly string[]>>>({})
  /** 当前选中的条目路径；只用于高亮，本期不打开文件。 */
  const selectedPath = ref<string | null>(null)
  /** 过滤输入；空串表示展示目录树。 */
  const filter = ref('')
  const searchView = ref<FileSearchView>({ phase: 'idle' })
  /** 自增序号：连续输入时只让最后一次检索的结果落地。 */
  let searchSequence = 0

  function setView(key: string, view: DirectoryView): void {
    views.value = { ...views.value, [key]: view }
  }

  function directoryView(projectPath: string, directory: string): DirectoryView {
    return views.value[cacheKey(projectPath, directory)] ?? IDLE_VIEW
  }

  function isExpanded(projectPath: string, directory: string): boolean {
    return (expanded.value[projectPath] ?? []).includes(directory)
  }

  /**
   * 读取一层目录；已读过或正在读取的层直接跳过，同一层不会并发重复读取。
   * 成功响应按自带的项目根复核：期间前台已切到别的项目时丢弃，不写进本项目的缓存。
   */
  async function ensureLoaded(projectPath: string, directory: string): Promise<void> {
    const key = cacheKey(projectPath, directory)
    const current = views.value[key]
    if (current !== undefined && current.phase !== 'idle' && current.phase !== 'error') return

    setView(key, { phase: 'loading' })
    const result = await listProjectDirectory(directory)
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

  /** 展开或折叠一层目录；展开时顺带读取该层。 */
  function toggleDirectory(projectPath: string, directory: string): void {
    const current = expanded.value[projectPath] ?? []
    const next = current.includes(directory)
      ? current.filter((entry) => entry !== directory)
      : [...current, directory]
    expanded.value = { ...expanded.value, [projectPath]: next }
    if (next.includes(directory)) void ensureLoaded(projectPath, directory)
  }

  /** 选中一行；本期只做高亮，不打开文件。 */
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
   * 只丢缓存不改变展开集合，因此刷新后可见结构保持不变。
   */
  async function refresh(): Promise<void> {
    const projectPath = useProjectStore().currentProject?.path ?? null
    if (projectPath === null) return

    const keep = Object.fromEntries(
      Object.entries(views.value).filter(([key]) => !key.startsWith(`${projectPath}\u0000`))
    )
    views.value = keep

    const directories = ['', ...(expanded.value[projectPath] ?? [])]
    await Promise.all(directories.map((directory) => ensureLoaded(projectPath, directory)))
  }

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
    refresh
  }
})

function notice(key: string, depth: number, text: string, tone: 'muted' | 'error'): FileTreeRow {
  return { type: 'notice', key, depth, text, tone }
}
