/**
 * 一次性内置 Pi agent 安装脚本：把官方发布的 Pi agent 安装到应用自有的运行时目录，
 * 逐行向 stdout 输出带协议标记的 JSON（进度与结论，形状见 `shared/updates-api.ts`）。
 *
 * 流程与官方受管安装一致：取官方发布的依赖清单 → 在 staging 目录安装依赖 → 冒烟校验
 * （加载候选 SDK 并比对版本）→ 原子重命名到 `releases/<版本>` → 切换当前版本指针 → 清理旧版本。
 * 校验或安装失败时删除 staging 且不切换指针，因此不会留下一个不可用的「当前版本」，旧运行时继续可用。
 *
 * 依赖命令经 cross-spawn 启动：Windows 上 npm 是 `.cmd` 批处理，Node 自带的 spawn 不能直接执行，
 * 与官方 SDK 的处理一致（其 `spawnProcess` 在 win32 上同样走 cross-spawn）；其余平台行为与自带 spawn 相同。
 *
 * 边界：只写运行时目录（主进程传入的绝对路径），不写 Pi 的任何配置文件，不改动包声明，不建立会话。
 * 依赖命令（npm）自己的输出全部转到 stderr，stdout 只用于协议行。
 * `PI_OFFLINE` 生效时不下载也不安装，只报告离线。
 *
 * 参数：argv[2] 是运行时根目录的绝对路径（必填，主进程给出）；argv[3] 是目标版本（可空，空表示取官方最新）。
 * 目标版本只接受与随应用发布的版本同一主版本的官方发布，其余不安装并如实报原因。
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import crossSpawn from 'cross-spawn'
import { AGENT_INSTALL_LINE_PREFIX } from '../../shared/updates-api'
import type { AgentInstallFailureReason, AgentInstallOutcome, AgentInstallPhase } from '../../shared/updates-api'
import {
  isValidReleaseVersion,
  majorVersion,
  readBundledSdkVersion,
  readCurrentVersion,
  releaseDir,
  releasesRoot,
  resolveSdkEntryInRelease,
  stagingRoot,
  writeCurrentVersion
} from '../../shared-process/runtime'

const RUNTIME_ROOT_ARG_INDEX = 2
const VERSION_ARG_INDEX = 3
/** 官方发布接口；与官方安装脚本和 SDK 自更新使用同一组地址。 */
const LATEST_VERSION_URL = 'https://pi.dev/api/latest-version'
const INSTALLER_API_BASE = 'https://pi.dev/api/installer/releases'
/** 单个远端请求的等待上限；依赖清单很小，给足超时也不会明显拖慢失败路径。 */
const REMOTE_TIMEOUT_MS = 60_000
/** 依赖安装与可用性探测的等待上限；安装本身可能很慢，探测必须短。 */
const NPM_INSTALL_TIMEOUT_MS = 10 * 60_000
const NPM_PROBE_TIMEOUT_MS = 20_000
/** 全局 settings.json 的读取上限；与仓库其他有界读取一致，超限则不读入内存。 */
const MAX_SETTINGS_BYTES = 512 * 1024
/** stderr 尾部保留的字符数；只用于失败时给出最后一行原因。 */
const STDERR_TAIL_CHARS = 600

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 目标版本超出本应用支持的版本范围；单独分类，便于页面直接告诉用户为什么不能装。 */
class UnsupportedVersionError extends Error {}

/** 与 Pi 的离线判定保持一致：`1`/`true`/`yes` 视为离线，空值不算。 */
function isOffline(): boolean {
  const value = process.env.PI_OFFLINE
  if (!value) return false
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes'
}

/** 协议行：先补一个换行，避免与依赖命令没有换行的输出拼成同一行而被主进程丢弃。 */
function writeLine(payload: Record<string, unknown>): void {
  process.stdout.write(`\n${AGENT_INSTALL_LINE_PREFIX}${JSON.stringify(payload)}\n`)
}

function writeProgress(phase: AgentInstallPhase, version: string | null, message: string | null): void {
  writeLine({ kind: 'progress', phase, version, message })
}

function writeResult(outcome: AgentInstallOutcome): void {
  writeLine({ kind: 'result', ...outcome })
}

