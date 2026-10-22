/** 终端与终端守护进程：preload 的 terminal 域，只经固定 channel 与主进程通信，载荷与响应在此重建与校验。 */

import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { TERMINAL_ACK_CHANNEL, TERMINAL_CLOSE_ALL_CHANNEL, TERMINAL_CLOSE_CHANNEL, TERMINAL_CREATE_CHANNEL, TERMINAL_DAEMON_STATUS_CHANNEL, TERMINAL_DAEMON_STATUS_EVENT, TERMINAL_DAEMON_STOP_CHANNEL, TERMINAL_DAEMON_STOP_STALE_CHANNEL, TERMINAL_DATA_EVENT, TERMINAL_EXIT_EVENT, TERMINAL_LIST_CHANNEL, TERMINAL_RESIZE_CHANNEL, TERMINAL_RENAME_CHANNEL, TERMINAL_RECOVERY_CHANNEL, TERMINAL_SNAPSHOTS_CHANNEL, TERMINAL_WRITE_CHANNEL, isTerminalCommandResult, isTerminalDaemonStatus, isTerminalDaemonStatusResult, isTerminalDataEvent, isTerminalExitEvent, isTerminalSessionResult, isTerminalSessionsResult, isTerminalSnapshotsResult } from '../shared/terminal-api'
import type { TerminalAckRequest, TerminalCloseRequest, TerminalCommandResult, TerminalCreateRequest, TerminalDaemonStatus, TerminalDaemonStatusResult, TerminalDataEvent, TerminalExitEvent, TerminalListRequest, TerminalResizeRequest, TerminalSnapshotRequest, TerminalRecoveryRequest, TerminalRenameRequest, TerminalSessionResult, TerminalSessionsResult, TerminalSnapshotsResult, TerminalWriteRequest } from '../shared/terminal-api'
import type { TerminalApi } from '../shared/terminal-api'

const INVALID_TERMINAL_SESSION_RESPONSE = '桌面接口返回了无法识别的终端状态。'
const INVALID_TERMINAL_SESSIONS_RESPONSE = '桌面接口返回了无法识别的终端清单。'
const INVALID_TERMINAL_COMMAND_RESPONSE = '桌面接口返回了无法识别的终端操作结果。'
const INVALID_TERMINAL_SNAPSHOTS_RESPONSE = '桌面接口返回了无法识别的终端快照。'
const INVALID_TERMINAL_DAEMON_STATUS_RESPONSE = '桌面接口返回了无法识别的终端守护进程状态。'

function invalidTerminalSessionResponse(): TerminalSessionResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_TERMINAL_SESSION_RESPONSE } }
}

function invalidTerminalSessionsResponse(): TerminalSessionsResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_TERMINAL_SESSIONS_RESPONSE } }
}

function invalidTerminalCommandResponse(): TerminalCommandResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_TERMINAL_COMMAND_RESPONSE } }
}

function invalidTerminalSnapshotsResponse(): TerminalSnapshotsResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_TERMINAL_SNAPSHOTS_RESPONSE } }
}

function invalidTerminalDaemonStatusResponse(): TerminalDaemonStatusResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_TERMINAL_DAEMON_STATUS_RESPONSE } }
}

