/** 专家资源管理的 IPC：派生内置专家、删除自定义专家、读取快速模式剔除清单。只写 <agentDir>/experts/ 下的内容，不碰随包目录。 */

import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import {
  EXPERTS_DELETE_CHANNEL,
  EXPERTS_DERIVE_CHANNEL,
  EXPERTS_FAST_MODE_CHANNEL,
  isExpertDeleteRequest,
  isExpertDeriveRequest
} from '../../shared/experts-api'
import type {
  ExpertDeleteResult,
  ExpertDeriveResult,
  FastModeExclusionsResult
} from '../../shared/experts-api'
import { agentResourcesDirectory } from '../../shared-process/agent-resources'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import { getSdkHostDirectory } from '../shared/pi-cli-process'
import { getPiAgentDir } from '../shared/pi-paths'
import { readFastModeExclusions } from '../sessions/expert-catalog'
import { deleteUserExpert, deriveBuiltinExpert } from '../sessions/expert-files'

/** 随包资源目录：与清单读取、宿主装载用的是同一处产物。 */
function productResourcesDirectory(): string {
  return agentResourcesDirectory(join(getSdkHostDirectory(), 'index.mjs'))
}

export function registerExpertHandlers(pageUrl: string): void {
  /** 派生：把内置专家的定义复制到产品 agent 目录，立刻出现在清单里。 */
  handle(
    EXPERTS_DERIVE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ExpertDeriveResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } })
      }
      if (args.length !== 1 || !isExpertDeriveRequest(args[0])) {
        return Promise.resolve({ ok: false, error: { code: 'INVALID_REQUEST', message: '派生请求只接受一个内置专家标识。' } })
      }
      return Promise.resolve(deriveBuiltinExpert({
        resourcesDirectory: productResourcesDirectory(),
        agentDir: getPiAgentDir(),
        builtinId: args[0].builtinId
      }))
    }
  )

  /** 删除：只对自定义专家生效；目录里还有别的文件时拒绝，不替用户清素材。 */
  handle(
    EXPERTS_DELETE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ExpertDeleteResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } })
      }
      if (args.length !== 1 || !isExpertDeleteRequest(args[0])) {
        return Promise.resolve({ ok: false, error: { code: 'INVALID_REQUEST', message: '删除请求只接受一个专家标识。' } })
      }
      return Promise.resolve(deleteUserExpert({ agentDir: getPiAgentDir(), expertId: args[0].expertId }))
    }
  )

  /** 快速模式剔除清单：只读目录，不启动会话；结果可以为空。 */
  handle(
    EXPERTS_FAST_MODE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<FastModeExclusionsResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } })
      }
      if (args.length !== 0) {
        return Promise.resolve({ ok: false, error: { code: 'INVALID_REQUEST', message: '剔除清单接口不接受参数。' } })
      }
      return Promise.resolve({ ok: true, data: { skillIds: readFastModeExclusions() } })
    }
  )
}
