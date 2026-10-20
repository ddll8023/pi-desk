/**
 * 终端功能的页面契约适配层：把渲染端请求转成守护进程请求，并保持原有的项目校验与错误文案。
 *
 * 终端进程、缓冲、背压与画面状态都不在这里——它们由独立守护进程持有，应用退出后继续运行。这一层只做三件事：
 * 把页面给的项目路径收敛为已登记项目的规范路径、把守护进程的错误码翻成页面契约、把输出与退出事件转给页面。
 *
 * 页面暂时不在（重载、窗口关闭）时不保留输出：守护进程的画面状态是权威来源，重新挂载后按快照补齐；
 * 这里只需立刻回报消费量，让守护进程继续下发，不把额度耗在没人接收的数据上。
 *
 * 应用退出只断开连接，不终止终端；关闭终端、关闭全部终端与结束旧版本守护进程都是用户显式动作。
 */
import type {
  TerminalCommandResult,
  TerminalCreateRequest,
  TerminalDaemonStatus,
  TerminalDaemonStatusResult,
  TerminalDataEvent,
  TerminalError,
  TerminalErrorCode,
  TerminalExitEvent,
  TerminalListRequest,
  TerminalSessionResult,
  TerminalSessionsResult,
  TerminalSnapshotsResult,
  TerminalAckRequest,
  TerminalCloseRequest,
  TerminalResizeRequest,
  TerminalSnapshotRequest,
  TerminalRecoveryRequest,
  TerminalWriteRequest
} from '../shared/terminal-api'
import { isTerminalSessionSnapshot } from '../shared/terminal-api'
import { TERMINAL_SNAPSHOT_MAX_CHARS } from '../shared/terminal-daemon-protocol'
import { TerminalDaemonClient } from './terminal-daemon-client'
import type { TerminalDaemonResult } from './terminal-daemon-client'

/** 守护进程错误码与页面契约的交集；不认识的码一律按内部错误展示，不把实现细节漏给页面。 */
const KNOWN_ERROR_CODES: readonly TerminalErrorCode[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'TERMINAL_NOT_FOUND',
  'TERMINAL_LIMIT_REACHED',
  'TERMINAL_DAEMON_UNAVAILABLE'
]

export interface TerminalManagerOptions {
  /** 把页面给出的项目路径收敛为已登记项目的规范路径；未登记时返回 null。 */
  readonly resolveProjectPath: (requested: string) => Promise<string | null>
  /** 下发终端输出；返回 false 表示当前没有可信页面接收。 */
  readonly sendData: (event: TerminalDataEvent) => boolean
  /** 下发终端退出；同样只发给可信页面。 */
  readonly sendExit: (event: TerminalExitEvent) => boolean
  /** 守护进程连接状态变化；调用方据此把最新状态推给页面。 */
  readonly onStatusChange: () => void
}

export class TerminalManager {
  private readonly client: TerminalDaemonClient

  constructor(private readonly options: TerminalManagerOptions) {
    this.client = new TerminalDaemonClient({
      onData: (event) => {
        // 没有页面接收时立刻回报消费量：这一段已经在守护进程的画面里，重挂载时由快照补齐。
        if (this.options.sendData(event)) return
        this.client.sendIfConnected({ type: 'ack', id: event.id, deliveryId: event.deliveryId, seqEnd: event.seqEnd })
      },
      onExit: (event) => {
        this.options.sendExit(event)
      },
      onConnectionChange: () => this.options.onStatusChange()
    })
  }

  /** 在已登记项目内新建终端；未登记的项目回可展示的原因。 */
  async create(request: TerminalCreateRequest): Promise<TerminalSessionResult> {
    const projectPath = await this.options.resolveProjectPath(request.projectPath)
    if (projectPath === null) {
      return sessionFailure('INVALID_REQUEST', '只能为已添加的项目创建终端。')
    }
    const result = await this.client.request({
      type: 'create',
      projectPath,
      cols: request.cols,
      rows: request.rows
    }, true)
    if (!result.ok) return { ok: false, error: toTerminalError(result.error) }
    return { ok: true, data: result.data }
  }

