/**
 * 工作流节点的进程载体：一个节点跑一次独立 pi 子进程，跑完收敛成一条结论。
 *
 * 与 `src/sdk-host/team-runner.ts` 同一套进程习惯（`--mode json` 逐行事件、`--session-dir` 落盘、
 * 写入守卫环境变量、超时强杀、输出上限），差别只在归属：工作流不依附任何会话，
 * 因此这里不 import 宿主模块，会话目录按「运行 + 节点」分开，节点之间不共享上下文。
 *
 * 专家正文在调用前由本模块解析：节点只带专家标识，不把正文写进定义文件，
 * 专家改版后节点自然按新正文运行。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { join, resolve } from 'node:path'
import { agentResourcesDirectory, readAgentResourceBundle } from '../../shared-process/agent-resources'
import {
  builtinExperts,
  loadExpertCatalog,
  resolveExpertCapabilityScope
} from '../../shared-process/expert-definitions'
import type { ExpertDefinition } from '../../shared-process/expert-definitions'
import { readExpertCapabilityDefaults } from '../../shared-process/expert-capability-defaults'
import { getPiAgentDir, getPiProcessEnvironment } from '../shared/pi-paths'
import { getSdkHostDirectory } from '../shared/pi-cli-process'
import { readConfiguredMcpServers } from '../resources/mcp-config-reader'
import { readExpertSkillContext } from '../sessions/expert-catalog'
import { MAX_WORKFLOW_NODE_OUTPUT } from '../../shared/workflow-api'
import type { WorkflowNodeFailure } from '../../shared/workflow-api'

/** 请求结束后的强杀宽限：给节点一次正常收尾机会，超出即强制结束。 */
const KILL_GRACE_MS = 3_000
/** 输出上限：防止异常输出把主进程内存吃满，超出即终止并按失败处理。 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/** 节点进程固定参数：关闭扩展、技能发现、提示词模板、上下文文件与 MCP，只留角色段与指令。 */
const NODE_ISOLATION_ARGS = [
  '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-mcp'
] as const

/** 写入范围变量：与 `sub-agent-write-guard.mjs` 读取的变量同名，守卫逻辑不重复实现。 */
const SCOPE_ENV = 'PI_SUB_AGENT_WRITE_SCOPE'

export interface WorkflowNodeStart {
  readonly cwd: string
  readonly sessionDir: string
  readonly sessionId: string
  /** 节点这一轮的唯一输入。 */
  readonly instruction: string
  /** 专家角色段；专家标识无效时为空串，节点仍可运行。 */
  readonly systemPrompt: string
  /** 写入范围：null 不限制，空数组只读。 */
  readonly writeScope: readonly string[] | null
  /** 专家生效的工具集；null 不限制（不传 `--tools`）。 */
  readonly tools: readonly string[] | null
  readonly timeoutMs: number
  readonly signal: { readonly cancelled: boolean }
}

export interface WorkflowNodeOutcome {
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly output: string | null
  readonly failure: WorkflowNodeFailure | null
}

/** 专家正文缓存：一次运行里多个节点共用同一份清单，只读一次；每次运行开始时失效。 */
let expertCache: Map<string, ExpertDefinition> | null = null

/** 置空缓存：运行开始时调用，专家改版后下一轮运行就能取到新正文。 */
export function resetExpertCache(): void {
  expertCache = null
  capabilityInputsCache = null
}

/**
 * 节点可用的工具名：随包清单声明的工具里去掉扩展注册的那些。
 *
 * 节点子进程带 `--no-extensions`，扩展工具在那里不存在；把它们的名字传给 `--tools` 没有意义。
 */
function executableToolNames(): string[] {
  const bundle = readAgentResourceBundle(agentResourcesDirectory(join(getSdkHostDirectory(), 'index.mjs')))
  const extensionTools = new Set(bundle.extensions.flatMap(item => item.requiredTools))
  return bundle.tools.map(item => item.name).filter(name => !extensionTools.has(name))
}

interface CapabilityInputs {
  readonly availableSkillIds: readonly string[]
  readonly availableMcpServers: readonly string[]
  readonly availableToolNames: readonly string[]
  readonly defaults: ReturnType<typeof readExpertCapabilityDefaults>
}

