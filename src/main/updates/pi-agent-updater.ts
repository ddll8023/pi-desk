/**
 * 内置 Pi agent 安装与运行时指针修复的编排：按需启动一次性安装脚本（`out/sdk-host/runtime-install.mjs`），
 * 逐行解析它带协议标记的输出，把进度广播给页面，并在进程结束时校验结论；运行时目录里的版本没能加载成功时，
 * 还可以重装指针指向的那个版本（复用同一个安装流程），或直接清除指针回到随应用发布的版本。
 *
 * 边界：
 * - 安装只由页面的显式请求触发：这里不自动执行、不排队、不重试；清指针同样只在页面请求时发生。
 * - 同一时刻只跑一次安装：并发调用复用进行中的那一次，不叠加；清指针在安装进行中时直接拒绝，避免与指针写入竞态。
 * - 运行时根目录由主进程给出，页面无法指定；目标版本只作转发，合法性由调用点校验。
 * - 依赖命令自己的输出走脚本的 stderr，因此 stdout 上除协议行外只会有噪声，只有带标记的整行参与解析。
 * - 进程的启动、超时终止与退出码判定交给共用的受管入口执行器，这里只解析协议行。
 */
import { clearCurrentVersion } from '../../runtime-install/runtime'
import { parseAgentInstallLine } from '../../shared/updates-api'
import type {
  AgentInstallOutcome,
  AgentInstallProgress,
  AgentInstallResult,
  AgentRuntimeResetResult
} from '../../shared/updates-api'
import { SingleFlight, executeManagedEntry } from '../shared/managed-entry-runner'
import { spawnRuntimeInstall } from '../shared/pi-cli-process'

/** 安装的总等待上限：下载依赖与安装依赖都可能很慢，因此远高于版本检查。 */
const INSTALL_TIMEOUT_MS = 15 * 60_000

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class PiAgentUpdater {
  private readonly flight = new SingleFlight<AgentInstallResult>()
  private readonly listeners = new Set<(progress: AgentInstallProgress) => void>()

  constructor(private readonly options: { readonly runtimeRoot: () => string }) {}

  /** 订阅安装进度；返回释放函数。 */
  onProgress(listener: (progress: AgentInstallProgress) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 安装或切换运行时版本；省略版本时取官方最新。进行中时复用同一次安装的结果。 */
  install(version?: string): Promise<AgentInstallResult> {
    return this.flight.run(() => this.run(version))
  }

  /**
   * 清除当前版本指针，回到随应用发布的版本。只用于运行时目录里的版本没能加载成功时的修复。
   * 安装进行中时拒绝：安装结束时会写指针，此时删指针的结果不可预期。
   */
  async resetRuntime(): Promise<AgentRuntimeResetResult> {
    if (this.flight.busy) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: '内置 Pi agent 安装正在进行，结束之后再清除指针。' } }
    }
    try {
      const clearedVersion = clearCurrentVersion(this.options.runtimeRoot())
      if (clearedVersion === null) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '当前没有运行时版本指针，无需清除。' } }
      }
      return { ok: true, data: { clearedVersion } }
    } catch (error) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: describeError(error) } }
    }
  }

  private async run(version?: string): Promise<AgentInstallResult> {
    try {
      const outcome = await this.execute(this.options.runtimeRoot(), version)
      return { ok: true, data: outcome }
    } catch (error) {
      const message = describeError(error)
      return { ok: false, error: { code: 'INTERNAL_ERROR', message } }
    }
  }

  private publish(progress: AgentInstallProgress): void {
    for (const listener of this.listeners) listener(progress)
  }

  /** 跑一次安装进程并取回结论；进度行随到随播，结论取最后一条结果行。 */
  private execute(runtimeRoot: string, version: string | undefined): Promise<AgentInstallOutcome> {
    let outcome: AgentInstallOutcome | null = null
    return executeManagedEntry<AgentInstallOutcome>({
      label: '内置 Pi agent 安装',
      timeoutMs: INSTALL_TIMEOUT_MS,
      spawn: () => spawnRuntimeInstall([runtimeRoot, version ?? ''], {
        // 安装脚本只写运行时目录，不依赖工作目录；这里沿用应用进程自身的工作目录。
        cwd: process.cwd(),
        stdin: false
      }),
      onLine: (line) => {
        const parsed = parseAgentInstallLine(line)
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