  /** 把页面输入写入终端；已退出或已关闭的终端回可展示的原因。 */
  async write(request: TerminalWriteRequest): Promise<TerminalCommandResult> {
    const result = await this.client.request({ type: 'write', id: request.id, data: request.data })
    return commandResult(result)
  }

  /** 同步终端尺寸；尺寸变化会转给 PTY，让全屏程序按新尺寸重排。 */
  async resize(request: TerminalResizeRequest): Promise<TerminalCommandResult> {
    const result = await this.client.request({
      type: 'resize',
      id: request.id,
      cols: request.cols,
      rows: request.rows
    })
    return commandResult(result)
  }

  /** 关闭终端并收敛其进程树；关闭不存在的终端按已关闭处理，重复调用是安全的。 */
  async close(request: TerminalCloseRequest): Promise<TerminalCommandResult> {
    const result = await this.client.request({ type: 'close', id: request.id })
    return commandResult(result)
  }

  /** 关闭全部终端（含其他项目）；用于用户显式清理常驻会话。 */
  async closeAll(): Promise<TerminalCommandResult> {
    const result = await this.client.request({ type: 'close-all' })
    return commandResult(result)
  }

  /** 读取终端清单；按项目过滤时只认已登记项目，未登记回非法请求而不是空清单。 */
  async list(request: TerminalListRequest): Promise<TerminalSessionsResult> {
    const projectPath = request.projectPath === null
      ? null
      : await this.options.resolveProjectPath(request.projectPath)
    if (request.projectPath !== null && projectPath === null) {
      return sessionsFailure('INVALID_REQUEST', '只能读取已添加项目的终端。')
    }
    const result = await this.client.request({ type: 'list', projectPath })
    if (!result.ok) {
      if (!this.client.hasLiveProcess) return { ok: true, data: { sessions: [] } }
      return { ok: false, error: toTerminalError(result.error) }
    }
    return { ok: true, data: { sessions: result.data } }
  }

