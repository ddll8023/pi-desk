/**
 * 会话列表、打开、重新加载、删除与历史读取编排的所有者：选择、新建、恢复、重载与删除会话。
 * 后台新建与打开已有会话不依赖桌面当前项目，也不修改桌面前台；登记、归属与信任仍由同一条授权链复核。
 * 历史读取按会话分流：已由运行实例接管时读权威分支，未接管时读会话日志文件，两条路径返回同一套条目身份。
 *
 * 列表来自 Pi 管理的会话文件（session-store），按调用方显式给出的项目读取并只读取窗口内的文件：
 * 侧栏按项目树展示会话，因此列表不再隐式取当前项目，但只接受已添加项目的规范路径；
 * 打开与重载回传运行实例、会话与工作区上下文，不附带会话列表：切换链不等目录扫描，列表读取失败也不会
 * 把已完成的切换报成失败；删除成功后回传调用方窗口大小的列表快照（`listLimit`），
 * 变更不会把页面已展开的列表塌回首屏。
 * 新建、打开、切换与重载都交给 SDK 宿主，由宿主在同一进程内替换会话，目标、归属与信任经本模块的
 * SDK 授权回路复核，执行根取来源实例登记的工作区，项目信任取其归属项目，不是前台选择。
 * 多运行实例下打开其他会话不中断任何正在运行的会话；重载以目标会话自己的项目做信任复核。
 * 删除以显式项目路径定位文件：先按与项目移除同一套门禁收敛占用（opening/closing 拒绝、在途工作
 * 需显式中断确认），释放成功后才删文件；任一步失败都会保留会话原样，不产生半删状态。
 * 会话文件删除后，按界面偏好清理该会话独占且无未提交改动的任务工作树；清理失败不回滚删除，也不影响列表返回。
 * 有活动操作而重载请求未确认时直接拒绝，不自动中断、不排队、不重放已提交的内容。
 * 执行模式在授权时读一次随目标下发，宿主据此裁剪 Skill 集合；读失败按标准模式处理。
 * 专家绑定只存标识：已存在的会话以持久绑定为准，新建时用打开请求里的值并在打开成功时立即落盘
 * （会话身份那一刻才确定，页面取不到），宿主装载定义后才注入角色段。
 * IPC 契约与校验在 shared/session-api.ts。
 */
import type {
  SessionDeleteRequest,
  SessionDeleteResult,
  SessionError,
  SessionErrorCode,
  SessionListResult,
  SessionOpenRequest,
  SessionOpenData,
  SessionOpenResult,
  SessionHistoryRequest,
  SessionHistoryResult,
  SessionExpertCatalog,
  SessionExpertsResult
} from '../../shared/session-api'
import { isExpertId, isSessionOpenRequest } from '../../shared/session-api'
import type { RuntimeStatus } from '../../shared/runtime-api'
import type { ExecutionMode } from '../../shared/preferences-api'
import type { WorkspaceManager } from '../workspaces/workspace-manager'
import { WorkspaceStorageError } from '../workspaces/workspace-store'
import { WorktreeOperationError } from '../git/worktree-service'
import type { ProjectManager } from '../projects/project-manager'
import { SdkHostError } from './sdk-host-manager'
import { sessionErrorOf } from './sdk-runtime-bridge'
import type { SdkRuntimeBridge } from './sdk-runtime-bridge'
import { SessionStorageError, deleteSessionFile, listSessions, resolveSessionFile, resolveSdkSessionFile, getProjectSessionDir } from './session-store'
import { ProjectPathError, normalizeProjectPath } from '../shared/project-path'
import type { SessionRunSummary } from './session-run-registry'
import { resolveSessionExpert } from './session-experts'
import type { SessionExpertBindings } from './session-experts'
import { resolveSessionTeam } from './session-teams'
import type { SessionTeamBindings } from './session-teams'
import { materializeTeamSessions, removeTeamSessionDirectory } from './team-sessions'
import type { TeamSessionBindings } from './team-sessions'
import type { TeamCatalogView, TeamView } from '../../shared/teams-api'
import { isSdkSessionReference } from '../../sdk-host/protocol'
import type { SdkHostFailureCode, SdkSessionReference, SdkSessionStatus, SdkSessionTarget } from '../../sdk-host/protocol'

/** SDK 目标授权失败只返回分类，底层路径与配置异常不作为宿主通信载荷。 */
export class SdkTargetFailure extends Error {
  constructor(readonly code: SdkHostFailureCode) { super(code) }
}

