/** 既有记忆引擎的固定协议适配；不提供 shell、初始化、迁移、维护或外部计划提交入口。 */
import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint, missing, readText } from './files.ts'

export const DOMAINS = ['communication', 'coding', 'learning', 'workflow'] as const
export type Domain = typeof DOMAINS[number]
export type SearchMode = 'records' | 'recent' | 'historical' | 'month'
export type JsonObject = Record<string, unknown>
export interface MemoryConfig {
  python: string
  engine: string
  store: string
  profileDomains: Domain[]
  /** 桌面传入的配置版本；变化后旧会话状态与缓存整个作废。 */
  revision: number
  /** 是否由桌面显式提供受管运行环境；是则不探测宿主 cwd、系统 PATH 或项目虚拟环境。 */
  managed: boolean
  /** 全局启用开关；桌面缺省关闭，独立 CLI 缺省开启。 */
  hostEnabled: boolean
  /** 宿主按执行模式关闭；此时 hostEnabled 为 false，但用户开关并未改动。 */
  hostDisabledByMode: boolean
  /** 受管运行环境是否完整可用；不可用时读取与保存都明确失败，不回退其他解释器。 */
  available: boolean
  unavailableReason: string | null
  /** 随包 IANA 时区目录；仅桌面受管环境提供，独立 CLI 保持自身默认。 */
  tzdata: string | null
  pythonVersion: string | null
  timezoneVersion: string | null
  /** 项目注册表映射；独立 CLI 为空，保存时项目归属留空。 */
  projects: readonly { id: string; path: string }[]
  /** 桌面项目注册表本次读取失败；仅用于状态报告，不改变检索范围。 */
  projectsUnavailable: boolean
}
/** 桌面显式配置；结构由 host.ts 校验，这里只声明引擎需要的最小字段。 */
export interface ManagedHostConfig {
  revision: number
  enabled: boolean
  /** 宿主按执行模式关闭，而不是用户关掉了开关。 */
  disabledByMode: boolean
  available: boolean
  store: string
  engine: string
  python: string
  tzdata: string | null
  pythonVersion: string | null
  timezoneVersion: string | null
  projects: readonly { id: string; path: string }[]
  projectsUnavailable: boolean
  error: string | null
}
export interface GeneratedPlan {
  readonly id: string
  readonly operation: 'save' | 'profile'
  readonly raw: JsonObject
  readonly preview: JsonObject
  readonly engineSha256: string
}
const MAX_OUTPUT = 2_097_152
const MAX_INPUT = 262_144
const PLAN_ID = /^s_[0-9A-HJKMNP-TV-Z]{26}$/
const RECORD_ID = /^m_[0-9A-HJKMNP-TV-Z]{26}$/
const READ_TIMEOUT = 30_000
/** 权威数据只有一份库文件；宿主传入的 store 仍是目录，由引擎定位库。 */
const STORE_FILE = 'memory.db'
const PLAN_VERSION = 4