/** 远端读取：只接受 JSON，超时或非 2xx 一律抛出，由调用方记入失败原因。 */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'pi-desk-runtime-install' },
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json()
}

/** 依赖清单是纯文本，单独取文本以免依赖上游的 JSON 形态。 */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'pi-desk-runtime-install' },
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.text()
}

/**
 * 只读读取全局设置里的 npm 命令；缺失或读不到就用 PATH 里的 npm。
 * `npmCommand` 是全局设置项（与 Pi 自己的自更新一致），因此这里只看全局 settings.json。
 */
function readConfiguredNpmCommand(agentDir: string): readonly string[] {
  const fallback = ['npm']
  if (agentDir === '') return fallback
  let raw: string
  try {
    const path = join(agentDir, 'settings.json')
    if (statSync(path).size > MAX_SETTINGS_BYTES) return fallback
    raw = readFileSync(path, 'utf8')
  } catch {
    return fallback
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback
    const value = (parsed as Record<string, unknown>).npmCommand
    if (!Array.isArray(value)) return fallback
    const command = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    return command.length > 0 ? command : fallback
  } catch {
    return fallback
  }
}

/**
 * 依赖命令是否可执行：跑一次 `--version`。
 * 可用时返回 null，否则返回不可用的原因（底层启动错误或退出码），由调用方带进失败文案，
 * 使「命令缺失或不可执行」能被归类成缺少命令，而不是原因未知。
 */
function probeCommand(command: readonly string[]): Promise<string | null> {
  const executable = command[0]
  if (executable === undefined) return Promise.resolve('依赖命令为空。')
  return new Promise((resolve) => {
    let child: ChildProcess
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 进程已退出时不产生未处理异常。
      }
      finish('探测超时。')
    }, NPM_PROBE_TIMEOUT_MS)
    try {
      child = crossSpawn(executable, [...command.slice(1), '--version'], { stdio: 'ignore', windowsHide: true })
    } catch (error) {
      finish(`无法启动：${describeError(error)}`)
      return
    }
    child.once('error', (error) => finish(`无法启动：${error.message}`))
    child.once('close', (code) => finish(code === 0 ? null : `--version 以退出码 ${code ?? '未知'} 结束。`))
  })
}

/** 在 staging 目录安装依赖；依赖命令的输出一律转到 stderr，stdout 留给协议行。 */
function installDependencies(command: readonly string[], stageDirPath: string): Promise<void> {
  const executable = command[0]
  if (executable === undefined) return Promise.reject(new Error('npm 命令为空。'))
  // 参数与官方受管安装保持一致：跳过生命周期脚本，只装运行时依赖，并保留平台可选依赖。
  const args = [
    ...command.slice(1),
    'ci',
    '--ignore-scripts',
    '--min-release-age=0',
    '--omit=dev',
    '--include=optional',
    '--no-fund',
    '--no-audit',
    '--loglevel=error',
    '--progress=false'
  ]
  return new Promise((resolve, reject) => {
    let settled = false
    let tail = ''
    const settle = (failure: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (failure !== null) reject(failure)
      else resolve()
    }
    const child = crossSpawn(executable, args, {
      cwd: stageDirPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 进程已退出时不产生未处理异常。
      }
      settle(new Error('安装依赖超时。'))
    }, NPM_INSTALL_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
      tail = (tail + chunk.toString()).slice(-STDERR_TAIL_CHARS)
    })
    child.once('error', (error) => settle(new Error(`无法启动 npm：${error.message}`)))
    child.once('close', (code) => {
      if (code === 0) {
        settle(null)
        return
      }
      const detail = tail.trim().split('\n').slice(-1)[0] ?? ''
      settle(new Error(`npm ci 以退出码 ${code ?? '未知'} 结束。${detail}`))
    })
  })
}

/**
 * 冒烟校验：加载候选发布目录里的 SDK 并比对版本号。
 * 只证明模块图能加载且版本符合预期，不代表 pi-desk 依赖的接口在新版本上仍然兼容。
 */
