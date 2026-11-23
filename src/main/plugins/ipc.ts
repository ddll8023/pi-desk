/**
 * 能力插件清单的 IPC：读取清单视图与切换单项启停。
 *
 * 只做调用者校验、请求校验与配置读写；依赖缺席原因与装配范围由 `catalog.ts` 计算，避免两处口径。
 * 启停写的是「下次启动不装配」，因此切换成功后不重建已注册的通道，也不假装立即生效。
 */
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopErrorCode } from '../../shared/desktop-api'
import { PLUGIN_LIST_CHANNEL, PLUGIN_TOGGLE_CHANNEL, isPluginToggleRequest } from '../../shared/plugin-api'
import type { PluginListResult, PluginToggleResult } from '../../shared/plugin-api'
import { DesktopConfigStorageError } from '../config/desktop-config-store'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import { configStore } from '../services'
import { describeBuiltinPlugins, hasBuiltinPlugin } from './catalog'

function pluginFailure(code: DesktopErrorCode, message: string): PluginListResult {
  return { ok: false, error: { code, message } }
}

/** 存储故障与内部错误使用同一错误码，只保留可展示的原因文本。 */
function pluginFailureFromError(error: unknown): PluginListResult {
  if (error instanceof DesktopConfigStorageError) {
    return pluginFailure('INTERNAL_ERROR', error.message)
  }
  return pluginFailure('INTERNAL_ERROR', '读取或保存插件启停状态时发生未预期的内部错误。')
}

async function currentDisabled(): Promise<Set<string>> {
  return new Set(await configStore.readDisabledPlugins())
}

/**
 * 启停串行链：读集合与写集合是两次独立的配置提交，并发切换会在后一次写入时覆盖前一次。
 * 这里把「读—算—写」串成一条链，链上的失败不影响后续请求。
 */
let toggleQueue: Promise<unknown> = Promise.resolve()

function enqueueToggle(work: () => Promise<PluginToggleResult>): Promise<PluginToggleResult> {
  const task = toggleQueue.then(work, work)
  toggleQueue = task.catch(() => undefined)
  return task
}

export function registerPluginHandlers(pageUrl: string): void {
  handle(
    PLUGIN_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PluginListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return pluginFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      // 清单接口不接受参数：插件范围由产品决定，页面不能自己挑。
      if (args.length !== 0) {
        return pluginFailure('INVALID_REQUEST', '插件清单接口不接受参数。')
      }
      try {
        return { ok: true, data: { plugins: describeBuiltinPlugins(await currentDisabled()) } }
      } catch (error) {
        return pluginFailureFromError(error)
      }
    }
  )

  handle(
    PLUGIN_TOGGLE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PluginToggleResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return pluginFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return pluginFailure('INVALID_REQUEST', '插件启停请求必须包含合法标识与布尔状态。')
      }
      const request = args[0]
      if (!isPluginToggleRequest(request)) {
        return pluginFailure('INVALID_REQUEST', '插件启停请求必须包含合法标识与布尔状态。')
      }
      const { id, enabled } = request
      if (!hasBuiltinPlugin(id)) {
        return pluginFailure('INVALID_REQUEST', '请求的插件不在当前清单里。')
      }
      try {
        return await enqueueToggle(async () => {
          const disabled = await currentDisabled()
          // 启用即从停用集合移除，停用即加入；重复切换是幂等的。
          if (enabled) disabled.delete(id)
          else disabled.add(id)
          // 用落盘返回值：它已经过过滤、去重与截断，是下次启动真正读到的集合。
          const saved = await configStore.saveDisabledPlugins([...disabled])
          return { ok: true, data: { plugins: describeBuiltinPlugins(new Set(saved)) } }
        })
      } catch (error) {
        return pluginFailureFromError(error)
      }
    }
  )
}
