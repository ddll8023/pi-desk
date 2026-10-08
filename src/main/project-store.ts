/**
 * 本地项目配置的唯一读写者：最近项目列表与当前项目的加载、保存与降级处理。
 *
 * 配置位于 Electron userData 目录下的 desktop-config.json。写入采用同目录临时文件加改名替换，
 * 所有读写串行执行；结构损坏先备份再重新开始，暂时读不到时进入只读降级，避免用空配置覆盖
 * 仍然存在的记录。路径归一化在 project-path.ts，切换编排在 project-manager.ts。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { app } from 'electron'
import { isProject } from '../shared/project-api'
import type { Project, ProjectList } from '../shared/project-api'
import { projectNameFromPath } from './project-path'

const CONFIG_BASE_NAME = 'desktop-config'
const CONFIG_FILE_NAME = `${CONFIG_BASE_NAME}.json`
/** 配置结构版本；字段含义变化必须显式升级，不静默改写既有文件。 */
const CONFIG_VERSION = 1
/** 最近项目上限；超出按 `lastOpenedAt` 最旧淘汰，避免配置文件无界增长。 */
const MAX_PROJECTS = 50

interface StoredConfig {
  readonly version: number
  readonly projects: readonly Project[]
  readonly currentProjectId: string | null
}

/** 配置写入失败；由调用方映射为 `PROJECT_STORAGE_FAILED`。 */
export class ProjectStorageError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** 按 key 去重，保留 `lastOpenedAt` 更新的那条。 */
function dedupeByRecency(projects: readonly Project[], keyOf: (project: Project) => string): Project[] {
  const kept = new Map<string, Project>()
  for (const project of projects) {
    const key = keyOf(project)
    const previous = kept.get(key)
    if (previous === undefined || project.lastOpenedAt > previous.lastOpenedAt) {
      kept.set(key, project)
    }
  }
  return [...kept.values()]
}

/** 最近打开在前；同一时间戳按路径排序，保证列表顺序稳定；超出上限丢弃最旧的。 */
function sortByRecency(projects: readonly Project[]): Project[] {
  return [...projects]
    .sort((left, right) => {
      if (left.lastOpenedAt !== right.lastOpenedAt) return right.lastOpenedAt - left.lastOpenedAt
      if (left.path === right.path) return 0
      return left.path < right.path ? -1 : 1
    })
    .slice(0, MAX_PROJECTS)
}

export class ProjectStore {
  /** 读写串行队列：并发的选择动作不会互相覆盖内存状态或文件内容。 */
  private queue: Promise<unknown> = Promise.resolve()
  private loaded = false
  private readOnly = false
  private notice: string | null = null
  private projects: Project[] = []
  private currentProjectId: string | null = null

  /** 读取列表与当前项目；首次调用从磁盘加载，之后返回内存状态。 */
  list(): Promise<ProjectList> {
    return this.enqueue(async () => {
      await this.loadFromDisk()
      return this.snapshot()
    })
  }

  /**
   * 把归一化后的目录设为当前项目并保存。
   * 只读降级时只更新本次运行的内存状态；保存失败保持内存状态不变。
   */
  selectProject(projectPath: string, name: string): Promise<ProjectList> {
    return this.enqueue(async () => {
      await this.loadFromDisk()

      const existing = this.projects.find((project) => project.path === projectPath)
      const record: Project = {
        id: existing?.id ?? randomUUID(),
        name,
        path: projectPath,
        lastOpenedAt: Date.now()
      }
      const projects = sortByRecency([
        record,
        ...this.projects.filter((project) => project.path !== projectPath)
      ])
      if (!this.readOnly) await this.persist(projects, record.id)

      this.projects = projects
      this.currentProjectId = record.id
      return this.snapshot()
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    // 前一次失败不能阻断后续操作；错误由各自调用方处理。
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private snapshot(): ProjectList {
    return {
      projects: [...this.projects],
      currentProjectId: this.currentProjectId,
      storageNotice: this.notice
    }
  }

  /** 首次加载后缓存；不存在的文件按空配置处理，且不创建文件。 */
  private async loadFromDisk(): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    const file = this.filePath()
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return
      // 权限、占用或 IO 故障：保留原文件，本次运行不写任何配置。
      this.readOnly = true
      this.notice = '本地项目配置暂时无法读取，本次运行不会保存项目选择。'
      return
    }

    const parsed = this.parseConfig(text)
    if (parsed === null) {
      const backup = await this.quarantine(file)
      if (backup === null) {
        this.readOnly = true
        this.notice = '本地项目配置无法解析且备份失败，本次运行不会保存项目选择。'
        return
      }
      this.notice = `本地项目配置无法解析，已备份为 ${backup} 并重新开始。`
      return
    }
    if (parsed.version !== CONFIG_VERSION) {
      // 未来版本的文件不改写、不覆盖，只读使用其中可识别的记录。
      this.readOnly = true
      this.projects = [...parsed.projects]
      this.currentProjectId = parsed.currentProjectId
      this.notice = `本地项目配置版本 ${parsed.version} 不受支持，本次运行不会保存项目选择。`
      return
    }
    this.projects = [...parsed.projects]
    this.currentProjectId = parsed.currentProjectId
  }

  /** 解析并逐条过滤；只有顶层结构无法识别时返回 null（按损坏处理）。 */
  private parseConfig(text: string): StoredConfig | null {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return null
    }
    if (!isRecord(value)) return null
    if (typeof value.version !== 'number' || !Number.isInteger(value.version)) return null

    const projects = this.sanitizeProjects(value.projects)
    const storedId = typeof value.currentProjectId === 'string' ? value.currentProjectId : null
    const currentProjectId = projects.some((project) => project.id === storedId) ? storedId : null
    return { version: value.version, projects, currentProjectId }
  }

  /** 只接受同时满足共享契约与"绝对路径"的记录；重复路径或重复 id 只保留最近打开的一条。 */
  private sanitizeProjects(value: unknown): Project[] {
    if (!Array.isArray(value)) return []

    const accepted: Project[] = []
    for (const entry of value) {
      if (!isProject(entry) || !isAbsolute(entry.path)) continue
      accepted.push({
        id: entry.id,
        name: entry.name === '' ? projectNameFromPath(entry.path) : entry.name,
        path: entry.path,
        lastOpenedAt: entry.lastOpenedAt
      })
    }
    return sortByRecency(
      dedupeByRecency(dedupeByRecency(accepted, (project) => project.path), (project) => project.id)
    )
  }

  /** 备份无法解析的配置；返回备份文件名，失败返回 null。 */
  private async quarantine(file: string): Promise<string | null> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(dirname(file), `${CONFIG_BASE_NAME}.corrupt-${stamp}.json`)
    try {
      await rename(file, target)
    } catch {
      return null
    }
    return basename(target)
  }

  /** 同目录临时文件加改名替换，中断时不会留下半份配置。 */
  private async persist(projects: readonly Project[], currentProjectId: string | null): Promise<void> {
    const file = this.filePath()
    const temporary = `${file}.${process.pid}-${Date.now()}.tmp`
    const payload: StoredConfig = { version: CONFIG_VERSION, projects, currentProjectId }
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new ProjectStorageError(
        error instanceof Error
          ? `无法保存本地项目配置：${error.message}`
          : '无法保存本地项目配置。'
      )
    }
  }

  private filePath(): string {
    return join(app.getPath('userData'), CONFIG_FILE_NAME)
  }
}
