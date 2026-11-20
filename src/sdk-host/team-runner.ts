/**
 * 成员轮的进程载体：把一条派活变成跑完一轮的 pi 子进程，并把结果收敛成一条观测记录。
 *
 * 为什么是子进程而不是同进程再建一个会话：宿主会话的装配紧绑页面绑定状态（bindingGuard、
 * 卡片转发、浏览器操作都按 bindingId），成员没有绑定，把这套状态参数化会动到主会话的装配边界。
 * 子进程与 `delegate_subagent` 共用同一套进程控制习惯，但刻意保留会话落盘：
 * 成员用 `--session-dir` 指向 `<agentDir>/team-sessions/<根会话 id>`，第二轮回 `--session <id>` 续用，
 * 因此成员能带着自己上一轮的上下文继续干——这是与委派子进程最本质的差别。
 *
 * 装配只带两样东西：专家角色段（`--append-system-prompt`，正文已在定义层裁剪到安全长度）
 * 与写入守卫（复用 `sub-agent-write-guard.mjs`）。技能正文不拼进命令行参数，
 * 成员按角色段列出的技能范围自行读取 SKILL.md。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { relative, resolve } from 'node:path'
import type { TeamMemberRun, TeamMemberRunFailure, TeamMemberRunUsage } from '../shared/team-run-api'
import { MAX_TEAM_RUN_FILES, MAX_TEAM_RUN_QUESTIONS, MAX_TEAM_RUN_SUMMARY } from '../shared/team-run-api'

/** 单轮预算：超时按失败收敛，不无限挂着拖住团长。 */
export const TEAM_MEMBER_TIMEOUT_MS = 15 * 60_000
/** 请求结束后的强杀宽限：给成员一次正常收尾机会，超出即强制结束。 */
const KILL_GRACE_MS = 3_000
/** 输出上限：防止异常输出把宿主内存吃满，超出即终止并按失败处理。 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/**
 * 子进程固定参数：关闭扩展与技能发现、提示词模板、上下文文件与 MCP。
 * 与委派子进程不同，这里**不**关闭会话落盘——成员会话是它的身份与上下文。
 */
const MEMBER_ISOLATION_ARGS = [
  '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-mcp'
] as const

/** 写入范围变量：与 `sub-agent-write-guard.mjs` 读取的变量同名，守卫逻辑不重复实现。 */
const SCOPE_ENV = 'PI_SUB_AGENT_WRITE_SCOPE'

export interface TeamMemberStart {
  /** `out/sdk-host/pi-cli.mjs`。 */
  readonly entryPath: string
  /** `out/sdk-host/sub-agent-write-guard.mjs`。 */
  readonly guardPath: string
  /** 项目根：成员在其中读写，会话目录另由 `sessionDir` 指定。 */
  readonly cwd: string
  readonly sessionDir: string
  readonly itemId: string
  readonly memberExpertId: string
  readonly attempt: number
  /** 成员会话 id：按根会话与成员确定性推出，首轮新建、之后精确复用。 */
  readonly sessionId: string
  /** 团长写的任务说明：成员这一轮的唯一输入，不含账本全貌。 */
  readonly instruction: string
  /** 成员专家角色段（正文已按定义层上限裁剪）。 */
  readonly systemPrompt: string
  /** 成员技能规范文件：已写到成员会话目录，Pi 读到存在的文件时取正文；null 表示没有技能。 */
  readonly skillPromptPath: string | null
  /** 成员工具范围；null 表示不裁剪。 */
  readonly tools: readonly string[] | null
  /** 成员写入范围（相对项目根）；null 不限制，空数组只读。 */
  readonly writeScope: readonly string[] | null
  readonly timeoutMs?: number
}

export interface TeamMemberHandle {
  readonly done: Promise<TeamMemberRun>
  stop(): void
}

/** 环境：剥掉宿主注入的产品变量，Electron 下必须显式按 Node 模式运行子进程。 */
function workerEnv(extra?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('PI_DESK_')) continue
    env[key] = value
  }
  env.ELECTRON_RUN_AS_NODE = '1'
  if (extra !== undefined) Object.assign(env, extra)
  return env
}

/** 写入范围归一成绝对路径；目录项以分隔符结尾，与守卫的边界比较口径一致。 */
function absoluteScope(cwd: string, scope: readonly string[]): string {
  return JSON.stringify(scope.map(item => {
    const target = resolve(cwd, item)
    const directory = item.endsWith('/') || item.endsWith('\\')
    return directory ? `${target}${process.platform === 'win32' ? '\\' : '/'}` : target
  }))
}

/** 助手文本：只取 text 块，拼成结论；思考与工具输出都不算成员结论。 */
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

function readUsage(value: unknown): TeamMemberRunUsage | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const positive = (input: unknown): number => (typeof input === 'number' && Number.isFinite(input) && input > 0
    ? Math.floor(input)
    : 0)
  const usage = {
    inputTokens: positive(record.input),
    outputTokens: positive(record.output),
    totalTokens: positive(record.totalTokens)
  }
  return usage.inputTokens === 0 && usage.outputTokens === 0 && usage.totalTokens === 0 ? null : usage
}

/** 工具参数里的写入目标：只有 write/edit 的 `path` 是真实写入事实。 */
function readWritePath(toolName: unknown, args: unknown): string | null {
  if (toolName !== 'write' && toolName !== 'edit') return null
  if (typeof args !== 'object' || args === null) return null
  const path = (args as Record<string, unknown>).path
  return typeof path === 'string' && path !== '' ? path : null
}

/**
 * 待决项：成员把需要拍板的事写成「待决：…」行。
 * 只认这个固定写法，不把结论里的普通句子猜成待决项。
 */
