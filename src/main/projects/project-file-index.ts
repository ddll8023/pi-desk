/**
 * 项目文件索引：为输入框的 `@` 引用与 Markdown 文档链接提供候选路径。
 *
 * 索引与 Markdown 文档补全固定主进程已授权的工作区，只读取文件名与相对路径，不读取
 * 任何文件内容。优先用 git ls-files 遵守忽略规则，Git 不可用时退化为遍历并跳过常见构建及依赖目录。
 * 索引按工作区缓存，目录变化时定向失效，TTL 作为兜底；执行根不可读返回错误，不伪装成空候选或改用其他目录。
 */
import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { ProjectMarkdownDocumentsResult, ProjectFileSearchResult } from '../../shared/project-file-api'
import { workspaceTarget } from '../../shared/workspace-api'
import type { WorkspaceContext } from '../../shared/workspace-api'

/** 一次检索最多返回多少条候选。 */
const FILE_SEARCH_LIMIT = 50

/** 索引条数上限：没有 git 的目录靠遍历兜底，避免把整个项目扫到底。 */
const FILE_INDEX_MAX = 20000

/** 索引缓存时长：`@` 每敲一个字都会查一次，不能每次都真的去列目录。 */
const FILE_INDEX_TTL_MS = 10_000

/** git 列举超时；超时按不可用处理，改走遍历。 */
const GIT_LIST_TIMEOUT_MS = 5_000

/** 遍历兜底时直接跳过的目录名；有 git 时交给 .gitignore 决定。 */
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.idea',
  '.vscode'
])

/** 一份工作区索引快照；执行根不一致或缓存过期时重建，不因同项目的其他工作区读取而串用。 */
interface ProjectFileIndexCache {
  readonly root: string
  readonly at: number
  readonly files: readonly string[]
}

export class ProjectFileIndex {
  private readonly cache = new Map<string, ProjectFileIndexCache>()

  /** 在已授权工作区检索；读取失败与没有匹配分开表达。 */
  async search(context: WorkspaceContext, query: string): Promise<ProjectFileSearchResult> {
    try {
      const files = await this.filesOf(context)
      return { ok: true, data: { ...workspaceTarget(context), entries: rankFiles(files, query) } }
    } catch (error) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : '检索工作区文件失败。' } }
    }
  }

  /** 文档补全和 @ 候选共用明确工作区的索引。 */
  async markdownDocuments(context: WorkspaceContext): Promise<ProjectMarkdownDocumentsResult> {
    try {
      const files = await this.filesOf(context)
      return { ok: true, data: { ...workspaceTarget(context), entries: [...new Set(files.filter(path => /\.(md|markdown)$/i.test(path)))], truncated: files.length >= FILE_INDEX_MAX } }
    } catch (error) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  /**
   * 指定 workspaceId 时只丢弃该工作区的快照，不指定时清空全部索引。
   * 目录监听用此入口使候选失效；监听不可用时由缓存时长定义兜底。
   */
  invalidate(workspaceId?: string): void {
    if (workspaceId) this.cache.delete(workspaceId)
    else this.cache.clear()
  }

  /** 取索引；根路径变化或缓存过期时重建。 */
  private async filesOf(context: WorkspaceContext): Promise<readonly string[]> {
    const root = context.rootPath
    const cached = this.cache.get(context.id) ?? null
    if (cached !== null && cached.root === root && Date.now() - cached.at < FILE_INDEX_TTL_MS) {
      return cached.files
    }

    const files = (await gitFileList(root)) ?? (await walkFileList(root))
    if (this.cache.size >= 64 && !this.cache.has(context.id)) this.cache.clear()
    this.cache.set(context.id, { root, at: Date.now(), files })
    return files
  }
}

/** 试 `git ls-files`：顺带遵守 .gitignore；返回 null 表示不可用（非仓库、没装 git 或超时）。 */
function gitFileList(root: string): Promise<readonly string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '-co', '--exclude-standard', '-z'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: GIT_LIST_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve(null)
          return
        }
        const files = stdout.split('\0').filter((entry) => entry !== '')
        resolve(files.slice(0, FILE_INDEX_MAX))
      }
    )
  })
}

/** 遍历兜底：跳过忽略目录，达到条数上限立即停止；符号链接既非文件也非目录，天然跳过。 */
async function walkFileList(root: string): Promise<readonly string[]> {
  const files: string[] = []

  /** 按目录递归索引，遵守忽略表与总条数上限。 */
  const walk = async (directory: string): Promise<void> => {
    if (files.length >= FILE_INDEX_MAX) return

    let entries: readonly Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (directory === root) throw error
      // 子目录不可读不影响其余候选；执行根本身不可读则回传错误。
      return
    }

    for (const entry of entries) {
      if (files.length >= FILE_INDEX_MAX) return
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        await walk(join(directory, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      files.push(toRelativePath(root, join(directory, entry.name)))
    }
  }

  await walk(root)
  return files
}

/** 统一成 POSIX 风格的项目相对路径，让检索串写法与平台无关。 */
function toRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/')
}

/** 按查询串过滤并排序：路径前缀 > basename 前缀 > basename 含 > 路径含。 */
function rankFiles(files: readonly string[], query: string): readonly string[] {
  const needle = query.trim().toLowerCase().replace(/^\.\//, '')
  if (needle === '') {
    // 刚打出一个 `@`：先给顶层条目，再逐层往下。
    return [...files]
      .sort((left, right) => pathDepth(left) - pathDepth(right)
        || left.length - right.length
        || left.localeCompare(right))
      .slice(0, FILE_SEARCH_LIMIT)
  }

  const ranked: { readonly path: string; readonly rank: number }[] = []
  for (const path of files) {
    const lower = path.toLowerCase()
    const slash = lower.lastIndexOf('/')
    const base = slash >= 0 ? lower.slice(slash + 1) : lower
    const rank = lower.startsWith(needle) ? 0
      : base.startsWith(needle) ? 1
        : base.includes(needle) ? 2
          : lower.includes(needle) ? 3
            : -1
    if (rank < 0) continue
    ranked.push({ path, rank })
  }

  ranked.sort((left, right) => left.rank - right.rank
    || left.path.length - right.path.length
    || left.path.localeCompare(right.path))
  return ranked.slice(0, FILE_SEARCH_LIMIT).map((entry) => entry.path)
}

/** 路径层级，用于空查询时从浅到深给出候选。 */
function pathDepth(path: string): number {
  return path.split('/').length
}
