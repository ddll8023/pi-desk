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
 * - 进程的启动、超时终止与退出码判定交给共用的受管入口执行器，这里只判定输出里的结论。
 */
import { EMPTY_UPDATES_SNAPSHOT, isUpdateCheckReport } from '../../shared/updates-api'
import type { UpdateCheckReport, UpdatesResult, UpdatesSnapshot } from '../../shared/updates-api'
import { SingleFlight, executeManagedEntry } from '../shared/managed-entry-runner'
import { spawnUpdateCheck } from '../shared/pi-cli-process'
import { getRuntimeRoot } from './pi-runtime'

/** 检查的总等待上限：脚本内部每个远端查询各自还有 10 秒上限。 */
const CHECK_TIMEOUT_MS = 30_000

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class UpdateChecker {
  /** 最近一次对外可见的快照；初始值是「还没有检查过」。 */
  private snapshot: UpdatesSnapshot = EMPTY_UPDATES_SNAPSHOT
  private readonly flight = new SingleFlight<UpdatesResult>()
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
   * 启动时的首次检查：已经检查过或正在进行时不发起，返回 null；
   * 发起时返回本次检查结果，供调用方在检查之后接自动更新；失败已进入快照，不需额外处理异常。
   */
  startInitialCheck(): Promise<UpdatesResult> | null {
    if (this.snapshot.checkedAt !== null || this.flight.busy) return null
    return this.check()
  }

  /** 重新检查；进行中时复用同一次检查的结果。 */
  check(): Promise<UpdatesResult> {
    return this.flight.run(() => this.run())
  }

  private async run(): Promise<UpdatesResult> {
    this.publish({ ...this.snapshot, checking: true })
    try {
      const report = await this.execute(this.options.currentProjectPath())
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

  /** 跑一次检查进程并取回结论；脚本输出里只有最后一行是结论，其余内容（依赖的日志）不参与判定。 */
  private execute(projectPath: string | null): Promise<UpdateCheckReport> {
    let lastLine = ''
    return executeManagedEntry<UpdateCheckReport>({
      label: '版本检查',
      timeoutMs: CHECK_TIMEOUT_MS,
      spawn: () => spawnUpdateCheck([projectPath ?? '', getRuntimeRoot()], {
        // 没有当前项目时用应用自己的工作目录：检查脚本此时不做项目级读取。
        cwd: projectPath ?? process.cwd(),
        stdin: false
      }),
      onLine: (line) => {
        const trimmed = line.trim()
        if (trimmed !== '') lastLine = trimmed
      },
      readResult: () => this.parse(lastLine)
    })
  }

  /** 只接受约定的 JSON 结构；解析不出来时返回 null，由执行器按「没有结论」处理。 */
  private parse(line: string): UpdateCheckReport | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return null
    }
    return isUpdateCheckReport(parsed) ? parsed : null
  }
}
