/**
 * 认证执行端的唯一持有者：懒启动并管理认证辅助进程，把辅助进程的帧投影为 Provider 状态与登录流程
 * 快照，编排登录、提示回应、取消、退出登录与外链打开。
 *
 * 边界：
 * - 凭据读写全部由官方 SDK 在辅助进程内完成，落在 `<agent-dir>/auth.json`；主进程不读、不写、
 *   也不回传任何已有凭据内容。
 * - 页面提交的密钥只经 `respondPrompt` 单向转发给辅助进程；本模块不记录密钥，也不把它写进任何
 *   日志、快照或错误文本。
 * - 页面不能指定辅助进程路径、命令文本或 URL：外链打开只接受本模块从流程帧里记录的地址。
 * - 同一时刻只允许一个登录流程，取消与失败都如实投影，不把 UI 状态变化当作 Pi 已使用新凭据。
 */
import { randomUUID } from 'node:crypto'
import type {
  AuthErrorCode,
  AuthFlowDeviceCode,
  AuthFlowPhase,
  AuthFlowSnapshot,
  AuthMethod,
  AuthPrompt,
  AuthStatus
} from '../shared/auth-api'
import { AUTH_MAX_SECRET_CHARS, AUTH_MAX_SELECT_VALUE_CHARS } from '../shared/auth-api'
import { isAuthStatusPayload } from '../auth-helper/protocol'
import type { AuthHelperErrorCode, AuthHelperFrame, AuthHelperRequestInput } from '../auth-helper/protocol'
import { AuthHelperProcess, AuthHelperProcessError } from './auth-helper-process'
import type { DesktopConfigStore } from './desktop-config-store'
import { ExternalUrlError, isOpenableAuthUrl, openAuthUrl } from './external-url'

/** 状态读取的等待上限；官方按 Provider 逐个解析凭据，第一次读取会做一次本地可用性刷新。 */
const STATUS_TIMEOUT_MS = 30_000

/** 退出登录的等待上限。 */
const LOGOUT_TIMEOUT_MS = 30_000

/** 登录与取消请求的等待上限：只等待请求被接受，不等待整个登录流程结束。 */
const COMMAND_TIMEOUT_MS = 15_000

/** 关闭辅助进程前等待它回应 shutdown 的期限。 */
const SHUTDOWN_TIMEOUT_MS = 2_000

/** 流程内进度文本保留条数上限；超出丢弃最旧的一条。 */
const MAX_FLOW_MESSAGES = 8

/** 认证执行端错误：错误码直接映射到共享契约。 */
export class AuthManagerError extends Error {
  constructor(readonly code: AuthErrorCode, message: string) {
    super(message)
  }
}

/** 与辅助进程的请求结果；超时统一映射为 `AUTH_UNAVAILABLE`。 */
type HelperOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly code: AuthErrorCode; readonly message: string }

interface PendingRequest {
  readonly settle: (outcome: HelperOutcome) => void
}

/** 流程的完整内部状态；快照只暴露页面需要的部分。 */
interface LoginFlowState {
  readonly flowId: string
  readonly providerId: string
  readonly method: AuthMethod
  phase: AuthFlowPhase
  prompt: AuthPrompt | null
  readonly messages: string[]
  deviceCode: AuthFlowDeviceCode | null
  /** 最近的授权或设备码验证地址；只在本模块内使用，不进快照。 */
  lastUrl: string | null
  browserOpened: boolean
  message: string | null
}

const TERMINAL_PHASES: readonly AuthFlowPhase[] = ['completed', 'failed', 'cancelled']

function isTerminal(phase: AuthFlowPhase): boolean {
  return TERMINAL_PHASES.includes(phase)
}

/** 辅助进程错误码到共享错误码的映射；未列出的取值按执行端不可用处理。 */
function mapHelperCode(code: AuthHelperErrorCode): AuthErrorCode {
  switch (code) {
    case 'AUTH_PROVIDER_UNKNOWN': return 'AUTH_PROVIDER_UNKNOWN'
    case 'AUTH_LOGIN_NOT_FOUND': return 'AUTH_LOGIN_NOT_FOUND'
    case 'AUTH_PROMPT_MISMATCH': return 'AUTH_PROMPT_MISMATCH'
    case 'INVALID_REQUEST': return 'INVALID_REQUEST'
    default: return 'AUTH_UNAVAILABLE'
  }
}

