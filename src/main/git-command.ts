/**
 * 主进程里唯一执行 git 的地方：命令、环境、超时、中止与错误归一都在这里。
 *
 * 背景与取舍：
 * - 一律用 `spawn`/`execFile` 直接跑系统 git，不引入 simple-git 一类的包装：它们只多一层默认参数与事件，
 *   却会掩盖退出码、stderr 与真实参数，出问题时反而难查。参数由调用方逐条给出，页面永远无法传入任意参数。
 * - 环境固定：`GIT_TERMINAL_PROMPT=0` 防止卡在凭据提示、`GIT_OPTIONAL_LOCKS=0` 让只读命令不刷新索引、
 *   `GIT_EDITOR=true` 防止任何命令意外拉起编辑器、`LC_ALL=C` 让提示文本稳定（错误映射与文案都依赖它）。
 * - 只读命令有 120s 超时；写与网络命令不设默认超时（可能等 hook 或凭据），但都接受 AbortSignal。
 *   网络命令（pull/push）由调用方传 `GIT_NETWORK_TIMEOUT_MS`：它们会等远端与凭据，没有上限就会永远挂着。
 * - 失败统一成 `GitCommandError`：调用方只需要区分「没装 git」「超时/中止」「git 报错」三种。
 */
import { execFile, spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** 只读命令的默认超时；与 Orca 同口径。 */
const READ_TIMEOUT_MS = 120_000

/** stdout/stderr 的缓冲上限；超过即视为异常输出，不做无界累积。 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024
const MAX_STDERR_CHARS = 64 * 1024

/** 失败类别：调用方据此决定错误码与文案，不解析 stderr 文本。 */
export type GitCommandFailureKind = 'unavailable' | 'timeout' | 'aborted' | 'failed'

export class GitCommandError extends Error {
  readonly kind: GitCommandFailureKind
  /** git 自己的 stderr（已截断）；不可用时为空串。 */
  readonly stderr: string
  readonly exitCode: number | null
  /** 出错的子命令（不含 `-c` 之类的公共前缀），只用于日志与文案。 */
  readonly subcommand: string

  constructor(kind: GitCommandFailureKind, message: string, details: {
    readonly stderr?: string
    readonly exitCode?: number | null
    readonly subcommand?: string
  } = {}) {
    super(message)
    this.name = 'GitCommandError'
    this.kind = kind
    this.stderr = details.stderr ?? ''
    this.exitCode = details.exitCode ?? null
    this.subcommand = details.subcommand ?? ''
  }
}

export interface GitRunOptions {
  /** 工作目录：仓库根或项目根，由调用方决定。 */
  readonly cwd: string
  /** 显式超时；只读命令由调用方传 `READ_TIMEOUT_MS`，写命令通常不传。 */
  readonly timeoutMs?: number
  readonly maxBuffer?: number
  /** 写入子进程 stdin 的内容（提交信息走这里，避免引号、换行与长度问题）。 */
  readonly stdin?: string
  readonly signal?: AbortSignal
}

export interface GitRunResult {
  readonly stdout: string
  readonly stderr: string
}

export interface GitBufferResult {
  readonly stdout: Buffer
  readonly stderr: string
}

export interface GitStreamResult {
  readonly stderr: string
  /** 解析器要求提前结束时为 true：此时 git 被主动终止，退出码不代表失败。 */
  readonly stoppedEarly: boolean
}

/** 统一的子进程环境：不继承用户可能设置的交互式 git 变量，只补齐必需项。 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_EDITOR = 'true'
  env.GIT_PAGER = 'cat'
  env.LC_ALL = 'C'
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  return env
}

/** 子命令名：跳过公共前缀 `-c key=value`，只用于日志与文案。 */
function subcommandOf(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) return ''
    if (arg === '-c') {
      index += 1
      continue
    }
    return arg
  }
  return ''
}

function stderrTail(stderr: string): string {
  return stderr.length > MAX_STDERR_CHARS ? stderr.slice(stderr.length - MAX_STDERR_CHARS) : stderr
}

/** 可展示的失败原因：优先取 git 自己最后一行非空 stderr，其次用退出码。 */
function failureMessage(args: readonly string[], stderr: string, exitCode: number | null): string {
  const lines = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const last = lines.length > 0 ? (lines[lines.length - 1] ?? '') : ''
  // git 的提示都带 `fatal:` / `error:` 前缀；界面里只需要那句原因。
  if (last !== '') return last.replace(/^(fatal|error):\s*/u, '')
  return exitCode === null ? 'git 命令执行失败。' : `git ${subcommandOf(args)} 失败（退出码 ${exitCode}）。`
}