/** 能力计算的输入：一次运行里多个节点共用，避免每个节点都重读清单与默认基线。 */
let capabilityInputsCache: CapabilityInputs | null = null

function capabilityInputs(): CapabilityInputs {
  if (capabilityInputsCache !== null) return capabilityInputsCache
  const skillContext = readExpertSkillContext()
  capabilityInputsCache = {
    availableSkillIds: [...skillContext.availableSkillIds],
    availableMcpServers: readConfiguredMcpServers().map(server => server.name),
    availableToolNames: executableToolNames(),
    defaults: readExpertCapabilityDefaults(getPiAgentDir())
  }
  return capabilityInputsCache
}

/** 节点生效的角色段、写入范围与工具集：节点自身的写入范围优先，未配置时沿用专家定义。 */
export interface WorkflowNodeRole {
  readonly systemPrompt: string
  readonly writeScope: readonly string[] | null
  readonly tools: readonly string[] | null
}

export function resolveNodeRole(
  expertId: string | null,
  nodeWriteScope: readonly string[] | null
): WorkflowNodeRole {
  const expert = expertForNode(expertId)
  if (expert === null) return { systemPrompt: '', writeScope: nodeWriteScope, tools: null }
  const inputs = capabilityInputs()
  const scope = resolveExpertCapabilityScope({
    definition: expert,
    defaults: inputs.defaults,
    availableSkillIds: inputs.availableSkillIds,
    availableMcpServers: inputs.availableMcpServers,
    availableToolNames: inputs.availableToolNames
  })
  return {
    systemPrompt: `# 工作流节点角色\n\n${expert.body}`.trim(),
    writeScope: nodeWriteScope ?? expert.writeScope,
    tools: scope.tools
  }
}

/** 当前可用专家清单（内置 + 自定义，同标识自定义覆盖内置）。 */
function expertDefinitions(): Map<string, ExpertDefinition> {
  if (expertCache !== null) return expertCache
  const bundle = readAgentResourceBundle(agentResourcesDirectory(join(getSdkHostDirectory(), 'index.mjs')))
  const skillContext = readExpertSkillContext()
  const catalog = loadExpertCatalog({
    builtin: builtinExperts(bundle),
    userDirectory: join(getPiAgentDir(), 'experts'),
    availableSkillIds: [...skillContext.availableSkillIds],
    subAgentOnlySkillIds: [...skillContext.subAgentOnlySkillIds],
    availableMcpServers: readConfiguredMcpServers().map(server => server.name)
  })
  expertCache = new Map(catalog.experts.map(expert => [expert.id, expert]))
  return expertCache
}

/** 读取节点使用专家的定义；读不到时返回 null，节点按「无角色段」运行并记录一条告警。 */
export function expertForNode(expertId: string | null): ExpertDefinition | null {
  if (expertId === null) return null
  try {
    return expertDefinitions().get(expertId) ?? null
  } catch {
    return null
  }
}

/** 写入范围归一成绝对路径；目录项以分隔符结尾，与守卫的边界比较口径一致。 */
function absoluteScope(cwd: string, scope: readonly string[]): string {
  return JSON.stringify(scope.map(item => {
    const target = resolve(cwd, item)
    const directory = item.endsWith('/') || item.endsWith('\\')
    return directory ? `${target}${process.platform === 'win32' ? '\\' : '/'}` : target
  }))
}

/** 助手文本：只取 text 块，拼成节点结论；思考与工具输出都不算结论。 */
function readAssistantText(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null
  const record = message as Record<string, unknown>
  if (record.role !== 'assistant') return null
  const content = record.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const item = block as Record<string, unknown>
      if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    }
  }
  return parts.join('')
}

/**
 * 跑一个节点：所有退出路径都收敛成一次返回值，调用方只处理终态。
 * 取消通过 `signal.cancelled` 传递（每轮检查一次），因此不需要把取消做成独立的 Promise。
 */
