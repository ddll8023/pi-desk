/**
 * 一次性版本检查脚本：读取当前加载的 Pi agent 版本与 Pi 包（扩展）的已安装/远端版本，
 * 向 stdout 输出一行 JSON（形状见 `shared/updates-api.ts` 的 `UpdateCheckReport`）。
 *
 * 边界：只读。不写 Pi 的任何配置文件、不安装也不更新任何东西、不建立会话。
 * 只有两类访问：读磁盘上的 package.json 与 git 提交，以及查询 npm registry、pi.dev 与 git 远端。
 * `PI_OFFLINE` 生效时完全不发起远端请求，只报告已安装版本。
 * 包声明与安装路径一律交给 SDK 的 `DefaultPackageManager` 判定，不在这里重建 Pi 的目录约定；
 * 声明了但没安装的 npm 包可能让 SDK 自行执行一次只读的 `npm root -g`（失败时静默跳过）。
 * SDK 从运行时目录或应用自带版本加载（由主进程注入的入口决定），因此报告的 agent 版本是实际将被加载的那一个。
 *
 * 失败语义：单个条目失败只写进该条目的 `error`，不影响其他条目；整体失败（读不到包声明等）
 * 才把原因写进报告的 `error`。只有脚本自身崩溃才以非零退出码结束，由主进程转换为页面可见的失败。
 *
 * 参数：argv[2] 是当前项目路径（可为空）；argv[3] 是运行时根目录（可为空）。
 * 项目路径为空时不做项目级读取；运行时根目录只用只读指针判断本次实际会加载哪个版本。
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadSdkModule, majorVersion, readBundledSdkVersion, readCurrentVersion } from '../../shared-process/runtime'
import type { SdkModule } from '../../shared-process/runtime'
import type { ExtensionUpdateInfo, PiAgentUpdateInfo, PiAgentUpdateStatus, UpdateCheckReport } from '../../shared/updates-api'

const runFile = promisify(execFile)

/** 项目路径与运行时根目录在 argv 里的位置；主进程固定给出，页面无法参与。 */
const PROJECT_ARG_INDEX = 2
const RUNTIME_ROOT_ARG_INDEX = 3
/** 单个远端查询的等待上限；每个条目各自计时，不共享总预算。 */
const REMOTE_TIMEOUT_MS = 10_000
/** git 子进程的等待上限与输出上限；只用于读取提交号。 */
const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_OUTPUT_BYTES = 1_048_576
/** 与 Pi 自身自检使用同一个官方发布接口。 */
const LATEST_PI_RELEASE_URL = 'https://pi.dev/api/latest-version'
const NPM_REGISTRY_URL = 'https://registry.npmjs.org'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 与 Pi 的离线判定保持一致：`1`/`true`/`yes` 视为离线，空值不算。 */
function isOffline(): boolean {
  const value = process.env.PI_OFFLINE
  if (!value) return false
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes'
}

/** 远端读取：只接受 JSON，超时或非 2xx 一律抛出，由调用方记入条目错误。 */
async function fetchJson(url: string, agentVersion: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': `pi-desk-version-check/${agentVersion}` },
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json()
}

/** 只比较 `x.y.z`（可带预发布后缀）形式；解析不出时返回 null，由调用方按「无法比较」处理。 */
function compareVersions(left: string, right: string): number | null {
  const parse = (value: string): readonly number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim())
    if (match === null) return null
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const a = parse(left)
  const b = parse(right)
  if (a === null || b === null) return null
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

interface NpmSource {
  readonly name: string
  /** 声明里带精确版本号时视为固定版本，不做远端比较。 */
  readonly pinned: boolean
}

/** 按 Pi 的 npm 源写法解析 `npm:<包名>[@版本]`；包名允许 `@scope/name`。 */
function parseNpmSource(source: string): NpmSource | null {
  const spec = source.slice('npm:'.length).trim()
  if (spec === '') return null
  const match = /^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/.exec(spec)
  const name = match?.[1]
  if (name === undefined) return null
  const range = match?.[2]
  return { name, pinned: range !== undefined && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(range) }
}

interface GitSource {
  readonly displayName: string
  /** 声明里带 ref（`@ref` 在仓库路径之后）时视为固定版本，不做远端比较。 */
  readonly pinned: boolean
}

