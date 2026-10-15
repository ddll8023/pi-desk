/**
 * MCP 服务器探测与取消：另起一次性官方 CLI 进程（`pi mcp list --json`）连接并报告服务器状态。
 *
 * 这不是运行中会话的查询：探测进程会自行连接每个已启用服务器（stdio 服务器会被再启动一次，
 * 并在该次连接关闭时随之结束），因此结果只反映探测那一刻。探测只读，不写任何配置文件。
 * 探测进程始终以未信任项目身份运行，项目级 `.pi/mcp.json` 由 Pi 忽略并在 `note` 里说明。
 *
 * 同一时刻只允许一次探测：并发调用按参数拒绝，不排队也不合并；探测句柄经 `activeProbe` 暴露给
 * `abort()`，使超时与用户取消共用同一条终止链，且不依赖任何会话后端状态。
 */
import type { ChildProcess } from 'node:child_process'
import type {
  McpInspection,
  McpInspectionResult,
  McpInspectAbortResult,
  McpServerReport,
  RuntimeErrorCode
} from '../shared/runtime-api'
import { spawnPiCli } from './pi-cli-process'
import { terminateProcessTree } from './process-tree-termination'

/**
 * MCP 服务器探测的等待上限：官方 CLI 会依次连接所有已启用服务器，
 * 每个服务器自身还有超时，因此明显长于单个命令。
 */
const MCP_INSPECT_TIMEOUT_MS = 120_000

/** 探测进程被要求终止后，等待其自行退出的期限。 */
const MCP_INSPECT_KILL_GRACE_MS = 3_000

/** 探测输出的字符数上限；超限按协议错误处理，不无界缓存。 */
const MCP_INSPECT_MAX_OUTPUT_CHARS = 2_097_152

/** 探测失败时保留的 stderr 尾部字符数；只用于诊断，不作为结果的一部分。 */
const MCP_INSPECT_STDERR_TAIL_CHARS = 600

/** 可分类的探测失败，由 `inspect` 统一转换为结果对象。 */
class McpInspectionFailure extends Error {
  readonly code: RuntimeErrorCode

  constructor(code: RuntimeErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** 任意值转纯文本条目；官方 CLI 的 errors 是字符串数组，其他形状也如实展示而不丢弃。 */
function toTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => (typeof item === 'string' ? item : String(item)))
}

function toToolExposure(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

/** 把官方 CLI 的一个服务器报告归一化成展示形状；缺失字段按 null 或默认值补齐，不猜测缺失值。 */
function toMcpServerReport(value: Record<string, unknown>): McpServerReport | null {
  if (typeof value.name !== 'string' || value.name === '') return null
  if (typeof value.state !== 'string' || value.state === '') return null
  return {
    name: value.name,
    scope: typeof value.scope === 'string' ? value.scope : 'global',
    source: typeof value.source === 'string' ? value.source : '',
    override: typeof value.override === 'string' ? value.override : null,
    // `enabled` 缺失时官方默认视为已启用。
    enabled: value.enabled !== false,
    exposure: typeof value.exposure === 'string' ? value.exposure : '',
    transport: typeof value.transport === 'string' ? value.transport : '',
    state: value.state,
    tools: Array.isArray(value.tools) ? value.tools.filter((tool): tool is string => typeof tool === 'string') : [],
    toolExposure: toToolExposure(value.toolExposure),
    // 官方只报告该服务器是否提供资源（`resources: true`），不报告资源与模板数量。
    hasResources: value.resources === true,
    error: typeof value.error === 'string' ? value.error : null
  }
}

/**
 * 解析官方 CLI 的 `--json` 输出；形状不符时返回 null，由调用方按协议错误处理。
 * 返回的字段不含 `inspectedAt`：那一个时刻由调用方在探测结束时落定，不由 Pi 输出提供。
 */
function parseMcpInspection(stdout: string): Omit<McpInspection, 'inspectedAt'> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const payload = parsed as Record<string, unknown>
  if (!Array.isArray(payload.servers)) return null
  const servers: McpServerReport[] = []
  for (const entry of payload.servers) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const report = toMcpServerReport(entry as Record<string, unknown>)
    if (report !== null) servers.push(report)
  }
  return {
    servers,
    configErrors: toTextList(payload.errors),
    note: typeof payload.note === 'string' && payload.note !== '' ? payload.note : null
  }
}

interface McpListProbeResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderrTail: string
}

/**
 * 执行固定的 `pi mcp list --json` 并收集输出。
 *
 * 参数是固定的，页面无法传入命令文本：官方 CLI 不接受信任 flag（`--approve` 会被 `mcp` 子命令拒绝，
 * 且与 `--json` 不能共存），因此探测始终以未信任项目身份运行：项目级 `.pi/mcp.json` 由 Pi 忽略，
 * 并在输出的 `note` 里说明。这也意味着探测结果可能与运行中会话（已信任项目）看到的服务器不同。
 * 退出码只如实回传，不在此判定成败。
 * `onStart` 在进程启动后同步给出中止入口，供调用方在超时、用户取消时终止进程树。
 */
