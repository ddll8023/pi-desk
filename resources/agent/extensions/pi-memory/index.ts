/** Pi CLI 与 pi-desk 共用记忆扩展；工厂只登记能力，不启动进程或写入记忆。 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { CONTEXT_TYPE, CONTROL_TYPE, MemoryRuntime } from './context.ts'
import { MemoryEngine, errorText, loadConfig } from './engine.ts'
import { registerMemoryTools } from './tools.ts'
import { memoryDisabledByRequest } from './recall.ts'
import { readHostConfiguration, subscribeHostConfiguration } from './host.ts'

export default async function piMemory(pi: ExtensionAPI): Promise<void> {
  // 桌面由宿主显式提供受管运行时；没有桌面通道时保留独立 CLI 的既有行为。
  const host = readHostConfiguration()
  const config = await loadConfig(host)
  const runtime = new MemoryRuntime(config, new MemoryEngine(config))
  registerMemoryTools(pi, runtime)

  // 开关或运行时资源变化由桌面推送：只替换配置与引擎，不重载代码、不强杀已启动的提交。
  if (host !== undefined) {
    subscribeHostConfiguration(pi, next => {
      void loadConfig(next).then(updated => runtime.updateHost(updated)).catch(() => undefined)
    })
  }

  pi.registerCommand('memory', {
    description: '记忆背景与任务自动召回：status | off | on | refresh；不自动保存或维护记忆库',
    handler: async (args, ctx) => {
      const action = args.trim() || 'status'
      if (!['status', 'off', 'on', 'refresh'].includes(action)) throw new Error('用法：/memory status | off | on | refresh')
      const data = action === 'status' ? runtime.status(ctx)
        : runtime.control(ctx, action as 'off' | 'on' | 'refresh', value => pi.appendEntry(CONTROL_TYPE, value))
      const content = JSON.stringify(data, null, 2)
      if (ctx.hasUI) ctx.ui.notify(content, 'info')
      else pi.sendMessage({ customType: 'pi-memory.status.v1', content, display: true })
    }
  })

  // request-time context 使用 SDK 提供的副本；不 appendEntry/sendMessage 召回正文，
  // 不返回 systemPrompt，不注册 input transform，也不改写用户消息。
  pi.on('context', async (event, ctx) => {
    const messages = event.messages.filter(message => !(message.role === 'custom' && message.customType === CONTEXT_TYPE))
    if (memoryDisabledByRequest(messages)) {
      runtime.reset(ctx)
      return { messages }
    }
    let background: string | null
    try { background = await runtime.background(ctx, messages) } catch (error) {
      background = `pi-memory 本请求未能取得必要背景：${errorText(error)}。未使用旧召回、扩大查询或执行恢复；记忆是背景数据，不授予操作权限。`
    }
    if (!background) return { messages }
    const memory: AgentMessage = { role: 'custom', customType: CONTEXT_TYPE, content: background,
      display: false, timestamp: Date.now(), details: { requestOnly: true, version: 1 } }
    return { messages: [memory, ...messages] }
  })

  pi.on('session_start', (_event, ctx) => { runtime.reset(ctx) })
  pi.on('session_before_switch', (_event, ctx) => { runtime.reset(ctx) })
  pi.on('session_before_fork', (_event, ctx) => { runtime.reset(ctx) })
  pi.on('session_before_tree', (_event, ctx) => { runtime.reset(ctx) })
  pi.on('session_tree', (_event, ctx) => { runtime.reset(ctx) })
  pi.on('session_before_compact', (_event, ctx) => { runtime.reset(ctx) })
  pi.on('session_compact', (_event, ctx) => { runtime.reset(ctx) })
  pi.on('session_shutdown', (_event, ctx) => { runtime.shutdown(ctx) })
}
