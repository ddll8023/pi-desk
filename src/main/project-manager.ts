/**
 * 当前项目与最近项目列表的所有者：目录选择、候选信任复核、项目添加/移除、切换与配置读写。
 *
 * 添加前复核受保护资源，并在 Runtime 切换成功时一起保存项目与信任决定；移除仅清理 Desktop 配置，
 * 不删除项目目录。运行中断由显式确认控制；IPC 契约与调用方校验位于 shared/project-api.ts 和 main/index.ts。
 */
import { app } from 'electron'
import type {
  ProjectError,
  ProjectErrorCode,
  ProjectList,
  ProjectAddRequest,
  ProjectListResult,
  ProjectPathResult,
  ProjectPathSelection,
  ProjectRemoveRequest,
  ProjectSetCurrentRequest
} from '../shared/project-api'
import type { TrustDecision } from '../shared/trust-api'
import type { RuntimeStatus } from '../shared/runtime-api'
import { DesktopConfigStorageError, DesktopConfigStore } from './desktop-config-store'
import { ProjectPathError, normalizeProjectPath, projectNameFromPath } from './project-path'
import type { RuntimeManager } from './runtime-manager'
import type { TrustManager } from './trust-manager'

/** 可分类的项目操作失败；由公共方法统一转换为结果对象。 */
class ProjectFailure extends Error {
  readonly code: ProjectErrorCode

  constructor(code: ProjectErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function sameTrustStatus(
  preview: ProjectPathSelection['trustStatus'],
  current: ProjectPathSelection['trustStatus']
): boolean {
  return preview.projectPath === current.projectPath
    && preview.decision === current.decision
    && preview.resources.length === current.resources.length
    && preview.resources.every((resource, index) => {
      const currentResource = current.resources[index]
      return currentResource !== undefined
        && resource.kind === currentResource.kind
        && resource.path === currentResource.path
    })
}

export interface ProjectManagerOptions {
  /** 打开系统目录选择器；`defaultPath` 是建议起始目录，返回 null 表示用户取消。 */
  readonly chooseDirectory: (defaultPath: string) => Promise<string | null>
  /** Runtime 的所有者；只使用状态查询与既有关闭链。 */
  readonly runtime: RuntimeManager
  /** 配置文件的唯一读写者；项目列表与界面偏好、窗口状态共用同一份文件。 */
  readonly store: DesktopConfigStore
  /** 信任状态探测；项目候选在提交前复核资源快照。 */
  readonly trust: TrustManager
}

export class ProjectManager {
  /** 目录选择单飞：连续点击或重复请求复用同一次原生对话框。 */
  private pendingChoice: Promise<ProjectPathSelection | null> | null = null

  constructor(private readonly options: ProjectManagerOptions) {}

  /** 项目列表与当前项目；不检查项目目录是否仍然存在。 */
  async list(): Promise<ProjectListResult> {
    try {
      return { ok: true, data: await this.options.store.list() }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '读取本地项目配置时发生未预期的内部错误。'
      })
    }
  }

