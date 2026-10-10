/**
 * Runtime 未启动时的 Pi 资源预读：用固定的 `pi` 可执行文件起一次性 RPC 进程，只发 `get_commands` 后退出。
 *
 * 与运行中 Runtime 同源（同一个可执行文件、同一套资源发现规则），但不常驻、不落会话（`--no-session`）、
 * 不执行 Extension（`--no-extensions`）：仅为一列输入框候选就去执行扩展代码没有依据。
 * 因此由扩展在运行时追加的技能不在此清单内；Runtime 就绪后一律以运行中的 `get_commands` 为权威。
 *
 * 只读：不写 Pi 配置、不写 `trust.json`；`--approve`/`--no-approve` 只对本次进程生效。
 * 进程定位与终止方式与既有的 MCP 探测保持一致：独立进程组，超时或失败按组终止，不残留子进程。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { PiResourceEntry, RuntimeErrorCode } from '../shared/runtime-api'
import { getPiExecutablePath } from './pi-process'
import { toResources } from './pi-protocol'

/** 一次性预读的等待上限；与运行中的资源读取同一量级。 */
const PREVIEW_TIMEOUT_MS = 15_000
/** 要求终止后等待进程自行退出的期限。 */
const PREVIEW_KILL_GRACE_MS = 3_000
/** stdout 累计字符上限；超限按协议错误处理，不无界缓存。 */
const PREVIEW_MAX_OUTPUT_CHARS = 1_048_576
/** stderr 只保留尾部用于诊断文本，不作为结果的一部分。 */
const PREVIEW_STDERR_TAIL_CHARS = 600
/** 缓存条目上限；超出后整体清空，避免多项目切换时无界增长。 */
const PREVIEW_CACHE_LIMIT = 32
/** 本次请求的固定 id，只认这一条响应。 */
const PREVIEW_REQUEST_ID = 'resource-preview'

/** 预读失败：与 RuntimeFailure 同形，调用方按错误码映射为 IPC 结果。 */
export class ResourcePreviewError extends Error {
  constructor(readonly code: RuntimeErrorCode, message: string) {
    super(message)
  }
}

/** 「项目路径 + 信任决定」到清单的缓存；只缓存成功结果，失败一律重新探测。 */
const previewCache = new Map<string, readonly PiResourceEntry[]>()

/**
 * 预读当前项目的资源清单；同一项目与信任决定只探测一次。
 * 失败向上抛出 `ResourcePreviewError`，不用空清单冒充成功。
 */
export async function previewProjectResources(
  projectPath: string,
  trustDecision: 'trusted' | 'untrusted' | null
): Promise<readonly PiResourceEntry[]> {
  const key = `${projectPath}\n${trustDecision ?? 'default'}`
  const cached = previewCache.get(key)
  if (cached !== undefined) return cached

  const entries = await runPreviewProbe(projectPath, trustDecision)
  if (previewCache.size >= PREVIEW_CACHE_LIMIT) previewCache.clear()
  previewCache.set(key, entries)
  return entries
}

/**
 * 按平台终止探测进程树：先 SIGTERM，宽限期后补 SIGKILL。
 * 与 MCP 探测使用同一条链，但不复用其私有实现，避免把两个功能的生命周期绑在一起。
 */
function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    try {
      const killer = spawn(taskkill, ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true
      })
      // 失败的 spawn 会异步 emit error，必须消费以避免拖垮主进程。
      killer.once('error', () => {})
      killer.unref()
    } catch {
      // taskkill 无法执行时回退到单进程终止。
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // 进程已退出时不产生未处理异常。
    }
  }
}

/** 启动参数固定：RPC、不落会话、不加载 Extension，信任决定按主进程已取得的结论传递。 */
function previewLaunchArguments(trustDecision: 'trusted' | 'untrusted' | null): string[] {
  const args = ['--mode', 'rpc', '--no-session', '--no-extensions']
  if (trustDecision === 'trusted') args.push('--approve')
  else if (trustDecision === 'untrusted') args.push('--no-approve')
  return args
}

