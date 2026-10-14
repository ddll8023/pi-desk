/**
 * Pi 版本检查的编排：按需启动一次性检查脚本（`out/sdk-host/update-check.mjs`），
 * 校验它输出的 JSON，并把结果作为快照缓存与广播给页面。
 *
 * 边界：
 * - 只读。检查进程不写 Pi 的任何配置文件、不安装也不更新任何东西；主进程也不在这里改动任何状态。
 * - 同一时刻只跑一次检查：并发调用复用进行中的那一次，不排队、不叠加。
 * - 启动时的那次检查是后台动作，失败只进入快照的 `error`，不阻断启动、不弹窗（弹窗由页面按快照决定）。
 * - 检查失败时保留上一次成功的结论（含它自己的 `checkedAt`），只把本次失败原因写进 `error`，
 *   因此页面必须把「上次成功检查的时刻」与「本次检查失败的原因」分开显示。
 * - 项目路径只取主进程给出的当前项目，页面无法指定；没有项目时不做项目级读取。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { EMPTY_UPDATES_SNAPSHOT, isUpdateCheckReport } from '../shared/updates-api'
import type { UpdateCheckReport, UpdatesResult, UpdatesSnapshot } from '../shared/updates-api'
import { spawnUpdateCheck } from './pi-cli-process'

/** 检查的总等待上限：脚本内部每个远端查询各自还有 10 秒上限。 */
const CHECK_TIMEOUT_MS = 30_000
/** 检查进程被要求终止后，等待其自行退出的期限。 */
const KILL_GRACE_MS = 3_000
/** 检查输出的字符数上限；超限按协议错误处理，不无界缓存。 */
const MAX_OUTPUT_CHARS = 262_144
/** 失败时保留的 stderr 尾部字符数；只用于诊断，不作为结果的一部分。 */
const STDERR_TAIL_CHARS = 600

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 可控地终止检查进程树：POSIX 向独立进程组发信号，Windows 用系统 taskkill 定向终止。 */
function terminateTree(child: ChildProcess, signal: NodeJS.Signals): void {
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

export class UpdateChecker {
  /** 最近一次对外可见的快照；初始值是「还没有检查过」。 */
  private snapshot: UpdatesSnapshot = EMPTY_UPDATES_SNAPSHOT
  private running: Promise<UpdatesResult> | null = null
  private readonly listeners = new Set<(snapshot: UpdatesSnapshot) => void>()

  constructor(private readonly options: { readonly currentProjectPath: () => string | null }) {}

  /** 当前快照；页面首次读取时可能仍是「检查中」。 */
  getSnapshot(): UpdatesSnapshot {
    return this.snapshot
  }

  /** 订阅快照变化；返回释放函数。 */
  onChanged(listener: (snapshot: UpdatesSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 启动时的一次后台检查：已经有结论或正在检查时不做任何事，
   * 失败已进入快照，因此这里不需要调用方处理异常。
   */
  startInitialCheck(): void {
    if (this.snapshot.checkedAt !== null || this.running !== null) return
    void this.check()
  }

  /** 重新检查；进行中时复用同一次检查的结果。 */
  check(): Promise<UpdatesResult> {
    const running = this.running ?? this.run().finally(() => {
      this.running = null
    })
    this.running = running
    return running
  }

  private async run(): Promise<UpdatesResult> {
    this.publish({ ...this.snapshot, checking: true })
    try {
      const stdout = await this.execute(this.options.currentProjectPath())
      const report = this.parse(stdout)
      const snapshot: UpdatesSnapshot = { ...report, checkedAt: Date.now(), checking: false }
      this.publish(snapshot)
      return { ok: true, data: snapshot }
    } catch (error) {
      const message = describeError(error)
      // 上一次成功的结论保持原样：它的 checkedAt 仍然描述那次检查，本次失败只写进 error。
      const snapshot: UpdatesSnapshot = { ...this.snapshot, checking: false, error: message }
      this.publish(snapshot)
      return { ok: false, error: { code: 'INTERNAL_ERROR', message } }
    }
  }

  private publish(snapshot: UpdatesSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener(snapshot)
  }

  /** 只接受约定的 JSON 结构；脚本输出里其他内容（依赖的日志）不参与判定。 */
  private parse(stdout: string): UpdateCheckReport {
    const line = stdout
      .split('\n')
      .map((value) => value.trim())
      .filter((value) => value !== '')
      .at(-1) ?? ''
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error('版本检查输出不是 JSON。')
    }
    if (!isUpdateCheckReport(parsed)) throw new Error('版本检查输出不是约定的结构。')
    return parsed
  }

  /** 跑一次检查进程并收集输出；退出码与超时在这里判定成败。 */
  private execute(projectPath: string | null): Promise<string> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawnUpdateCheck([projectPath ?? ''], {
          // 没有当前项目时用应用自己的工作目录：检查脚本此时不做项目级读取。
          cwd: projectPath ?? process.cwd(),
          stdin: false
        })
      } catch (error) {
        reject(new Error(`无法启动版本检查进程：${describeError(error)}`))
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false
      let forceTimer: NodeJS.Timeout | null = null

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')

      function settle(failure: Error | null, output: string): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (forceTimer !== null) clearTimeout(forceTimer)
        if (failure !== null) reject(failure)
        else resolve(output)
      }

      const timer = setTimeout(() => {
        settle(new Error('版本检查超时，结果未知。'), '')
        terminateTree(child, 'SIGTERM')
        forceTimer = setTimeout(() => terminateTree(child, 'SIGKILL'), KILL_GRACE_MS)
      }, CHECK_TIMEOUT_MS)

      child.stdout?.on('data', (chunk: string) => {
        if (settled) return
        stdout += chunk
        if (stdout.length > MAX_OUTPUT_CHARS) settle(new Error('版本检查输出超出长度上限。'), '')
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS)
      })

      child.once('error', (error) => {
        settle(new Error(`版本检查进程启动失败：${error.message}`), '')
      })

      child.once('close', (code, signal) => {
        if (settled) return
        if (code === null) {
          settle(new Error(`版本检查进程被信号 ${signal ?? '未知'} 结束，未取得结果。`), '')
          return
        }
        if (code !== 0) {
          const detail = stderr.trim().split('\n').slice(-1)[0] ?? ''
          settle(new Error(`版本检查进程以退出码 ${code} 结束。${detail}`), '')
          return
        }
        settle(null, stdout)
      })
    })
  }
}
