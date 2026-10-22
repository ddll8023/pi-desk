/** 内置终端的 IPC：新建、写入、改尺寸、命名、关闭、列出、快照读取与恢复确认、全部关闭、守护进程状态与旧版本收敛、背压确认。PTY 与画面由独立守护进程持有，主进程只转发受限协议。 */

import type { IpcMainInvokeEvent } from 'electron'
import {
  TERMINAL_ACK_CHANNEL,
  TERMINAL_CLOSE_ALL_CHANNEL,
  TERMINAL_CLOSE_CHANNEL,
  TERMINAL_CREATE_CHANNEL,
  TERMINAL_DAEMON_STATUS_CHANNEL,
  TERMINAL_DAEMON_STOP_CHANNEL,
  TERMINAL_DAEMON_STOP_STALE_CHANNEL,
  TERMINAL_LIST_CHANNEL,
  TERMINAL_RESIZE_CHANNEL,
  TERMINAL_RECOVERY_CHANNEL,
  TERMINAL_RENAME_CHANNEL,
  TERMINAL_SNAPSHOTS_CHANNEL,
  TERMINAL_WRITE_CHANNEL,
  isTerminalAckRequest,
  isTerminalCloseRequest,
  isTerminalCreateRequest,
  isTerminalListRequest,
  isTerminalRenameRequest,
  isTerminalResizeRequest,
  isTerminalSnapshotRequest,
  isTerminalRecoveryRequest,
  isTerminalWriteRequest
} from '../../shared/terminal-api'
import type {
  TerminalCommandResult,
  TerminalDaemonStatusResult,
  TerminalErrorCode,
  TerminalSessionResult,
  TerminalSessionsResult,
  TerminalSnapshotsResult
} from '../../shared/terminal-api'
import { handle } from '../ipc/dispatch'
import { isTrustedCaller } from '../ipc/dispatch'
import { terminals } from '../services'

export function terminalSessionFailure(code: TerminalErrorCode, message: string): TerminalSessionResult {
  return { ok: false, error: { code, message } }
}

export function terminalSessionsFailure(code: TerminalErrorCode, message: string): TerminalSessionsResult {
  return { ok: false, error: { code, message } }
}

export function terminalCommandFailure(code: TerminalErrorCode, message: string): TerminalCommandResult {
  return { ok: false, error: { code, message } }
}

export function terminalSnapshotsFailure(code: TerminalErrorCode, message: string): TerminalSnapshotsResult {
  return { ok: false, error: { code, message } }
}

export function terminalDaemonStatusFailure(code: TerminalErrorCode, message: string): TerminalDaemonStatusResult {
  return { ok: false, error: { code, message } }
}

/**
 * 内置终端：创建、写入、改尺寸、关闭、清单与数据确认。
 * 终端进程只在主进程，页面不接触 shell、环境变量与工作目录；数据确认只释放背压额度。
 */
export function registerTerminalHandlers(pageUrl: string): void {
  handle(
    TERMINAL_CREATE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TerminalSessionResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalSessionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isTerminalCreateRequest(args[0])) {
        return terminalSessionFailure('INVALID_REQUEST', '创建终端只接受已登记项目路径与初始行列数。')
      }
      return terminals.create(args[0])
    }
  )

  handle(
    TERMINAL_WRITE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TerminalCommandResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalCommandFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isTerminalWriteRequest(args[0])) {
        return terminalCommandFailure('INVALID_REQUEST', '终端写入只接受终端标识与不超过上限的文本。')
      }
      return terminals.write(args[0])
    }
  )

  handle(
    TERMINAL_RESIZE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TerminalCommandResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalCommandFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isTerminalResizeRequest(args[0])) {
        return terminalCommandFailure('INVALID_REQUEST', '调整终端尺寸只接受终端标识与合法行列数。')
      }
      return terminals.resize(args[0])
    }
  )

  handle(
    TERMINAL_RENAME_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TerminalCommandResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalCommandFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isTerminalRenameRequest(args[0])) {
        return terminalCommandFailure('INVALID_REQUEST', '命名终端只接受终端标识与不超长的标题。')
      }
      return terminals.rename(args[0])
    }
  )

  handle(
    TERMINAL_CLOSE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TerminalCommandResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalCommandFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isTerminalCloseRequest(args[0])) {
        return terminalCommandFailure('INVALID_REQUEST', '关闭终端只接受终端标识。')
      }
      return terminals.close(args[0])
    }
  )

  handle(
    TERMINAL_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TerminalSessionsResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalSessionsFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isTerminalListRequest(args[0])) {
        return terminalSessionsFailure('INVALID_REQUEST', '终端清单只接受一个项目路径或 null。')
      }
      return terminals.list(args[0])
    }
  )

  handle(
    TERMINAL_SNAPSHOTS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TerminalSnapshotsResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalSnapshotsFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isTerminalSnapshotRequest(args[0])) {
        return terminalSnapshotsFailure('INVALID_REQUEST', '读取终端画面需要终端标识和投递代际。')
      }
      return terminals.snapshots(args[0])
    }
  )

  handle(
    TERMINAL_RECOVERY_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TerminalCommandResult> => {
      if (!isTrustedCaller(event, pageUrl)) return terminalCommandFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      if (args.length !== 1 || !isTerminalRecoveryRequest(args[0])) {
        return terminalCommandFailure('INVALID_REQUEST', '终端恢复动作不合法。')
      }
      return terminals.recover(args[0])
    }
  )

  handle(
    TERMINAL_CLOSE_ALL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TerminalCommandResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalCommandFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return terminalCommandFailure('INVALID_REQUEST', '关闭全部终端不接受参数。')
      }
      return terminals.closeAll()
    }
  )

  handle(
    TERMINAL_DAEMON_STATUS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TerminalDaemonStatusResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalDaemonStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return terminalDaemonStatusFailure('INVALID_REQUEST', '终端守护进程状态接口不接受参数。')
      }
      return terminals.status()
    }
  )

  handle(
    TERMINAL_DAEMON_STOP_STALE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): TerminalCommandResult => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalCommandFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return terminalCommandFailure('INVALID_REQUEST', '结束旧终端守护进程不接受参数。')
      }
      return terminals.stopStaleDaemon()
    }
  )

  handle(
    TERMINAL_DAEMON_STOP_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TerminalCommandResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalCommandFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return terminalCommandFailure('INVALID_REQUEST', '停止终端守护进程不接受参数。')
      }
      return terminals.stopDaemon()
    }
  )

  /** 只有当前投递代际的累计进度能释放额度；迟到和重复确认由守护进程忽略。 */
  handle(
    TERMINAL_ACK_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): void => {
      if (!isTrustedCaller(event, pageUrl) || args.length !== 1 || !isTerminalAckRequest(args[0])) return
      terminals.acknowledge(args[0])
    }
  )
}
