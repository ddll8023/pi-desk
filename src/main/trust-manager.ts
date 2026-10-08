/**
 * Project Trust 的探测与决定管理：识别会触发信任要求的项目资源，读写 Desktop 侧的持久决定，
 * 并把决定映射为 Pi 启动参数。不读写 Pi 的 `~/.pi/agent/trust.json`，不处理 `project_trust`
 * extension 事件，也不做任何 OS 沙箱或工具权限限制；路径归一化复用 project-path.ts。
 *
 * 资源清单与决定优先级来自 Pi v1.0.4 官方文档（security.md）：CLI 覆盖最优先，因此有受保护
 * 资源时 Desktop 的决定会覆盖用户既有的 Pi 保存记录，这一行为已在界面中如实说明。
 */
import { stat } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import type { TrustDecision, TrustResourceKind, TrustStatus } from '../shared/trust-api'
import type { DesktopConfigStore } from './desktop-config-store'
import { normalizeProjectPath, ProjectPathError } from './project-path'

/** 探测到的资源条目；kind 与 TrustResourceKind 一一对应。 */
interface ProbedResource {
  readonly path: string
  readonly kind: TrustResourceKind
}

/** 项目目录下 `.pi` 内的受保护资源；裸 `.pi` 目录不触发信任要求。 */
const PI_RESOURCES: readonly (readonly [kind: TrustResourceKind, name: string])[] = [
  ['settings', 'settings.json'],
  ['mcp', 'mcp.json'],
  ['extensions', 'extensions'],
  ['skills', 'skills'],
  ['prompts', 'prompts'],
  ['themes', 'themes'],
  ['systemMd', 'SYSTEM.md'],
  ['appendSystemMd', 'APPEND_SYSTEM.md']
]

/** 探测结果的进程内缓存；决定保存后随状态刷新，不做文件监听。 */
interface ProbeCacheEntry {
  readonly decision: TrustDecision | null
  readonly resources: readonly ProbedResource[]
}

export class TrustManager {
  /** 规范路径 → 探测缓存；只缓存成功探测，失败路径不缓存。 */
  private readonly cache = new Map<string, ProbeCacheEntry>()

  constructor(private readonly options: { readonly store: DesktopConfigStore }) {}

  private get store(): DesktopConfigStore {
    return this.options.store
  }

  /**
   * 当前项目的信任状态：探测受保护资源并附带已保存决定。探测失败按资源不存在处理，
   * 不让单个路径的 stat 错误演变成状态读取失败。
   */
  async statusOf(rawProjectPath: string | null): Promise<TrustStatus> {
    if (rawProjectPath === null) {
      return { projectPath: null, decision: null, resources: [] }
    }
    const projectPath = await this.canonicalize(rawProjectPath)
    const entry = await this.probe(projectPath)
    return {
      projectPath,
      decision: entry.decision,
      resources: entry.resources
    }
  }

  /**
   * 保存、更新或清除当前项目的决定，返回更新后的状态。
   * `projectPath` 必须与当前项目一致（防止页面改写其他项目的决定）。
   */
  async decide(
    rawProjectPath: string,
    decision: TrustDecision | null,
    currentProjectPath: string | null
  ): Promise<TrustStatus> {
    const projectPath = await this.canonicalize(rawProjectPath)
    if (currentProjectPath === null || projectPath !== currentProjectPath) {
      throw new TrustManagerError('只能修改当前项目的信任决定。')
    }
    await this.store.saveTrustDecision(projectPath, decision)
    this.cache.delete(projectPath)
    return this.statusOf(projectPath)
  }

  /** 启动 Runtime 前调用：返回应传递的信任覆盖；无受保护资源时为 null（不传参数）。 */
  async resolveLaunchDecision(currentProjectPath: string | null): Promise<{
    readonly decision: TrustDecision | null
    readonly requiresPrompt: boolean
  }> {
    if (currentProjectPath === null) {
      return { decision: null, requiresPrompt: false }
    }
    const projectPath = await this.canonicalize(currentProjectPath)
    const entry = await this.probe(projectPath)
    if (entry.resources.length === 0) {
      return { decision: null, requiresPrompt: false }
    }
    if (entry.decision === null) {
      return { decision: null, requiresPrompt: true }
    }
    return { decision: entry.decision, requiresPrompt: false }
  }

  /** 归一化失败按内部错误处理；调用方传入的路径已经过一次校验。 */
  private async canonicalize(rawProjectPath: string): Promise<string> {
    try {
      return await normalizeProjectPath(rawProjectPath)
    } catch (error) {
      if (error instanceof ProjectPathError) {
        throw new TrustManagerError(error.message)
      }
      throw error
    }
  }

  /** 探测并缓存；决定来自配置存储，资源清单来自文件系统。 */
  private async probe(projectPath: string): Promise<ProbeCacheEntry> {
    const cached = this.cache.get(projectPath)
    const decision = await this.store.readTrustDecision(projectPath)
    if (cached !== undefined && cached.decision === decision) return cached

    const resources = await this.probeResources(projectPath)
    const entry: ProbeCacheEntry = { decision, resources }
    this.cache.set(projectPath, entry)
    return entry
  }

  /** 按官方清单逐项探测；单路径失败按不存在处理，不影响其他条目。 */
  private async probeResources(projectPath: string): Promise<readonly ProbedResource[]> {
    const found: ProbedResource[] = []
    const piDir = join(projectPath, '.pi')
    for (const [kind, name] of PI_RESOURCES) {
      if (await this.pathExists(join(piDir, name))) {
        found.push({ path: join(piDir, name), kind })
      }
    }
    for (const ancestor of this.ancestorDirectories(projectPath)) {
      if (await this.pathExists(join(ancestor, '.agents', 'skills'))) {
        found.push({ path: join(ancestor, '.agents', 'skills'), kind: 'agentSkills' })
      }
    }
    return found
  }

  /** 祖先目录序列（含项目自身）；到文件系统根为止，不触碰文件系统。 */
  private ancestorDirectories(projectPath: string): readonly string[] {
    const directories: string[] = []
    let current = parse(projectPath).root
    let pointer = projectPath
    while (true) {
      directories.push(pointer)
      if (pointer === current) break
      const parent = dirname(pointer)
      if (parent === pointer) break
      pointer = parent
    }
    return directories
  }

  /** 存在性探测：目录与文件统一按可达即存在；失败一律视为不存在。 */
  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }
}

export class TrustManagerError extends Error {}