function readQuestions(summary: string | null): string[] {
  if (summary === null) return []
  const questions: string[] = []
  for (const line of summary.split(/\r?\n/)) {
    const match = /^\s*(?:待决项?|待确认项?)\s*[：:]\s*(.+)$/.exec(line)
    if (match === null) continue
    const item = match[1]?.trim()
    if (item === undefined || item === '') continue
    questions.push(item.slice(0, 400))
    if (questions.length >= MAX_TEAM_RUN_QUESTIONS) break
  }
  return questions
}

/** 起一条成员轮：参数、环境、事件解析与终止收敛都在这里，调用方只拿终态记录。 */
export function startTeamMember(start: TeamMemberStart): TeamMemberHandle {
  const startedAt = Date.now()
  const timeoutMs = start.timeoutMs ?? TEAM_MEMBER_TIMEOUT_MS
  const writable = start.writeScope !== null && start.writeScope.length > 0
  const args: string[] = ['--mode', 'json', '--session-dir', start.sessionDir]
  // 始终传精确 id：缺失时新建，已存在时复用，因此不需要区分首轮与续派。
  args.push('--session-id', start.sessionId)
  args.push('--append-system-prompt', start.systemPrompt)
  // 技能正文走文件而不是命令行：正文可达几十 KB，超出命令行长度上限会被截断。
  if (start.skillPromptPath !== null) args.push('--append-system-prompt', start.skillPromptPath)
  if (start.tools !== null) args.push('--tools', start.tools.join(','))
  args.push(...MEMBER_ISOLATION_ARGS)
  // 只读成员不给写入工具；有范围才装守卫，不声明的成员不额外加限制。
  if (start.writeScope !== null && start.writeScope.length === 0) args.push('--exclude-tools', 'write,edit')
  if (writable) args.push('-e', start.guardPath)
  args.push(start.instruction)

  const envExtra: Record<string, string> = {}
  if (writable) envExtra[SCOPE_ENV] = absoluteScope(start.cwd, start.writeScope ?? [])

  let child: ChildProcess | null = null
  let cancelled = false
  let timedOut = false
  let settled = false
  let killTimer: NodeJS.Timeout | null = null
  let supervisor: NodeJS.Timeout | null = null
  const files: string[] = []
  let summary: string | null = null
  let usage: TeamMemberRunUsage | null = null
  let aborted = false
  let stderrTail = ''

  const done = new Promise<TeamMemberRun>(resolveDone => {
    /** 终态收敛：所有退出路径都走这里，保证记录只写一次。 */
    const finish = (failure: TeamMemberRunFailure | null): void => {
      if (settled) return
      settled = true
      if (supervisor !== null) clearTimeout(supervisor)
      if (killTimer !== null) clearTimeout(killTimer)
      const status = failure === null ? 'completed' : failure === 'aborted' ? 'cancelled' : 'failed'
      resolveDone({
        itemId: start.itemId,
        memberExpertId: start.memberExpertId,
        attempt: start.attempt,
        status,
        startedAt,
        finishedAt: Date.now(),
        summary: summary === null ? null : summary.slice(0, MAX_TEAM_RUN_SUMMARY),
        files,
        questions: readQuestions(summary),
        usage,
        failure
      })
    }

    const stopChild = (): void => {
      if (child === null || child.killed) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (child !== null && !child.killed) child.kill('SIGKILL')
      }, KILL_GRACE_MS)
    }

    supervisor = setTimeout(() => {
      timedOut = true
      stopChild()
      // 宽限后仍无退出事件就按超时收敛；exit 先到时由 exit 分支收敛，不重复写。
      setTimeout(() => finish('timeout'), KILL_GRACE_MS + 500)
    }, timeoutMs)

    try {
      child = spawn(process.execPath, [start.entryPath, ...args], {
        cwd: start.cwd,
        env: workerEnv(envExtra),
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

    const consume = (event: Record<string, unknown>): void => {
      if (event.type === 'tool_execution_start') {
        const path = readWritePath(event.toolName, event.args)
        if (path !== null && files.length < MAX_TEAM_RUN_FILES) {
          const target = relative(start.cwd, resolve(start.cwd, path)).split('\\').join('/')
          if (!files.includes(target)) files.push(target)
        }
        return
      }
      if (event.type === 'message_end') {
        const text = readAssistantText(event.message)
        // 成员一轮里还有工具调用：只保留最后一段助手文本作为结论。
        if (text !== null && text.trim() !== '') summary = text.trim()
        if (typeof event.message === 'object' && event.message !== null) {
          usage = readUsage((event.message as Record<string, unknown>).usage) ?? usage
        }
        return
      }
      if (event.type === 'message_update') {
        usage = readUsage(event.usage) ?? usage
        return
      }
      if (event.type === 'agent_settled') aborted = event.aborted === true
    }

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
          try { consume(JSON.parse(line) as Record<string, unknown>) } catch { /* 非 JSON 行不参与解析 */ }
        }
        index = buffer.indexOf('\n')
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2_000)
    })
    child.once('error', () => finish('unavailable'))
    child.once('exit', code => {
      if (cancelled) {
        finish('aborted')
        return
      }
      if (timedOut) {
        finish('timeout')
        return
      }
      if (aborted) {
        finish('aborted')
        return
      }
      if (code === 0) {
        // 退出码为 0 却没有结论：成员没交付结论，按失败收敛，免得团长把空当完成。
        finish(summary === null ? 'error' : null)
        return
      }
      // 非零退出：把 stderr 末尾带进记录，便于团长判断是能力缺失还是任务失败。
      if (stderrTail.trim() !== '') summary = `${summary ?? ''}\n${stderrTail.trim()}`.trim()
      finish('error')
    })
  })

  return {
    done,
    stop(): void {
      cancelled = true
      child?.kill('SIGTERM')
    }
  }
}