/** 把 spawn/execFile 的原始错误归一成三类失败；ENOENT 只可能是没装 git。 */
function normalizeFailure(args: readonly string[], error: NodeJS.ErrnoException, stderr: string, exitCode: number | null, timedOut: boolean): GitCommandError {
  if (error.code === 'ENOENT') {
    return new GitCommandError('unavailable', '未找到可用的 git，请先安装 git 并确认它在 PATH 中。', {
      subcommand: subcommandOf(args)
    })
  }
  if (timedOut) {
    return new GitCommandError('timeout', `git ${subcommandOf(args)} 超时，仓库可能过大或操作被阻塞。`, {
      stderr: stderrTail(stderr),
      exitCode,
      subcommand: subcommandOf(args)
    })
  }
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
    return new GitCommandError('aborted', '操作已取消。', {
      stderr: stderrTail(stderr),
      exitCode,
      subcommand: subcommandOf(args)
    })
  }
  return new GitCommandError('failed', failureMessage(args, stderr, exitCode), {
    stderr: stderrTail(stderr),
    exitCode,
    subcommand: subcommandOf(args)
  })
}

/** 跑一次 git 并读回文本 stdout；失败抛 `GitCommandError`。 */
export function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve, reject) => {
    const child = execFile(
      'git',
      [...args],
      {
        cwd: options.cwd,
        env: gitEnvironment(),
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? MAX_BUFFER_BYTES,
        windowsHide: true,
        encoding: 'utf8',
        ...(options.signal === undefined ? {} : { signal: options.signal })
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr })
          return
        }
        const typed = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean }
        const exitCode = typeof typed.code === 'number' ? typed.code : null
        reject(normalizeFailure(args, typed, stderr, exitCode, typed.killed === true && exitCode === null))
      }
    )
    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.end(options.stdin)
    }
  })
}

/** 跑一次 git 并按原始字节读回 stdout：diff 的两侧内容需要先判二进制再解码。 */
export function runGitBuffer(args: readonly string[], options: GitRunOptions): Promise<GitBufferResult> {
  return new Promise<GitBufferResult>((resolve, reject) => {
    const child = execFile(
      'git',
      [...args],
      {
        cwd: options.cwd,
        env: gitEnvironment(),
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? MAX_BUFFER_BYTES,
        windowsHide: true,
        encoding: 'buffer',
        ...(options.signal === undefined ? {} : { signal: options.signal })
      },
      (error, stdout, stderr) => {
        // 按字节读时 stderr 也是 Buffer，统一转成文本再交给错误归一。
        const stderrText = stderr.toString('utf8')
        if (error === null) {
          resolve({ stdout, stderr: stderrText })
          return
        }
        const typed = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean }
        const exitCode = typeof typed.code === 'number' ? typed.code : null
        reject(normalizeFailure(args, typed, stderrText, exitCode, typed.killed === true && exitCode === null))
      }
    )
    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.end(options.stdin)
    }
  })
}

/**
 * 流式跑一次 git：`onStdout` 逐块拿到解码后的文本，返回 true 表示「已经够了」。
 * 状态读取靠它在上限处主动停掉 git，而不是等几十万行全部进内存。
 */
export function streamGit(
  args: readonly string[],
  options: Omit<GitRunOptions, 'stdin' | 'maxBuffer'>,
  onStdout: (chunk: string) => boolean
): Promise<GitStreamResult> {
  return new Promise<GitStreamResult>((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: options.cwd,
      env: gitEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.signal === undefined ? {} : { signal: options.signal })
    })

    const decoder = new StringDecoder('utf8')
    let stderr = ''
    let stoppedEarly = false
    let settled = false
    let timedOut = false

    const timer = options.timeoutMs === undefined
      ? null
      : setTimeout(() => {
        timedOut = true
        child.kill()
      }, options.timeoutMs)

    const clear = (): void => {
      if (timer !== null) clearTimeout(timer)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stoppedEarly) return
      if (onStdout(decoder.write(chunk))) {
        stoppedEarly = true
        child.kill()
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= MAX_STDERR_CHARS) return
      stderr = stderrTail(stderr + chunk.toString('utf8'))
    })

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clear()
      reject(normalizeFailure(args, error, stderr, null, false))
    })

    child.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      clear()
      // 解析器要求停掉 git 时退出码为 null 或 143，不算失败。
      if (stoppedEarly) {
        resolve({ stderr, stoppedEarly: true })
        return
      }
      if (timedOut) {
        reject(normalizeFailure(args, new Error('timeout') as NodeJS.ErrnoException, stderr, code, true))
        return
      }
      if (code === 0) {
        resolve({ stderr, stoppedEarly: false })
        return
      }
      reject(normalizeFailure(args, new Error('exit') as NodeJS.ErrnoException, stderr, code, false))
    })
  })
}

export const GIT_READ_TIMEOUT_MS = READ_TIMEOUT_MS

/**
 * 网络命令（pull/push/fetch）的超时：等待远端与凭据可能很久，但必须有上限，
 * 否则 ssh 口令提示、断网等情形会让命令永久挂着、界面一直停在「推送中」。
 */
export const GIT_NETWORK_TIMEOUT_MS = 180_000