export function runWorkflowNode(start: WorkflowNodeStart): Promise<WorkflowNodeOutcome> {
  const guardPath = resolve(getSdkHostDirectory(), 'sub-agent-write-guard.mjs')
  const entryPath = resolve(getSdkHostDirectory(), 'pi-cli.mjs')
  // 空数组表示只读：同样装守卫，由守卫拒绍全部写入；只靠 `--exclude-tools write,edit` 挡不住 shell。
  const writable = start.writeScope !== null
  const args: string[] = ['--mode', 'json', '--session-dir', start.sessionDir, '--session-id', start.sessionId]
  if (start.systemPrompt !== '') args.push('--append-system-prompt', start.systemPrompt)
  // 专家工具范围：空数组表示一个也没选，此时不传 `--tools`（传空串没有意义），
  // 由调用方在事件里记一条说明，避免静默退化成默认工具集。
  if (start.tools !== null && start.tools.length > 0) args.push('--tools', start.tools.join(','))
  args.push(...NODE_ISOLATION_ARGS)
  // 空数组表示只读：即使不装 `--exclude-tools`，守卫也会拒给写入。
  if (start.writeScope !== null && start.writeScope.length === 0) args.push('--exclude-tools', 'write,edit')
  if (writable) args.push('-e', guardPath)
  args.push(start.instruction)

  const env: NodeJS.ProcessEnv = getPiProcessEnvironment({ ELECTRON_RUN_AS_NODE: '1' })
  if (writable) env[SCOPE_ENV] = absoluteScope(start.cwd, start.writeScope ?? [])

  return new Promise<WorkflowNodeOutcome>(resolveOutcome => {
    let child: ChildProcess | null = null
    let settled = false
    let cancelled = false
    let timedOut = false
    let killTimer: NodeJS.Timeout | null = null
    let supervisor: NodeJS.Timeout | null = null
    let watcher: NodeJS.Timeout | null = null
    let output: string | null = null
    let stderrTail = ''

    const stopChild = (): void => {
      if (child === null || child.killed) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (child !== null && !child.killed) child.kill('SIGKILL')
      }, KILL_GRACE_MS)
    }

    const stopWatcher = (): void => {
      if (watcher === null) return
      clearInterval(watcher)
      watcher = null
    }

    const finish = (failure: WorkflowNodeFailure | null): void => {
      if (settled) return
      settled = true
      if (supervisor !== null) clearTimeout(supervisor)
      if (killTimer !== null) clearTimeout(killTimer)
      stopWatcher()
      const status = failure === null ? 'completed' : failure === 'aborted' ? 'cancelled' : 'failed'
      resolveOutcome({
        status,
        output: output === null ? null : output.slice(0, MAX_WORKFLOW_NODE_OUTPUT),
        failure
      })
    }

    supervisor = setTimeout(() => {
      timedOut = true
      stopChild()
      setTimeout(() => finish('timeout'), KILL_GRACE_MS + 500)
    }, start.timeoutMs)

    // 取消信号按固定间隔检查：调用方不必持有子进程句柄。
    watcher = setInterval(() => {
      if (!start.signal.cancelled) return
      cancelled = true
      stopWatcher()
      stopChild()
      setTimeout(() => finish('aborted'), KILL_GRACE_MS + 500)
    }, 200)

    try {
      child = spawn(process.execPath, [entryPath, ...args], {
        cwd: start.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch {
      finish('unavailable')
      return
    }

    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let size = 0

    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) {
        stopChild()
        finish('error')
        return
      }
      buffer += decoder.decode(chunk, { stream: true })
      // 只按字节 LF 切记录：字符串里可能出现 Unicode 行分隔符，不能当边界。
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') {
          try {
            const event = JSON.parse(line) as Record<string, unknown>
            if (event.type === 'message_end') {
              const text = readAssistantText(event.message)
              // 节点一轮里还有工具调用：只保留最后一段助手文本作为结论。
              if (text !== null && text.trim() !== '') output = text.trim()
            }
          } catch {
            // 非 JSON 行不参与解析。
          }
        }
        index = buffer.indexOf('\n')
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2_000)
    })
    child.once('error', () => {
      finish('unavailable')
    })
    child.once('exit', code => {
      if (cancelled) {
        finish('aborted')
        return
      }
      if (timedOut) {
        finish('timeout')
        return
      }
      if (code === 0) {
        // 退出码为 0 却没有结论：节点没交付结论，按失败收敛，免得下游把空当完成。
        finish(output === null ? 'error' : null)
        return
      }
      if (stderrTail.trim() !== '') output = `${output ?? ''}\n${stderrTail.trim()}`.trim()
      finish('error')
    })
  })
}