export function object(value: unknown, label = '对象'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效`)
  return value as JsonObject
}
export function array(value: unknown, label = '数组'): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}格式无效`)
  return value
}
export function text(value: unknown, label = '文本'): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效`)
  return value
}
export function domain(value: unknown): Domain {
  if (!DOMAINS.includes(value as Domain)) throw new Error('画像领域必须为 communication/coding/learning/workflow')
  return value as Domain
}
export function domains(value: unknown): Domain[] {
  return [...new Set(array(value, '画像领域').map(domain))]
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Python 解释器动态探测链：
 * 1. 显式环境变量 PYTHON 或 PI_PYTHON；
 * 2. 传入目录（缺省为宿主 cwd）下的虚拟环境，不代表业务项目身份；
 * 3. 系统 PATH 中的全局解释器（POSIX 优先 python3，Windows 优先 python）。
 */
export async function detectPython(hostDirectory?: string): Promise<string> {
  const envPython = process.env.PI_PYTHON || process.env.PYTHON
  if (envPython && envPython.trim()) return envPython.trim()

  if (hostDirectory) {
    const isWin = process.platform === 'win32'
    const venvCandidate = isWin
      ? join(hostDirectory, '.venv', 'Scripts', 'python.exe')
      : join(hostDirectory, '.venv', 'bin', 'python')
    try {
      const info = await lstat(venvCandidate)
      if (info.isFile()) return venvCandidate
    } catch {}
  }

  return process.platform === 'win32' ? 'python' : 'python3'
}

/**
 * 引擎脚本动态定位链：
 * 1. 显式配置路径；
 * 2. 同一资源树内相对寻址：../../skills/memory/scripts/memory_store.py
 * 3. 同一资源树内备选寻址：../../skills/memory-skill/memory/scripts/memory_store.py
 * 4. 全局用户技能路径回退：~/.pi/agent/skills/...
 */
export async function detectEngine(configured?: string): Promise<string> {
  if (configured && configured.trim()) {
    try {
      const abs = resolve(configured.trim())
      if ((await lstat(abs)).isFile()) return abs
    } catch {}
  }

  const candidates = [
    fileURLToPath(new URL('../../skills/memory/scripts/memory_store.py', import.meta.url)),
    fileURLToPath(new URL('../../skills/memory-skill/memory/scripts/memory_store.py', import.meta.url)),
    join(homedir(), '.pi', 'agent', 'skills', 'memory', 'scripts', 'memory_store.py'),
    join(homedir(), '.pi', 'agent', 'skills', 'memory-skill', 'memory', 'scripts', 'memory_store.py')
  ]

  for (const candidate of candidates) {
    try {
      const info = await lstat(candidate)
      if (info.isFile()) return candidate
    } catch {}
  }

  return fileURLToPath(new URL('../../skills/memory/scripts/memory_store.py', import.meta.url))
}

/**
 * 加载记忆配置。
 * 桌面传入受管配置时只采纳它，不做任何解释器与脚本探测；
 * 无桌面通道时保留独立 CLI 的探测行为。两边都只从入口旁 config.json 取画像领域。
 */
export async function loadConfig(host?: ManagedHostConfig): Promise<MemoryConfig> {
  let data: JsonObject = {}
  try {
    const configPath = fileURLToPath(new URL('./config.json', import.meta.url))
    data = object(JSON.parse(await readText(configPath, 65_536)), '配置')
  } catch (error) {
    if (!missing(error)) throw error
    // 零配置：允许 config.json 不存在
  }

  const rawDomains = Array.isArray(data.profileDomains) ? data.profileDomains : ['communication', 'workflow']
  const profileDomains = domains(rawDomains)

  if (host !== undefined) {
    return { python: host.python, engine: host.engine, store: host.store, profileDomains,
      revision: host.revision, managed: true, hostEnabled: host.enabled, hostDisabledByMode: host.disabledByMode,
      available: host.available,
      unavailableReason: host.error, tzdata: host.tzdata, pythonVersion: host.pythonVersion,
      timezoneVersion: host.timezoneVersion, projects: host.projects,
      projectsUnavailable: host.projectsUnavailable }
  }

  const rawPython = typeof data.python === 'string' && data.python.trim() ? data.python.trim() : undefined
  const rawEngine = typeof data.engine === 'string' && data.engine.trim() ? data.engine.trim() : undefined
  const python = rawPython || await detectPython(process.cwd())
  const engine = await detectEngine(rawEngine)
  return { python, engine, store: join(homedir(), '.agents', 'memory-store'), profileDomains,
    revision: 0, managed: false, hostEnabled: true, hostDisabledByMode: false, available: true, unavailableReason: null,
    tzdata: null, pythonVersion: null, timezoneVersion: null, projects: [], projectsUnavailable: false }
}

export class MemoryEngine {
  readonly store: string
  constructor(readonly config: MemoryConfig) { this.store = config.store }

  /** 受管环境不可用时只报告原因，不用其他解释器代替。 */
  private requireAvailable(): void {
    if (!this.config.available) throw new Error(this.config.unavailableReason ?? '受管记忆运行环境不可用')
  }

  /** 检查用户级记忆库目录与库文件是否存在；缺库时不自建、不迁移。 */
  async hasStore(): Promise<boolean> {
    try {
      const info = await lstat(this.store)
      if (!info.isDirectory()) throw new Error('全局记忆库根不是目录')
    } catch (error) {
      if (missing(error)) return false
      throw error
    }
    try {
      const database = await lstat(join(this.store, STORE_FILE))
      return database.isFile()
    } catch (error) {
      if (missing(error)) return false
      throw error
    }
  }

  /** 与引擎边界保持一致：用户库及其内部组件均不接受符号链接。 */
  private async storePath(parts: string[]): Promise<string> {
    let path = this.store
    for (const part of [null, ...parts]) {
      if (part !== null) path = join(path, part)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`记忆库不允许符号链接：${path}`)
    }
    return path
  }

  async requireStore(): Promise<void> {
    try {
      const root = await this.storePath([])
      if (!(await lstat(root)).isDirectory()) throw new Error('记忆库根不是目录')
    } catch (error) {
      if (missing(error)) throw new Error('用户级记忆库不存在；未初始化')
      throw error
    }
    try {
      const database = await lstat(await this.storePath([STORE_FILE]))
      if (!database.isFile()) throw new Error('记忆库文件不是普通文件')
    } catch (error) {
      if (missing(error)) throw new Error('记忆库文件缺失；未自动创建或迁移')
      throw error
    }
  }

  /** 画像缓存键用库版本：版本变化即失效，不再读取源文件。 */
  async profileSignature(selected: Domain[]): Promise<string> {
    await this.requireStore()
    const status = await this.run(['status'])
    const version = status.store_version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) throw new Error('记忆库版本无效')
    return fingerprint(JSON.stringify([version, [...selected].sort()]))
  }

  /** 固定参数数组启动现有脚本；-I/-B 避免项目 Python 路径和字节码缓存。 */
  private async run(args: string[], input?: unknown, signal?: AbortSignal, committing: boolean | 'statistics' = false,
    beforeSpawn?: () => void, readTimeout = READ_TIMEOUT): Promise<JsonObject> {
    this.requireAvailable()
    await this.requireStore()
    beforeSpawn?.()
    if (signal?.aborted) throw new Error('记忆操作已取消，未提交')
    const body = input === undefined ? '' : JSON.stringify(input)
    if (Buffer.byteLength(body) > MAX_INPUT) throw new Error('候选超过输入上限，未截断或提交')
    return new Promise((resolveResult, reject) => {
      const pinned = this.config.tzdata === null ? [] : ['--tzdata', this.config.tzdata]
      const child = spawn(this.config.python, ['-I', '-B', this.config.engine,
        ...pinned, '--store', this.config.store, ...args], {
        cwd: homedir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
      })
      const output: Buffer[] = []
      let size = 0
      let stderr = ''
      let problem: Error | undefined
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const stop = (message: string): void => {
        problem ??= new Error(message)
        // 权威提交与单文件统计写入开始后不强杀、不重试；取消不等于撤销。
        if (!committing) child.kill()
      }
      const abort = (): void => stop('记忆操作已取消，未提交')
      if (!committing) {
        signal?.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => stop('记忆引擎等待超时；未自动重试或恢复'), readTimeout)
        if (signal?.aborted) abort()
      }
      const finish = (error?: Error, result?: JsonObject): void => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolveResult(result!)
      }
      child.on('error', error => finish(new Error(`无法启动既有记忆引擎：${error.message}`)))
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size <= MAX_OUTPUT) output.push(chunk)
        else stop('记忆引擎输出超过上限，未将截断结果当作完整数据')
      })
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(0, 8_192) })
      child.stdin.on('error', error => { problem ??= new Error(`无法发送完整候选：${error.message}`) })
      child.on('close', code => {
        const unknown = committing === 'statistics'
          ? '；统计提交结果未确认，未自动重试或改写权威记忆，可按记录查询统计'
          : committing ? '；提交结果未确认，不得自动重试，需先读取实际记忆状态' : ''
        if (problem) { finish(new Error(problem.message + unknown)); return }
        try {
          const response = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output))), '引擎响应')
          if (response.ok !== true || code !== 0) {
            const error = object(response.error ?? {}, '引擎错误')
            throw new Error(`${String(error.type ?? 'ENGINE_ERROR')}：${String(error.message ?? (stderr || `exit ${code}`))}`)
          }
          finish(undefined, object(response.data, '引擎数据'))
        } catch (error) { finish(new Error(`记忆引擎失败：${errorText(error)}${unknown}`)) }
      })
      child.stdin.end(body)
    })
  }

  status(signal?: AbortSignal): Promise<JsonObject> { return this.run(['status'], undefined, signal) }
  profiles(selected: Domain, signal?: AbortSignal): Promise<JsonObject> {
    return this.run(['profiles', '--domain', selected], undefined, signal)
  }
  rules(query: string, offset: number, limit: number, signal?: AbortSignal): Promise<JsonObject> {
    return this.run(['rules', '--query', query, '--offset', String(offset), '--limit', String(limit)], undefined, signal)
  }
  /** 全局召回走独立协议，旧 search 的近期默认不随部署前后的工具定义悄悄改变。 */
  search(query: string, mode: SearchMode, month: string | undefined,
    offset: number, limit: number, signal?: AbortSignal): Promise<JsonObject> {
    if (!['records', 'recent', 'historical', 'month'].includes(mode)) throw new Error('检索模式无效')
    const args = ['recall', '--query', query, '--mode', mode, '--offset', String(offset), '--limit', String(limit)]
    if (mode === 'month') {
      if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('按月搜索必须明确 YYYY-MM')
      args.push('--month', month)
    } else if (month !== undefined) throw new Error('非按月模式不接受 month，未扩大范围')
    return this.run(args, undefined, signal)
  }
  /** 自动背景只走只读协议；独立短预算，不借用主动读取统计或审批入口。 */
  backgroundRecall(input: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    return this.run(['recall-background', '--input', '-'], input, signal, false, undefined, 5_000)
  }

  errorRecall(input: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    return this.run(['error-recall', '--input', '-'], input, signal, false, undefined, 5_000)
  }

  read(ids: string[], signal?: AbortSignal): Promise<JsonObject> {
    if (!ids.length || ids.length > 50 || ids.some(id => !RECORD_ID.test(id))) throw new Error('原文读取必须指定 1..50 个真实日记 ID')
    return this.run(['read', ...ids], undefined, signal)
  }

  accessStats(ids: string[], signal?: AbortSignal): Promise<JsonObject> {
    if (!ids.length || ids.length > 50 || ids.some(id => !RECORD_ID.test(id))) throw new Error('统计查询必须指定 1..50 个真实日记 ID')
    return this.run(['access-stats', ...new Set(ids)], undefined, signal)
  }

  /** 调用身份来自宿主，不开放计数、时间或启停参数；底层 read 仍为纯读取。 */
  recordAccess(ids: string[], sessionId: string, toolCallId: string, storeVersion: string,
    beforeSpawn: () => void): Promise<JsonObject> {
    if (!ids.length || ids.length > 50 || ids.some(id => !RECORD_ID.test(id))
      || !sessionId.trim() || sessionId.length > 512 || !toolCallId.trim() || toolCallId.length > 512
      || !/^\d{1,19}$/.test(storeVersion)) throw new Error('访问统计的记录、宿主身份或来源版本无效')
    return this.run(['access-record', '--input', '-'], {
      ids: [...new Set(ids)], session_id: sessionId, tool_call_id: toolCallId, store_version: storeVersion
    }, undefined, 'statistics', beforeSpawn)
  }

  async plan(operation: 'save' | 'profile', input: JsonObject, signal?: AbortSignal): Promise<GeneratedPlan> {
    const engineSha256 = fingerprint(await readText(await realpath(this.config.engine)))
    const preview = await this.run(['plan', operation, '--input', '-'], input, signal)
    const id = text(preview.plan_id, '实际计划 ID')
    if (!PLAN_ID.test(id)) throw new Error('引擎返回非法计划 ID')
    const raw = object(await this.run(['plan-show', '--plan-id', id], undefined, signal), '计划')
    if (raw.plan_version !== PLAN_VERSION || raw.memory_scope !== 'global' || raw.plan_id !== id || raw.operation !== operation
      || preview.plan_version !== PLAN_VERSION || preview.memory_scope !== 'global' || preview.operation !== operation) throw new Error('计划协议或身份不一致，禁止提交')
    const payload = object(raw.payload, '计划正文')
    const pairs = operation === 'save'
      ? [['date', 'date'], ['new_records', 'records'],
          ['superseded_records', 'supersede'], ['withdrawn_months', 'withdrawn_months']]
      : [['new_profile', 'profile'], ['replace_profile_ids', 'replace_ids'], ['replaced_profiles', 'replaced_profiles']]
    if (pairs.some(([key, source]) => JSON.stringify(preview[key!]) !== JSON.stringify(payload[source!]))) {
      throw new Error('计划内容与引擎预览不一致，禁止审批或提交')
    }
    if (engineSha256 !== fingerprint(await readText(await realpath(this.config.engine)))) throw new Error('生成计划期间引擎已变化')
    return Object.freeze({ id, operation, raw, preview, engineSha256 })
  }

  async assertPlan(plan: GeneratedPlan): Promise<void> {
    await this.requireStore()
    const raw = object(await this.run(['plan-show', '--plan-id', plan.id]), '计划')
    if (JSON.stringify(raw.payload) !== JSON.stringify(plan.raw.payload) || raw.created_at !== plan.raw.created_at) {
      throw new Error('计划内容已变化，旧确认失效；必须重新生成并展示')
    }
    const created = plan.raw.created_at
    if (typeof created !== 'number' || !Number.isFinite(created) || Date.now() / 1000 - created > 86_400 || created > Date.now() / 1000 + 60) {
      throw new Error('计划已过期或时间无效；必须重新生成并展示')
    }
    if (fingerprint(await readText(await realpath(this.config.engine))) !== plan.engineSha256) throw new Error('引擎内容已变化，旧确认失效')
  }

  /** 只能由插件持有的具体计划进入；模型工具没有 plan_id/approved/commit 参数。 */
  async commit(plan: GeneratedPlan, stillCurrent: () => void): Promise<JsonObject> {
    await this.assertPlan(plan)
    // 最后的绑定复核在 run 完成异步前置检查后、同步 spawn 前执行。
    const result = await this.run(['commit', '--plan-id', plan.id, '--approved'], undefined, undefined, true, stillCurrent)
    if (result.committed !== plan.id || result.operation !== plan.operation) {
      throw new Error('提交响应与具体计划不一致，结果未确认；不得自动重试')
    }
    return result
  }
}