/** 可分类的会话操作失败；由公共方法统一转换为结果对象。 */
class SessionFailure extends Error {
  readonly code: SessionErrorCode

  constructor(code: SessionErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * 历史读取的过期失败：绑定路径在读取期间换绑（`STALE_SESSION`），
 * 日志路径的文件戳被改写或游标已不在当前分支（`INVALID_SESSION_TARGET`）。
 * 两者都是「这一页已经过期」，不是目标或授权错误，因此单独归成 `HISTORY_STALE`。
 */
function isStaleHistoryFailure(error: unknown): error is SdkHostError {
  return error instanceof SdkHostError
    && (error.code === 'STALE_SESSION' || error.code === 'INVALID_SESSION_TARGET')
}

export interface SessionManagerOptions {
  /**
   * 当前项目来源、已添加项目范围与配置；只用于列表校验与界面上下文，不作为运行实例的授权依据。
   */
  readonly projects: ProjectManager
  /** 会话后端；列表之外的会话编排都经它提交。 */
  readonly sdk: SdkRuntimeBridge
  readonly workspaces: WorkspaceManager
  /** SDK 授权使用新鲜信任结果，不复用调用方传入的旧决定。 */
  readonly projectsTrust: import('../trust/trust-manager').TrustManager
  /**
   * 运行实例归属查询：授权只认注册表登记的项目，不读前台选择；
   * 占用查询用于区分「会话由其他实例承载」与「列表已过期」。
   */
  readonly ownership: {
    isProjectActive(projectPath: string): boolean
    workspaceOfRun(runId: number): string | null
    runOfSession(projectPath: string, sessionId: string): SessionRunSummary | null
  }
  /** 执行模式：由主进程读配置后交给宿主裁剪 Skill 集合，不改变任何授权规则。 */
  readonly readExecutionMode: () => Promise<ExecutionMode>
  /** 删除会话后是否清理该会话关联且无未提交改动的工作树；由界面偏好决定，读不到时按不清理处理。 */
  readonly readCleanupOnSessionDelete?: () => Promise<boolean>
  /** 按会话清理其独占的工作树；实现自己负责跳过共享、脏工作树等情况。 */
  readonly cleanupSessionWorkspace?: (projectPath: string, sessionId: string) => Promise<boolean>
  /** 会话专家绑定的读写口；缺省时按没有专家处理，打开照常进行。 */
  readonly sessionExperts?: SessionExpertBindings
  /** 会话团队绑定的读写口；缺省时按未开团处理，打开照常进行。 */
  readonly sessionTeams?: SessionTeamBindings
  /** 读取专家清单与加载诊断；缺省时清单为空，不阻止其他会话能力。 */
  readonly readExpertCatalog?: () => SessionExpertCatalog
  /** 读取团队清单与诊断；开团判定与团长来源取自它，缺省时任何团队都不算就绪。 */
  readonly readTeamCatalog?: () => TeamCatalogView
  /** 成员会话登记读写口；缺省时不物化成员，开团仍可用（团长单独工作）。 */
  readonly teamSessions?: TeamSessionBindings
}

export class SessionManager {
  /**
   * 本次打开请求里的专家，按「工作区 + 会话」暂存，等宿主发起授权时取走。
   * 宿主授权只拿得到引用与工作区，拿不到页面请求；新会话还没有会话 id，不能靠持久绑定传递。
   */
  private readonly pendingExperts = new Map<string, string | null>()
  /** 本次打开请求里的团队，与专家共用同一套暂存键；两边互不影响。 */
  private readonly pendingTeams = new Map<string, string | null>()

  constructor(private readonly options: SessionManagerOptions) {}

  /** 暂存键：新建会话没有会话 id，用 `new` 占位，避免与已有会话互相覆盖。 */
  private expertKey(workspaceId: string, sessionId: string | null): string {
    return `${workspaceId}\u0000${sessionId ?? 'new'}`
  }

  /** 专家清单：清单读不出来时只报告，不让选择器因为安装问题整个不可用。 */
  async listExperts(): Promise<SessionExpertsResult> {
    try {
      return { ok: true, data: this.options.readExpertCatalog?.() ?? { experts: [], issues: [] } }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '读取专家清单时发生未预期的内部错误。'
      })
    }
  }