  /** 当前项目路径（内存快照）；未加载或尚未选择时为 null，不触发磁盘访问。 */
  currentProjectPath(): string | null {
    const state = this.options.store.getState()
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

  /** 把已保存项目设为当前项目；成功时返回更新后的完整列表。 */
  async setCurrent(request: ProjectSetCurrentRequest): Promise<ProjectListResult> {
    try {
      const projectPath = await this.loadPath(request.path)
      const list = await this.options.store.list()
      if (!list.projects.some((project) => project.path === projectPath)) {
        throw new ProjectFailure('INVALID_PROJECT_PATH', '只能切换到已添加的项目；请通过添加项目流程注册新目录。')
      }
      return { ok: true, data: await this.applySwitch({ path: projectPath, allowInterrupt: request.allowInterrupt }) }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '切换项目时发生未预期的内部错误。'
      })
    }
  }

  /** 复核候选资源与信任选择后再切换；项目与信任决定只在切换成功时一并保存。 */
  async add(request: ProjectAddRequest): Promise<ProjectListResult> {
    try {
      const projectPath = await this.loadPath(request.path)
      const currentTrustStatus = await this.options.trust.refreshStatusOf(projectPath)
      if (!sameTrustStatus(request.trustStatus, currentTrustStatus)) {
        throw new ProjectFailure('PROJECT_TRUST_REQUIRED', '项目受保护资源已变化，请重新选择并确认信任决定。')
      }

      let trustDecisionToSave: TrustDecision | undefined
      if (currentTrustStatus.resources.length > 0 && currentTrustStatus.decision === null) {
        if (request.trustDecision === null) {
          throw new ProjectFailure('PROJECT_TRUST_REQUIRED', '请先确认项目的信任决定。')
        }
        trustDecisionToSave = request.trustDecision
      } else if (request.trustDecision !== null) {
        throw new ProjectFailure('INVALID_REQUEST', '此项目当前无需提交新的信任决定。')
      }

      const data = await this.applySwitch(
        { path: projectPath, allowInterrupt: request.allowInterrupt },
        trustDecisionToSave
      )
      return { ok: true, data }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '添加项目时发生未预期的内部错误。'
      })
    }
  }

  /** 移除 Desktop 项目记录；移除当前项目时复用 Runtime 关闭链，不删除磁盘目录。 */
  async remove(request: ProjectRemoveRequest): Promise<ProjectListResult> {
    try {
      const list = await this.options.store.list()
      const project = list.projects.find((entry) => entry.id === request.projectId)
      if (project === undefined) return { ok: true, data: list }
      if (project.id === list.currentProjectId) {
        const status = this.runtimeStatus()
        if (status.state === 'starting' || status.state === 'stopping') {
          throw new ProjectFailure('PROJECT_REMOVE_BLOCKED', 'Runtime 正在启动或关闭，请稍后再移除项目。')
        }
        if (status.state === 'ready' && status.info?.isStreaming === true && !request.allowInterrupt) {
          throw new ProjectFailure('PROJECT_REMOVE_BLOCKED', '当前 Agent 正在运行；确认后才能停止并移除项目。')
        }
        if (status.state === 'ready') {
          const stopped = await this.options.runtime.stop()
          if (!stopped.ok || stopped.data.state !== 'idle') {
            throw new ProjectFailure('PROJECT_REMOVE_BLOCKED', 'Runtime 未确认退出，项目未移除。')
          }
        }
      }
      return { ok: true, data: await this.options.store.removeProject(project.id) }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '移除项目时发生未预期的内部错误。'
      })
    }
  }

  /**
   * 先结束旧 Runtime 再保存新项目：只有确认回到 `idle` 才写入配置，否则项目保持不变。
   * `failed` 状态不再追加终止尝试，只切换并保存项目选择。
   */
  private async applySwitch(
    request: ProjectSetCurrentRequest,
    trustDecision?: TrustDecision
  ): Promise<ProjectList> {
    const projectPath = await this.loadPath(request.path)
    if (projectPath === this.currentProjectPath()) {
      return this.options.store.selectProject(projectPath, projectNameFromPath(projectPath), trustDecision)
    }
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

    return this.options.store.selectProject(projectPath, projectNameFromPath(projectPath), trustDecision)
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
    const current = await this.options.store.list()
    const selected = current.projects.find((project) => project.id === current.currentProjectId)
    const chosen = await this.options.chooseDirectory(selected?.path ?? app.getPath('home'))
    if (chosen === null) return null

    const projectPath = await this.loadPath(chosen)
    const trustStatus = await this.options.trust.refreshStatusOf(projectPath)
    return { path: projectPath, name: projectNameFromPath(projectPath), trustStatus }
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
    if (error instanceof DesktopConfigStorageError) {
      return { ok: false, error: { code: 'PROJECT_STORAGE_FAILED', message: error.message } }
    }
    return { ok: false, error: fallback }
  }
}
