/**
 * 本地 Desktop 配置的唯一读写者：最近项目的添加/移除、当前项目、界面偏好、窗口状态、各项目信任决定（Project Trust）
 * 与安装级 UUID 的加载、保存与降级处理。
 *
 * 配置位于 Electron userData 目录下的 desktop-config.json。写入采用同目录临时文件加改名替换，
 * 所有读写串行执行；加载时记录文件的标识（mtime 与大小），每次写入前比对，磁盘在加载后被其他
 * 写入者改动过就放弃本次保存，不用过期内容覆盖它。结构损坏先备份再重新开始，暂时读不到时进入
 * 只读降级，避免用空配置覆盖仍然存在的记录。界面偏好、窗口状态、各项目的信任决定与安装级 UUID
 * 是同一文件里的可选字段，
 * 缺失或非法一律按默认值处理，不参与结构判定，也不改变版本语义；路径归一化在 project-path.ts，切换编排在
 * project-manager.ts，偏好读取在 preferences-manager.ts，窗口状态校正与保存时机在 window-state.ts，
 * 信任决定的探测与启动参数映射在 trust-manager.ts。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { app } from 'electron'
import type { UiPreferences, UiTheme } from '../shared/preferences-api'
import type { TrustDecision } from '../shared/trust-api'
import { isTrustDecision } from '../shared/trust-api'
import { isProject } from '../shared/project-api'
import type { Project, ProjectList } from '../shared/project-api'
import { projectNameFromPath } from './project-path'

const CONFIG_BASE_NAME = 'desktop-config'
const CONFIG_FILE_NAME = `${CONFIG_BASE_NAME}.json`
/** 配置结构版本；字段含义变化必须显式升级，不静默改写既有文件。 */
const CONFIG_VERSION = 1
/** 最近项目上限；超出按 `lastOpenedAt` 最旧淘汰，避免配置文件无界增长。 */
const MAX_PROJECTS = 50
/** 窗口尺寸的存储边界；只拒绝明显异常的值，实际尺寸下限与显示器上限由 window-state.ts 处理。 */
const MIN_STORED_WINDOW = 320
const MAX_STORED_WINDOW = 20_000

/** 界面偏好默认值；只在字段缺失或非法时使用。 */
export const DEFAULT_UI_PREFERENCES: UiPreferences = { sidebarCollapsed: false, theme: 'system' }

/** 窗口状态默认值；位置为 null 表示交给窗口自行居中。 */
export const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1120,
  height: 820,
  x: null,
  y: null,
  maximized: false
}

/** 窗口尺寸、位置与最大化状态；`x` 与 `y` 必须同时有效才作为可恢复位置。 */
export interface WindowState {
  readonly width: number
  readonly height: number
  readonly x: number | null
  readonly y: number | null
  readonly maximized: boolean
}

interface StoredConfig {
  readonly version: number
  readonly projects: readonly Project[]
  readonly currentProjectId: string | null
  readonly ui: UiPreferences
  readonly window: WindowState
  /** 可选字段：键是项目规范路径，值是 Desktop 侧保存的信任决定；缺失或非法按无决定处理。 */
  readonly projectTrust: Record<string, TrustDecision>
  /**
   * 可选字段：安装级 UUID。只用于需要 device id 的供应商登录（如 ChatGPT 账户登录），
   * 不是凭据；与 Pi 自己保存在 settings.json 里的值互不影响。缺失或非法按无值处理。
   */
  readonly authDeviceId: string | null
}

/** 需要落盘的完整配置内容；调用方显式给出，避免部分更新丢掉其他字段。 */
interface PersistPayload {
  readonly projects: readonly Project[]
  readonly currentProjectId: string | null
  readonly ui: UiPreferences
  readonly windowState: WindowState
  readonly projectTrust: Record<string, TrustDecision>
  readonly authDeviceId: string | null
}

