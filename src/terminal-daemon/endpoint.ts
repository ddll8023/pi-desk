/**
 * 终端守护进程的端点与运行文件约定：端点名带协议版本，token 与 pid 文件也按版本分开。
 *
 * 端点名带版本，是为了让协议不兼容的两代守护进程互不覆盖：新版本连不上旧版本，旧版本也不会被新版本
 * 当成自己的端点。旧版本留下的进程与终端只能由用户显式结束（见主进程的 stale 状态）。
 *
 * 安全边界：token 文件只允许当前用户读取（0600），端点名按运行目录散列，避免同一台机器上不同数据目录
 * （例如便携版与开发态）互相连上。这里只做路径与文件读写，不判断进程存活之外的任何状态。
 */
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  TERMINAL_DAEMON_HISTORY_DIR_NAME,
  TERMINAL_DAEMON_PROTOCOL_VERSION,
  TERMINAL_DAEMON_SESSIONS_FILE
} from '../shared/terminal-daemon-protocol'

/** 守护进程自有的全部路径；`runtimeDir` 由调用方给出（应用侧是 userData 下的固定子目录）。 */
export interface TerminalDaemonPaths {
  readonly runtimeDir: string
  readonly dataDir: string
  readonly lockDir: string
  readonly endpoint: string
  readonly tokenFile: string
  readonly pidFile: string
  readonly sessionsFile: string
  readonly historyDir: string
  readonly logFile: string
}

/** POSIX 套接字路径的安全上限；sun_path 通常只有 104~108 字节，超过就退回系统临时目录。 */
const MAX_SOCKET_PATH_CHARS = 100

/** 端点、token 与 pid 文件的固定前缀；末尾接协议版本。 */
const ARTIFACT_PREFIX = 'daemon-v'

export function resolveDaemonPaths(
  runtimeDir: string,
  protocolVersion: number = TERMINAL_DAEMON_PROTOCOL_VERSION
): TerminalDaemonPaths {
  const dataDir = join(runtimeDir, `${ARTIFACT_PREFIX}${protocolVersion}`)
  return {
    runtimeDir,
    dataDir,
    lockDir: join(runtimeDir, `${ARTIFACT_PREFIX}${protocolVersion}.lock`),
    endpoint: resolveEndpoint(runtimeDir, protocolVersion),
    tokenFile: join(runtimeDir, `${ARTIFACT_PREFIX}${protocolVersion}.token`),
    pidFile: join(runtimeDir, `${ARTIFACT_PREFIX}${protocolVersion}.pid`),
    sessionsFile: join(dataDir, TERMINAL_DAEMON_SESSIONS_FILE),
    historyDir: join(dataDir, TERMINAL_DAEMON_HISTORY_DIR_NAME),
    logFile: join(dataDir, 'daemon.log')
  }
}

/**
 * 端点地址：Windows 用命名管道，其他平台用 Unix 域套接字。
 * 运行目录路径过长时套接字无法绑定，此时按运行目录散列到系统临时目录，仍保证不同数据目录互不相通。
 */
