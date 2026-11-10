/** Agent 目录设置页的受限桥接：只转发状态与导入请求，不向页面开放路径或文件内容。 */
import { isAgentHomeResult } from '../../../../shared/agent-home-api'
import type { AgentHomeResult } from '../../../../shared/agent-home-api'

interface AgentHomeBridge {
  readonly getAgentHomeState: () => Promise<unknown>
  readonly importSharedAgent: () => Promise<unknown>
}

function bridge(): AgentHomeBridge | null {
  const value = window.desktop as Partial<AgentHomeBridge> | undefined
  if (value === undefined || typeof value.getAgentHomeState !== 'function'
    || typeof value.importSharedAgent !== 'function') return null
  return value as AgentHomeBridge
}

function unavailable(): AgentHomeResult {
  return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '当前环境没有桌面 agent 目录接口。' } }
}

async function call(work: (target: AgentHomeBridge) => Promise<unknown>): Promise<AgentHomeResult> {
  const target = bridge()
  if (target === null) return unavailable()
  try {
    const response = await work(target)
    if (!isAgentHomeResult(response)) {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: 'Agent 目录接口返回了不符合契约的结果。' } }
    }
    return response
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Agent 目录接口调用失败。' } }
  }
}

export function loadAgentHomeState(): Promise<AgentHomeResult> {
  return call(target => target.getAgentHomeState())
}

/** 导入只补缺、不覆盖；重复点击不会改掉产品目录里已有的内容。 */
export function importSharedAgent(): Promise<AgentHomeResult> {
  return call(target => target.importSharedAgent())
}
