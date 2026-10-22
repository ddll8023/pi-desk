/** 版本检查、扩展更新与内置 agent 安装：preload 的 updates 域，只经固定 channel 与主进程通信，载荷与响应在此重建与校验。 */

import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { UPDATES_CHECK_CHANNEL, UPDATES_GET_CHANNEL, UPDATES_INSTALL_AGENT_CHANNEL, UPDATES_INSTALL_AGENT_PROGRESS_EVENT, UPDATES_REINSTALL_AGENT_CHANNEL, UPDATES_RESET_AGENT_RUNTIME_CHANNEL, UPDATES_STATE_EVENT, UPDATES_UPDATE_CHANNEL, UPDATES_UPDATE_OUTCOME_EVENT, UPDATES_UPDATE_PROGRESS_EVENT, isAgentInstallProgress, isAgentInstallResult, isAgentRuntimeResetResult, isPackageUpdateOutcome, isPackageUpdateProgress, isPackageUpdateResult, isUpdatesResult, isUpdatesSnapshot } from '../shared/updates-api'
import type { AgentInstallProgress, AgentInstallResult, AgentRuntimeResetResult, PackageUpdateOutcome, PackageUpdateProgress, PackageUpdateResult, UpdatesResult, UpdatesSnapshot } from '../shared/updates-api'
import type { UpdatesApi } from '../shared/updates-api'

const INVALID_UPDATES_RESPONSE = '桌面接口返回了无法识别的版本检查结果。'
const INVALID_PACKAGE_UPDATE_RESPONSE = '桌面接口返回了无法识别的扩展更新结果。'
const INVALID_AGENT_INSTALL_RESPONSE = '桌面接口返回了无法识别的内置 Pi agent 安装结果。'
const INVALID_AGENT_RUNTIME_RESET_RESPONSE = '桌面接口返回了无法识别的运行时指针清除结果。'

function invalidUpdatesResponse(): UpdatesResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_UPDATES_RESPONSE } }
}

function invalidPackageUpdateResponse(): PackageUpdateResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PACKAGE_UPDATE_RESPONSE } }
}

function invalidAgentInstallResponse(): AgentInstallResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_AGENT_INSTALL_RESPONSE } }
}

function invalidAgentRuntimeResetResponse(): AgentRuntimeResetResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_AGENT_RUNTIME_RESET_RESPONSE } }
}

export const updatesApi = {
  async getUpdates(): Promise<UpdatesResult> {
    const response: unknown = await ipcRenderer.invoke(UPDATES_GET_CHANNEL)
    return isUpdatesResult(response) ? response : invalidUpdatesResponse()
  },

  async checkUpdates(): Promise<UpdatesResult> {
    const response: unknown = await ipcRenderer.invoke(UPDATES_CHECK_CHANNEL)
    return isUpdatesResult(response) ? response : invalidUpdatesResponse()
  },

  onUpdatesChanged(listener: (snapshot: UpdatesSnapshot) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 快照载荷同样不可信：契约不符时丢弃，由下一次快照收敛。
      if (!isUpdatesSnapshot(payload)) return
      listener(payload)
    }
    ipcRenderer.on(UPDATES_STATE_EVENT, handler)
    return () => {
      ipcRenderer.off(UPDATES_STATE_EVENT, handler)
    }
  },

  async updatePackages(source?: string): Promise<PackageUpdateResult> {
    const response: unknown = await ipcRenderer.invoke(
      UPDATES_UPDATE_CHANNEL,
      ...(source === undefined ? [] : [source])
    )
    return isPackageUpdateResult(response) ? response : invalidPackageUpdateResponse()
  },

  onPackageUpdateProgress(listener: (progress: PackageUpdateProgress) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 进度载荷同样不可信：契约不符时丢弃，由后续进度或结论收敛。
      if (!isPackageUpdateProgress(payload)) return
      listener(payload)
    }
    ipcRenderer.on(UPDATES_UPDATE_PROGRESS_EVENT, handler)
    return () => {
      ipcRenderer.off(UPDATES_UPDATE_PROGRESS_EVENT, handler)
    }
  },

  onPackageUpdateOutcome(listener: (outcome: PackageUpdateOutcome) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 结论载荷同样不可信：契约不符时丢弃，由下一次更新或重查收敛。
      if (!isPackageUpdateOutcome(payload)) return
      listener(payload)
    }
    ipcRenderer.on(UPDATES_UPDATE_OUTCOME_EVENT, handler)
    return () => {
      ipcRenderer.off(UPDATES_UPDATE_OUTCOME_EVENT, handler)
    }
  },

  async installAgentRuntime(version?: string): Promise<AgentInstallResult> {
    const response: unknown = await ipcRenderer.invoke(
      UPDATES_INSTALL_AGENT_CHANNEL,
      ...(version === undefined ? [] : [version])
    )
    return isAgentInstallResult(response) ? response : invalidAgentInstallResponse()
  },

  onAgentInstallProgress(listener: (progress: AgentInstallProgress) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 进度载荷同样不可信：契约不符时丢弃，由后续进度或结论收敛。
      if (!isAgentInstallProgress(payload)) return
      listener(payload)
    }
    ipcRenderer.on(UPDATES_INSTALL_AGENT_PROGRESS_EVENT, handler)
    return () => {
      ipcRenderer.off(UPDATES_INSTALL_AGENT_PROGRESS_EVENT, handler)
    }
  },

  async reinstallAgentRuntime(version: string): Promise<AgentInstallResult> {
    const response: unknown = await ipcRenderer.invoke(UPDATES_REINSTALL_AGENT_CHANNEL, version)
    return isAgentInstallResult(response) ? response : invalidAgentInstallResponse()
  },

  async resetAgentRuntime(): Promise<AgentRuntimeResetResult> {
    const response: unknown = await ipcRenderer.invoke(UPDATES_RESET_AGENT_RUNTIME_CHANNEL)
    return isAgentRuntimeResetResult(response) ? response : invalidAgentRuntimeResetResponse()
  }
} satisfies UpdatesApi
