/** 远程会话能力白名单：校验设备与项目，后台新建及首条消息共用去重身份，其余写操作固定会话与绑定代际；不接受任意 IPC 或文件路径。 */
import { createHash } from 'node:crypto'
import type { DesktopConfigStore } from '../config/desktop-config-store'
import type { SessionManager } from '../sessions/session-manager'
import type { SdkRuntimeBridge } from '../sessions/sdk-runtime-bridge'
import type { LanCreatedSession, LanOperation, LanRequest, LanResult, LanSessionTarget } from '../../shared/lan-remote-api'
import type { Project } from '../../shared/project-api'
import { LanAccessError, LanDeviceManager } from './device-manager'

const MAX_WRITE_RECORDS = 1024
function unwrap<T>(result: LanResult<T>): T {
  if (!result.ok) throw new LanAccessError(result.error.code, result.error.message, 409)
  return result.data
}

export class LanSessionService {
  private stopped = false
  /** 整个服务代际保留写请求结果；满额拒绝新写入，不淘汰旧记录后悄悄重放。 */
  private readonly writes = new Map<string, { readonly fingerprint: string; readonly result: Promise<unknown> }>()
  constructor(
    readonly serverId: string,
    private readonly store: DesktopConfigStore,
    private readonly devices: LanDeviceManager,
    private readonly sessions: SessionManager,
    readonly runtime: SdkRuntimeBridge
  ) {}

  stop(): void { this.stopped = true; this.writes.clear() }
  private requireActive(): void {
    if (this.stopped) throw new LanAccessError('SERVICE_STOPPED', '局域网服务已停止，请重新连接。', 409)
  }
  async authorizeProject(deviceId: string, projectId: string): Promise<Project> {
    this.requireActive()
    const { projects } = await this.store.list()
    await this.devices.requireDevice(deviceId)
    this.requireActive()
    const project = projects.find(entry => entry.id === projectId)
    if (!project) throw new LanAccessError('FORBIDDEN', '项目已被移除，请刷新项目列表。')
    return project
  }

  async authorizeTarget(deviceId: string, ref: LanSessionTarget): Promise<Project> {
    const project = await this.authorizeProject(deviceId, ref.projectId)
    const run = this.runtime.listRunStates().find(entry => entry.runId === ref.target.runId)
    const status = this.runtime.getStatusOfRun(ref.target.runId)
    if (!run || run.projectPath !== project.path || run.sessionId !== ref.sessionId || run.phase !== 'running'
      || !status || status.runtimeId !== ref.target.runtimeId || status.sessionId !== ref.sessionId) {
      throw new LanAccessError('TARGET_CHANGED', '会话或运行代际已变化，请重新打开会话。', 409)
    }
    return project
  }

  async snapshot(deviceId: string, ref: LanSessionTarget) {
    await this.authorizeTarget(deviceId, ref)
    const projection = unwrap(await this.runtime.getProjection(ref.target))
    await this.authorizeTarget(deviceId, ref)
    if (projection.runtimeId !== ref.target.runtimeId) throw new LanAccessError('TARGET_CHANGED', '会话投影已换代，请重新打开会话。', 409)
    return { status: this.runtime.getStatusOfRun(ref.target.runId), projection,
      interaction: this.runtime.getExtensionUiSnapshot(ref.target.runId) }
  }

  execute(deviceId: string, request: LanRequest): Promise<unknown> {
    this.requireActive()
    if (request.serverId !== this.serverId) throw new LanAccessError('SERVER_CHANGED', '局域网服务已重启；旧写请求不会重新执行，请刷新连接。', 409)
    const command = request.command
    if (command.operation === 'projects' || command.operation === 'sessions'
      || command.operation === 'history' || command.operation === 'snapshot') return this.dispatch(deviceId, command)
    const key = `${deviceId}:${request.requestId}`
    const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex')
    const previous = this.writes.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new LanAccessError('REQUEST_CONFLICT', '同一个请求身份不能提交不同操作。', 409)
      // 重试仍须有当前设备授权；不因缓存命中绕过撤销。
      return this.authorizeProject(deviceId, command.projectId).then(() => previous.result)
    }
    if (this.writes.size >= MAX_WRITE_RECORDS) throw new LanAccessError('REQUEST_LIMIT', '请求去重记录已满，请在桌面关闭后重新开启局域网访问。', 429)
    const result = Promise.resolve().then(() => this.dispatch(deviceId, command))
    this.writes.set(key, { fingerprint, result })
    return result
  }

  private async dispatch(deviceId: string, command: LanOperation): Promise<unknown> {
    this.requireActive()
    if (command.operation === 'projects') {
      const { projects } = await this.store.list()
      await this.devices.requireDevice(deviceId)
      this.requireActive()
      return { projects: projects.map(project => ({ id: project.id, name: project.name })) }
    }
    if (command.operation === 'sessions') {
      const project = await this.authorizeProject(deviceId, command.projectId)
      const list = unwrap(await this.sessions.list(project.path, command.limit))
      await this.authorizeProject(deviceId, command.projectId)
      return { projectId: command.projectId, sessions: list.sessions, remaining: list.remaining, skipped: list.skipped, limit: list.limit }
    }
    if (command.operation === 'history') {
      const project = await this.authorizeProject(deviceId, command.projectId)
      const result = unwrap(await this.sessions.readHistory({ projectPath: project.path, sessionId: command.sessionId, query: command.query }))
      await this.authorizeProject(deviceId, command.projectId)
      return { projectId: command.projectId, sessionId: command.sessionId, data: result.data }
    }
    if (command.operation === 'open') {
      const project = await this.authorizeProject(deviceId, command.projectId)
      const opened = unwrap(await this.sessions.openBackground(project.path, command.sessionId))
      await this.authorizeProject(deviceId, command.projectId)
      return { projectId: command.projectId, sessionId: opened.openedSessionId,
        target: { runId: opened.runId, runtimeId: this.runtime.getStatusOfRun(opened.runId)?.runtimeId ?? null } }
    }
    if (command.operation === 'create') {
      const project = await this.authorizeProject(deviceId, command.projectId)
      const opened = unwrap(await this.sessions.createBackground(project.path))
      await this.authorizeProject(deviceId, command.projectId)
      const sessionId = opened.openedSessionId
      if (sessionId === null) throw new LanAccessError('INVALID_RESPONSE', '新建会话未返回实际会话身份，请先核对电脑上的结果。', 409)
      const status = this.runtime.getStatusOfRun(opened.runId)
      const target = { runId: opened.runId, runtimeId: status?.sessionId === sessionId ? status.runtimeId : null }
      // 会话已经创建：首条消息失败也返回原身份，手机后续只能重试发送，不再重新新建。
      const created: LanCreatedSession = { projectId: command.projectId, sessionId, target,
        prompt: target.runtimeId === null
          ? { ok: false, error: { code: 'RUNTIME_NOT_READY', message: '会话已创建但运行目标尚未就绪，请重新连接后发送。' } }
          : await this.runtime.prompt(target, command.message, []) }
      return created
    }
    if (command.operation === 'snapshot') return this.snapshot(deviceId, command)
    await this.authorizeTarget(deviceId, command)
    switch (command.operation) {
      case 'prompt': return unwrap(await this.runtime.prompt(command.target, command.message, []))
      case 'abort': return unwrap(await this.runtime.abort(command.target))
      case 'respond': {
        const response = await this.runtime.respondExtensionDialog(command.target, command.dialogId, command.response)
        if (!response) throw new LanAccessError('INTERACTION_ENDED', '该问题已处理或失效，请刷新会话。', 409)
        return response
      }
    }
  }
}
