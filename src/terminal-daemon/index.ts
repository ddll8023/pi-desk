/**
 * 终端守护进程入口：脱离应用进程常驻，持有全部 PTY、画面状态与历史，应用退出后继续运行。
 *
 * 启动顺序：解析运行目录 → 建目录 → 生成并落盘 token → 写 pid 记录 → 从历史恢复终端 → 开始监听。
 * 之所以先落盘再监听：客户端是靠「能连上」判断守护进程在不在的，过早监听会让客户端在恢复完成前拿到空清单。
 *
 * 生命周期：不跟随应用退出；只在收到 `shutdown` 请求、SIGTERM/SIGINT，或「没有任何会话且长时间没有客户端」
 * 时退出。退出前收敛全部终端进程树、把元数据落盘、删掉自己写的 pid 与 token 文件。
 *
 * 边界：这里只做启动编排与请求分发，终端语义在会话管理、传输在服务端；不读 Pi 配置、不启动会话、不接受
 * 页面直接连接（页面只能经主进程调用）。
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, statSync, truncateSync } from 'node:fs'
import { TERMINAL_DAEMON_PROTOCOL_VERSION } from '../shared/terminal-daemon-protocol'
import type {
  TerminalDaemonRequest
} from '../shared/terminal-daemon-protocol'
import { TerminalDaemonServer } from './daemon-server'
import type { TerminalDaemonReply } from './daemon-server'
import {
  ensureDaemonDirectories,
  readPidFile,
  readTokenFile,
  removeOwnedFile,
  resolveDaemonPaths,
  writePidFile,
  writeTokenFile
} from './endpoint'
import { HistoryStore } from './history-store'
import { TerminalSessionManager } from './session-manager'

/** 回滚缓冲行数：与页面 xterm 保持一致，快照才能还原同样多的历史。 */
const SCROLLBACK_LINES = 5000

/** 元数据落盘防抖：尺寸拖动会连续触发，只在停下来后写一次。 */
const PERSIST_DEBOUNCE_MS = 500

/**
 * 没有任何会话且没有客户端时的空闲退出时间。
 * 短一点是为了让「关掉应用后想覆盖解压或更新」不必等太久，也不必手动杀进程；
 * 只要还有一个终端（含已退出但保留历史的），就不会命中这条退出。
 */
const IDLE_EXIT_MS = 30 * 1000

/** 空闲检查间隔；只做一次时间比较，开销可以忽略。 */
const IDLE_CHECK_INTERVAL_MS = 5 * 1000

/** 日志文件上限；超过后裁掉前半段，避免长期运行把日志写爆。 */
const LOG_MAX_BYTES = 512 * 1024

/** 启动参数：运行目录由应用给出，守护进程不自行推断用户数据目录。 */
function readRuntimeDir(argv: readonly string[]): string {
  for (const argument of argv) {
    if (argument.startsWith('--runtime-dir=')) {
      const value = argument.slice('--runtime-dir='.length)
      if (value !== '') return value
    }
  }
  throw new Error('缺少启动参数 --runtime-dir。')
}

const runtimeDir = readRuntimeDir(process.argv.slice(2))
const paths = resolveDaemonPaths(runtimeDir, TERMINAL_DAEMON_PROTOCOL_VERSION)
ensureDaemonDirectories(paths)

/** 写日志：文件追加并限量，同时打到 stderr 供开发态排查；日志失败不影响终端。 */
function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`
  try {
    const size = statSync(paths.logFile).size
    if (size > LOG_MAX_BYTES) truncateSync(paths.logFile, 0)
  } catch {
    // 文件还不存在或不可写：直接尝试追加即可。
  }
  try {
    appendFileSync(paths.logFile, line, 'utf8')
  } catch {
    // 日志不可写时不影响守护进程本身。
  }
  process.stderr.write(line)
}

function logError(error: unknown): void {
  log(`错误：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
}

const token = randomBytes(32).toString('hex')
writeTokenFile(paths.tokenFile, token)
writePidFile(paths.pidFile, {
  pid: process.pid,
  protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
  startedAt: Date.now()
})

const history = new HistoryStore({
  directory: paths.historyDir,
  sessionsFile: paths.sessionsFile,
  onError: logError
})

let server: TerminalDaemonServer | null = null
let persistTimer: NodeJS.Timeout | null = null
let shuttingDown = false

/** 元数据落盘：防抖合并连续变化，写入失败只记日志。 */
function schedulePersist(): void {
  if (persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void history.writeSessionRecords(sessions.persistedRecords())
  }, PERSIST_DEBOUNCE_MS)
}

const sessions = new TerminalSessionManager({
  scrollbackLines: SCROLLBACK_LINES,
  history,
  // 事件帧的形状以协议为准，逐字段映射：直接展开 `event` 会带上 `chars` 这类协议没声明的字段，
  // 对端校验不过就会把连接当成异常对端断开（终端因此只能建出来、拿不到任何输出）。
  sendData: (event) => server?.sendEvent({
    event: 'data',
    id: event.id,
    chunk: event.chunk,
    seqEnd: event.seqEnd
  }) ?? false,
  sendExit: (event) => server?.sendEvent({ event: 'exit', id: event.id, exitCode: event.exitCode }) ?? false,
  onSessionsChanged: schedulePersist,
  onError: logError
})