/** 起一次性进程取回清单：请求与进程退出分开处理，拿到响应后再关 stdin 让它自行退出。 */
function runPreviewProbe(
  projectPath: string,
  trustDecision: 'trusted' | 'untrusted' | null
): Promise<readonly PiResourceEntry[]> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(getPiExecutablePath(), previewLaunchArguments(trustDecision), {
        cwd: projectPath,
        // 只追加版本检查开关；凭据等仍由 Pi 自己的配置与环境提供。
        env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        // 独立进程组便于按组终止；不调用 unref，进程仍由应用管理。
        detached: process.platform !== 'win32',
        windowsHide: true
      })
    } catch (error) {
      reject(new ResourcePreviewError(
        'RUNTIME_SPAWN_FAILED',
        `无法启动资源预读进程：${error instanceof Error ? error.message : String(error)}`
      ))
      return
    }

    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    // 进程提前退出时对 stdin 的写入会异步 emit EPIPE；不消费会拖垮主进程。
    child.stdin?.on('error', () => {})
    let buffer = ''
    let stderr = ''
    let outputChars = 0
    let settled = false
    let closeTimer: NodeJS.Timeout | null = null

    const timeoutTimer = setTimeout(() => {
      fail(new ResourcePreviewError('RUNTIME_TIMEOUT', '资源预读超时，未取得清单。'))
    }, PREVIEW_TIMEOUT_MS)

    function clearCloseTimer(): void {
      if (closeTimer === null) return
      clearTimeout(closeTimer)
      closeTimer = null
    }

    /** 失败即终止进程树：不再需要结果，也不留下后台进程。 */
    function fail(error: ResourcePreviewError): void {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearCloseTimer()
      terminateProcessTree(child, 'SIGTERM')
      closeTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), PREVIEW_KILL_GRACE_MS)
      reject(error)
    }

    /** 成功即要求进程退出；退出确认交由宽限期兜底，不阻塞结果的返回。 */
    function succeed(entries: readonly PiResourceEntry[]): void {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      try {
        child.stdin?.end()
      } catch {
        // 进程已退出时写入会失败，此时无需再关 stdin。
      }
      closeTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), PREVIEW_KILL_GRACE_MS)
      resolve(entries)
    }

    function handleLine(line: string): void {
      if (settled || line === '') return
      let payload: unknown
      try {
        payload = JSON.parse(line)
      } catch {
        fail(new ResourcePreviewError('RUNTIME_PROTOCOL_ERROR', '资源预读进程输出了非 JSON 行。'))
        return
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return
      const record = payload as Record<string, unknown>
      if (record.type !== 'response' || record.id !== PREVIEW_REQUEST_ID) return
      if (record.success !== true) {
        const reason = typeof record.error === 'string' && record.error !== '' ? record.error : '未提供错误信息'
        fail(new ResourcePreviewError('RUNTIME_COMMAND_REJECTED', `Pi 拒绝了读取资源清单：${reason}`))
        return
      }
      const entries = toResources(record.data)
      if (entries === null) {
        fail(new ResourcePreviewError('RUNTIME_PROTOCOL_ERROR', 'get_commands 响应缺少约定的 commands 数组。'))
        return
      }
      succeed(entries)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      outputChars += chunk.length
      if (outputChars > PREVIEW_MAX_OUTPUT_CHARS) {
        fail(new ResourcePreviewError('RUNTIME_PROTOCOL_ERROR', '资源预读输出超出长度上限。'))
        return
      }
      buffer += stdoutDecoder.write(chunk)
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        handleLine(line.endsWith('\r') ? line.slice(0, -1) : line)
        if (settled) return
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + stderrDecoder.write(chunk)).slice(-PREVIEW_STDERR_TAIL_CHARS)
    })

    child.once('error', (error) => {
      fail(new ResourcePreviewError('RUNTIME_SPAWN_FAILED', `资源预读进程启动失败：${error.message}`))
    })

    child.once('close', (code, signal) => {
      clearCloseTimer()
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      const detail = stderr === '' ? '' : `：${stderr.trim()}`
      reject(new ResourcePreviewError(
        'RUNTIME_EXITED',
        code === null
          ? `资源预读进程被信号 ${signal ?? '未知'} 结束，未取得清单。`
          : `资源预读进程提前退出（退出码 ${code}）${detail}`
      ))
    })

    // 进程就绪前写入不影响：stdin 是管道，命令行会先在内核缓冲区排队。
    try {
      child.stdin?.write(`${JSON.stringify({ type: 'get_commands', id: PREVIEW_REQUEST_ID })}\n`)
    } catch (error) {
      fail(new ResourcePreviewError(
        'RUNTIME_SPAWN_FAILED',
        `无法向资源预读进程写入请求：${error instanceof Error ? error.message : String(error)}`
      ))
    }
  })
}
