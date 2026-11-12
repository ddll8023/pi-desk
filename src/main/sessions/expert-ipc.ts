/**
 * 专家资源管理的 IPC：派生内置专家、读取与保存自定义专家、删除自定义专家、读取快速模式剔除清单，
 * 以及能力候选读取与默认能力基线保存。只写 <agentDir> 下的 experts/ 与基线文件，不碰随包目录。
 */

import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import {
  EXPERTS_CAPABILITIES_CHANNEL,
  EXPERTS_DELETE_CHANNEL,
  EXPERTS_DERIVE_CHANNEL,
  EXPERTS_FAST_MODE_CHANNEL,
  EXPERTS_READ_CHANNEL,
  EXPERTS_SAVE_CHANNEL,
  EXPERTS_SAVE_DEFAULTS_CHANNEL,
  isExpertDeleteRequest,
  isExpertDeriveRequest,
  isExpertReadRequest,
  isExpertSaveDefaultsRequest,
  isExpertSaveRequest
} from '../../shared/experts-api'
import type {
  ExpertCapabilitiesResult,
  ExpertDeleteResult,
  ExpertDeriveResult,
  ExpertReadResult,
  ExpertSaveDefaultsResult,
  ExpertSaveResult,
  FastModeExclusionsResult
} from '../../shared/experts-api'
import { agentResourcesDirectory } from '../../shared-process/agent-resources'
import { writeExpertCapabilityDefaults } from '../../shared-process/expert-capability-defaults'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import { getSdkHostDirectory } from '../shared/pi-cli-process'
import { getPiAgentDir } from '../shared/pi-paths'
import { readConfiguredMcpServers } from '../resources/mcp-config-reader'
import { readExpertCapabilities, readExpertSkillContext, readFastModeExclusions } from '../sessions/expert-catalog'
import { deleteUserExpert, deriveBuiltinExpert, readUserExpertDefinition, saveUserExpertDefinition } from '../sessions/expert-files'

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

  /** 读取：只返回自定义专家的声明与正文；内置专家请走派生，不在这里开放编辑。 */
  handle(
    EXPERTS_READ_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ExpertReadResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } })
      }
      if (args.length !== 1 || !isExpertReadRequest(args[0])) {
        return Promise.resolve({ ok: false, error: { code: 'INVALID_REQUEST', message: '读取请求只接受一个专家标识。' } })
      }
      return Promise.resolve(readUserExpertDefinition({ agentDir: getPiAgentDir(), expertId: args[0].expertId }))
    }
  )

  /**
   * 保存：`expertId` 为空表示新建，标识由主进程分配；技能上下文与清单读取同源，
   * 避免「清单说技能可用、保存却拒绝」的两套结论。清单读不到时直接失败，不静默放过引用。
   */
  handle(
    EXPERTS_SAVE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ExpertSaveResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } })
      }
      if (args.length !== 1 || !isExpertSaveRequest(args[0])) {
        return Promise.resolve({
          ok: false,
          error: { code: 'INVALID_REQUEST', message: '保存请求需要显示名称、简介、技能引用与正文。' }
        })
      }
      const request = args[0]
      let skillContext: ReturnType<typeof readExpertSkillContext>
      try {
        skillContext = readExpertSkillContext()
      } catch {
        return Promise.resolve({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: '技能清单读取失败，无法校验技能引用。' }
        })
      }
      return Promise.resolve(saveUserExpertDefinition({
        agentDir: getPiAgentDir(),
        expertId: request.expertId,
        displayName: request.displayName,
        summary: request.summary,
        skillIds: request.skillIds,
        skillsMode: request.skillsMode,
        skillAddIds: request.skillAddIds,
        skillRemoveIds: request.skillRemoveIds,
        mcpMode: request.mcpMode,
        mcpServerIds: request.mcpServerIds,
        mcpAddIds: request.mcpAddIds,
        mcpRemoveIds: request.mcpRemoveIds,
        body: request.body,
        availableSkillIds: skillContext.availableSkillIds,
        subAgentOnlySkillIds: skillContext.subAgentOnlySkillIds,
        // 未配置的服务器不拦保存，只在结果里回报，与技能引用同一口径。
        availableMcpServers: readConfiguredMcpServers().map(server => server.name)
      }))
    }
  )

  /** 能力候选：技能、全局 MCP 服务器与当前默认基线；页面不开会话也能勾选。 */
  handle(
    EXPERTS_CAPABILITIES_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ExpertCapabilitiesResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } })
      }
      if (args.length !== 0) {
        return Promise.resolve({ ok: false, error: { code: 'INVALID_REQUEST', message: '能力候选读取不接受参数。' } })
      }
      try {
        return Promise.resolve({ ok: true, data: readExpertCapabilities() })
      } catch {
        return Promise.resolve({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: '读取能力候选失败，检查随包资源是否完整。' }
        })
      }
    }
  )

  /** 保存默认基线：写入后返回归一化结果，页面据此确认看到的与生效的一致。 */
  handle(
    EXPERTS_SAVE_DEFAULTS_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ExpertSaveDefaultsResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } })
      }
      if (args.length !== 1 || !isExpertSaveDefaultsRequest(args[0])) {
        return Promise.resolve({
          ok: false,
          error: { code: 'INVALID_REQUEST', message: '默认能力只能包含技能标识与 MCP 服务器名两份列表（null 表示不限制）。' }
        })
      }
      try {
        return Promise.resolve({ ok: true, data: writeExpertCapabilityDefaults(getPiAgentDir(), args[0]) })
      } catch {
        return Promise.resolve({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: '保存默认能力失败，检查应用数据目录是否可写。' }
        })
      }
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