function describeExit(event: { readonly code: number | null; readonly signal: string | null }): string {
  if (event.code !== null) return `认证辅助进程已退出（退出码 ${event.code}）。`
  if (event.signal !== null) return `认证辅助进程被信号 ${event.signal} 结束。`
  return '认证辅助进程已退出。'
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}

export interface AuthManagerOptions {
  readonly store: DesktopConfigStore
  /** 外链打开入口；便于测试替换，默认交给系统浏览器。 */
  readonly openUrl?: (url: string) => Promise<void>
  /** 是否自动打开授权地址；设备码流程不自动打开。 */
  readonly autoOpenAuthUrl?: boolean
}

export class AuthManager {
  private helper: AuthHelperProcess | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(snapshot: AuthFlowSnapshot) => void>()
  private flow: LoginFlowState | null = null
  private disposed = false

  constructor(private readonly options: AuthManagerOptions) {}

  onFlowChanged(listener: (snapshot: AuthFlowSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 读取 Provider 与认证状态；`flow` 是当前登录流程快照（没有时为 null）。 */
  async readStatus(): Promise<AuthStatus> {
    const outcome = await this.request({ type: 'status' }, STATUS_TIMEOUT_MS)
    if (!outcome.ok) throw new AuthManagerError(outcome.code, outcome.message)
    if (!isAuthStatusPayload(outcome.data)) {
      throw new AuthManagerError('INTERNAL_ERROR', '认证辅助进程返回的状态不符合约定。')
    }
    return {
      providers: outcome.data.providers,
      configError: outcome.data.configError,
      flow: this.flowSnapshot()
    }
  }

  /**
   * 启动官方登录流程。同一时刻只允许一个流程；成功只表示流程已开始，
   * 结果（完成、失败、取消）由流程快照与事件收敛。
   */
  async beginLogin(providerId: string, method: AuthMethod): Promise<AuthFlowSnapshot> {
    if (this.flow !== null && !isTerminal(this.flow.phase)) {
      throw new AuthManagerError('AUTH_LOGIN_CONFLICT', '已有一个登录流程在进行中，请先完成或取消它。')
    }

    const deviceId = await this.readDeviceId()
    const flow: LoginFlowState = {
      flowId: randomUUID(),
      providerId,
      method,
      phase: 'waiting',
      prompt: null,
      messages: [],
      deviceCode: null,
      lastUrl: null,
      browserOpened: false,
      message: null
    }
    this.flow = flow

    let outcome: HelperOutcome
    try {
      outcome = await this.request(
        { type: 'login', flowId: flow.flowId, providerId, method, deviceId },
        COMMAND_TIMEOUT_MS
      )
    } catch (error) {
      // 请求本身没有发出去（例如辅助进程不可用）：不留下一个永远不会推进的流程。
      this.flow = null
      throw error
    }
    if (!outcome.ok) {
      // 流程没有真正开始：清掉占位状态，避免页面看到一个永远不推进的流程。
      this.flow = null
      throw new AuthManagerError(outcome.code, outcome.message)
    }
    this.publish()
    return this.requireSnapshot()
  }

  /** 回应流程中的当前提示；密钥只经这里单向传给辅助进程。 */
  async respondPrompt(flowId: string, promptId: string, value: string): Promise<AuthFlowSnapshot> {
    const flow = this.requireFlow(flowId)
    const prompt = flow.prompt
    if (prompt === null || prompt.promptId !== promptId) {
      throw new AuthManagerError('AUTH_PROMPT_MISMATCH', '该提示已经不再等待回应。')
    }
    if (prompt.kind === 'select') {
      const allowed = prompt.options.some((option) => option.id === value)
      if (!allowed || value.length > AUTH_MAX_SELECT_VALUE_CHARS) {
        throw new AuthManagerError('INVALID_REQUEST', '选项回应不在本次提示的候选中。')
      }
    } else {
      if (value.length === 0) {
        throw new AuthManagerError('INVALID_REQUEST', '输入不能为空；如需放弃请取消登录流程。')
      }
      if (value.length > AUTH_MAX_SECRET_CHARS) {
        throw new AuthManagerError('INVALID_REQUEST', `输入超过 ${AUTH_MAX_SECRET_CHARS} 字符上限。`)
      }
    }

    const outcome = await this.request(
      { type: 'prompt-response', flowId: flow.flowId, promptId, value },
      COMMAND_TIMEOUT_MS
    )
    if (!outcome.ok) throw new AuthManagerError(outcome.code, outcome.message)
    if (flow.prompt !== null && flow.prompt.promptId === promptId) {
      flow.prompt = null
      flow.phase = 'waiting'
      this.publish()
    }
    return this.requireSnapshot()
  }

  /** 取消登录流程；取消后凭据不会保存。 */
  async cancelLogin(flowId: string): Promise<AuthFlowSnapshot> {
    const flow = this.requireFlow(flowId)
    if (isTerminal(flow.phase)) return this.requireSnapshot()

    flow.phase = 'cancelling'
    this.publish()
    const outcome = await this.request({ type: 'cancel', flowId: flow.flowId }, COMMAND_TIMEOUT_MS)
    if (!outcome.ok) {
      // 取消失败时不假装已取消：流程状态由辅助进程的结束帧或退出收敛。
      flow.message = outcome.message
      this.publish()
      throw new AuthManagerError(outcome.code, outcome.message)
    }
    return this.requireSnapshot()
  }

  /**
   * 在系统浏览器中打开该流程记录的授权地址（或设备码验证地址）。
   * 页面只传 flowId，地址来自辅助进程的帧，因此不接受页面传入的任意 URL。
   */
  async openFlowUrl(flowId: string): Promise<AuthFlowSnapshot> {
    const flow = this.requireFlow(flowId)
    const url = flow.lastUrl
    if (url === null || isTerminal(flow.phase)) {
      throw new AuthManagerError('AUTH_OPEN_URL_FAILED', '当前流程没有可打开的授权地址。')
    }
    try {
      await this.openUrl(url)
      flow.browserOpened = true
      this.publish()
    } catch (error) {
      throw new AuthManagerError(
        'AUTH_OPEN_URL_FAILED',
        error instanceof ExternalUrlError ? error.message : '无法在系统浏览器中打开授权地址。'
      )
    }
    return this.requireSnapshot()
  }

  /** 删除已保存的凭据；不影响环境变量与 models.json 配置。成功后返回刷新后的状态。 */
  async logout(providerId: string): Promise<AuthStatus> {
    const outcome = await this.request({ type: 'logout', providerId }, LOGOUT_TIMEOUT_MS)
    if (!outcome.ok) throw new AuthManagerError(outcome.code, outcome.message)
    return this.readStatus()
  }

  /** 应用退出时使用：先请辅助进程自行退出，超时后按平台兜底终止。 */
  async stop(): Promise<void> {
    this.disposed = true
    const helper = this.helper
    this.helper = null
    this.failAllPending(new AuthManagerError('AUTH_UNAVAILABLE', '认证执行端已关闭。'))
    if (this.flow !== null && !isTerminal(this.flow.phase)) {
      this.flow.phase = 'cancelled'
      this.flow.prompt = null
      this.flow.message = '应用退出，登录流程已中止。'
      this.publish()
    }
    if (helper === null) return
    try {
      await this.requestOn(helper, { type: 'shutdown' }, SHUTDOWN_TIMEOUT_MS)
    } catch {
      // 辅助进程没有回应关闭请求时直接进入关闭链。
    }
    await helper.stop()
  }

  /** 处理辅助进程的单帧；形状已由进程层校验。 */
  private handleFrame(frame: AuthHelperFrame): void {
    switch (frame.type) {
      case 'response': {
        const pending = this.pending.get(frame.id)
        if (pending === undefined) return
        this.pending.delete(frame.id)
        pending.settle(frame.ok
          ? { ok: true, data: frame.data }
          : { ok: false, code: mapHelperCode(frame.code), message: this.withDiagnostics(frame.message) })
        return
      }
      case 'prompt': {
        const flow = this.currentFlow(frame.flowId)
        if (flow === null) return
        flow.prompt = frame.prompt
        flow.phase = 'prompt'
        this.publish()
        return
      }
      case 'prompt-void': {
        const flow = this.currentFlow(frame.flowId)
        if (flow === null || flow.prompt === null || flow.prompt.promptId !== frame.promptId) return
        flow.prompt = null
        if (!isTerminal(flow.phase)) flow.phase = 'waiting'
        this.publish()
        return
      }
      case 'notify': {
        const flow = this.currentFlow(frame.flowId)
        if (flow === null) return
        this.applyNotify(flow, frame)
        this.publish()
        return
      }
      case 'flow-end': {
        const flow = this.currentFlow(frame.flowId)
        if (flow === null) return
        flow.prompt = null
        flow.message = frame.message
        flow.phase = frame.ok ? 'completed' : frame.cancelled ? 'cancelled' : 'failed'
        this.publish()
        return
      }
    }
  }

  /** 通知帧只影响展示与「可打开地址」；打开浏览器失败不改变流程阶段。 */
  private applyNotify(flow: LoginFlowState, frame: Extract<AuthHelperFrame, { type: 'notify' }>): void {
    const event = frame.event
    if (event.kind === 'auth_url') {
      this.recordUrl(flow, event.url)
      if (event.instructions !== null) this.pushMessage(flow, event.instructions)
      if (this.options.autoOpenAuthUrl !== false && flow.lastUrl !== null) {
        void this.openUrl(flow.lastUrl)
          .then(() => {
            flow.browserOpened = true
            this.publish()
          })
          .catch(() => {
            // 打不开时保留地址，页面可再次请求打开。
            this.publish()
          })
      }
      return
    }
    if (event.kind === 'device_code') {
      flow.deviceCode = { userCode: event.userCode, verificationUri: event.verificationUri }
      // 设备码只展示地址，不自动打开浏览器。
      this.recordUrl(flow, event.verificationUri)
      return
    }
    this.pushMessage(flow, event.message)
  }

  private recordUrl(flow: LoginFlowState, url: string): void {
    flow.lastUrl = isOpenableAuthUrl(url) ? url : null
  }

  private pushMessage(flow: LoginFlowState, message: string): void {
    const text = truncate(message, 500)
    if (text === '') return
    flow.messages.push(text)
    if (flow.messages.length > MAX_FLOW_MESSAGES) flow.messages.shift()
  }

  private openUrl(url: string): Promise<void> {
    return this.options.openUrl === undefined ? openAuthUrl(url) : this.options.openUrl(url)
  }

  /**
   * 读取安装级 UUID；只在登录流程需要时读取一次并落盘。
   * 配置只读降级时返回 null，登录仍可进行，只有需要 device id 的供应商会由 Pi 自行报错。
   */
  private async readDeviceId(): Promise<string | null> {
    try {
      return await this.options.store.getOrCreateAuthDeviceId()
    } catch {
      return null
    }
  }

  private requireFlow(flowId: string): LoginFlowState {
    const flow = this.flow
    if (flow === null || flow.flowId !== flowId) {
      throw new AuthManagerError('AUTH_LOGIN_NOT_FOUND', '登录流程不存在或已结束。')
    }
    return flow
  }

  /** 帧只作用于当前流程；旧流程的迟到帧一律忽略。 */
  private currentFlow(flowId: string): LoginFlowState | null {
    const flow = this.flow
    if (flow === null || flow.flowId !== flowId) return null
    return flow
  }

  private requireSnapshot(): AuthFlowSnapshot {
    const snapshot = this.flowSnapshot()
    if (snapshot === null) {
      throw new AuthManagerError('AUTH_LOGIN_NOT_FOUND', '登录流程不存在或已结束。')
    }
    return snapshot
  }

  private flowSnapshot(): AuthFlowSnapshot | null {
    const flow = this.flow
    if (flow === null) return null
    const openable = !isTerminal(flow.phase) && flow.lastUrl !== null && isOpenableAuthUrl(flow.lastUrl)
    return {
      flowId: flow.flowId,
      providerId: flow.providerId,
      method: flow.method,
      phase: flow.phase,
      prompt: flow.prompt,
      messages: [...flow.messages],
      deviceCode: flow.deviceCode,
      browserOpened: flow.browserOpened,
      hasOpenableUrl: openable,
      message: flow.message
    }
  }

  private publish(): void {
    const snapshot = this.flowSnapshot()
    if (snapshot === null) return
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot)
      } catch {
        // 通知失败不改变流程状态。
      }
    }
  }

  private ensureHelper(): AuthHelperProcess {
    if (this.disposed) {
      throw new AuthManagerError('AUTH_UNAVAILABLE', '认证执行端已关闭。')
    }
    if (this.helper !== null && !this.helper.isExited) return this.helper

    let helper: AuthHelperProcess
    try {
      helper = AuthHelperProcess.start({
        onFrame: (frame) => this.handleFrame(frame),
        onProtocolError: () => {
          // 协议错误只影响本次记录；连接中断由退出路径收敛。
        },
        onSpawnFailure: (message) => this.failAllPending(
          new AuthManagerError('AUTH_UNAVAILABLE', `无法启动认证辅助进程：${message}`)
        ),
        onExit: (event) => this.handleExit(event)
      })
    } catch (error) {
      if (error instanceof AuthHelperProcessError) {
        throw new AuthManagerError('AUTH_UNAVAILABLE', error.message)
      }
      throw new AuthManagerError('AUTH_UNAVAILABLE', '无法启动认证辅助进程。')
    }
    this.helper = helper
    return helper
  }

  /** 辅助进程退出：收敛所有等待中的请求与进行中的流程，不自动重启。 */
  private handleExit(event: { readonly code: number | null; readonly signal: string | null }): void {
    this.helper = null
    this.failAllPending(new AuthManagerError('AUTH_UNAVAILABLE', describeExit(event)))
    const flow = this.flow
    if (flow !== null && !isTerminal(flow.phase)) {
      flow.prompt = null
      flow.phase = 'failed'
      flow.message = `${describeExit(event)}登录流程已中止。`
      this.publish()
    }
  }

  private failAllPending(error: AuthManagerError): void {
    for (const [, pending] of [...this.pending]) {
      pending.settle({ ok: false, code: error.code, message: error.message })
    }
    this.pending.clear()
  }

  private request(frame: AuthHelperRequestInput, timeoutMs: number): Promise<HelperOutcome> {
    const helper = this.ensureHelper()
    return this.requestOn(helper, frame, timeoutMs)
  }

  /** 发送一条请求并等待响应；超时只结束等待，结果未知且不自动重发。 */
  private requestOn(
    helper: AuthHelperProcess,
    frame: AuthHelperRequestInput,
    timeoutMs: number
  ): Promise<HelperOutcome> {
    const id = randomUUID()
    return new Promise<HelperOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({
          ok: false,
          code: 'AUTH_UNAVAILABLE',
          message: `认证辅助进程在 ${timeoutMs} 毫秒内没有回应本次请求；结果未知，不会自动重发。`
        })
      }, timeoutMs)

      this.pending.set(id, {
        settle: (outcome) => {
          clearTimeout(timer)
          resolve(outcome)
        }
      })

      helper.write({ ...frame, id }).catch((error: unknown) => {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        pending.settle({
          ok: false,
          code: 'AUTH_UNAVAILABLE',
          message: `无法向认证辅助进程写入请求：${error instanceof Error ? error.message : '未知原因'}`
        })
      })
    })
  }

  /** 把辅助进程最近的诊断附加到错误文本后，便于定位启动或打包问题。 */
  private withDiagnostics(message: string): string {
    const diagnostics = this.helper?.readDiagnostics() ?? []
    if (diagnostics.length === 0) return message
    return truncate(`${message}（最近诊断：${diagnostics.slice(-3).join(' | ')}）`, 800)
  }
}
