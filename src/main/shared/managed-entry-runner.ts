/**
 * 受管一次性入口的通用执行：启动入口、按行读取输出、超时终止进程树、校验退出码与结论。
 *
 * 三个调用方（版本检查、扩展更新、内置 Pi agent 安装）共用这一段骨架，各自只给出启动方式、
 * 逐行处理与「结论」的判定；失败文案由 `label` 拼装。这里不理解协议内容，也不写任何配置。
 *
 * 输出按行缓冲：只保留未结束的一行，超长残行直接丢弃（协议行都很短），
 * 因此内存不随依赖命令的输出量增长，也不因为输出超过某个总量而误判失败。
 */
import type { ChildProcess } from 'node:child_process'
import { terminateProcessTree } from './process-tree-termination'

/** 进程被要求终止后，等待其自行退出的期限。 */
const KILL_GRACE_MS = 3_000
/** 单行残片的上限：超过即丢弃，避免依赖命令长时间不换行时无界缓存。 */
const MAX_PENDING_CHARS = 1_048_576
/** 失败时保留的 stderr 尾部字符数；只用于诊断，不作为结果的一部分。 */
const STDERR_TAIL_CHARS = 600

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface ManagedEntryExecution<TResult> {
  /** 失败文案里的名字，例如「版本检查」。 */
  readonly label: string
  readonly timeoutMs: number
  /** 启动入口；入口与参数由调用点固定给出，页面不参与。 */
  readonly spawn: () => ChildProcess
  /** 收到一整行输出（已去掉行尾的 \r）；只处理本协议关心的行，其余行忽略即可。 */
  readonly onLine: (line: string) => void
  /** 进程正常结束后的结论；还没有结论时返回 null，由这里按「输出不是约定的结构」处理。 */
  readonly readResult: () => TResult | null
}

/** 执行一次受管入口并返回它的结论；超时、异常退出与缺失结论都以抛出结束。 */
export function executeManagedEntry<TResult>(options: ManagedEntryExecution<TResult>): Promise<TResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = options.spawn()
    } catch (error) {
      reject(new Error(`无法启动${options.label}进程：${describeError(error)}`))
      return
    }

    let pending = ''
    let stderr = ''
    let settled = false
    let forceTimer: NodeJS.Timeout | null = null

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    const settle = (failure: Error | null, result: TResult | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceTimer !== null) clearTimeout(forceTimer)
      if (failure !== null) reject(failure)
      else if (result !== null) resolve(result)
    }

    const timer = setTimeout(() => {
      settle(new Error(`${options.label}超时，结果未知。`), null)
      terminateProcessTree(child, 'SIGTERM')
      forceTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), KILL_GRACE_MS)
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk: string) => {
      if (settled) return
      pending += chunk
      let index = pending.indexOf('\n')
      while (index >= 0) {
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        try {
          options.onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
        } catch (error) {
          // 逐行处理失败是真失败：报明确原因并收掉进程树，不让主进程因为一个回调抛错而崩掉。
          settle(new Error(`${options.label}输出处理失败：${describeError(error)}`), null)
          terminateProcessTree(child, 'SIGTERM')
          forceTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), KILL_GRACE_MS)
          return
        }
        index = pending.indexOf('\n')
      }
      if (pending.length > MAX_PENDING_CHARS) pending = ''
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS)
    })

    child.once('error', (error) => {
      settle(new Error(`${options.label}进程启动失败：${error.message}`), null)
    })

    child.once('close', (code, signal) => {
      if (settled) return
      // 先取出结论：它在逐行处理的闭包里赋值，这里需要一次明确的取值再判定。
      const result = options.readResult()
      if (code === null) {
        settle(new Error(`${options.label}进程被信号 ${signal ?? '未知'} 结束，未取得结果。`), null)
        return
      }
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-1)[0] ?? ''
        settle(new Error(`${options.label}进程以退出码 ${code} 结束。${detail}`), null)
        return
      }
      if (result === null) {
        settle(new Error(`${options.label}输出不是约定的结构。`), null)
        return
      }
      settle(null, result)
    })
  })
}

/** 同一时刻只跑一次的执行槽：并发调用复用进行中的那一次，不排队也不叠加。 */
export class SingleFlight<TResult> {
  private running: Promise<TResult> | null = null

  /** 是否有一次执行仍在进行；用于「已经有结论就不再启动」这类判断。 */
  get busy(): boolean {
    return this.running !== null
  }

  run(task: () => Promise<TResult>): Promise<TResult> {
    const running = this.running ?? task().finally(() => {
      this.running = null
    })
    this.running = running
    return running
  }
}
