/** 工作区与持久会话绑定的唯一存储所有者：按需读取、串行原子保存，损坏或外部改写时拒绝覆盖。 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { isWorkspaceContext } from '../../shared/workspace-api'
import type { WorkspaceContext } from '../../shared/workspace-api'

export interface WorkspaceBinding {
  readonly projectPath: string
  readonly sessionId: string
  readonly workspaceId: string
}
export interface WorkspaceCatalog {
  readonly version: 1
  readonly workspaces: readonly WorkspaceContext[]
  readonly bindings: readonly WorkspaceBinding[]
}
export class WorkspaceStorageError extends Error {}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
function decode(value: unknown): WorkspaceCatalog {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WorkspaceStorageError('工作区记录格式无效。')
  const data = value as Record<string, unknown>
  if (data.version !== 1 || !Array.isArray(data.workspaces) || !Array.isArray(data.bindings)
    || Object.keys(data).some(key => !['version', 'workspaces', 'bindings'].includes(key))) {
    throw new WorkspaceStorageError('工作区记录版本或字段无效。')
  }
  const workspaces: WorkspaceContext[] = []
  const ids = new Set<string>()
  const defaults = new Set<string>()
  for (const entry of data.workspaces) {
    if (!isWorkspaceContext(entry) || ids.has(entry.id) || !isAbsolute(entry.projectPath) || !isAbsolute(entry.rootPath)
      || (entry.repositoryPath !== null && !isAbsolute(entry.repositoryPath))
      || (entry.worktreePath !== null && !isAbsolute(entry.worktreePath))) throw new WorkspaceStorageError('工作区身份或目录记录无效。')
    if (entry.kind === 'project' && defaults.has(entry.projectPath)) throw new WorkspaceStorageError('项目存在重复默认工作区。')
    if (entry.kind === 'project') defaults.add(entry.projectPath)
    ids.add(entry.id)
    workspaces.push(entry)
  }
  const bindings: WorkspaceBinding[] = []
  const sessions = new Set<string>()
  for (const entry of data.bindings) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new WorkspaceStorageError('会话工作区绑定无效。')
    const binding = entry as Record<string, unknown>
    if (typeof binding.projectPath !== 'string' || typeof binding.sessionId !== 'string' || !binding.sessionId
      || typeof binding.workspaceId !== 'string' || Object.keys(binding).some(key => !['projectPath', 'sessionId', 'workspaceId'].includes(key))) {
      throw new WorkspaceStorageError('会话工作区绑定字段无效。')
    }
    const workspace = workspaces.find(item => item.id === binding.workspaceId)
    const key = JSON.stringify([binding.projectPath, binding.sessionId])
    if (!workspace || workspace.projectPath !== binding.projectPath || sessions.has(key)) throw new WorkspaceStorageError('会话工作区绑定归属不一致。')
    sessions.add(key)
    bindings.push({ projectPath: binding.projectPath, sessionId: binding.sessionId, workspaceId: binding.workspaceId })
  }
  return { version: 1, workspaces, bindings }
}

export class WorkspaceStore {
  private tail: Promise<unknown> = Promise.resolve()
  private catalog: WorkspaceCatalog | null = null
  private stamp: string | null = null
  constructor(private readonly filePath: () => string) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation)
    this.tail = task.catch(() => {})
    return task
  }
  private async diskStamp(path: string): Promise<string | null> {
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new WorkspaceStorageError('工作区记录不是有界的普通文件。')
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
    } catch (error) { if (missing(error)) return null; throw error }
  }
  private async load(): Promise<WorkspaceCatalog> {
    if (this.catalog !== null) {
      if (await this.diskStamp(this.filePath()) !== this.stamp) throw new WorkspaceStorageError('工作区记录已被外部改写，请重新打开应用；未采用旧绑定继续执行。')
      return this.catalog
    }
    const path = this.filePath()
    const before = await this.diskStamp(path)
    if (before === null) {
      this.catalog = { version: 1, workspaces: [], bindings: [] }
      this.stamp = null
      return this.catalog
    }
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(path, 'utf8')) }
    catch { throw new WorkspaceStorageError('工作区记录无法读取或解析；已保留原文件。') }
    if (await this.diskStamp(path) !== before) throw new WorkspaceStorageError('读取期间工作区记录发生变化，请重新打开应用。')
    this.catalog = decode(parsed)
    this.stamp = before
    return this.catalog
  }
  read(): Promise<WorkspaceCatalog> {
    return this.enqueue(async () => structuredClone(await this.load()))
  }
  update(change: (catalog: WorkspaceCatalog) => WorkspaceCatalog): Promise<WorkspaceCatalog> {
    return this.enqueue(async () => {
      const current = await this.load()
      const next = decode(change(structuredClone(current)))
      if (JSON.stringify(current) === JSON.stringify(next)) return structuredClone(current)
      const text = `${JSON.stringify(next, null, 2)}\n`
      if (Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) throw new WorkspaceStorageError('工作区记录超过存储上限；未覆盖现有记录。')
      const path = this.filePath()
      if (await this.diskStamp(path) !== this.stamp) throw new WorkspaceStorageError('工作区记录已被外部改写，未覆盖；请重新打开应用。')
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        if (await this.diskStamp(path) !== this.stamp) throw new WorkspaceStorageError('保存期间工作区记录发生变化，未覆盖。')
        await rename(temporary, path)
        this.stamp = await this.diskStamp(path)
        this.catalog = next
      } finally { await rm(temporary, { force: true }).catch(() => {}) }
      return structuredClone(next)
    })
  }
}