  /**
   * SDK 内部目标授权：归属项目由调用方按来源运行实例给定，不读前台选择。
   * 无受保护资源但没有显式信任时按未信任建立，避免新出现的资源被隐式加载；
   * 异步读取前后都以注册表登记为准，前台切换不会改变已登记运行实例的授权范围。
   */
  async prepareSdkTarget(reference: SdkSessionReference, ownerProjectPath: string, workspaceId: string): Promise<SdkSessionTarget> {
    if (!isSdkSessionReference(reference)) throw new SdkTargetFailure('INVALID_SESSION_TARGET')
    try {
      const projectPath = await normalizeProjectPath(ownerProjectPath)
      if (projectPath !== ownerProjectPath) throw new SdkTargetFailure('INVALID_SESSION_TARGET')
      const trust = await this.options.projectsTrust.refreshStatusOf(projectPath)
      if (trust.resources.length > 0 && trust.decision === null) throw new SdkTargetFailure('TRUST_REQUIRED')
      const identity = reference.kind === 'new' ? null : await resolveSdkSessionFile(projectPath, reference)
      if (!this.options.ownership.isProjectActive(projectPath)) throw new SdkTargetFailure('STALE_SESSION')
      const workspace = await this.options.workspaces.authorize(projectPath, workspaceId)
      await this.options.workspaces.bindSession(projectPath, identity?.sessionId ?? null, workspaceId)
      const bindings = await this.sessionBindings(projectPath, identity?.sessionId ?? null, workspaceId)
      return { projectPath, workspaceId, sessionDir: getProjectSessionDir(projectPath), trusted: trust.decision === 'trusted',
        mode: await this.executionMode(),
        expertId: bindings.expertId,
        teamId: bindings.teamId,
        worktreePath: workspace.kind === 'task' ? workspace.rootPath : null,
        sessionId: identity?.sessionId ?? null, sessionFile: identity?.sessionFile ?? null,
        fileStamp: identity?.fileStamp ?? null }
    } catch (error) {
      if (error instanceof SdkTargetFailure) throw error
      if (error instanceof SessionStorageError) throw new SdkTargetFailure('SESSION_NOT_FOUND')
      throw new SdkTargetFailure('AUTHORIZATION_FAILED')
    }
  }

  /**
   * 本次授权使用的专家：先看这次打开请求暂存的值，没有再看持久绑定。
   * `sessionId` 是持久绑定的定位键，`pendingSessionId` 是本次请求带来的暂存键：新会话在切换之后才有 id，
   * 请求值仍挂在 `new` 上，两者不能共用同一个键去查，否则会把「刚选好的专家」查成没有。
   * 未启用绑定时只接受请求值，行为与未引入专家前一致。
   */
  private async expertOf(
    projectPath: string, sessionId: string | null, workspaceId: string, pendingSessionId: string | null = sessionId
  ): Promise<string | null> {
    const pending = this.pendingExperts.get(this.expertKey(workspaceId, pendingSessionId))
    if (this.options.sessionExperts === undefined) return isExpertId(pending) ? pending : null
    return resolveSessionExpert({
      bindings: this.options.sessionExperts, projectPath, sessionId, requested: pending
    })
  }

  /**
   * 本会话绑定的团队标识（含本次请求的暂存值）；绑定存在不代表团队可开团，
   * 是否生效由 `openableTeam` 再判一次。
   */
  private async boundTeamId(
    projectPath: string, sessionId: string | null, workspaceId: string, pendingSessionId: string | null = sessionId
  ): Promise<string | null> {
    const pending = this.pendingTeams.get(this.expertKey(workspaceId, pendingSessionId))
    if (this.options.sessionTeams === undefined) return isExpertId(pending) ? pending : null
    return resolveSessionTeam({
      bindings: this.options.sessionTeams, projectPath, sessionId, requested: pending
    })
  }

  /**
   * 可开团判定：只有团长与至少一名成员都在专家清单里才成立。
   * 团队未就绪、已删除或清单读不出来都按未开团处理——只开一半的团队比不开更糟。
   */
  private openableTeam(teamId: string | null): TeamView | null {
    if (teamId === null) return null
    try {
      const team = this.options.readTeamCatalog?.().teams.find(item => item.id === teamId) ?? null
      return team !== null && team.ready ? team : null
    } catch (error) {
      console.error('[session-manager] 团队清单读取失败，按未开团处理', error)
      return null
    }
  }

  /**
   * 本次生效的专家与团队：团队就绪时团长是唯一的专家来源，
   * 否则会出现「团队一个团长、会话另一个专家」两份权威。
   */
  private async sessionBindings(
    projectPath: string, sessionId: string | null, workspaceId: string, pendingSessionId: string | null = sessionId
  ): Promise<{ readonly expertId: string | null; readonly teamId: string | null }> {
    const team = this.openableTeam(await this.boundTeamId(projectPath, sessionId, workspaceId, pendingSessionId))
    if (team !== null) return { expertId: team.leadExpertId, teamId: team.id }
    return { expertId: await this.expertOf(projectPath, sessionId, workspaceId, pendingSessionId), teamId: null }
  }