/** 只做展示与「是否固定 ref」的判定；仓库地址与 ref 的最终解释仍由 Pi 自己完成。 */
function parseGitSource(source: string): GitSource {
  const raw = source.startsWith('git:') ? source.slice('git:'.length).trim() : source.trim()
  const withoutScheme = raw.replace(/^(?:https?|ssh|git):\/\//u, '')
  const lastSlash = withoutScheme.lastIndexOf('/')
  const atIndex = withoutScheme.lastIndexOf('@')
  const pinned = atIndex >= 0 && atIndex > lastSlash
  return { displayName: pinned ? withoutScheme.slice(0, atIndex) : withoutScheme, pinned }
}

function sourceType(source: string): 'npm' | 'git' | 'local' {
  if (source.startsWith('npm:')) return 'npm'
  if (source.startsWith('git:') || /^(?:https?|ssh|git):\/\//u.test(source) || source.startsWith('git@')) return 'git'
  return 'local'
}

/** 读已安装包的版本号；读不到不是失败，条目仍按「已安装但读不到版本」展示。 */
function readInstalledVersion(installedPath: string | undefined): string | null {
  if (installedPath === undefined) return null
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(installedPath, 'package.json'), 'utf8'))
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return null
    const version = (manifest as Record<string, unknown>).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

/** 读 git 输出；禁止交互式凭据提示，避免在无人值守的检查里挂住。 */
async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const result = await runFile('git', [...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return result.stdout
}

/** 已安装提交短哈希；读不到时抛出，由调用方记入条目错误。 */
async function localGitRevision(installedPath: string): Promise<string> {
  return (await runGit(['rev-parse', '--short', 'HEAD'], installedPath)).trim()
}

/** 远端默认分支的提交短哈希；只用于与已安装提交比较，不移动任何 ref。 */
async function remoteGitRevision(installedPath: string): Promise<string> {
  const output = await runGit(['ls-remote', 'origin', 'HEAD'], installedPath)
  const match = /^([0-9a-f]{40})\s+HEAD$/m.exec(output)
  if (match?.[1] === undefined) throw new Error('远端没有报告 HEAD。')
  return match[1].slice(0, 7)
}

const OFFLINE_ERROR = '离线模式（PI_OFFLINE）下不检查远端版本。'

/** npm 源：已安装版本与 registry 最新版本比较；固定版本与未安装各自单独标注。 */
async function checkNpmEntry(
  entry: { readonly source: string; readonly scope: 'user' | 'project'; readonly installedPath: string | undefined },
  offline: boolean,
  agentVersion: string
): Promise<ExtensionUpdateInfo> {
  const parsed = parseNpmSource(entry.source)
  const installedVersion = readInstalledVersion(entry.installedPath)
  const base = {
    source: entry.source,
    scope: entry.scope,
    type: 'npm' as const,
    displayName: parsed?.name ?? entry.source,
    installedVersion,
    latestVersion: null,
    error: null
  }
  if (entry.installedPath === undefined) {
    return { ...base, status: 'not-installed', error: 'Pi 报告该包未安装。' }
  }
  if (parsed === null) {
    return { ...base, status: 'unchecked', error: '无法解析 npm 包名，未做远端比较。' }
  }
  if (parsed.pinned) return { ...base, status: 'pinned' }
  if (offline) return { ...base, status: 'unchecked', error: OFFLINE_ERROR }

  try {
    const payload = await fetchJson(`${NPM_REGISTRY_URL}/${encodeURIComponent(parsed.name)}/latest`, agentVersion)
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('响应不是对象。')
    }
    const latest = (payload as Record<string, unknown>).version
    if (typeof latest !== 'string' || latest.trim() === '') throw new Error('响应缺少 version 字段。')
    const latestVersion = latest.trim()
    if (installedVersion === null) {
      return { ...base, latestVersion, status: 'unchecked', error: '已安装但读不到版本号，无法比较。' }
    }
    const comparison = compareVersions(latestVersion, installedVersion)
    if (comparison === null) {
      return { ...base, latestVersion, status: 'unchecked', error: `无法比较版本号 ${installedVersion} 与 ${latestVersion}。` }
    }
    return { ...base, latestVersion, status: comparison > 0 ? 'update-available' : 'up-to-date' }
  } catch (error) {
    return { ...base, status: 'unchecked', error: `无法取得最新版本：${describeError(error)}` }
  }
}

/** git 源：已安装提交与远端 HEAD 比较；固定 ref、未安装、缺 git 都单独标注。 */
async function checkGitEntry(
  entry: { readonly source: string; readonly scope: 'user' | 'project'; readonly installedPath: string | undefined },
  offline: boolean
): Promise<ExtensionUpdateInfo> {
  const parsed = parseGitSource(entry.source)
  const base = {
    source: entry.source,
    scope: entry.scope,
    type: 'git' as const,
    displayName: parsed.displayName,
    installedVersion: null,
    latestVersion: null,
    error: null
  }
  if (entry.installedPath === undefined) {
    return { ...base, status: 'not-installed', error: 'Pi 报告该包未安装。' }
  }
  if (parsed.pinned) return { ...base, status: 'pinned' }
  if (offline) return { ...base, status: 'unchecked', error: OFFLINE_ERROR }

  try {
    const installedVersion = await localGitRevision(entry.installedPath)
    const latestVersion = await remoteGitRevision(entry.installedPath)
    return {
      ...base,
      installedVersion,
      latestVersion,
      status: installedVersion === latestVersion ? 'up-to-date' : 'update-available'
    }
  } catch (error) {
    return { ...base, status: 'unchecked', error: `无法比较提交：${describeError(error)}` }
  }
}

/** local 源没有可比版本：只如实标注来源，不做任何远端查询。 */
function localEntry(entry: {
  readonly source: string
  readonly scope: 'user' | 'project'
  readonly installedPath: string | undefined
}): ExtensionUpdateInfo {
  return {
    source: entry.source,
    scope: entry.scope,
    type: 'local',
    displayName: entry.source,
    installedVersion: readInstalledVersion(entry.installedPath),
    latestVersion: null,
    status: 'local',
    error: null
  }
}

/**
 * Pi agent 自身的版本与官方最新发布；取不到最新版时保留已加载版本并说明原因。
 * `runtimeVersion` 是指针指向的版本：它与实际加载的版本不一致时，说明运行时目录里的版本没能用上。
 */
async function checkPiAgent(
  sdk: SdkModule,
  offline: boolean,
  runtimeVersion: string | null
): Promise<PiAgentUpdateInfo> {
  const base = {
    version: sdk.VERSION,
    runtimeVersion,
    latestVersion: null,
    note: null,
    status: 'unchecked' as const,
    error: null
  }
  if (offline) return { ...base, error: OFFLINE_ERROR }
  try {
    const payload = await fetchJson(LATEST_PI_RELEASE_URL, sdk.VERSION)
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('响应不是对象。')
    }
    const data = payload as Record<string, unknown>
    const latest = data.version
    if (typeof latest !== 'string' || latest.trim() === '') throw new Error('响应缺少 version 字段。')
    const latestVersion = latest.trim()
    const note = typeof data.note === 'string' && data.note.trim() !== '' ? data.note.trim() : null
    return {
      ...base,
      latestVersion,
      note,
      status: piAgentStatus(latestVersion, compareVersions(latestVersion, sdk.VERSION))
    }
  } catch (error) {
    return { ...base, error: `无法取得最新版本：${describeError(error)}` }
  }
}