/** 配置写入失败；由调用方映射为 `PROJECT_STORAGE_FAILED` 或通用内部错误。 */
export class DesktopConfigStorageError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** 主题字段单独回退：`sidebarCollapsed` 缺失时整体用默认值，主题字段非法时只回退主题。 */
function sanitizeTheme(value: unknown): UiTheme {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

function sanitizeUiPreferences(value: unknown): UiPreferences {
  if (!isRecord(value) || typeof value.sidebarCollapsed !== 'boolean') {
    return DEFAULT_UI_PREFERENCES
  }
  return { sidebarCollapsed: value.sidebarCollapsed, theme: sanitizeTheme(value.theme) }
}

/** 只接受绝对路径键与合法决定值；单个非法条目丢弃，不影响其他记录。 */
function sanitizeProjectTrust(value: unknown): Record<string, TrustDecision> {
  if (!isRecord(value)) return {}
  const decisions: Record<string, TrustDecision> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!isAbsolute(key) || !isTrustDecision(entry)) continue
    decisions[key] = entry
  }
  return decisions
}

/** 安装级 UUID 的接受形状；只接受标准 UUID，其他取值一律按无值处理。 */
const AUTH_DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function sanitizeAuthDeviceId(value: unknown): string | null {
  return typeof value === 'string' && AUTH_DEVICE_ID_PATTERN.test(value) ? value.toLowerCase() : null
}

/** 尺寸非法回落到默认值；位置缺失或非法一律丢弃，不猜测部分坐标。 */
function sanitizeWindowState(value: unknown): WindowState {
  if (!isRecord(value)) return DEFAULT_WINDOW_STATE

  const width = readDimension(value.width, DEFAULT_WINDOW_STATE.width)
  const height = readDimension(value.height, DEFAULT_WINDOW_STATE.height)
  const x = readCoordinate(value.x)
  const y = readCoordinate(value.y)
  const hasPosition = x !== null && y !== null
  return {
    width,
    height,
    x: hasPosition ? x : null,
    y: hasPosition ? y : null,
    maximized: value.maximized === true
  }
}

function readDimension(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  if (value < MIN_STORED_WINDOW || value > MAX_STORED_WINDOW) return fallback
  return value
}

function readCoordinate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < -MAX_STORED_WINDOW || value > MAX_STORED_WINDOW) return null
  return value
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

