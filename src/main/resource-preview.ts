/**
 * 页面尚未就绪时的 Pi 预读：同一个一次性 RPC 进程读取资源、可用模型与默认模型。
 *
 * 不落会话、不加载 Extension、不连接 MCP；模型与资源只作启动前候选，就绪后以活动会话与主进程查询为准。
 * 各命令的拒绝、形状错误与超时分别返回，避免模型读取失败挡住技能，或资源失败挡住模型选择。
 * 同项目与信任决定的并发读取合并，强制刷新淘汰旧结果；进程按组终止，不残留子进程。
 * 未选项目时另有全局预读：用中立目录作 cwd，只取模型与默认身份，不读项目资源。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { PiResourcePreview, RuntimeErrorCode } from '../shared/runtime-api'
import { spawnPiCli } from './pi-cli-process'
import { toModelSummaries, toResources, toRuntimeInfo } from './pi-response-projection'

const PREVIEW_TIMEOUT_MS = 15_000
const PREVIEW_KILL_GRACE_MS = 3_000
const PREVIEW_MAX_OUTPUT_CHARS = 1_048_576
const PREVIEW_STDERR_TAIL_CHARS = 600
const PREVIEW_CACHE_LIMIT = 32

/** 预读命令：id 用于匹配响应，type 是发给 Pi 的 RPC 命令。 */
type PreviewCommand = { readonly id: string; readonly type: string }

const PREVIEW_COMMANDS: readonly PreviewCommand[] = [
  { id: 'preview-resources', type: 'get_commands' },
  { id: 'preview-models', type: 'get_available_models' },
  { id: 'preview-default-model', type: 'get_state' }
]
/** 全局范围（未选项目）只需要模型与默认身份，不读项目资源。 */
const MODEL_PREVIEW_COMMANDS: readonly PreviewCommand[] = [
  { id: 'preview-models', type: 'get_available_models' },
  { id: 'preview-default-model', type: 'get_state' }
]
/** 全局范围的缓存键；项目路径均为绝对路径，不会与这个字面值相同。 */
const GLOBAL_PREVIEW_KEY = '__global__'

type PreviewSnapshot = Omit<PiResourcePreview, 'projectPath'>

/** 进程级预读失败；命令级失败由快照中的独立错误字段表达。 */
export class ResourcePreviewError extends Error {
  constructor(readonly code: RuntimeErrorCode, message: string) {
    super(message)
  }
}

const previewCache = new Map<string, PreviewSnapshot>()
const inFlight = new Map<string, Promise<PreviewSnapshot>>()

/** 两种范围共用同一份缓存与并发合并；只有全部命令成功的结果才进缓存。 */
function runCachedPreview(
  key: string,
  probe: () => Promise<PreviewSnapshot>,
  force: boolean
): Promise<PreviewSnapshot> {
  if (force) previewCache.delete(key)
  else {
    const cached = previewCache.get(key)
    if (cached !== undefined) return Promise.resolve(cached)
  }
  const pending = inFlight.get(key)
  // 强制刷新可能来自刚完成的认证，不能复用认证改变之前已经开始的探测。
  if (pending !== undefined && !force) return pending

  const promise: Promise<PreviewSnapshot> = probe().then((snapshot) => {
    if (inFlight.get(key) === promise
      && snapshot.entriesError === null && snapshot.modelsError === null && snapshot.defaultModelError === null) {
      if (previewCache.size >= PREVIEW_CACHE_LIMIT) previewCache.clear()
      previewCache.set(key, snapshot)
    }
    return snapshot
  }).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key)
  })
  inFlight.set(key, promise)
  return promise
}

/** 同一项目与信任决定共用一次读取；只缓存全部成功的结果，强制刷新不能被旧探测覆盖。 */
export async function previewProjectResources(
  projectPath: string,
  trustDecision: 'trusted' | 'untrusted' | null,
  force = false
): Promise<PreviewSnapshot> {
  return runCachedPreview(
    `${projectPath}\n${trustDecision ?? 'default'}`,
    () => runPreviewProbe(projectPath, trustDecision, PREVIEW_COMMANDS),
    force
  )
}

/**
 * 未选项目时的全局预读：模型目录来自 Pi 的 agent 目录，与工作目录无关，
 * 因此用调用方给的中立目录作 cwd，并固定按未信任探测，不触发信任提示。
 */
export async function previewGlobalModels(neutralDir: string, force = false): Promise<PreviewSnapshot> {
  return runCachedPreview(
    GLOBAL_PREVIEW_KEY,
    () => runPreviewProbe(neutralDir, 'untrusted', MODEL_PREVIEW_COMMANDS),
    force
  )
}

/** 只终止本次创建的探测进程树，不按进程名清理其他 Pi。 */
function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    try {
      const killer = spawn(taskkill, ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore', detached: true, windowsHide: true
      })
      killer.once('error', () => {})
      killer.unref()
    } catch {
      // taskkill 无法执行时仍允许自然退出与后续终止兜底。
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* 进程已退出。 */ }
  }
}

/** 模型预读不需要 MCP 连接，也不能为展示候选执行扩展代码或保存会话。 */
function previewLaunchArguments(trustDecision: 'trusted' | 'untrusted' | null): string[] {
  const args = ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp']
  if (trustDecision === 'trusted') args.push('--approve')
  else if (trustDecision === 'untrusted') args.push('--no-approve')
  return args
}