function resolveEndpoint(runtimeDir: string, protocolVersion: number): string {
  const digest = createHash('sha256').update(runtimeDir).digest('hex').slice(0, 12)
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\pi-desk-terminal-daemon-v${protocolVersion}-${digest}`
  }
  const preferred = join(runtimeDir, `${ARTIFACT_PREFIX}${protocolVersion}.sock`)
  if (preferred.length <= MAX_SOCKET_PATH_CHARS) return preferred
  return join(tmpdir(), `pi-desk-terminal-daemon-v${protocolVersion}-${digest}.sock`)
}

/** 创建运行目录与历史目录；权限只影响其他用户能否枚举，读不到内容仍由 token 兜底。 */
export function ensureDaemonDirectories(paths: TerminalDaemonPaths): void {
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 })
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 })
  mkdirSync(paths.historyDir, { recursive: true, mode: 0o700 })
}

/** 先获得版本独占目录才允许触碰 token、元数据或监听端点。失败实例没有清理权。 */
export function acquireDaemonOwnership(paths: TerminalDaemonPaths): () => void {
  const ownerFile = join(paths.lockDir, 'owner.json')
  const identity = randomUUID()
  const claim = (): void => {
    mkdirSync(paths.lockDir, { mode: 0o700 })
    writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, identity }), { mode: 0o600 })
  }
  try { claim() } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') throw error
    const observed = statSync(paths.lockDir)
    const guardDir = join(paths.lockDir, 'reclaim')
    // 清理者也要独占；记录清理者身份，清理过程中崩溃不会永久留下一个不可恢复的标记。
    const guardOwner = join(guardDir, 'owner.json')
    try { mkdirSync(guardDir, { mode: 0o700 }) } catch (guardError) {
      if (typeof guardError !== 'object' || guardError === null || !('code' in guardError) || guardError.code !== 'EEXIST') throw guardError
      let guard: { pid?: unknown; identity?: unknown } | null = null
      try { guard = JSON.parse(readFileSync(guardOwner, 'utf8')) as { pid?: unknown; identity?: unknown } } catch { /* 可能在写入身份前崩溃。 */ }
      if (typeof guard?.pid === 'number' && guard.pid > 0) {
        if (isProcessAlive(guard.pid)) throw new Error('另一终端守护进程正在清理旧端点。')
      } else if (Date.now() - statSync(guardDir).mtimeMs < 30_000) {
        throw new Error('终端守护进程清理标记尚在初始化。')
      }
      try { unlinkSync(guardOwner) } catch (unlinkError) {
        if (typeof unlinkError !== 'object' || unlinkError === null || !('code' in unlinkError) || unlinkError.code !== 'ENOENT') throw unlinkError
      }
      rmdirSync(guardDir)
      mkdirSync(guardDir, { mode: 0o700 })
    }
    writeFileSync(guardOwner, JSON.stringify({ pid: process.pid, identity }), { mode: 0o600 })
    try {
      const current = statSync(paths.lockDir)
      if (observed.ino !== current.ino || observed.dev !== current.dev) throw new Error('终端守护进程所有权已变化。')
      let owner: { pid?: unknown } | null = null
      try { owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as { pid?: unknown } } catch { /* 允许恢复初始化中断的空锁。 */ }
      if (typeof owner?.pid === 'number' && owner.pid > 0) {
        if (isProcessAlive(owner.pid)) throw new Error('已有终端守护进程正在运行。')
      } else if (Date.now() - observed.mtimeMs < 30_000) {
        throw new Error('终端守护进程正在初始化。')
      }
      try { unlinkSync(ownerFile) } catch (unlinkError) {
        if (typeof unlinkError !== 'object' || unlinkError === null || !('code' in unlinkError) || unlinkError.code !== 'ENOENT') throw unlinkError
      }
    } finally {
      const guard = JSON.parse(readFileSync(guardOwner, 'utf8')) as { identity?: unknown }
      if (guard.identity === identity) { unlinkSync(guardOwner); rmdirSync(guardDir) }
    }
    rmdirSync(paths.lockDir)
    claim()
  }
  return () => {
    try {
      const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as { pid?: unknown; identity?: unknown }
      if (owner.pid !== process.pid || owner.identity !== identity) return
      unlinkSync(ownerFile)
      rmdirSync(paths.lockDir)
    } catch { /* 所有权已变化时不清理。 */ }
  }
}

/** 写入 token 文件：先写临时文件再改名，避免读到半截内容。 */
export function writeTokenFile(file: string, token: string): void {
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, token, { mode: 0o600 })
  renameSync(temporary, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows 上 chmod 只是尽力而为：文件权限由用户目录 ACL 决定。
  }
}

/** 读取 token 文件；不存在或为空时返回 null，调用方据此决定要不要拉起新守护进程。 */
export function readTokenFile(file: string): string | null {
  try {
    const token = readFileSync(file, 'utf8').trim()
    return token === '' ? null : token
  } catch {
    return null
  }
}

/** pid 文件内容：守护进程自报的进程号、协议版本与启动时间。 */
export interface DaemonPidRecord {
  readonly pid: number
  readonly protocolVersion: number
  readonly startedAt: number
}

export function writePidFile(file: string, record: DaemonPidRecord): void {
  writeFileSync(file, JSON.stringify(record), { mode: 0o600 })
}

/** 读取 pid 文件；缺失或内容不合法时返回 null。 */
export function readPidFile(file: string): DaemonPidRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as { pid?: unknown; protocolVersion?: unknown; startedAt?: unknown }
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid)) return null
    if (typeof record.protocolVersion !== 'number' || !Number.isInteger(record.protocolVersion)) return null
    const startedAt = typeof record.startedAt === 'number' ? record.startedAt : 0
    return { pid: record.pid, protocolVersion: record.protocolVersion, startedAt }
  } catch {
    return null
  }
}

/** 删除自己写的文件；失败忽略（文件已不在或已被替换都无需处理）。 */
export function removeOwnedFile(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // 文件不存在或没有权限：都不影响当前进程的收尾。
  }
}

/** 其他协议版本留下的 pid 记录；用于提示用户存在接不回来的旧守护进程。 */
export interface StaleDaemonRecord {
  readonly pid: number
  readonly protocolVersion: number
  readonly file: string
}

/**
 * 扫描运行目录里其他协议版本的 pid 文件。
 * 只读记录，不判断进程是否还活着——存活判断由调用方做，避免把「读不到」当成「已退出」。
 */
export function listOtherVersionDaemons(
  runtimeDir: string,
  protocolVersion: number = TERMINAL_DAEMON_PROTOCOL_VERSION
): readonly StaleDaemonRecord[] {
  let entries: string[]
  try {
    entries = readdirSync(runtimeDir)
  } catch {
    return []
  }
  const records: StaleDaemonRecord[] = []
  for (const entry of entries) {
    const match = /^daemon-v(\d+)\.pid$/.exec(entry)
    if (match === null) continue
    const version = Number(match[1] ?? '')
    if (!Number.isInteger(version) || version === protocolVersion) continue
    const file = join(runtimeDir, entry)
    const record = readPidFile(file)
    if (record === null) continue
    records.push({ pid: record.pid, protocolVersion: version, file })
  }
  return records
}

/** 进程是否还活着：信号 0 只探测存在性，不实际发送信号。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 表示进程存在但不属于当前用户；按「活着」处理，不把它当成可以复用的空位。
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  }
}