  /**
   * 读执行模式；读失败按标准模式处理。偏好读不到时不能默默收紧 Agent 的能力集，
   * 也不应因此让用户建不了会话。
   */  private async executionMode(): Promise<ExecutionMode> {
    try {
      return await this.options.readExecutionMode()
    } catch {
      return 'standard'
    }
  }

  /**
   * 指定项目的会话列表窗口；只接受已添加项目的规范路径，不要求它是当前项目。
   * 未添加的目录一律拒绝，页面不能借列表接口探测任意目录。
   */
  async list(projectPath: string, limit: number): Promise<SessionListResult> {
    try {
      const requested = await normalizeProjectPath(projectPath)
      if (!await this.options.projects.hasProject(requested)) {
        throw new SessionFailure('INVALID_PROJECT_PATH', '只能读取已添加项目的会话。')
      }
      const list = await listSessions(requested, limit)
      // 列表读取成功后预热该项目的只读解析宿主，为后续历史读取准备 SDK。
      // 预热只保活一个解析进程，不改登记、不占会话、不报错，失败也只是退回冷启动。
      this.options.sdk.prepareProject(requested)
      return { ok: true, data: list }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '读取会话列表时发生未预期的内部错误。'
      })
    }
  }

  /**
   * 会话历史读取：页面只给项目与会话，这里判定该会话当前由哪条路径作答。
   * 已被运行实例接管时由绑定路径读权威分支（绑定代际在 SDK 桥内复核）；未接管时由宿主解析日志文件。
   * 两条都返回会话所属工作区，不启动执行会话或写入会话日志；缺少默认工作区时可登记其元数据。
   * 读取不申请信任或占用；读不到时页面退回原来的等待呈现。
   */
  async readHistory(request: SessionHistoryRequest): Promise<SessionHistoryResult> {
    try {
      const projectPath = await normalizeProjectPath(request.projectPath)
      if (!await this.options.projects.hasProject(projectPath)) {
        throw new SessionFailure('INVALID_PROJECT_PATH', '只能读取已添加项目的会话历史。')
      }
      const workspace = await this.options.workspaces.contextForSession(projectPath, request.sessionId)
      const bound = await this.options.sdk.readBoundHistory({
        projectPath, sessionId: request.sessionId, query: request.query
      })
      if (bound !== null) {
        return { ok: true, data: { projectPath, sessionId: request.sessionId, workspace, data: bound } }
      }
      const identity = await resolveSdkSessionFile(projectPath, { kind: 'id', sessionId: request.sessionId })
      const data = await this.options.sdk.readSessionLog({
        projectPath, sessionId: identity.sessionId,
        sessionFile: identity.sessionFile, fileStamp: identity.fileStamp, query: request.query
      })
      return { ok: true, data: { projectPath, sessionId: identity.sessionId, workspace, data } }
    } catch (error) {
      // 游标与绑定代际已失效不是读取失败：页面据此按权威基准重建一次，
      // 因此不能落进 `INVALID_PROJECT_PATH`（项目未登记）或 `RUNTIME_NOT_READY`（宿主未就绪）的分类里。
      if (isStaleHistoryFailure(error)) {
        return { ok: false, error: { code: 'HISTORY_STALE', message: error.message } }
      }
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '读取会话历史时发生未预期的内部错误。'
      })
    }
  }

  /** 打开或新建会话；成功时只返回实际归属项目、运行实例与会话身份，不回传会话列表。 */
  async open(request: SessionOpenRequest): Promise<SessionOpenResult> {
    try {
      return { ok: true, data: await this.applyOpen(request) }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '打开会话时发生未预期的内部错误。'
      })
    } finally {
      const current = this.options.projects.currentProjectPath()
      if (current !== null && current !== request.projectPath) this.options.sdk.focusProject(current)
    }
  }

  /** 后台只接入已有会话，不允许新建、中断或修改项目信任；网络调用方仍须独立完成设备与项目授权。 */
  async openBackground(projectPath: string, sessionId: string): Promise<SessionOpenResult> {
    const request: SessionOpenRequest = { projectPath, sessionId, allowInterrupt: false }
    if (typeof sessionId !== 'string' || !isSessionOpenRequest(request)) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: '后台打开必须给出有效的项目路径与已有会话身份。' } }
    }
    try {
      return { ok: true, data: await this.applyOpen(request, 'background') }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '后台打开会话时发生未预期的内部错误。'
      })
    }
  }

  /** 后台新建仅允许已登记项目，沿用信任与目标准备门禁，不抢桌面前台或中断已有任务。 */
  async createBackground(projectPath: string): Promise<SessionOpenResult> {
    const request: SessionOpenRequest = { projectPath, sessionId: null, allowInterrupt: false }
    if (!isSessionOpenRequest(request)) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: '后台新建必须给出有效的项目路径。' } }
    }
    try {
      return { ok: true, data: await this.applyOpen(request, 'background') }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '后台新建会话时发生未预期的内部错误。'
      })
    }
  }

  /**
   * 新建与打开的公共门禁：登记与会话归属共用，只有桌面打开要求当前项目并参与前台选择。
   * 后台新建与打开先刷新项目资源与信任，缺少决定时拒绝，不代替用户授予信任；实际绑定仍经 SDK 授权链复核。
   * 多运行实例下打开其他会话不会中断正在运行的会话；后台入口固定不允许中断。
   */
  private async applyOpen(
    request: SessionOpenRequest, placement: 'foreground' | 'background' = 'foreground'
  ): Promise<SessionOpenData> {
    // 后台请求不分配选择序号，避免打断尚未完成的桌面前台选择。
    const selection = placement === 'foreground' ? this.options.sdk.beginSelection() : null
    const projectPath = await normalizeProjectPath(request.projectPath)
    if (!await this.options.projects.hasProject(projectPath)) {
      throw new SessionFailure('INVALID_PROJECT_PATH', '只能打开已添加项目的会话。')
    }
    const workspace = await this.options.workspaces.resolveForSession(projectPath, request.sessionId, request.workspaceId)
    if (selection !== null) {
      if (this.options.projects.currentProjectPath() !== projectPath) {
        throw new SessionFailure('RUNTIME_COMMAND_REJECTED', '项目已切换，未打开旧项目的会话。')
      }
      const status = this.backendStatus()
      const bound = this.boundSessionOfForeground()
      if (request.sessionId !== null && status.state === 'ready' && status.runId !== null
        && bound?.projectPath === projectPath && status.info?.sessionId === request.sessionId) {
        return this.openData(projectPath, status.runId, request.sessionId, true,
          await this.sessionBindings(projectPath, request.sessionId, workspace.id))
      }
    } else {
      const trust = await this.options.projectsTrust.refreshStatusOf(projectPath)
      if (trust.resources.length > 0 && trust.decision === null) {
        throw new SessionFailure('TRUST_REQUIRED', '该项目包含需要在桌面端作出信任决定的资源。')
      }
    }
    // 已占用的会话可复用实际实例，即使会话文件尚未落盘也不视为列表过期。
    if (request.sessionId !== null && !this.isSessionOccupied(projectPath, request.sessionId)
      && await resolveSessionFile(projectPath, request.sessionId) === null) {
      throw new SessionFailure('SESSION_NOT_FOUND', '当前项目下找不到该会话；列表可能已过期。')
    }

    // 专家与团队随本次打开请求暂存：宿主授权时只拿得到引用与工作区，取不到页面请求本身。
    const expertKey = this.expertKey(workspace.id, request.sessionId)
    if (request.expertId !== undefined) {
      this.pendingExperts.set(expertKey, isExpertId(request.expertId) ? request.expertId : null)
    }
    if (request.teamId !== undefined) {
      this.pendingTeams.set(expertKey, isExpertId(request.teamId) ? request.teamId : null)
    }
    try {
      return await this.openWithSdk(projectPath, request, selection, workspace.id)
    } finally {
      this.pendingExperts.delete(expertKey)
      this.pendingTeams.delete(expertKey)
    }
  }

  /** 该会话是否已由某个运行实例占用；占用覆盖打开中与未确认退出，与会话文件是否已落盘无关。 */
  private isSessionOccupied(projectPath: string, sessionId: string): boolean {
    return this.options.ownership.runOfSession(projectPath, sessionId) !== null
  }

  /**
   * SDK 主链：目标预检、信任判定与旧会话收敛都由宿主在替换前完成，
   * 这里只复核实际打开的会话；成功后的状态经事件收敛。
   */
  private async openWithSdk(
    projectPath: string, request: SessionOpenRequest, selection: number | null, workspaceId: string
  ): Promise<SessionOpenData> {
    const switched = await this.options.sdk.switchSession(
      request.sessionId === null ? 'new' : 'open',
      request.sessionId === null ? { kind: 'new' } : { kind: 'id', sessionId: request.sessionId },
      request.allowInterrupt,
      { projectPath, sessionId: request.sessionId, workspaceId },
      selection
    )
    if (switched.cancelled) {
      throw new SessionFailure('RUNTIME_COMMAND_REJECTED', '会话切换被取消，当前会话保持不变。')
    }
    const openedSessionId = this.options.sdk.sessionStatusOfRun(switched.runId)?.sessionId ?? null
    if (request.sessionId !== null && openedSessionId !== request.sessionId) {
      // 目标一致性由宿主预检保证；这里只复核实际打开的会话，不删除任何文件。
      throw new SessionFailure('SESSION_NOT_FOUND', '实际打开的会话与请求不一致；未改动任何已有文件。')
    }
    // 专家与团队只解析一次：同一个值既用于新会话落盘，也用于打开回显，不再按新的会话 id 反查一遍。
    const bindings = await this.sessionBindings(projectPath, openedSessionId, workspaceId, request.sessionId)
    if (request.sessionId === null && openedSessionId !== null) {
      if (bindings.expertId !== null) await this.rememberNewSessionExpert(projectPath, openedSessionId, bindings.expertId)
      if (bindings.teamId !== null) await this.rememberNewSessionTeam(projectPath, openedSessionId, bindings.teamId)
      // 成员会话随开团物化：只有登记，不启动进程。
      if (bindings.teamId !== null) await this.rememberTeamMembers(projectPath, openedSessionId, bindings.teamId)
    }
    // 后台结果不走桌面的前台归属收敛，不能因桌面正在显示其他项目而触发 focusProject。
    return this.openData(projectPath, switched.runId, openedSessionId, selection !== null, bindings)
  }

  /**
   * 新会话的专家绑定：会话身份在打开成功时才有，页面要到首轮消息落盘后才知道 id，故由这里写入。
   * 写失败不让打开失败——专家是增强，重新打开会话重新选即可；记录一次即可查。
   */
  private async rememberNewSessionExpert(projectPath: string, sessionId: string, expertId: string): Promise<void> {
    try {
      await this.options.sessionExperts?.save({ projectPath, sessionId, expertId })
    } catch (error) {
      console.error('[session-manager] 会话专家绑定写入失败', error)
    }
  }

  /** 新会话的团队绑定：与专家绑定同一步写入，写失败不影响打开——重开会话重新选即可。 */
  private async rememberNewSessionTeam(projectPath: string, sessionId: string, teamId: string): Promise<void> {
    try {
      await this.options.sessionTeams?.save({ projectPath, sessionId, teamId })
    } catch (error) {
      console.error('[session-manager] 会话团队绑定写入失败', error)
    }
  }

  /**
   * 物化成员登记：按团队定义的成员逐个建一条，已存在的保留其会话 id。
   * 写失败不影响打开——团队仍能工作，只是成员清单缺项，重新开团会再补。
   */
  private async rememberTeamMembers(projectPath: string, rootSessionId: string, teamId: string): Promise<void> {
    const bindings = this.options.teamSessions
    if (bindings === undefined) return
    const team = this.openableTeam(teamId)
    if (team === null) return
    try {
      await materializeTeamSessions({
        bindings,
        projectPath,
        rootSessionId,
        teamId: team.id,
        memberExpertIds: team.memberExpertIds
      })
    } catch (error) {
      console.error('[session-manager] 成员会话登记写入失败', error)
    }
  }

  /**
   * 桌面打开结果与前台归属收敛：实际归属项目、运行实例与实际会话身份。
   * 不再附带回传会话列表：列表由页面按自己的窗口节奏单独读取，打开链不等目录扫描。
   * 列表读取可能晚于前台切换，因此实际打开身份必须在读取前固定。
   * 专家由打开链解析后传入：这里不再自行反查，回显与本次生效的必须是同一个值。
   */
  private async openData(
    projectPath: string, runId: number, openedSessionId: string | null, focus: boolean,
    bindings: { readonly expertId: string | null; readonly teamId: string | null }
  ): Promise<SessionOpenData> {
    const workspaceId = this.options.ownership.workspaceOfRun(runId)
    if (workspaceId === null) throw new SessionFailure('RUNTIME_NOT_READY', '运行实例缺少已授权工作区，未使用项目目录代替。')
    const workspace = await this.options.workspaces.authorize(projectPath, workspaceId)
    await this.options.workspaces.bindSession(projectPath, openedSessionId, workspaceId)
    const currentProjectPath = this.options.projects.currentProjectPath()
    if (focus && currentProjectPath !== null && currentProjectPath !== projectPath) {
      // 等待宿主期间用户可能已经切项目；旧请求不能把前台留在原项目。
      this.options.sdk.focusProject(currentProjectPath)
    }
    return { projectPath, runId, openedSessionId, workspace, expertId: bindings.expertId, teamId: bindings.teamId }
  }

  /**
   * 删除会话：以显式项目路径定位，只接受已添加项目；会话正被运行实例占用时先收敛占用再删文件。
   * 门禁与项目移除同一套：正在打开或关闭的实例直接拒绝；在途工作未确认中断时拒绝，
   * 页面拿到 `SESSION_SWITCH_BLOCKED` 后走既有中断确认弹层重试。释放失败时文件保持原样。
   */
  async delete(request: SessionDeleteRequest): Promise<SessionDeleteResult> {
    try {
      const projectPath = await normalizeProjectPath(request.projectPath)
      if (!await this.options.projects.hasProject(projectPath)) {
        throw new SessionFailure('INVALID_PROJECT_PATH', '只能删除已添加项目的会话。')
      }
      // 文件归属先于占用收敛：解析不到的目标不释放任何运行实例，页面拿到可重试的列表过期提示。
      if (await resolveSessionFile(projectPath, request.sessionId) === null) {
        throw new SessionFailure('SESSION_NOT_FOUND', '当前项目下找不到该会话；列表可能已过期。')
      }
      const run = this.options.ownership.runOfSession(projectPath, request.sessionId)
      if (run !== null) {
        if (run.phase === 'opening' || run.phase === 'closing') {
          throw new SessionFailure('SESSION_SWITCH_BLOCKED', '该会话的运行实例正在打开或关闭，请稍后再删除。')
        }
        if (!request.allowInterrupt && this.options.sdk.runHasPendingWork(run.runId)) {
          throw new SessionFailure('SESSION_SWITCH_BLOCKED', '该会话有正在运行的操作；确认后会先停止它再删除。')
        }
        // 运行中与退出未确认的占用都经同一释放链收敛；宿主已失败时释放只解除占用。
        const released = await this.options.sdk.releaseRun(run.runId, request.allowInterrupt)
        if (!released.ok) {
          throw new SessionFailure('SESSION_SWITCH_BLOCKED', '会话的运行实例未能释放，会话未删除；可稍后重试。')
        }
      }
      await deleteSessionFile(projectPath, request.sessionId)
      // 绑定只是标识记录：清理失败不影响已完成的删除，也不阻断后续工作区清理。
      await this.options.sessionExperts?.forget(projectPath, request.sessionId).catch(() => undefined)
      await this.options.sessionTeams?.forget(projectPath, request.sessionId).catch(() => undefined)
      // 成员登记随根会话清理；成员会话文件一并移入系统废纸篓，不让它们脱离根会话留在磁盘上。
      await this.options.teamSessions?.forget(projectPath, request.sessionId).catch(() => undefined)
      await removeTeamSessionDirectory(request.sessionId).catch(() => undefined)
      // 会话已删：按偏好清理它独占且无改动的任务工作树。清理失败不回滚删除，也不影响列表返回。
      await this.cleanupWorkspaceAfterDelete(projectPath, request.sessionId)
      return { ok: true, data: await listSessions(projectPath, request.listLimit) }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '删除会话时发生未预期的内部错误。'
      })
    }
  }

  /**
   * 删除会话后的工作树清理：偏好关闭或未注入实现时什么都不做；异常不外抛，
   * 否则会把已完成的删除报成失败，让用户误以为会话还在。
   */
  private async cleanupWorkspaceAfterDelete(projectPath: string, sessionId: string): Promise<void> {
    const read = this.options.readCleanupOnSessionDelete
    const cleanup = this.options.cleanupSessionWorkspace
    if (read === undefined || cleanup === undefined) return
    try {
      if (!await read()) return
      await cleanup(projectPath, sessionId)
    } catch (error) {
      console.warn('[session] 删除会话后清理工作树失败：', error)
    }
  }

  /**
   * 重新加载 Pi 资源：宿主在同一进程内重建会话 services；守门与打开链复用，
   * 但不做“同会话幂等返回”，因为目的正是重建服务。
   */
  async reload(allowInterrupt: boolean): Promise<SessionOpenResult> {
    try {
      return { ok: true, data: await this.applyReload(allowInterrupt) }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '重新加载 Pi 资源时发生未预期的内部错误。'
      })
    }
  }

  /**
   * 重载编排：目标是前台运行实例当前绑定的会话，目标与会话身份在提交前固定。
   * 信任按被重载会话的归属项目复核，避免用前台项目代替它的授权范围。
   */
  private async applyReload(allowInterrupt: boolean): Promise<SessionOpenData> {
    this.requireProjectPath()
    const status = this.backendStatus()
    if (status.state === 'starting' || status.state === 'stopping') {
      throw new SessionFailure('SESSION_SWITCH_BLOCKED', 'Runtime 正在启动或关闭，请稍后再重新加载资源。')
    }
    if (status.state === 'ready' && status.info?.isStreaming === true && !allowInterrupt) {
      throw new SessionFailure(
        'SESSION_SWITCH_BLOCKED',
        '当前有正在运行的操作；确认后会先停止它再重新加载资源。'
      )
    }

    // 宿主按目标会话重建 services；会话已有消息但文件缺失时由宿主拒绝。
    const bound = this.boundSessionOfForeground()
    if (bound === null) {
      throw new SessionFailure('RUNTIME_NOT_READY', '当前没有可重新加载的会话。')
    }
    const selection = this.options.sdk.beginSelection()
    const trust = await this.options.projectsTrust.refreshStatusOf(bound.projectPath)
    if (trust.resources.length > 0 && trust.decision === null) {
      throw new SessionFailure('TRUST_REQUIRED', '该会话所属项目包含需要信任决定的资源。')
    }
    const switched = await this.options.sdk.switchSession('reload', { kind: 'new' }, allowInterrupt,
      { projectPath: bound.projectPath, sessionId: bound.sessionId, workspaceId: bound.workspaceId }, selection)
    if (switched.cancelled) {
      throw new SessionFailure('RUNTIME_COMMAND_REJECTED', '重新加载资源被取消，当前会话保持不变。')
    }
    const openedSessionId = this.options.sdk.sessionStatusOfRun(switched.runId)?.sessionId ?? null
    // reload 不带请求值：专家与团队都以持久绑定为准，绑定不存在的会话两项都为 null。
    const bindings = openedSessionId === null
      ? { expertId: null, teamId: null }
      : await this.sessionBindings(bound.projectPath, openedSessionId, bound.workspaceId)
    return this.openData(bound.projectPath, switched.runId, openedSessionId, true, bindings)
  }

  /**
   * 前台运行实例当前绑定的会话；没有前台实例、尚未绑定或未登记归属项目时返回 null，
   * 调用方据此按未就绪拒绝，不用前台项目或本地缓存代替目标。
   */
  private boundSessionOfForeground(): {
    readonly projectPath: string
    readonly sessionId: string | null
    readonly workspaceId: string
  } | null {
    const runId = this.options.sdk.foregroundRunId()
    if (runId === null) return null
    const status: SdkSessionStatus | null = this.options.sdk.sessionStatusOfRun(runId)
    if (status === null || status.bindingId === null || status.projectPath === null) return null
    const workspaceId = this.options.ownership.workspaceOfRun(runId)
    if (workspaceId === null) return null
    return { projectPath: status.projectPath, sessionId: status.sessionId, workspaceId }
  }

  private requireProjectPath(): string {
    const projectPath = this.options.projects.currentProjectPath()
    if (projectPath === null) {
      throw new SessionFailure('INVALID_PROJECT_PATH', '尚未选择项目，无法读取会话。')
    }
    return projectPath
  }

  /** 门禁与幂等判断都读会话后端的实际状态，不使用第二份快照。 */
  private backendStatus(): RuntimeStatus {
    const result = this.options.sdk.getStatus()
    if (!result.ok) {
      throw new SessionFailure('INTERNAL_ERROR', '无法读取 Runtime 状态。')
    }
    return result.data
  }

  private failure(error: unknown, fallback: SessionError): { ok: false; error: SessionError } {
    if (error instanceof SessionFailure) {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    if (error instanceof ProjectPathError) {
      return { ok: false, error: { code: 'INVALID_PROJECT_PATH', message: error.message } }
    }
    if (error instanceof SessionStorageError || error instanceof WorkspaceStorageError) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: error.message } }
    }
    if (error instanceof WorktreeOperationError) {
      return { ok: false, error: { code: error.code === 'TRUST_REQUIRED' ? 'TRUST_REQUIRED' : 'RUNTIME_COMMAND_REJECTED', message: error.message } }
    }
    // 宿主与会话授权失败按固定分类映射；未知异常仍收敛为调用方的兜底错误。
    if (error instanceof SdkHostError || error instanceof SdkTargetFailure) {
      return { ok: false, error: sessionErrorOf(error) }
    }
    return { ok: false, error: fallback }
  }
}