export class DesktopConfigStore {
  /** 读写串行队列：并发的选择动作不会互相覆盖内存状态或文件内容。 */
  private queue: Promise<unknown> = Promise.resolve()
  private loaded = false
  private readOnly = false
  private notice: string | null = null
  private projects: Project[] = []
  private currentProjectId: string | null = null
  private ui: UiPreferences = DEFAULT_UI_PREFERENCES
  private windowState: WindowState = DEFAULT_WINDOW_STATE
  private projectTrust: Record<string, TrustDecision> = {}
  /** 磁盘上的安装级 UUID；只在配置里保存过一次后才有值。 */
  private storedAuthDeviceId: string | null = null
  /** 本次运行使用的安装级 UUID；尚未落盘时也保持同一个值。 */
  private authDeviceId: string | null = null
  /**
   * 加载时磁盘上这份配置的标识（mtime 与大小）；null 表示加载时文件不存在。
   * 写入前用它发现「另一个写入者在我们加载后改过这份配置」，避免用过期内容覆盖磁盘。
   */
  private loadedStamp: string | null = null

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
  selectProject(
    projectPath: string,
    name: string,
    trustDecision?: TrustDecision
  ): Promise<ProjectList> {
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
      const projectTrust = trustDecision === undefined
        ? this.projectTrust
        : { ...this.projectTrust, [projectPath]: trustDecision }
      if (!this.readOnly) {
        await this.persist({
          projects,
          currentProjectId: record.id,
          ui: this.ui,
          windowState: this.windowState,
          projectTrust,
          authDeviceId: this.deviceIdForPersist()
        })
      }

      this.projects = projects
      this.currentProjectId = record.id
      this.projectTrust = projectTrust
      return this.snapshot()
    })
  }

  /** 从 Desktop 列表移除项目记录，不访问或删除项目目录；同时清除当前选择与该路径的信任决定。 */
  removeProject(projectId: string): Promise<ProjectList> {
    return this.enqueue(async () => {
      await this.loadFromDisk()
      const removed = this.projects.find((project) => project.id === projectId)
      if (removed === undefined) return this.snapshot()

      const projects = this.projects.filter((project) => project.id !== projectId)
      const currentProjectId = this.currentProjectId === projectId ? null : this.currentProjectId
      const projectTrust = { ...this.projectTrust }
      delete projectTrust[removed.path]
      if (!this.readOnly) {
        await this.persist({
          projects,
          currentProjectId,
          ui: this.ui,
          windowState: this.windowState,
          projectTrust,
          authDeviceId: this.deviceIdForPersist()
        })
      }

      this.projects = projects
      this.currentProjectId = currentProjectId
      this.projectTrust = projectTrust
      return this.snapshot()
    })
  }

  /** 读取界面偏好；首次调用从磁盘加载。 */
  readUiPreferences(): Promise<UiPreferences> {
    return this.enqueue(async () => {
      await this.loadFromDisk()
      return this.ui
    })
  }

  /** 保存界面偏好；只读降级时只更新内存状态，不写文件。 */
  saveUiPreferences(ui: UiPreferences): Promise<UiPreferences> {
    return this.enqueue(async () => {
      await this.loadFromDisk()
      if (!this.readOnly) {
        await this.persist({
          projects: this.projects,
          currentProjectId: this.currentProjectId,
          ui,
          windowState: this.windowState,
          projectTrust: this.projectTrust,
          authDeviceId: this.deviceIdForPersist()
        })
      }
      this.ui = ui
      return this.ui
    })
  }

  /** 读取窗口状态；首次调用从磁盘加载，尺寸与位置的可用性校正由 window-state.ts 完成。 */
  readWindowState(): Promise<WindowState> {
    return this.enqueue(async () => {
      await this.loadFromDisk()
      return this.windowState
    })
  }

  /** 保存窗口状态；只读降级时只更新内存状态，不写文件。 */
  saveWindowState(windowState: WindowState): Promise<void> {
    return this.enqueue(async () => {
      await this.loadFromDisk()
      if (!this.readOnly) {
        await this.persist({
          projects: this.projects,
          currentProjectId: this.currentProjectId,
          ui: this.ui,
          windowState,
          projectTrust: this.projectTrust,
          authDeviceId: this.deviceIdForPersist()
        })
      }
      this.windowState = windowState
    })
  }

  /** 读取项目的信任决定；首次调用从磁盘加载。项目路径规范化由调用方负责。 */
  readTrustDecision(projectPath: string): Promise<TrustDecision | null> {
    return this.enqueue(async () => {
      await this.loadFromDisk()
      return this.projectTrust[projectPath] ?? null
    })
  }

  /**
   * 保存、更新或清除（decision 为 null）项目的信任决定；只读降级时只更新内存状态，不写文件。
   * 键使用调用方传入的规范化路径，与其他字段共用同一份文件与写入队列。
   */
  saveTrustDecision(projectPath: string, decision: TrustDecision | null): Promise<void> {
    return this.enqueue(async () => {
      await this.loadFromDisk()
      const next: Record<string, TrustDecision> = { ...this.projectTrust }
      if (decision === null) delete next[projectPath]
      else next[projectPath] = decision
      if (!this.readOnly) {
        await this.persist({
          projects: this.projects,
          currentProjectId: this.currentProjectId,
          ui: this.ui,
          windowState: this.windowState,
          projectTrust: next,
          authDeviceId: this.deviceIdForPersist()
        })
      }
      this.projectTrust = next
    })
  }

  /**
   * 读取安装级 UUID；首次调用生成一个并尽力落盘。
   * 配置只读降级时只保存在本次运行内存中（本次运行内保持不变），下次启动会重新生成；
   * 它不是凭据，也不与 Pi 自己保存在 settings.json 里的 device id 共享。
   */
  getOrCreateAuthDeviceId(): Promise<string | null> {
    return this.enqueue(async () => {
      await this.loadFromDisk()
      if (this.authDeviceId !== null) return this.authDeviceId
      if (this.storedAuthDeviceId !== null) {
        this.authDeviceId = this.storedAuthDeviceId
        return this.authDeviceId
      }

      const generated = randomUUID()
      this.authDeviceId = generated
      if (!this.readOnly) {
        try {
          await this.persist({
            projects: this.projects,
            currentProjectId: this.currentProjectId,
            ui: this.ui,
            windowState: this.windowState,
            projectTrust: this.projectTrust,
            authDeviceId: generated
          })
          this.storedAuthDeviceId = generated
        } catch {
          // 落盘失败不影响本次运行使用同一个已生成的值。
        }
      }
      return this.authDeviceId
    })
  }

  /** 落盘时使用的安装级 UUID：优先用本次运行的值，其次用磁盘上已有的值。 */
  private deviceIdForPersist(): string | null {
    return this.authDeviceId ?? this.storedAuthDeviceId
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    // 前一次失败不能阻断后续操作；错误由各自调用方处理。
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** 内存快照；不触发磁盘读取，供同一进程内的其他主进程模块读取当前项目。 */
  getState(): ProjectList {
    return this.snapshot()
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
      if (isMissingFile(error)) {
        this.loadedStamp = null
        return
      }
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
      // 原文件已被改名，接下来的第一次保存是从空配置重建，不按覆盖处理。
      this.loadedStamp = null
      return
    }
    this.loadedStamp = await this.stampOf(file)
    if (parsed.version !== CONFIG_VERSION) {
      // 未来版本的文件不改写、不覆盖，只读使用其中可识别的记录。
      this.readOnly = true
      this.projects = [...parsed.projects]
      this.currentProjectId = parsed.currentProjectId
      this.ui = parsed.ui
      this.windowState = parsed.window
      this.projectTrust = parsed.projectTrust
      this.storedAuthDeviceId = parsed.authDeviceId
      this.notice = `本地项目配置版本 ${parsed.version} 不受支持，本次运行不会保存项目选择。`
      return
    }
    this.projects = [...parsed.projects]
    this.currentProjectId = parsed.currentProjectId
    this.ui = parsed.ui
    this.windowState = parsed.window
    this.projectTrust = parsed.projectTrust
    this.storedAuthDeviceId = parsed.authDeviceId
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
    return {
      version: value.version,
      projects,
      currentProjectId,
      ui: sanitizeUiPreferences(value.ui),
      window: sanitizeWindowState(value.window),
      projectTrust: sanitizeProjectTrust(value.projectTrust),
      authDeviceId: sanitizeAuthDeviceId(value.authDeviceId)
    }
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

  /** 文件标识；文件不存在返回 null。只用于发现外部写入，不参与内容校验。 */
  private async stampOf(file: string): Promise<string | null> {
    try {
      const info = await stat(file)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return null
    }
  }

  /** 同目录临时文件加改名替换，中断时不会留下半份配置。 */
  private async persist(next: PersistPayload): Promise<void> {
    const file = this.filePath()
    const temporary = `${file}.${process.pid}-${Date.now()}.tmp`
    const payload: StoredConfig = {
      version: CONFIG_VERSION,
      projects: next.projects,
      currentProjectId: next.currentProjectId,
      ui: next.ui,
      window: next.windowState,
      projectTrust: next.projectTrust,
      authDeviceId: next.authDeviceId
    }
    // 这份配置是整文件写入：磁盘在加载后被别的写入者改过时，宁可放弃本次保存，也不用过期内容覆盖。
    if (await this.stampOf(file) !== this.loadedStamp) {
      throw new DesktopConfigStorageError(
        '本地项目配置已被其他进程修改，本次保存已放弃；请关闭多余的实例后重启应用再试。'
      )
    }
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new DesktopConfigStorageError(
        error instanceof Error
          ? `无法保存本地项目配置：${error.message}`
          : '无法保存本地项目配置。'
      )
    }
    this.loadedStamp = await this.stampOf(file)
  }

  private filePath(): string {
    return join(app.getPath('userData'), CONFIG_FILE_NAME)
  }
}
