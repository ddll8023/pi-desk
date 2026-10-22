/** 项目信任门禁：解析当前项目是否需要信任决定，并为 Git 写操作提供统一放行判断。读操作不经过这里；未登记的运行实例不会被解析成任何项目。 */

import { join } from 'node:path'
import type { DesktopError } from '../../shared/desktop-api'
import { projectManager, trustManager, sdkRuntime } from '../services'

/**
 * Project Trust 拦截点（基于当前项目）：有受保护资源且无已保存决定时返回 `requiresPrompt`，
 * 由调用方按 `TRUST_REQUIRED` 拒绝；有决定或无资源时一并返回已保存的决定，
 * 供只读列举（MCP 配置）判断项目级配置是否生效。
 */
export async function resolveTrustForCurrentProject(): Promise<{
  readonly requiresPrompt: boolean
  readonly decision: 'trusted' | 'untrusted' | null
  readonly message: string | null
}> {
  const outcome = await trustManager.resolveLaunchDecision(projectManager.currentProjectPath())
  if (!outcome.requiresPrompt) {
    return { requiresPrompt: false, decision: outcome.decision, message: null }
  }
  const status = await trustManager.statusOf(projectManager.currentProjectPath())
  const summary = status.resources.map((resource) => resource.path).join('、')
  return {
    requiresPrompt: true,
    decision: null,
    message: `项目包含需要信任决定的资源：${summary}`
  }
}

/**
 * Git 写操作的项目信任门禁：暂存、提交、推送等会执行仓库里的 filter 与 hook，属于执行他人代码。
 * 尚无决定时回 `TRUST_REQUIRED` 交给信任对话框；已被标记为未信任时同样拒绝，但不弹框，直接说明原因。
 * 返回 null 表示放行。读操作不经过这里。
 */
export async function requireGitWriteTrust(): Promise<DesktopError | null> {
  const trust = await resolveTrustForCurrentProject()
  if (trust.requiresPrompt) {
    return { code: 'TRUST_REQUIRED', message: trust.message ?? '项目包含需要信任决定的资源，确认后再执行 Git 写操作。' }
  }
  if (trust.decision === 'untrusted') {
    return {
      code: 'TRUST_REQUIRED',
      message: '这个项目被标记为未信任，Git 写操作不会执行仓库里的钩子与过滤器；如需继续，在设置里改为信任。'
    }
  }
  return null
}

/**
 * 信任交互的目标项目：带运行实例身份时取该实例的归属项目（重载按被重载会话的归属项目复核，
 * 可能不等于前台项目），不带身份时取当前项目。未登记的身份不解析成任何项目。
 */
export function trustProjectOf(runId: unknown): string | null {
  if (runId === undefined) return projectManager.currentProjectPath()
  if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0) return null
  const run = sdkRuntime.listRunStates().find(candidate => candidate.runId === runId)
  return run?.projectPath ?? null
}