async function verifyRelease(releaseDirPath: string, version: string): Promise<void> {
  const entryPath = resolveSdkEntryInRelease(releaseDirPath, version)
  if (entryPath === null) throw new Error('安装结果里找不到可用的 SDK 入口。')
  const loaded: unknown = await import(/* @vite-ignore */ pathToFileURL(entryPath).href)
  const reported = typeof loaded === 'object' && loaded !== null && 'VERSION' in loaded
    ? (loaded as { VERSION?: unknown }).VERSION
    : undefined
  if (reported !== version) {
    throw new Error(`冒烟校验加载出版本 ${typeof reported === 'string' ? reported : '未知'}，期望 ${version}。`)
  }
}

/** 清理上一次失败留下的 staging 目录；清理不掉不影响本次安装。 */
function cleanupStaging(runtimeRoot: string): void {
  try {
    for (const entry of readdirSync(stagingRoot(runtimeRoot))) {
      if (!entry.startsWith('install-')) continue
      try {
        rmSync(join(stagingRoot(runtimeRoot), entry), { force: true, recursive: true })
      } catch {
        // 仍被占用的目录留到下次安装再清理。
      }
    }
  } catch {
    // staging 目录还不存在。
  }
}

/**
 * 清理旧版本：保留当前激活版本与它之前的那一个（回滚要在，正在被其他会话使用的版本也可能仍在跑），
 * 其余删除；删不掉就留到下次安装再试。
 */
function pruneReleases(runtimeRoot: string, keep: readonly string[]): void {
  const root = releasesRoot(runtimeRoot)
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const entry of entries) {
    if (keep.includes(entry) || !isValidReleaseVersion(entry)) continue
    try {
      rmSync(join(root, entry), { force: true, recursive: true })
    } catch {
      // 文件可能仍被占用；留到下次安装再清理。
    }
  }
}

/** 取官方最新版本号；取不到就抛出，由调用方归类为网络失败。 */
async function fetchLatestVersion(): Promise<string> {
  const payload = await fetchJson(LATEST_VERSION_URL)
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('最新版本响应不是对象。')
  }
  const version = (payload as Record<string, unknown>).version
  if (typeof version !== 'string' || version.trim() === '') throw new Error('最新版本响应缺少 version 字段。')
  return version.trim()
}

function classifyFailure(error: unknown, phase: AgentInstallPhase): AgentInstallFailureReason {
  if (error instanceof UnsupportedVersionError) return 'unsupported-version'
  const message = describeError(error)
  // EINVAL 是 Windows 上 spawn 到不可直接执行的文件（例如 `.cmd`）时的报错，同样属于命令不可用。
  if (/ENOENT|EINVAL|command not found|not recognized as an internal or external command/i.test(message)) {
    return 'tool-missing'
  }
  if (phase === 'verify') return 'verify-failed'
  if (/HTTP \d{3}|fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up|超时/i.test(message)) {
    return 'network'
  }
  return 'unknown'
}

/**
 * 版本范围策略：只接受与随应用发布的版本同一主版本的官方发布。
 * 理由：pi-desk 依赖 SDK 内部结构，冒烟校验只能证明它「能加载」，不能证明兼容；
 * 跨主版本的升级不提供应用内安装，由新的应用发布带上。基线读不到时不拦，不假装判定过。
 */
function assertSupportedTarget(target: string): void {
  const bundledVersion = readBundledSdkVersion(import.meta.url)
  const bundledMajor = bundledVersion === null ? null : majorVersion(bundledVersion)
  const targetMajor = majorVersion(target)
  if (bundledMajor === null || targetMajor === null || bundledMajor === targetMajor) return
  throw new UnsupportedVersionError(
    `版本 ${target} 的主版本与随应用发布的 ${bundledVersion ?? '未知版本'} 不一致，`
    + '不在本应用支持的版本范围内；跨主版本的升级需要安装新的应用版本。'
  )
}

