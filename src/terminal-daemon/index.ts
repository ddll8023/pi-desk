/** 终端守护进程编排：先取得版本独占权，后恢复与监听；停止时保存画面和元数据，不删除历史。 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, statSync, truncateSync } from 'node:fs'
import { TERMINAL_DAEMON_PROTOCOL_VERSION } from '../shared/terminal-daemon-protocol'
import type { TerminalDaemonRequest } from '../shared/terminal-daemon-protocol'
import { TerminalDaemonServer } from './daemon-server'
import type { TerminalDaemonReply } from './daemon-server'
import {
  acquireDaemonOwnership, ensureDaemonDirectories, readEntryBuildId, readPidFile, readTokenFile,
  removeOwnedFile, resolveDaemonPaths, writePidFile, writeTokenFile
} from './endpoint'
import { HistoryStore } from './history-store'
import { TerminalSessionManager } from './session-manager'

const SCROLLBACK_LINES = 5000
const PERSIST_DEBOUNCE_MS = 500
const IDLE_EXIT_MS = 30_000
const LOG_MAX_BYTES = 512 * 1024
function readRuntimeDir(argv: readonly string[]): string {
  const argument = argv.find((item) => item.startsWith('--runtime-dir='))
  const value = argument?.slice('--runtime-dir='.length)
  if (!value) throw new Error('缺少启动参数 --runtime-dir。')
  return value
}
const paths = resolveDaemonPaths(readRuntimeDir(process.argv.slice(2)), TERMINAL_DAEMON_PROTOCOL_VERSION)
// 构建标识在启动时取一次：之后同一进程始终自报它真正执行的构建，不随产物被重新构建而漂移。
const buildId = readEntryBuildId(process.argv[1] ?? '')
ensureDaemonDirectories(paths)
// 失败实例在这里直接退出，不注册任何会修改运行资料的收尾逻辑。
let releaseOwnership: () => void
try { releaseOwnership = acquireDaemonOwnership(paths) }
catch { process.exit(1) }

function log(message: string): void {
  try {
    try { if (statSync(paths.logFile).size > LOG_MAX_BYTES) truncateSync(paths.logFile, 0) } catch { /* 首次写入。 */ }
    appendFileSync(paths.logFile, `${new Date().toISOString()} ${message}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch { /* 诊断失败不能拖住 PTY。 */ }
}
let lastErrorAt = 0
function logError(error: unknown): void {
  // 磁盘故障可能让每个批次都失败，错误日志也必须限频。
  if (Date.now() - lastErrorAt < 1000) return
  lastErrorAt = Date.now()
  log(`错误：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
}
const token = randomBytes(32).toString('hex')
let server: TerminalDaemonServer | null = null
let persistTimer: NodeJS.Timeout | null = null
let shuttingDown = false
let restored = false
let lastClientAt = Date.now()
const history = new HistoryStore({
  directory: paths.historyDir, sessionsFile: paths.sessionsFile, onError: logError,
  onConsumed: (id) => sessions.historyConsumed(id)
})
function schedulePersist(): void {
  if (shuttingDown || persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    if (!shuttingDown) void history.writeSessionRecords(sessions.persistedRecords())
  }, PERSIST_DEBOUNCE_MS)
}
const sessions = new TerminalSessionManager({
  scrollbackLines: SCROLLBACK_LINES, history,
  sendData: (event) => server?.sendEvent({ event: 'data', id: event.id, deliveryId: event.deliveryId, chunk: event.chunk, seqEnd: event.seqEnd }) ?? false,
  sendExit: (event) => server?.sendEvent({ event: 'exit', id: event.id, exitCode: event.exitCode }) ?? false,
  onSessionsChanged: schedulePersist, onError: logError
})

