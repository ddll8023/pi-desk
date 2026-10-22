/** 更新与运行时的 IPC：版本检查快照与重查、扩展更新、内置 Pi agent 安装与重装、运行时指针修复。都只由页面显式发起，不自动执行也不重试。 */

import type { IpcMainInvokeEvent } from 'electron'
import {
  UPDATES_CHECK_CHANNEL,
  UPDATES_GET_CHANNEL,
  UPDATES_INSTALL_AGENT_CHANNEL,
  UPDATES_REINSTALL_AGENT_CHANNEL,
  UPDATES_RESET_AGENT_RUNTIME_CHANNEL,
  UPDATES_UPDATE_CHANNEL
} from '../../shared/updates-api'
import type {
  AgentInstallResult,
  AgentRuntimeResetResult,
  PackageUpdateResult,
  PiAgentUpdateInfo,
  UpdatesResult
} from '../../shared/updates-api'
import { handle } from '../ipc/dispatch'
import { isTrustedCaller } from '../ipc/dispatch'
import { updateChecker, packageUpdater, piAgentUpdater } from '../services'

/**
 * 运行时回退时返回指针指向的版本，否则返回 null。
 * 判据是指针版本与实际加载的版本不一致：指针缺失，或目录里的版本已经用上了，都不属于回退。
 */
export function pendingRuntimeVersion(piAgent: PiAgentUpdateInfo | null): string | null {
  if (piAgent === null) return null
  const pointer = piAgent.runtimeVersion
  if (pointer === null || pointer === piAgent.version) return null
  return pointer
}

export function registerUpdatesHandlers(pageUrl: string): void {
  handle(
    UPDATES_GET_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): UpdatesResult => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '版本检查读取接口不接受参数。' } }
      }
      return { ok: true, data: updateChecker.getSnapshot() }
    }
  )
  handle(
    UPDATES_CHECK_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<UpdatesResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '版本检查接口不接受参数。' } }
      }
      return await updateChecker.check()
    }
  )
  handle(
    UPDATES_UPDATE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PackageUpdateResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length > 1) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '扩展更新接口只接受一个可选的包来源。' } }
      }
      const requested = args.length === 0 ? undefined : args[0]
      if (requested !== undefined && typeof requested !== 'string') {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '扩展更新接口只接受文本来源。' } }
      }
      const source = requested === undefined || requested === '' ? undefined : requested
      // 页面只能引用主进程已经报告过的来源，不能凭空构造要更新的包。
      if (source !== undefined
        && !updateChecker.getSnapshot().extensions.some((entry) => entry.source === source)) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '只能更新版本检查报告过的包。' } }
      }
      return await packageUpdater.update(source)
    }
  )
  handle(
    UPDATES_INSTALL_AGENT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AgentInstallResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length > 1) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '内置 Pi agent 安装接口只接受一个可选版本号。' } }
      }
      const requested = args.length === 0 ? undefined : args[0]
      if (requested !== undefined && typeof requested !== 'string') {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '内置 Pi agent 安装接口只接受文本版本号。' } }
      }
      const version = requested === undefined || requested === '' ? undefined : requested
      // 页面只能要求安装主进程已经报告过的官方最新版本，且该版本得处于可更新状态；
      // 版本范围由安装入口再判一次，这里先把明显不该装的请求挡在门外。
      const piAgent = updateChecker.getSnapshot().piAgent
      if (version !== undefined
        && (piAgent === null || piAgent.status !== 'update-available' || version !== piAgent.latestVersion)) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '只能安装版本检查报告过的、处于可更新状态的官方版本。' } }
      }
      return await piAgentUpdater.install(version)
    }
  )
  handle(
    UPDATES_REINSTALL_AGENT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AgentInstallResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '重装运行时版本接口只接受一个版本号。' } }
      }
      const requested = args[0]
      if (typeof requested !== 'string' || requested === '') {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '重装运行时版本接口只接受非空文本版本号。' } }
      }
      // 只能重装主进程报告过的、运行中没生效的那个运行时版本；版本范围由安装入口再判一次。
      if (requested !== pendingRuntimeVersion(updateChecker.getSnapshot().piAgent)) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '只能重装版本检查报告过的、运行中未生效的运行时版本。' } }
      }
      return await piAgentUpdater.install(requested)
    }
  )
  handle(
    UPDATES_RESET_AGENT_RUNTIME_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AgentRuntimeResetResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '清除运行时指针接口不接受参数。' } }
      }
      // 清指针只用于修复回退，避免在一切正常时把在用的版本指针删掉。
      if (pendingRuntimeVersion(updateChecker.getSnapshot().piAgent) === null) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '只有运行时版本未能生效时才能清除指针。' } }
      }
      return await piAgentUpdater.resetRuntime()
    }
  )
}
