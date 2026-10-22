/**
 * 扩展更新的编排：按需启动一次性更新脚本（`out/sdk-host/package-update.mjs`），
 * 逐行解析它带协议标记的输出，把进度广播给页面，并在进程结束时校验结论。
 *
 * 边界：
 * - 更新只由调用方的显式请求触发（页面点击，或启动时开启开关后的自动更新）：这里不排队、不重试。
 * - 同一时刻只跑一次更新：并发调用复用进行中的那一次，不叠加。
 * - 项目路径只取主进程给出的当前项目；没有当前项目时不带项目路径（脚本此时不做项目级读取）。
 * - 要更新的来源由调用点按「已经报告过的包」校验后再传进来，这里只转发，不解释来源。
 * - 进程的启动、超时终止与退出码判定交给共用的受管入口执行器，这里只解析协议行。
 * - 结论既随返回值给调用方，也在订阅者上广播一次：自动更新没有调用方在等，只能靠广播被页面看到。
 */
import { parsePackageUpdateLine } from '../../shared/updates-api'
import type { PackageUpdateOutcome, PackageUpdateProgress, PackageUpdateResult } from '../../shared/updates-api'
import { SingleFlight, executeManagedEntry } from '../shared/managed-entry-runner'
import { spawnPackageUpdate } from '../shared/pi-cli-process'

/** 更新的总等待上限：安装依赖可能很慢，因此远高于版本检查；依赖命令自身没有超时。 */
const UPDATE_TIMEOUT_MS = 10 * 60_000

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class PackageUpdater {
  private readonly flight = new SingleFlight<PackageUpdateResult>()
  private readonly listeners = new Set<(progress: PackageUpdateProgress) => void>()
  private readonly outcomeListeners = new Set<(outcome: PackageUpdateOutcome) => void>()

  constructor(private readonly options: { readonly currentProjectPath: () => string | null }) {}

  /** 订阅更新进度；返回释放函数。 */
  onProgress(listener: (progress: PackageUpdateProgress) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 订阅更新结论；返回释放函数。自动执行的更新没有调用方在等结果，页面靠它得知已经结束。 */
  onOutcome(listener: (outcome: PackageUpdateOutcome) => void): () => void {
    this.outcomeListeners.add(listener)
    return () => {
      this.outcomeListeners.delete(listener)
    }
  }

  /** 执行一次更新；进行中时复用同一次更新的结果。 */
  update(source?: string): Promise<PackageUpdateResult> {
    return this.flight.run(() => this.run(source))
  }

  private async run(source?: string): Promise<PackageUpdateResult> {
    try {
      const outcome = await this.execute(this.options.currentProjectPath(), source)
      this.publishOutcome(outcome)
      return { ok: true, data: outcome }
    } catch (error) {
      const message = describeError(error)
      return { ok: false, error: { code: 'INTERNAL_ERROR', message } }
    }
  }

  private publish(progress: PackageUpdateProgress): void {
    for (const listener of this.listeners) listener(progress)
  }

  /** 结论广播：没有结论可报（进程异常退出或超时）时不造一条假的，由调用方自己处置。 */
  private publishOutcome(outcome: PackageUpdateOutcome): void {
    for (const listener of this.outcomeListeners) listener(outcome)
  }

  /** 跑一次更新进程并取回结论；进度行随到随播，结论取最后一条结果行。 */
  private execute(projectPath: string | null, source: string | undefined): Promise<PackageUpdateOutcome> {
    let outcome: PackageUpdateOutcome | null = null
    return executeManagedEntry<PackageUpdateOutcome>({
      label: '扩展更新',
      timeoutMs: UPDATE_TIMEOUT_MS,
      spawn: () => spawnPackageUpdate([projectPath ?? '', source ?? ''], {
        // 没有当前项目时用应用自己的工作目录：脚本此时不做项目级读取。
        cwd: projectPath ?? process.cwd(),
        stdin: false
      }),
      onLine: (line) => {
        const parsed = parsePackageUpdateLine(line)
        if (parsed === null) return
        if (parsed.kind === 'progress') {
          this.publish(parsed.progress)
          return
        }
        outcome = parsed.outcome
      },
      readResult: () => outcome
    })
  }
}