/**
 * 远端版本的结论：与随应用发布的版本主版本不一致时标为 `unsupported`。
 * 这类版本不提供应用内更新，只如实提示，避免把应用置于未验证的 SDK 上；
 * 无法判定基线或版本号时不做这层判断，退回按版本号比较。
 */
function piAgentStatus(latestVersion: string, comparison: number | null): PiAgentUpdateStatus {
  const bundledVersion = readBundledSdkVersion(import.meta.url)
  const bundledMajor = bundledVersion === null ? null : majorVersion(bundledVersion)
  const latestMajor = majorVersion(latestVersion)
  if (bundledMajor !== null && latestMajor !== null && bundledMajor !== latestMajor) return 'unsupported'
  return comparison !== null && comparison > 0 ? 'update-available' : 'up-to-date'
}

/** 项目路径为空时不读项目级声明：把 agent 目录当工作目录，避免把无关目录当成项目。 */
function resolveCwd(agentDir: string): string {
  const projectPath = (process.argv[PROJECT_ARG_INDEX] ?? '').trim()
  return projectPath === '' ? agentDir : projectPath
}

async function main(): Promise<void> {
  const offline = isOffline()
  const sdk = await loadSdkModule()
  const agentDir = sdk.getAgentDir()
  const cwd = resolveCwd(agentDir)
  const runtimeRoot = (process.argv[RUNTIME_ROOT_ARG_INDEX] ?? '').trim()
  const runtimeVersion = runtimeRoot === '' ? null : readCurrentVersion(runtimeRoot)
  const piAgent = await checkPiAgent(sdk, offline, runtimeVersion)

  let extensions: ExtensionUpdateInfo[] = []
  let error: string | null = null
  try {
    const settingsManager = sdk.SettingsManager.create(cwd, agentDir)
    const packageManager = new sdk.DefaultPackageManager({ cwd, agentDir, settingsManager })
    const configured = packageManager.listConfiguredPackages()
    extensions = await Promise.all(configured.map((entry) => {
      const target = { source: entry.source, scope: entry.scope, installedPath: entry.installedPath }
      switch (sourceType(entry.source)) {
        case 'npm': return checkNpmEntry(target, offline, sdk.VERSION)
        case 'git': return checkGitEntry(target, offline)
        default: return Promise.resolve(localEntry(target))
      }
    }))
  } catch (caught) {
    error = `读取 Pi 包声明失败：${describeError(caught)}`
  }

  const report: UpdateCheckReport = { offline, checkedAt: null, piAgent, extensions, error }
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

void main().catch((error: unknown) => {
  console.error(`Pi 版本检查失败：${describeError(error)}`)
  process.exitCode = 1
})