/** 请求分发：把协议请求映射到会话管理；错误码与页面契约同名，便于两端共用文案。 */
async function handleRequest(request: TerminalDaemonRequest): Promise<TerminalDaemonReply> {
  switch (request.type) {
    case 'status':
      return { ok: true, data: sessions.status() }
    case 'list':
      return { ok: true, data: sessions.list(request.projectPath) }
    case 'create': {
      const outcome = await sessions.create(request.projectPath, request.cols, request.rows)
      if (outcome.ok) return { ok: true, data: outcome.info }
      return {
        ok: false,
        error: outcome.reason === 'limit'
          ? { code: 'TERMINAL_LIMIT_REACHED', message: '同时运行的终端已达上限，请先关闭一个。' }
          : { code: 'INTERNAL_ERROR', message: '启动终端失败，请检查本机 shell 是否可用。' }
      }
    }
    case 'write':
      return sessions.write(request.id, request.data)
        ? { ok: true, data: null }
        : { ok: false, error: { code: 'TERMINAL_NOT_FOUND', message: '该终端已退出或已关闭，不能再输入。' } }
    case 'resize':
      return sessions.resize(request.id, request.cols, request.rows)
        ? { ok: true, data: null }
        : { ok: false, error: { code: 'TERMINAL_NOT_FOUND', message: '该终端已关闭。' } }
    case 'close':
      sessions.close(request.id)
      return { ok: true, data: null }
    case 'close-all':
      sessions.closeAll()
      return { ok: true, data: null }
    case 'ack':
      sessions.acknowledge(request.id, request.chars)
      return { ok: true, data: null }
    case 'snapshots':
      return { ok: true, data: await sessions.snapshots() }
    case 'reset-delivery':
      sessions.resetDelivery()
      return { ok: true, data: null }
    case 'shutdown':
      // 先回帧再退出：客户端要能确认请求已被接受。
      setTimeout(() => void shutdown(0), 0)
      return { ok: true, data: null }
    default:
      return {
        ok: false,
        error: { code: 'INVALID_REQUEST', message: '不支持的请求类型。' }
      }
  }
}

/** 收尾：停监听、收敛终端、落盘元数据、删掉自己的 pid 与 token 文件。 */
async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  try {
    server?.close()
    await history.writeSessionRecords(sessions.persistedRecords())
    await sessions.shutdown()
    await history.flush()
  } catch (error) {
    logError(error)
  }
  // 只删自己写的记录：pid 与 token 都可能已被新实例替换，按内容比对后再删。
  // 无条件删 token 会把新实例的握手凭据一起删掉，客户端随后只能靠重启守护进程才能连上。
  const record = readPidFile(paths.pidFile)
  if (record !== null && record.pid === process.pid) removeOwnedFile(paths.pidFile)
  if (readTokenFile(paths.tokenFile) === token) removeOwnedFile(paths.tokenFile)
  log('守护进程已退出。')
  process.exit(exitCode)
}

let lastClientAt = Date.now()

/** 空闲退出：没有任何会话、也没有客户端时，长时间闲置就退出，把内存还给系统。 */
function startIdleWatch(): void {
  const timer = setInterval(() => {
    if (shuttingDown) return
    if (sessions.sessionCount > 0 || server?.attached === true) {
      lastClientAt = Date.now()
      return
    }
    if (Date.now() - lastClientAt < IDLE_EXIT_MS) return
    clearInterval(timer)
    log('空闲退出：没有会话也没有客户端。')
    void shutdown(0)
  }, IDLE_CHECK_INTERVAL_MS)
  timer.unref()
}

process.on('SIGTERM', () => void shutdown(0))
process.on('SIGINT', () => void shutdown(0))
process.on('uncaughtException', (error) => logError(error))
process.on('unhandledRejection', (error) => logError(error))
// 应用退出后 stderr 管道会被对端关闭：不处理写入错误会让守护进程自己被 EPIPE 终止。
process.stderr.on('error', () => {})

void (async () => {
  await sessions.restore()
  server = new TerminalDaemonServer({
    endpoint: paths.endpoint,
    token,
    handle: handleRequest,
    onClientChange: (attached) => {
      if (attached) lastClientAt = Date.now()
      log(attached ? '客户端已连接。' : '客户端已断开。')
    },
    onError: logError
  })
  await server.listen()
  log(`守护进程已启动（pid=${process.pid}，协议 v${TERMINAL_DAEMON_PROTOCOL_VERSION}，会话 ${sessions.sessionCount} 个）。`)
  startIdleWatch()
})().catch((error: unknown) => {
  logError(error)
  void shutdown(1)
})
