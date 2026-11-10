/**
 * 首启导入：把终端 CLI 的 agent 目录里可复用的部分复制到产品自己的 agent 目录。
 *
 * 只复制一次、只写产品目录：`settings.json`、`models.json`、`mcp.json`、`npm/`、`sessions/`。
 * 不复制 `auth.json`（凭据由桌面独立登录，复制 OAuth 刷新令牌会让两边互相失效）、`extensions/`
 * （产品扩展随包提供，第三方扩展留给 CLI）与各类缓存。不移动、不删除、不改写源目录；
 * 逐项判断目标是否已存在，已存在即跳过，因此可重复调用，中断后下次启动继续补齐。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  AgentHomeImportItem, AgentHomeImportItemId, AgentHomeImportSnapshot, AgentHomeSnapshot
} from '../../shared/agent-home-api'
import { getPiAgentDir, getSharedPiAgentDir, hasExplicitAgentDirectory } from '../shared/pi-paths'

/** 导入项固定且有界：页面与日志只按 id 投影，不接受调用方指定文件名。 */
interface ImportItemSpec {
  readonly id: AgentHomeImportItemId
  readonly name: string
  readonly directory: boolean
}

const IMPORT_ITEMS: readonly ImportItemSpec[] = [
  { id: 'settings', name: 'settings.json', directory: false },
  { id: 'models', name: 'models.json', directory: false },
  { id: 'mcp', name: 'mcp.json', directory: false },
  { id: 'npm', name: 'npm', directory: true },
  { id: 'sessions', name: 'sessions', directory: true }
]

const MARKER_NAME = '.shared-import.json'
const MARKER_VERSION = 1
const MAX_MARKER_BYTES = 16_384
const MAX_DETAIL_CHARS = 300

/** 本次进程内最近一次导入结论；重启后回退到标记文件。 */
let latest: AgentHomeImportSnapshot | null = null
let running: Promise<AgentHomeImportSnapshot> | null = null

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > MAX_DETAIL_CHARS ? `${message.slice(0, MAX_DETAIL_CHARS)}…` : message
}

function idleSnapshot(): AgentHomeImportSnapshot {
  return { source: getSharedPiAgentDir(), target: getPiAgentDir(), state: 'idle', items: [], message: null }
}

/** 读取上次落盘的结论；字段不合法或版本不符时按没有结论处理。 */
function readMarker(target: string): AgentHomeImportSnapshot | null {
  try {
    const path = join(target, MARKER_NAME)
    if (!existsSync(path) || statSync(path).size > MAX_MARKER_BYTES) return null
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!record(raw) || raw.version !== MARKER_VERSION || !record(raw.snapshot)) return null
    const value = raw.snapshot
    if (typeof value.source !== 'string' || typeof value.target !== 'string'
      || !['idle', 'running', 'done', 'partial', 'skipped'].includes(String(value.state))
      || !Array.isArray(value.items)) return null
    const items: AgentHomeImportItem[] = []
    for (const item of value.items) {
      if (!record(item) || !IMPORT_ITEMS.some(entry => entry.id === item.id)
        || !['copied', 'existing', 'missing', 'failed'].includes(String(item.state))
        || !(item.detail === null || typeof item.detail === 'string')) return null
      items.push({
        id: item.id as AgentHomeImportItemId,
        state: item.state as AgentHomeImportItem['state'],
        detail: item.detail as string | null
      })
    }
    return {
      source: value.source, target: value.target,
      state: value.state as AgentHomeImportSnapshot['state'],
      items,
      message: typeof value.message === 'string' ? value.message : null
    }
  } catch { return null }
}

/** 结论按同目录临时文件加改名替换写入：中断后不会读到半份内容。 */
function writeMarker(snapshot: AgentHomeImportSnapshot): void {
  try {
    mkdirSync(snapshot.target, { recursive: true })
    const path = join(snapshot.target, MARKER_NAME)
    const temporary = `${path}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: MARKER_VERSION, snapshot }, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    // 结论写不进盘只影响下次启动的展示，不影响本次导入结果。
    console.error(`[agent-home] 导入结论落盘失败：${describeError(error)}`)
  }
}

function item(source: string, target: string, spec: ImportItemSpec): AgentHomeImportItem {
  const from = join(source, spec.name)
  const to = join(target, spec.name)
  if (existsSync(to)) return { id: spec.id, state: 'existing', detail: null }
  if (!existsSync(from)) return { id: spec.id, state: 'missing', detail: '共享目录中没有这一项' }
  try {
    if (spec.directory) {
      cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
    } else {
      copyFileSync(from, to)
    }
    return { id: spec.id, state: 'copied', detail: null }
  } catch (error) {
    // 只清理本次没写完的目标目录，绝不触碰源目录。
    try { rmSync(to, { recursive: true, force: true }) } catch { /* 清理失败与导入失败同样只留诊断 */ }
    return { id: spec.id, state: 'failed', detail: describeError(error) }
  }
}

async function execute(): Promise<AgentHomeImportSnapshot> {
  const target = getPiAgentDir()
  const source = getSharedPiAgentDir()
  const base = { source, target }

  if (hasExplicitAgentDirectory()) {
    const snapshot: AgentHomeImportSnapshot = { ...base, state: 'skipped', items: [],
      message: '已由 PI_CODING_AGENT_DIR 指定 agent 目录，产品未单独导入。' }
    latest = snapshot
    return snapshot
  }
  if (samePath(source, target)) {
    const snapshot: AgentHomeImportSnapshot = { ...base, state: 'skipped', items: [],
      message: '共享目录与产品目录是同一处，无需导入。' }
    latest = snapshot
    return snapshot
  }
  if (!existsSync(source)) {
    const snapshot: AgentHomeImportSnapshot = { ...base, state: 'skipped', items: [],
      message: '没有找到 Pi 的共享目录，产品从空白配置开始。' }
    latest = snapshot
    return snapshot
  }
  const previous = readMarker(target)
  // 缺项（共享目录没有对应文件）也算终态：只有复制失败才需要下次启动重试。
  if (previous !== null && previous.state !== 'running' && samePath(previous.source, source)
    && previous.items.every(entry => entry.state !== 'failed')) {
    latest = previous
    return previous
  }

  const runningSnapshot: AgentHomeImportSnapshot = { ...base, state: 'running', items: [], message: null }
  latest = runningSnapshot
  mkdirSync(target, { recursive: true })
  const items = IMPORT_ITEMS.map(spec => item(source, target, spec))
  const failed = items.some(entry => entry.state === 'failed')
  const snapshot: AgentHomeImportSnapshot = {
    ...base,
    state: failed ? 'partial' : 'done',
    items,
    message: failed ? '部分项目未导入，可再次导入重试。' : null
  }
  writeMarker(snapshot)
  latest = snapshot
  return snapshot
}

/** 同一次启动只跑一遍；进行中重复调用复用同一次结果。 */
export function runSharedImport(): Promise<AgentHomeImportSnapshot> {
  running ??= execute().finally(() => { running = null })
  return running
}

/** 页面与日志读取的统一快照：内存结论优先，其次上次落盘结论。 */
export function readAgentHomeSnapshot(): AgentHomeSnapshot {
  const productDir = getPiAgentDir()
  const sharedDir = getSharedPiAgentDir()
  return {
    productDir,
    sharedDir,
    sharedDirExists: existsSync(sharedDir),
    explicitDirectory: hasExplicitAgentDirectory(),
    imported: latest ?? readMarker(productDir) ?? idleSnapshot()
  }
}