function runMcpListProbe(
  projectPath: string,
  onStart: (abort: (message: string) => void) => void
): Promise<McpListProbeResult> {
  const args = ['mcp', 'list', '--json']

  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnPiCli(args, { cwd: projectPath, stdin: false })
    } catch (error) {
      reject(new McpInspectionFailure(
        'RUNTIME_SPAWN_FAILED',
        `无法启动 MCP 探测进程：${error instanceof Error ? error.message : String(error)}`
      ))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let forceTimer: NodeJS.Timeout | null = null

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    function cleanup(): void {
      clearTimeout(timer)
      if (forceTimer !== null) clearTimeout(forceTimer)
    }

    function fail(failure: McpInspectionFailure): void {
      if (settled) return
      settled = true
      cleanup()
      reject(failure)
    }

    /**
     * 结束本次探测并终止进程树：先给 SIGTERM，宽限期后补 SIGKILL。
     * 退出码与中止原因由调用方决定，因为超时与用户取消共用同一条终止链。
     */
    function abortProbe(code: RuntimeErrorCode, message: string): void {
      fail(new McpInspectionFailure(code, message))
      terminateProcessTree(child, 'SIGTERM')
      forceTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), MCP_INSPECT_KILL_GRACE_MS)
    }

    child.stdout?.on('data', (chunk: string) => {
      if (settled) return
      stdout += chunk
      if (stdout.length > MCP_INSPECT_MAX_OUTPUT_CHARS) {
        stdout = ''
        fail(new McpInspectionFailure('RUNTIME_PROTOCOL_ERROR', 'MCP 探测输出超出长度上限。'))
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MCP_INSPECT_STDERR_TAIL_CHARS)
    })

    const timer = setTimeout(() => {
      abortProbe('RUNTIME_TIMEOUT', 'MCP 探测超时，结果未知。')
    }, MCP_INSPECT_TIMEOUT_MS)

    child.once('error', (error) => {
      fail(new McpInspectionFailure('RUNTIME_SPAWN_FAILED', `MCP 探测进程启动失败：${error.message}`))
    })

    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      cleanup()
      if (code === null) {
        reject(new McpInspectionFailure(
          'RUNTIME_EXITED',
          `MCP 探测进程被信号 ${signal ?? '未知'} 结束，未取得结果。`
        ))
        return
      }
      resolve({ exitCode: code, stdout, stderrTail: stderr })
    })

    // 在所有回调就位后再交出中止入口：调用方只会在稍后使用它，此时定时器与状态都已初始化。
    onStart((message) => abortProbe('RUNTIME_EXITED', message))
  })
}

export class McpInspectionManager {
  private activeProbe: { readonly projectPath: string; readonly abort: (message: string) => void } | null = null

  /**
   * 探测当前项目的 MCP 服务器：以当前项目为工作目录执行固定的 `pi mcp list --json`。
   * 并发调用按参数拒绝，不排队也不合并。
   * 退出码 1 表示有配置错误或已启用服务器未连接，仍按成功返回；其他退出码按失败处理。
   */
  async inspect(projectPath: string): Promise<McpInspectionResult> {
    if (this.activeProbe !== null) {
      return {
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '已有一个 MCP 探测在进行中；等它结束，或先取消它。'
        }
      }
    }

    try {
      const probe = await runMcpListProbe(projectPath, (abort) => {
        this.activeProbe = { projectPath, abort }
      })
      if (probe.exitCode !== 0 && probe.exitCode !== 1) {
        const detail = probe.stderrTail.trim().split('\n').slice(-1)[0] ?? ''
        throw new McpInspectionFailure(
          'RUNTIME_COMMAND_REJECTED',
          `MCP 探测进程以退出码 ${probe.exitCode} 结束。${detail}`
        )
      }
      const inspection = parseMcpInspection(probe.stdout)
      if (inspection === null) {
        throw new McpInspectionFailure('RUNTIME_PROTOCOL_ERROR', 'MCP 探测输出不是约定的 JSON 结构。')
      }
      // 时刻在这里落定：它描述的是本次探测结束的时刻，不是 Pi 的报告字段。
      return { ok: true, data: { ...inspection, inspectedAt: Date.now() } }
    } catch (error) {
      const failure = error instanceof McpInspectionFailure
        ? error
        : new McpInspectionFailure('INTERNAL_ERROR', 'MCP 探测时发生未预期的内部错误。')
      return { ok: false, error: { code: failure.code, message: failure.message } }
    } finally {
      this.activeProbe = null
    }
  }

  /** 终止进行中的探测；没有进行中的探测时不产生任何副作用。 */
  abort(): McpInspectAbortResult {
    const probe = this.activeProbe
    if (probe === null) return { ok: true, data: { aborted: false } }
    probe.abort('MCP 探测已被取消。')
    return { ok: true, data: { aborted: true } }
  }
}
