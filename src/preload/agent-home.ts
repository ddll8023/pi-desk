/** Agent 目录域桥接：只经固定 channel 转发状态与导入请求，不开放任何路径或文件内容。 */
import { ipcRenderer } from 'electron'
import {
  AGENT_HOME_IMPORT_CHANNEL, AGENT_HOME_STATE_CHANNEL, isAgentHomeResult
} from '../shared/agent-home-api'
import type { AgentHomeApi, AgentHomeResult } from '../shared/agent-home-api'

async function invoke(channel: string): Promise<AgentHomeResult> {
  try {
    const response: unknown = await ipcRenderer.invoke(channel)
    if (!isAgentHomeResult(response)) {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: 'Agent 目录接口返回了不符合契约的结果。' } }
    }
    return response
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Agent 目录接口调用失败。' } }
  }
}

export const agentHomeApi: AgentHomeApi = {
  async getAgentHomeState(): Promise<AgentHomeResult> {
    return invoke(AGENT_HOME_STATE_CHANNEL)
  },
  async importSharedAgent(): Promise<AgentHomeResult> {
    return invoke(AGENT_HOME_IMPORT_CHANNEL)
  }
}