  /** 单终端分块取画面；页面解析完成后另行开启投递，实时输出不会抢在快照前进入页面。 */
  async snapshots(request: TerminalSnapshotRequest): Promise<TerminalSnapshotsResult> {
    let completed = false
    try {
      const result = await this.client.request({ type: 'snapshot-begin', id: request.id, deliveryId: request.deliveryId })
      if (!result.ok) return { ok: false, error: toTerminalError(result.error) }
      const header = result.data
      if (!header || header.id !== request.id || header.deliveryId !== request.deliveryId
        || !Number.isSafeInteger(header.totalChars) || header.totalChars < 0 || header.totalChars > TERMINAL_SNAPSHOT_MAX_CHARS
        || !isTerminalSessionSnapshot({ ...header, ansi: '' })) {
        return { ok: false, error: { code: 'INVALID_RESPONSE', message: '终端快照头不合法。' } }
      }
      const chunks: string[] = []
      let offset = 0
      while (offset < header.totalChars) {
        const part = await this.client.request({ type: 'snapshot-read', id: request.id, deliveryId: request.deliveryId, offset })
        if (!part.ok) return { ok: false, error: toTerminalError(part.error) }
        if (typeof part.data?.chunk !== 'string' || part.data.chunk.length === 0
          || part.data.nextOffset !== offset + part.data.chunk.length || part.data.nextOffset > header.totalChars) {
          return { ok: false, error: { code: 'INVALID_RESPONSE', message: '终端快照分块不合法。' } }
        }
        chunks.push(part.data.chunk)
        offset = part.data.nextOffset
      }
      const snapshot = { id: header.id, deliveryId: header.deliveryId, ansi: chunks.join(''), cols: header.cols,
        rows: header.rows, status: header.status, exitCode: header.exitCode, seq: header.seq }
      if (!isTerminalSessionSnapshot(snapshot)) return { ok: false, error: { code: 'INVALID_RESPONSE', message: '终端快照不合法。' } }
      completed = true
      return { ok: true, data: { snapshot } }
    } catch (error) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : '读取终端快照失败。' } }
    } finally {
      if (!completed) this.client.sendIfConnected({ type: 'detach', id: request.id, deliveryId: request.deliveryId })
    }
  }

  async recover(request: TerminalRecoveryRequest): Promise<TerminalCommandResult> {
    if (request.action === 'detach') {
      this.client.sendIfConnected({ type: 'detach', id: request.id, deliveryId: request.deliveryId })
      return { ok: true }
    }
    return commandResult(await this.client.request({ type: 'snapshot-ready', id: request.id, deliveryId: request.deliveryId }))
  }

  /** 释放页面已消费的背压额度；未知终端与非法数量一律忽略，不回传结果。 */
  acknowledge(request: TerminalAckRequest): void {
    // 只回报消费量：断开时不必为了 ACK 去拉起守护进程。
    this.client.sendIfConnected({ type: 'ack', id: request.id, deliveryId: request.deliveryId, seqEnd: request.seqEnd })
  }

  /** 关闭某个项目的全部终端；项目被移除时调用，页面无需逐个关闭。 */
  async closeProject(projectPath: string): Promise<void> {
    if (!this.client.connected) return
    const result = await this.client.request({ type: 'list', projectPath })
    if (!result.ok) return
    for (const session of result.data) {
      await this.client.request({ type: 'close', id: session.id })
    }
  }

  /**
   * 页面重新加载后调用：上一份页面未确认的在途额度不再有人回报，让守护进程清掉它避免终端被永久背压。
   * 终端与画面状态都保留，页面重新挂载后按快照接回。
   */
  resetDelivery(): void {
    this.client.sendIfConnected({ type: 'reset-delivery' })
  }

  /** 守护进程状态：连接信息、会话计数，以及是否存在接不回来的旧版本守护进程。 */
  async status(): Promise<TerminalDaemonStatusResult> {
    const stale = this.client.staleDaemon()
    const result = await this.client.request({ type: 'status' })
    if (!result.ok) {
      return {
        ok: true,
        data: {
          connected: false,
          protocolVersion: null,
          pid: null,
          startedAt: null,
          sessionCount: 0,
          runningCount: 0,
          restoredCount: 0,
          stale
        }
      }
    }
    const status: TerminalDaemonStatus = {
      connected: true,
      protocolVersion: result.data.protocolVersion,
      pid: result.data.pid,
      startedAt: result.data.startedAt,
      sessionCount: result.data.sessionCount,
      runningCount: result.data.runningCount,
      restoredCount: result.data.restoredCount,
      stale
    }
    return { ok: true, data: status }
  }

  /** 结束协议版本不符的旧守护进程及其终端；只在用户显式操作时调用。 */
  stopStaleDaemon(): TerminalCommandResult {
    this.client.stopStaleDaemon()
    return { ok: true }
  }

  /**
   * 停止守护进程（含全部终端）：用于覆盖解压或更新前释放文件占用。
   * 下次显式新建终端才允许拉起守护进程；历史保留并按「已退出」记录恢复。
   */
  async stopDaemon(): Promise<TerminalCommandResult> {
    const result = await this.client.stopDaemon()
    if (!result.ok) return { ok: false, error: toTerminalError(result.error) }
    return { ok: true }
  }

  /** 应用退出：只断开连接，终端与守护进程继续运行。 */
  shutdown(): void {
    this.client.disconnect()
  }
}

function commandResult(result: TerminalDaemonResult<unknown>): TerminalCommandResult {
  if (!result.ok) return { ok: false, error: toTerminalError(result.error) }
  return { ok: true }
}

/** 把守护进程错误码翻成页面契约；不认识的码按内部错误处理，保留可读原因。 */
function toTerminalError(error: { readonly code: string; readonly message: string }): TerminalError {
  const code = KNOWN_ERROR_CODES.find((candidate) => candidate === error.code) ?? 'INTERNAL_ERROR'
  return { code, message: error.message }
}

function sessionFailure(code: TerminalErrorCode, message: string): TerminalSessionResult {
  return { ok: false, error: { code, message } }
}

function sessionsFailure(code: TerminalErrorCode, message: string): TerminalSessionsResult {
  return { ok: false, error: { code, message } }
}