async function install(runtimeRoot: string, requestedVersion: string): Promise<AgentInstallOutcome> {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? ''
  const previousVersion = readCurrentVersion(runtimeRoot)
  let phase: AgentInstallPhase = 'download'
  let target = requestedVersion
  let stageDirPath: string | null = null

  try {
    if (target === '') {
      writeProgress(phase, null, '正在读取官方最新版本…')
      target = await fetchLatestVersion()
    }
    if (!isValidReleaseVersion(target)) throw new Error(`版本号不合法：${target}`)
    assertSupportedTarget(target)

    writeProgress(phase, target, `目标版本 ${target}`)
    mkdirSync(releasesRoot(runtimeRoot), { recursive: true })

    // 同一版本已经装好时只切换指针：安装是幂等的，不重复下载。
    const installed = resolveSdkEntryInRelease(releaseDir(runtimeRoot, target), target)
    if (installed !== null) {
      writeProgress('activate', target, '该版本已就绪，直接切换')
      writeCurrentVersion(runtimeRoot, target)
      writeProgress('done', target, '已切换当前版本')
      pruneReleases(runtimeRoot, [target, ...(previousVersion === null ? [] : [previousVersion])])
      return { offline: false, installedVersion: target, previousVersion, reason: null, error: null }
    }

    const npmCommand = readConfiguredNpmCommand(agentDir)
    writeProgress(phase, target, `使用依赖命令 ${npmCommand.join(' ')}`)
    const probeFailure = await probeCommand(npmCommand)
    if (probeFailure !== null) {
      throw new Error(`找不到可用的依赖命令：${npmCommand.join(' ')}（${probeFailure}）`)
    }

    cleanupStaging(runtimeRoot)
    mkdirSync(stagingRoot(runtimeRoot), { recursive: true })
    stageDirPath = join(stagingRoot(runtimeRoot), `install-${process.pid}-${Date.now()}`)
    mkdirSync(stageDirPath, { recursive: true })

    writeProgress(phase, target, '正在下载官方依赖清单…')
    const base = `${INSTALLER_API_BASE}/${encodeURIComponent(target)}`
    const [packageJson, packageLock] = await Promise.all([
      fetchText(`${base}/package.json`),
      fetchText(`${base}/package-lock.json`)
    ])
    writeFileSync(join(stageDirPath, 'package.json'), packageJson)
    writeFileSync(join(stageDirPath, 'package-lock.json'), packageLock)

    phase = 'install'
    writeProgress(phase, target, '正在安装依赖，这一步可能较慢…')
    await installDependencies(npmCommand, stageDirPath)

    phase = 'verify'
    writeProgress(phase, target, '正在校验安装结果…')
    await verifyRelease(stageDirPath, target)

    phase = 'activate'
    writeProgress(phase, target, '正在切换当前版本…')
    const targetReleaseDir = releaseDir(runtimeRoot, target)
    // 能走到这里说明目标目录里没有可用入口（可用时在开头就切换返回了），
    // 因此先移除这个不可用的旧目录再改名；移除失败时不切换指针，旧运行时继续可用。
    if (existsSync(targetReleaseDir)) {
      rmSync(targetReleaseDir, { force: true, recursive: true })
    }
    renameSync(stageDirPath, targetReleaseDir)
    stageDirPath = null
    writeCurrentVersion(runtimeRoot, target)
    pruneReleases(runtimeRoot, [target, ...(previousVersion === null ? [] : [previousVersion])])
    writeProgress('done', target, '安装完成，重启 Runtime 后生效')
    return { offline: false, installedVersion: target, previousVersion, reason: null, error: null }
  } catch (error) {
    return {
      offline: false,
      installedVersion: null,
      previousVersion,
      reason: classifyFailure(error, phase),
      error: describeError(error)
    }
  } finally {
    if (stageDirPath !== null) {
      try {
        rmSync(stageDirPath, { force: true, recursive: true })
      } catch {
        // 残留的 staging 目录由下次安装清理。
      }
    }
  }
}

async function main(): Promise<void> {
  const runtimeRoot = (process.argv[RUNTIME_ROOT_ARG_INDEX] ?? '').trim()
  const requestedVersion = (process.argv[VERSION_ARG_INDEX] ?? '').trim()

  if (runtimeRoot === '' || !isAbsolute(runtimeRoot)) {
    writeResult({
      offline: false,
      installedVersion: null,
      previousVersion: null,
      reason: 'unknown',
      error: '运行时根目录必须是绝对路径。'
    })
    return
  }

  if (isOffline()) {
    writeResult({ offline: true, installedVersion: null, previousVersion: null, reason: null, error: null })
    return
  }

  writeResult(await install(runtimeRoot, requestedVersion))
}

void main().catch((error: unknown) => {
  console.error(`内置 Pi agent 安装失败：${describeError(error)}`)
  process.exitCode = 1
})
