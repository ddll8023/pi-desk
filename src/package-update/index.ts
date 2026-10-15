/**
 * 一次性扩展更新脚本：按主进程给定的项目路径与可选来源，更新 Pi 已声明的包（扩展），
 * 逐行向 stdout 输出带协议标记的 JSON（进度与结论，形状见 `shared/updates-api.ts`）。
 *
 * 边界：只更新已声明的包，不改动 Pi 的包声明本身，不建立会话，也不写其它配置文件。
 * 依赖命令（npm、git）自己的输出会与协议共用同一个 stdout，因此协议行一律带固定前缀，
 * 并在行首补一个换行：主进程只解析带前缀的整行，其余内容一律忽略。
 * `PI_OFFLINE` 生效时完全不执行更新，只报告离线。
 *
 * 失败语义：单个来源失败写进结论的 `failed`（含归类），整体中断写进 `error`；
 * 同一原因不重复报告。只有脚本自身崩溃才以非零退出码结束，由主进程转换为页面可见的失败。
 *
 * 参数：argv[2] 是当前项目路径（可为空）；argv[3] 是要更新的包声明原文（可为空，空表示全部）。
 */
import { DefaultPackageManager, SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent'
import { PACKAGE_UPDATE_LINE_PREFIX } from '../shared/updates-api'
import type {
  PackageUpdateFailure,
  PackageUpdateFailureReason,
  PackageUpdateOutcome,
  PackageUpdateProgress
} from '../shared/updates-api'

/** 项目路径与来源在 argv 里的位置；主进程固定给出，页面无法参与。 */
const PROJECT_ARG_INDEX = 2
const SOURCE_ARG_INDEX = 3

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 与 Pi 的离线判定保持一致：`1`/`true`/`yes` 视为离线，空值不算。 */
function isOffline(): boolean {
  const value = process.env.PI_OFFLINE
  if (!value) return false
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes'
}

/** 协议行：先补一个换行，避免与依赖命令没有换行的输出拼成同一行而被主进程丢弃。 */
function writeLine(payload: Record<string, unknown>): void {
  process.stdout.write(`\n${PACKAGE_UPDATE_LINE_PREFIX}${JSON.stringify(payload)}\n`)
}

/**
 * 把失败文本归类：工具缺失与网络失败需要用户做不同的事，因此单独分出；
 * 其余一律 `unknown`，不根据片段猜测具体原因。
 */
function classifyFailure(message: string): PackageUpdateFailureReason {
  if (/not trusted/i.test(message)) return 'untrusted'
  if (/ENOENT|command not found|not recognized as an internal or external command/i.test(message)) {
    return 'tool-missing'
  }
  if (/ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|socket hang up|timed out|network|HTTP \d{3}/i.test(message)) {
    return 'network'
  }
  return 'unknown'
}

function writeResult(outcome: PackageUpdateOutcome): void {
  writeLine({ kind: 'result', ...outcome })
}

async function main(): Promise<void> {
  const agentDir = getAgentDir()
  const projectPath = (process.argv[PROJECT_ARG_INDEX] ?? '').trim()
  const source = (process.argv[SOURCE_ARG_INDEX] ?? '').trim()
  // 项目路径为空时不读项目级声明：把 agent 目录当工作目录，避免把无关目录当成项目。
  const cwd = projectPath === '' ? agentDir : projectPath

  if (isOffline()) {
    writeResult({ offline: true, updated: [], failed: [], error: null })
    return
  }

  const updated = new Set<string>()
  const failed: PackageUpdateFailure[] = []
  /** 同一来源的同一原因只记一次：SDK 在批次失败时可能既发事件又抛出同一个原因。 */
  const recorded = new Set<string>()

  try {
    const settingsManager = SettingsManager.create(cwd, agentDir)
    const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager })
    packageManager.setProgressCallback((event) => {
      const message = event.message ?? null
      const progress: PackageUpdateProgress = {
        phase: event.type,
        action: event.action,
        source: event.source,
        message
      }
      writeLine({ kind: 'progress', ...progress })
      if (event.type === 'complete') updated.add(event.source)
      if (event.type !== 'error') return
      const text = message ?? '更新失败，依赖命令没有给出原因。'
      const key = `${event.source}\u0000${text}`
      if (recorded.has(key)) return
      recorded.add(key)
      failed.push({ source: event.source, reason: classifyFailure(text), message: text })
    })

    await packageManager.update(source === '' ? undefined : source)
    writeResult({ offline: false, updated: [...updated], failed, error: null })
  } catch (error) {
    const message = describeError(error)
    // 已经按来源记过同一原因时不再重复写进整体原因，避免页面出现两遍相同文案。
    const duplicated = failed.some((entry) => entry.message === message)
    writeResult({ offline: false, updated: [...updated], failed, error: duplicated ? null : message })
  }
}

void main().catch((error: unknown) => {
  console.error(`扩展更新失败：${describeError(error)}`)
  process.exitCode = 1
})