export const terminalApi = {
  async createTerminal(request: TerminalCreateRequest) {
    const payload: TerminalCreateRequest = {
      projectPath: request.projectPath,
      cols: request.cols,
      rows: request.rows
    }
    const response: unknown = await ipcRenderer.invoke(TERMINAL_CREATE_CHANNEL, payload)
    return isTerminalSessionResult(response) ? response : invalidTerminalSessionResponse()
  },

  async writeTerminal(request: TerminalWriteRequest) {
    const payload: TerminalWriteRequest = { id: request.id, data: request.data }
    const response: unknown = await ipcRenderer.invoke(TERMINAL_WRITE_CHANNEL, payload)
    return isTerminalCommandResult(response) ? response : invalidTerminalCommandResponse()
  },

  async resizeTerminal(request: TerminalResizeRequest) {
    const payload: TerminalResizeRequest = { id: request.id, cols: request.cols, rows: request.rows }
    const response: unknown = await ipcRenderer.invoke(TERMINAL_RESIZE_CHANNEL, payload)
    return isTerminalCommandResult(response) ? response : invalidTerminalCommandResponse()
  },

  async renameTerminal(request: TerminalRenameRequest) {
    const payload: TerminalRenameRequest = { id: request.id, title: request.title }
    const response: unknown = await ipcRenderer.invoke(TERMINAL_RENAME_CHANNEL, payload)
    return isTerminalCommandResult(response) ? response : invalidTerminalCommandResponse()
  },

  async closeTerminal(request: TerminalCloseRequest) {
    const payload: TerminalCloseRequest = { id: request.id }
    const response: unknown = await ipcRenderer.invoke(TERMINAL_CLOSE_CHANNEL, payload)
    return isTerminalCommandResult(response) ? response : invalidTerminalCommandResponse()
  },

  async listTerminals(request: TerminalListRequest) {
    const payload: TerminalListRequest = { projectPath: request.projectPath }
    const response: unknown = await ipcRenderer.invoke(TERMINAL_LIST_CHANNEL, payload)
    return isTerminalSessionsResult(response) ? response : invalidTerminalSessionsResponse()
  },

  async fetchTerminalSnapshots(request: TerminalSnapshotRequest) {
    const payload: TerminalSnapshotRequest = { id: request.id, deliveryId: request.deliveryId }
    const response: unknown = await ipcRenderer.invoke(TERMINAL_SNAPSHOTS_CHANNEL, payload)
    return isTerminalSnapshotsResult(response) ? response : invalidTerminalSnapshotsResponse()
  },

  async recoverTerminal(request: TerminalRecoveryRequest) {
    const payload: TerminalRecoveryRequest = { id: request.id, deliveryId: request.deliveryId, action: request.action }
    const response: unknown = await ipcRenderer.invoke(TERMINAL_RECOVERY_CHANNEL, payload)
    return isTerminalCommandResult(response) ? response : invalidTerminalCommandResponse()
  },

  async closeAllTerminals() {
    const response: unknown = await ipcRenderer.invoke(TERMINAL_CLOSE_ALL_CHANNEL)
    return isTerminalCommandResult(response) ? response : invalidTerminalCommandResponse()
  },

  async getTerminalDaemonStatus() {
    const response: unknown = await ipcRenderer.invoke(TERMINAL_DAEMON_STATUS_CHANNEL)
    return isTerminalDaemonStatusResult(response) ? response : invalidTerminalDaemonStatusResponse()
  },

  async stopStaleTerminalDaemon() {
    const response: unknown = await ipcRenderer.invoke(TERMINAL_DAEMON_STOP_STALE_CHANNEL)
    return isTerminalCommandResult(response) ? response : invalidTerminalCommandResponse()
  },

  async stopTerminalDaemon() {
    const response: unknown = await ipcRenderer.invoke(TERMINAL_DAEMON_STOP_CHANNEL)
    return isTerminalCommandResult(response) ? response : invalidTerminalCommandResponse()
  },

  onTerminalDaemonStatus(listener: (status: TerminalDaemonStatus) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 状态事件同样不可信：契约不符时丢弃，由下一次读取收敛。
      if (!isTerminalDaemonStatus(payload)) return
      listener(payload)
    }
    ipcRenderer.on(TERMINAL_DAEMON_STATUS_EVENT, handler)
    return () => {
      ipcRenderer.off(TERMINAL_DAEMON_STATUS_EVENT, handler)
    }
  },

  ackTerminalData(request: TerminalAckRequest) {
    void ipcRenderer
      .invoke(TERMINAL_ACK_CHANNEL, { id: request.id, deliveryId: request.deliveryId, seqEnd: request.seqEnd })
      .catch(() => undefined)
  },

  onTerminalData(listener: (event: TerminalDataEvent) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 事件载荷同样不可信：契约不符时丢弃，由后续输出收敛。
      if (!isTerminalDataEvent(payload)) return
      listener(payload)
    }
    ipcRenderer.on(TERMINAL_DATA_EVENT, handler)
    return () => {
      ipcRenderer.off(TERMINAL_DATA_EVENT, handler)
    }
  },

  onTerminalExit(listener: (event: TerminalExitEvent) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 退出事件同样不可信：契约不符时丢弃，由终端清单收敛。
      if (!isTerminalExitEvent(payload)) return
      listener(payload)
    }
    ipcRenderer.on(TERMINAL_EXIT_EVENT, handler)
    return () => {
      ipcRenderer.off(TERMINAL_EXIT_EVENT, handler)
    }
  }
} satisfies TerminalApi
