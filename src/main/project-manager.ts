/**
 * 当前项目与最近项目列表的所有者：目录选择、切换编排与配置读写调用。
 *
 * 切换项目复用 RuntimeManager 的关闭链：有活动操作而请求未确认时直接拒绝，不自动中断、不排队、
 * 不重放；归一化交给 project-path，持久化交给 project-store。IPC 契约与校验在
 * shared/project-api.ts，调用者与参数校验在 main/index.ts。
 */
import { app } from 'electron'
import type {
  ProjectError,
  ProjectErrorCode,
  ProjectList,
  ProjectListResult,
  ProjectPathResult,
  ProjectPathSelection,
  ProjectSetCurrentRequest
} from '../shared/project-api'
import type { RuntimeStatus } from '../shared/runtime-api'
import { ProjectPathError, normalizeProjectPath, projectNameFromPath } from './project-path'
import { ProjectStorageError, ProjectStore } from './project-store'
import type { RuntimeManager } from './runtime-manager'

/** 可分类的项目操作失败；由公共方法统一转换为结果对象。 */
class ProjectFailure extends Error {
  readonly code: ProjectErrorCode

  constructor(code: ProjectErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface ProjectManagerOptions {
  /** 打开系统目录选择器；`defaultPath` 是建议起始目录，返回 null 表示用户取消。 */
  readonly chooseDirectory: (defaultPath: string) => Promise<string | null>
  /** Runtime 的所有者；只使用状态查询与既有关闭链。 */
  readonly runtime: RuntimeManager
}

export class ProjectManager {
  private readonly store = new ProjectStore()
  /** 目录选择单飞：连续点击或重复请求复用同一次原生对话框。 */
  private pendingChoice: Promise<ProjectPathSelection | null> | null = null

  constructor(private readonly options: ProjectManagerOptions) {}

  /** 项目列表与当前项目；不检查项目目录是否仍然存在。 */
  async list(): Promise<ProjectListResult> {
    try {
      return { ok: true, data: await this.store.list() }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '读取本地项目配置时发生未预期的内部错误。'
      })
    }
  }

  /** 当前项目路径（内存快照）；未加载或尚未选择时为 null，不触发磁盘访问。 */
  currentProjectPath(): string | null {
    const state = this.store.getState()
    const current = state.projects.find((project) => project.id === state.currentProjectId)
    return current?.path ?? null
  }

  /** 系统目录选择器；返回归一化后的目录，取消时数据为 `null`。 */
  async chooseDirectory(): Promise<ProjectPathResult> {
    try {
      return { ok: true, data: await this.requestChoice() }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '打开目录选择器时发生未预期的内部错误。'
      })
    }
  }

  /** 把请求路径设为当前项目；成功时返回更新后的完整列表。 */
  async setCurrent(request: ProjectSetCurrentRequest): Promise<ProjectListResult> {
    try {
      return { ok: true, data: await this.applySwitch(request) }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '切换项目时发生未预期的内部错误。'
      })
    }
  }

  /**
   * 先结束旧 Runtime 再保存新项目：只有确认回到 `idle` 才写入配置，否则项目保持不变。
   * `failed` 状态不再追加终止尝试，只切换并保存项目选择。
   */
  private async applySwitch(request: ProjectSetCurrentRequest): Promise<ProjectList> {
    const projectPath = await this.loadPath(request.path)
    const status = this.runtimeStatus()

    if (status.state === 'starting' || status.state === 'stopping') {
      throw new ProjectFailure('PROJECT_SWITCH_BLOCKED', 'Runtime 正在启动或关闭，请稍后再切换项目。')
    }
    if (status.state === 'ready' && status.info?.isStreaming === true && !request.allowInterrupt) {
      throw new ProjectFailure(
        'PROJECT_SWITCH_BLOCKED',
        '当前有正在运行的操作；确认后会先停止它再切换项目。'
      )
    }
    if (status.state === 'ready') {
      const stopped = await this.options.runtime.stop()
      if (!stopped.ok || stopped.data.state !== 'idle') {
        throw new ProjectFailure(
          'PROJECT_SWITCH_BLOCKED',
          '旧 Runtime 未确认退出，项目未切换；请先关闭 Runtime 后重试。'
        )
      }
    }

    return this.store.selectProject(projectPath, projectNameFromPath(projectPath))
  }

  private requestChoice(): Promise<ProjectPathSelection | null> {
    const pending = this.pendingChoice
    if (pending !== null) return pending

    const choice = this.openDirectoryDialog().finally(() => {
      this.pendingChoice = null
    })
    this.pendingChoice = choice
    return choice
  }

  private async openDirectoryDialog(): Promise<ProjectPathSelection | null> {
    const current = await this.store.list()
    const selected = current.projects.find((project) => project.id === current.currentProjectId)
    const chosen = await this.options.chooseDirectory(selected?.path ?? app.getPath('home'))
    if (chosen === null) return null

    const projectPath = await this.loadPath(chosen)
    return { path: projectPath, name: projectNameFromPath(projectPath) }
  }

  /** 归一化并校验用户提供的目录；失败按 `INVALID_PROJECT_PATH` 归类。 */
  private async loadPath(input: unknown): Promise<string> {
    try {
      return await normalizeProjectPath(input)
    } catch (error) {
      if (error instanceof ProjectPathError) {
        throw new ProjectFailure('INVALID_PROJECT_PATH', error.message)
      }
      throw error
    }
  }

  private runtimeStatus(): RuntimeStatus {
    const result = this.options.runtime.getStatus()
    if (!result.ok) {
      throw new ProjectFailure('INTERNAL_ERROR', '无法读取 Runtime 状态。')
    }
    return result.data
  }

  private failure(error: unknown, fallback: ProjectError): { ok: false; error: ProjectError } {
    if (error instanceof ProjectFailure) {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    if (error instanceof ProjectStorageError) {
      return { ok: false, error: { code: 'PROJECT_STORAGE_FAILED', message: error.message } }
    }
    return { ok: false, error: fallback }
  }
}