/** 一组固定请求共享进程；命令级错误不影响其他已取得的结果。 */
function runPreviewProbe(
  workingDirectory: string,
  trustDecision: 'trusted' | 'untrusted' | null,
  commands: readonly PreviewCommand[]
): Promise<PreviewSnapshot> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnPiCli(previewLaunchArguments(trustDecision), {
        cwd: workingDirectory,
        stdin: true,
        env: { PI_SKIP_VERSION_CHECK: '1' }
      })
    } catch (error) {
      reject(new ResourcePreviewError('RUNTIME_SPAWN_FAILED',
        `无法启动预读进程：${error instanceof Error ? error.message : String(error)}`))
      return
    }

    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    child.stdin?.on('error', () => {})
    const pending = new Map<string, string>(commands.map(command => [command.id, command.type]))
    let snapshot: PreviewSnapshot = {
      entries: [], entriesError: null,
      models: [], modelsError: null,
      defaultModel: null, defaultModelError: null
    }
    let buffer = ''
    let stderr = ''
    let outputChars = 0
    let settled = false
    let closeTimer: NodeJS.Timeout | null = null
    const timeoutTimer = setTimeout(() => {
      for (const command of pending.values()) applyResponse(command, null, `${command} 预读超时。`)
      pending.clear()
      succeed()
    }, PREVIEW_TIMEOUT_MS)

    function clearCloseTimer(): void {
      if (closeTimer === null) return
      clearTimeout(closeTimer)
      closeTimer = null
    }

    /** 进程或协议失效时停止探测，保留失败原因，不返回假的空清单。 */
    function fail(error: ResourcePreviewError): void {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearCloseTimer()
      terminateProcessTree(child, 'SIGTERM')
      closeTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), PREVIEW_KILL_GRACE_MS)
      reject(error)
    }

    /** 结果确定后关闭 stdin；宽限期兜底避免一次性进程继续驻留。 */
    function succeed(): void {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      try { child.stdin?.end() } catch { /* 进程可能已经退出。 */ }
      closeTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), PREVIEW_KILL_GRACE_MS)
      resolve(snapshot)
    }

    /** 每个固定响应独立解析，默认模型为空与读取失败保持区分。 */
    function applyResponse(command: string, data: unknown, error: string | null): void {
      if (command === 'get_commands') {
        const entries = error === null ? toResources(data) : null
        snapshot = { ...snapshot, entries: entries ?? [],
          entriesError: error ?? (entries === null ? 'get_commands 响应缺少约定的 commands 数组。' : null) }
      } else if (command === 'get_available_models') {
        const models = error === null ? toModelSummaries(data) : null
        snapshot = { ...snapshot, models: models ?? [],
          modelsError: error ?? (models === null ? 'get_available_models 响应缺少约定的 models 数组。' : null) }
      } else if (command === 'get_state') {
        const info = error === null ? toRuntimeInfo(data) : null
        snapshot = { ...snapshot,
          defaultModel: info?.modelProvider && info.modelId
            ? { provider: info.modelProvider, modelId: info.modelId } : null,
          defaultModelError: error ?? (info === null ? 'get_state 响应缺少约定的会话字段。' : null) }
      }
    }

    function handleLine(line: string): void {
      if (settled || line === '') return
      let payload: unknown
      try { payload = JSON.parse(line) } catch {
        fail(new ResourcePreviewError('RUNTIME_PROTOCOL_ERROR', '预读进程输出了非 JSON 行。'))
        return
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return
      const record = payload as Record<string, unknown>
      if (record.type !== 'response' || typeof record.id !== 'string') return
      const command = pending.get(record.id)
      if (command === undefined) return
      pending.delete(record.id)
      const reason = typeof record.error === 'string' && record.error !== '' ? record.error : '未提供错误信息'
      const error = record.command !== command
        ? `${command} 预读响应的命令不一致。`
        : record.success === true ? null : `Pi 拒绝了 ${command}：${reason}`
      applyResponse(command, record.data, error)
      if (pending.size === 0) succeed()
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      outputChars += chunk.length
      if (outputChars > PREVIEW_MAX_OUTPUT_CHARS) {
        fail(new ResourcePreviewError('RUNTIME_PROTOCOL_ERROR', '预读输出超出长度上限。'))
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
    child.once('error', error => {
      fail(new ResourcePreviewError('RUNTIME_SPAWN_FAILED', `预读进程启动失败：${error.message}`))
    })
    child.once('close', (code, signal) => {
      clearCloseTimer()
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      const detail = stderr === '' ? '' : `：${stderr.trim()}`
      reject(new ResourcePreviewError('RUNTIME_EXITED', code === null
        ? `预读进程被信号 ${signal ?? '未知'} 结束，未取得完整结果${detail}`
        : `预读进程提前退出（退出码 ${code}）${detail}`))
    })
    try {
      for (const command of commands) child.stdin?.write(`${JSON.stringify(command)}\n`)
    } catch (error) {
      fail(new ResourcePreviewError('RUNTIME_SPAWN_FAILED',
        `无法向预读进程写入请求：${error instanceof Error ? error.message : String(error)}`))
    }
  })
}