async function handleRequest(request: TerminalDaemonRequest): Promise<TerminalDaemonReply> {
  if (shuttingDown) return { ok: false, error: { code: 'TERMINAL_DAEMON_UNAVAILABLE', message: '终端守护进程正在停止。' } }
  switch (request.type) {
    case 'status': return { ok: true, data: { ...sessions.status(), buildId } }
    case 'list': return { ok: true, data: sessions.list(request.projectPath) }
    case 'create': {
      const outcome = await sessions.create(request.projectPath, request.cols, request.rows)
      if (outcome.ok) return { ok: true, data: outcome.info }
      return { ok: false, error: outcome.reason === 'limit'
        ? { code: 'TERMINAL_LIMIT_REACHED', message: '终端资源已达上限，请关闭一个运行中的终端或等待输出保存。' }
        : { code: 'INTERNAL_ERROR', message: '启动终端失败，请检查本机 shell 是否可用。' } }
    }
    case 'write': return commandReply(sessions.write(request.id, request.data), '该终端已退出或已关闭，不能再输入。')
    case 'resize': return commandReply(sessions.resize(request.id, request.cols, request.rows), '该终端已关闭。')
    case 'rename': return commandReply(sessions.rename(request.id, request.title), '该终端已关闭或标题不合法。')
    case 'close': sessions.close(request.id); return { ok: true, data: null }
    case 'close-all': sessions.closeAll(); return { ok: true, data: null }
    case 'ack': sessions.acknowledge(request.id, request.deliveryId, request.seqEnd); return { ok: true, data: null }
    case 'detach': sessions.detach(request.id, request.deliveryId); return { ok: true, data: null }
    case 'snapshot-begin': return { ok: true, data: await sessions.beginSnapshot(request.id, request.deliveryId) }
    case 'snapshot-read': return { ok: true, data: sessions.readSnapshot(request.id, request.deliveryId, request.offset) }
    case 'snapshot-ready': return commandReply(sessions.readySnapshot(request.id, request.deliveryId), '终端恢复已失效，请重新接回。')
    case 'reset-delivery': sessions.resetDelivery(); return { ok: true, data: null }
    case 'shutdown':
      // 响应写入 socket 后再关闭监听；停止请求不等同于清空终端历史。
      setTimeout(() => void shutdown(0), 10)
      return { ok: true, data: null }
  }
}
function commandReply(ok: boolean, message: string): TerminalDaemonReply {
  return ok ? { ok: true, data: null } : { ok: false, error: { code: 'TERMINAL_NOT_FOUND', message } }
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = null
  try {
    server?.close()
    // 先保留轻量清单，shutdown 不再回调调度空清单写入。
    if (restored) {
      await history.writeSessionRecords(sessions.persistedRecords())
      await sessions.shutdown()
      await history.flush()
    }
  } catch (error) { logError(error) }
  if (readPidFile(paths.pidFile)?.pid === process.pid) removeOwnedFile(paths.pidFile)
  if (readTokenFile(paths.tokenFile) === token) removeOwnedFile(paths.tokenFile)
  log('守护进程已退出。')
  releaseOwnership()
  process.exit(exitCode)
}

process.on('SIGTERM', () => void shutdown(0))
process.on('SIGINT', () => void shutdown(0))
process.on('uncaughtException', (error) => { logError(error); void shutdown(1) })
process.on('unhandledRejection', (error) => { logError(error); void shutdown(1) })
void (async () => {
  writeTokenFile(paths.tokenFile, token)
  writePidFile(paths.pidFile, {
    pid: process.pid, protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION, startedAt: Date.now(), buildId
  })
  await sessions.restore()
  restored = true
  server = new TerminalDaemonServer({
    endpoint: paths.endpoint, token, handle: handleRequest,
    onClientChange: (attached) => {
      // 新连接与旧连接都不得继承上一页面的在途额度和投递代际。
      sessions.resetDelivery()
      if (attached) lastClientAt = Date.now()
      log(attached ? '客户端已连接。' : '客户端已断开。')
    },
    onWritable: () => sessions.flushPending(), onError: logError
  })
  await server.listen()
  log(`守护进程已启动（pid=${process.pid}，协议 v${TERMINAL_DAEMON_PROTOCOL_VERSION}）。`)
  const idleTimer = setInterval(() => {
    if (shuttingDown) return
    // 只有运行中的终端与已连接的应用才需要守护进程常驻；仅剩已退出的冷记录时允许空闲退出，
    // 历史与画面仍在磁盘上，下次拉起由 restore() 按轻量记录接回。
    if (sessions.runningSessionCount > 0 || server?.attached === true) { lastClientAt = Date.now(); return }
    if (Date.now() - lastClientAt >= IDLE_EXIT_MS) { clearInterval(idleTimer); void shutdown(0) }
  }, 5000)
  idleTimer.unref()
})().catch((error: unknown) => { logError(error); void shutdown(1) })
