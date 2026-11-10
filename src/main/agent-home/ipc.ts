/** Agent 目录设置 IPC：校验调用者与参数，转发给唯一所有者；页面不能指定源目录或目标路径。 */
import type { IpcMainInvokeEvent } from 'electron'
import { AGENT_HOME_IMPORT_CHANNEL, AGENT_HOME_STATE_CHANNEL } from '../../shared/agent-home-api'
import type { AgentHomeResult } from '../../shared/agent-home-api'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import { readAgentHomeSnapshot, runSharedImport } from './shared-import'

export function registerAgentHomeHandlers(pageUrl: string): void {
  handle(AGENT_HOME_STATE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AgentHomeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Agent 目录状态读取不接受参数。' } }
      }
      return { ok: true, data: readAgentHomeSnapshot() }
    })

  handle(AGENT_HOME_IMPORT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AgentHomeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '导入不接受页面参数。' } }
      }
      // 导入只补缺、不覆盖：重复点击不会改掉产品目录里已有的结论。
      await runSharedImport()
      return { ok: true, data: readAgentHomeSnapshot() }
    })
}
