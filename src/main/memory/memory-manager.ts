/**
 * 用户级全局记忆的桌面所有者：开关、受管运行时状态、库状态、首次初始化、按 ID 的正文、按领域的画像与全量画像／风格读取，
 * 以及会话卡片候选与设置页画像／风格保存（画像保存会在提交前剔除已失效的来源记录）。
 *
 * 只通过受管解释器与配套引擎执行固定动作；不读项目文件、不推断项目身份、不修改业务项目。
 * 库状态探测、正文、画像与风格读取都是只读调用；创建只在用户明确确认且目标位置尚无可用库时执行，不覆盖既有数据。
 * 写入用户库的动作只有四处：安装级配置里的开关、经用户确认的首次创建、用户点击卡片保存的候选，
 * 以及用户在设置页点击保存的画像与风格（三种写入共用同一条 plan→commit，不另建第二条写入路径）；页面与宿主都只读这一份结果。
 */
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import type { DesktopConfigStore } from '../config/desktop-config-store'
import { getSessionRoot } from '../sessions/session-store'
import type { MemoryHostConfiguration, MemoryConfigurationProvider } from '../../shared-process/memory-runtime'
import { managedMemoryConfiguration } from '../../shared-process/memory-runtime'
import type { MemoryErrorCode, MemoryInitializeRequest, MemoryPreference, MemoryProfileDomain, MemoryProfileListResult, MemoryProfileReadRecord, MemoryProfileReadResult, MemoryProfileSaveRequest, MemoryProfileSaveResult, MemoryReadRecord, MemoryReadResult, MemoryResult, MemorySaveCandidatesRequest, MemorySaveResult, MemorySnapshot, MemoryStyleListResult, MemoryStyleReadRecord, MemoryStyleReadResult, MemoryStyleSampleRecord, MemoryStyleSaveRequest, MemoryStyleSaveResult } from '../../shared/memory-api'

const ENGINE_TIMEOUT_MS = 30_000
const ENGINE_MAX_OUTPUT = 4 * 1024 * 1024
/** 候选输入上限：与扩展侧引擎适配器同一量级，超限整份拒绝，不截断。 */
const SAVE_INPUT_MAX_BYTES = 262_144
/** 来源探测的批量上限：与引擎 `read` 的 1..50 一致；超过则分批读，不放弃过滤。 */
const MEMORY_READ_BATCH = 50
/** 引擎计划 ID：`s_` 前缀加 ULID 字母表，形态不符一律不提交。 */
const ENGINE_PLAN_ID = /^s_[0-9A-HJKMNP-TV-Z]{26}$/
/** 画像 ID：`p_` 前缀加 ULID 字母表；提交回执里的新画像 ID 按此校验。 */
const PROFILE_ID = /^p_[0-9A-HJKMNP-TV-Z]{26}$/
/** 权威数据只有一份库文件；库目录由配置给出，文件名固定。 */
const STORE_FILE = 'memory.db'
const SUPPORTED_PLATFORMS = ['win32', 'darwin']

export interface MemoryManagerOptions {
  readonly store: DesktopConfigStore
  /** 宿主构建产物入口；受管运行时与引擎都相对它定位。 */
  readonly hostEntry: () => string
  /** 初始化前向用户展示目标位置与影响，并取得真实确认。 */
  readonly confirmInitialize: (detail: string) => Promise<boolean>
  /** 配置变化后通知受管宿主；由组合根接到 Runtime 桥上。 */
  readonly notifyHosts: () => Promise<void>
}

function failure(code: MemoryErrorCode, message: string): MemoryResult {
  return { ok: false, error: { code, message } }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只搬展示所需字段：引擎行缺少可选文本时留空，不因缺字段丢掉整条正文。 */
function toReadRecord(value: unknown): MemoryReadRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.content !== 'string') return null
  const text = (item: unknown): string => (typeof item === 'string' ? item : '')
  return { id: value.id, title: text(value.title), type: text(value.type), date: text(value.date),
    topic: text(value.topic), status: text(value.status), content: value.content }
}

/** 画像行只搬展示字段：依据与来源记录随行返回，设置页编辑时按原值带出（失效来源在提交前剔除）。 */
function toProfileRecord(value: unknown): MemoryProfileReadRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.content !== 'string') return null
  const text = (item: unknown): string => (typeof item === 'string' ? item : '')
  const sources = Array.isArray(value.source_record_ids)
    ? value.source_record_ids.filter((item): item is string => typeof item === 'string')
    : []
  return { id: value.id, domain: text(value.domain), scope: text(value.scope), basis: text(value.basis),
    title: text(value.title), content: value.content, source_record_ids: sources }
}

/**
 * 风格行只搬展示字段：要点与逐字原句是给卡片展开用的正文，
 * 缺字段的样本整条丢弃，不用空字符串冒充原句。
 */
function toStyleRecord(value: unknown): MemoryStyleReadRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return null
  const text = (item: unknown): string => (typeof item === 'string' ? item : '')
  const samples: MemoryStyleSampleRecord[] = []
  if (Array.isArray(value.samples)) {
    for (const item of value.samples) {
      if (!isRecord(item)) continue
      const quote = typeof item.quote === 'string' ? item.quote : ''
      const sourceSession = typeof item.source_session === 'string' ? item.source_session : ''
      const sourceDate = typeof item.source_date === 'string' ? item.source_date : ''
      if (!quote || !sourceSession || !sourceDate) continue
      samples.push({ quote, source_session: sourceSession, source_date: sourceDate })
    }
  }
  return { id: value.id, name: value.name, scene: text(value.scene), points: text(value.points),
    date: text(value.date), samples }
}

export class MemoryManager {
  /** 配置版本：任一开关或资源变化都递增，用于让扩展侧丢弃旧会话状态。 */
  private revision = 0
  private initializing = false
  /** 写入互斥：三种 plan→commit 共用一个标记，避免两份计划交叉提交。 */
  private writing = false
  readonly provider: MemoryConfigurationProvider = {
    read: hostEntry => this.configuration(hostEntry)
  }

  constructor(private readonly options: MemoryManagerOptions) {}

  /** 读取当前开关；配置不可读时按关闭处理并如实记录，不把故障当作已开启。 */
  private async enabled(): Promise<{ enabled: boolean; notice: string | null }> {
    try {
      return { enabled: (await this.options.store.readMemoryEnabled()).enabled, notice: null }
    } catch {
      return { enabled: false, notice: '本地配置暂时无法读取，本次运行按关闭处理，不会保存开关。' }
    }
  }

  private async configuration(hostEntry: string): Promise<MemoryHostConfiguration> {
    const state = await this.enabled()
    const registry = await this.projects()
    return managedMemoryConfiguration(hostEntry, state.enabled, this.revision, registry.projects, registry.unavailable,
      getSessionRoot())
  }

  /**
   * 启动对齐专用：把记忆库里旧项目归属改判到派生 ID。
   *
   * 库文件不存在视为无可迁移；单条失败只回报项目名，由调用方决定是否保留旧 ID。
   * 归属迁移只改 `records.project_id`，不写正文、不重建词项。
   */
  async reassignProjects(
    pairs: readonly { readonly id: string; readonly name: string; readonly next: string }[]
  ): Promise<{ migrated: number; skipped: number; failed: readonly string[] }> {
    if (pairs.length === 0) return { migrated: 0, skipped: 0, failed: [] }
    let configuration: MemoryHostConfiguration
    try {
      configuration = await this.configuration(this.options.hostEntry())
    } catch {
      return { migrated: 0, skipped: 0, failed: ['受管记忆运行环境不可用'] }
    }
    try {
      const info = await stat(join(configuration.store, STORE_FILE))
      if (!info.isFile()) return { migrated: 0, skipped: pairs.length, failed: [] }
    } catch {
      return { migrated: 0, skipped: pairs.length, failed: [] }
    }
    let migrated = 0
    let skipped = 0
    const failed: string[] = []
    for (const pair of pairs) {
      const result = await this.runEngine(configuration, ['reassign', '--from', pair.id, '--to', pair.next, '--approved'])
      let payload: unknown = null
      try { payload = result.text.trim() ? JSON.parse(result.text) : null } catch { payload = null }
      if (result.code === 0 && isRecord(payload) && payload.ok === true) {
        const count = isRecord(payload.data) && typeof payload.data.reassigned === 'number' ? payload.data.reassigned : 0
        migrated += count
        continue
      }
      // 「没有归属」表示该 ID 在库里没有记录，属于正常跳过，不算失败。
      const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
        ? payload.error.message
        : ''
      if (/没有归属/.test(message)) { skipped += 1; continue }
      failed.push(pair.name)
    }
    return { migrated, skipped, failed }
  }

  /**
   * 项目映射用于记录归属与按项目收窄检索：`path` 供工作目录匹配归属，`name` 供会话内选择检索范围。
   * 注册表读不到时置标记，记忆仍可用，只是不标项目、不能按项目收窄。
   */
  private async projects(): Promise<{ projects: { id: string; name: string; path: string }[]; unavailable: boolean }> {
    try {
      const list = await this.options.store.list()
      return { projects: list.projects.map(project => ({ id: project.id, name: project.name, path: project.path })), unavailable: false }
    } catch { return { projects: [], unavailable: true } }
  }

  /** 状态读取不写任何用户数据；运行环境与库状态分别报告。 */
  async snapshot(): Promise<MemoryResult> {
    const state = await this.enabled()
    const registry = await this.projects()
    let configuration: MemoryHostConfiguration
    try {
      configuration = managedMemoryConfiguration(this.options.hostEntry(), state.enabled, this.revision,
        registry.projects, registry.unavailable, getSessionRoot())
    } catch {
      return failure('RUNTIME_MISSING', '受管记忆运行环境无法解析；未回退系统 Python。')
    }
    const library = await this.inspectLibrary(configuration)
    const supported = SUPPORTED_PLATFORMS.includes(process.platform) && ['x64', 'arm64'].includes(process.arch)
    return { ok: true, data: {
      enabled: state.enabled,
      activation: 'applied',
      initializing: this.initializing,
      notice: state.notice,
      runtime: {
        state: configuration.available ? 'available' : supported ? 'missing' : 'unsupported',
        pythonVersion: configuration.pythonVersion,
        timezoneVersion: configuration.timezoneVersion,
        message: configuration.error
      },
      library
    } }
  }

  /** 开关保存成功后才生效；随后推进配置版本并让已就绪宿主采纳新配置。 */
  async setEnabled(preference: MemoryPreference): Promise<MemoryResult> {
    try {
      await this.options.store.saveMemoryEnabled(preference)
    } catch (error) {
      return failure('INTERNAL_ERROR', error instanceof Error ? error.message : '记忆开关未保存。')
    }
    this.revision += 1
    return this.settleHosts()
  }

  /**
   * 首次创建用户级全局记忆库。
   * 已有可用库、目标位置不可用或用户取消都不写入；提交后推进版本并刷新宿主。
   */
  async initialize(request: MemoryInitializeRequest): Promise<MemoryResult> {
    if (this.initializing) return failure('BUSY', '已有记忆库初始化正在进行，请等待其真实结果。')
    const configuration = await this.configuration(this.options.hostEntry())
    if (!configuration.available) {
      return failure('RUNTIME_MISSING', configuration.error ?? '受管记忆运行环境不可用，未创建记忆库。')
    }
    const library = await this.inspectLibrary(configuration)
    if (library.state === 'ready') return failure('INVALID_REQUEST', '已有可用记忆库，未覆盖任何内容。')
    if (library.state !== 'missing') {
      return failure('STORE_UNAVAILABLE', library.message ?? '记忆库当前不可用，未创建。')
    }
    const zone = this.resolveZone(request.timezone)
    if (zone === null) return failure('INVALID_REQUEST', `时区 ${request.timezone} 在当前系统不可用。`)
    const confirmed = await this.options.confirmInitialize(
      `将在 ${configuration.store} 创建一个空的用户级全局记忆库，时区为 ${zone}。\n`
      + '所有项目共用这个位置，不会写入任何项目目录，也不会覆盖已有内容。'
    )
    if (!confirmed) return failure('CANCELLED', '未创建记忆库。')
    this.initializing = true
    try {
      const result = await this.runEngine(configuration, ['init', '--timezone', zone])
      if (result.code !== 0) return failure('INITIALIZATION_FAILED', this.describeFailure(result))
      const created = await this.inspectLibrary(configuration)
      if (created.state !== 'ready') {
        return failure('INITIALIZATION_FAILED', created.message ?? '记忆库创建后状态无法确认，请重新读取状态。')
      }
    } finally {
      this.initializing = false
    }
    this.revision += 1
    return this.settleHosts()
  }

  /** 宿主推送失败只影响当前会话是否已采纳新配置，不掩盖已保存的真相。 */
  private async settleHosts(): Promise<MemoryResult> {
    try {
      await this.options.notifyHosts()
    } catch {
      const snapshot = await this.snapshot()
      return snapshot.ok
        ? { ok: true, data: { ...snapshot.data, activation: 'unconfirmed',
          notice: '配置已保存，但当前会话未确认采纳；重新加载资源后会生效。' } }
        : snapshot
    }
    return this.snapshot()
  }

  private resolveZone(value: string): string | null {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone
    } catch { return null }
  }

  /** 固定参数启动受管解释器；超时或非零退出都只返回真实结论，不自动重试。`input` 经 stdin 以 `--input -` 协议传入。 */
  private runEngine(configuration: MemoryHostConfiguration, args: string[], input?: unknown): Promise<{ code: number; text: string }> {
    return new Promise(resolvePromise => {
      const pinned = configuration.tzdata === null ? [] : ['--tzdata', configuration.tzdata]
      const body = input === undefined ? null : JSON.stringify(input)
      const child = spawn(configuration.python, ['-I', '-B', configuration.engine,
        ...pinned, '--store', configuration.store, ...args], {
        stdio: body === null ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'], windowsHide: true
      })
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (code: number): void => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        resolvePromise({ code, text: Buffer.concat(chunks).toString('utf8') })
      }
      timer = setTimeout(() => { try { child.kill() } catch { /* 只以退出码判断结论。 */ } finish(-1) }, ENGINE_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= ENGINE_MAX_OUTPUT) chunks.push(chunk) })
      child.stderr?.resume()
      if (body !== null) {
        // 引擎提前退出时写入会报 EPIPE：结论仍以退出码与输出为准，不把写入失败当成独立结论。
        child.stdin?.on('error', () => { /* 由退出码与输出判定。 */ })
        child.stdin?.end(body)
      }
      child.on('error', () => finish(-1))
      child.on('close', code => finish(code ?? -1))
    })
  }

  private async inspectLibrary(configuration: MemoryHostConfiguration): Promise<MemorySnapshot['library']> {
    if (!configuration.available) {
      return { state: 'unavailable', path: configuration.store, timezone: null, message: configuration.error }
    }
    const result = await this.runEngine(configuration, ['status'])
    try {
      const parsed: unknown = JSON.parse(result.text)
      if (isRecord(parsed) && parsed.ok === true && isRecord(parsed.data)) {
        // 就绪以库结构版本与时区为准；不再依赖已退出的文件清单。
        const version = parsed.data.store_version
        const timezone = parsed.data.timezone
        if (typeof version === 'number' && Number.isInteger(version) && version >= 0 && typeof timezone === 'string') {
          return { state: 'ready', path: configuration.store, timezone, message: null }
        }
        const shape = await this.libraryShape(configuration)
        if (shape !== null) return shape
        return { state: 'invalid', path: configuration.store, timezone: null,
          message: '记忆库状态缺少版本或时区；未自动修复。' }
      }
      if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string') {
        const message = parsed.error.message
        // 引擎只在库本身不存在时返回这个结论；其他错误保留原文，不当成缺库。
        if (message.includes('记忆库不存在')) {
          return { state: 'missing', path: configuration.store, timezone: null, message: null }
        }
        const shape = await this.libraryShape(configuration)
        if (shape !== null) return shape
        return { state: 'invalid', path: configuration.store, timezone: null, message: message.slice(0, 400) }
      }
    } catch { /* 输出不可解析时按下一条分支报告，不伪造状态。 */ }
    const shape = await this.libraryShape(configuration)
    if (shape !== null) return shape
    return { state: 'unavailable', path: configuration.store, timezone: null,
      message: this.describeFailure(result) }
  }

  /**
   * 库根的只读形态判定：只有目录存在且带库文件才算「已初始化」的候选。
   * 缺根或只有空／残留目录都属于「尚未创建」，否则用户会在页面上看不到创建入口；
   * 非空目录的覆盖保护由引擎 init 自己拒绝，这里不预判也不会写入任何内容。
   */
  private async libraryShape(configuration: MemoryHostConfiguration): Promise<MemorySnapshot['library'] | null> {
    let directory: Stats
    try {
      directory = await stat(configuration.store)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { state: 'missing', path: configuration.store, timezone: null, message: null } : null
    }
    if (!directory.isDirectory()) {
      return { state: 'invalid', path: configuration.store, timezone: null,
        message: '记忆库保存位置不是目录，未创建也无法读取。' }
    }
    try {
      if ((await stat(join(configuration.store, STORE_FILE))).isFile()) return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      return { state: 'missing', path: configuration.store, timezone: null,
        message: '该位置已有目录但没有记忆库文件；创建只会在空目录中进行，不会覆盖既有文件。' }
    }
    return null
  }

  /**
   * 只读读取记录正文：ID 由调用方给出，只用引擎固定的 `read` 子命令。
   * 不写库、不产生标注；库不存在时如实报告，不把它当成空结果。
   */
  async readRecords(ids: readonly string[]): Promise<MemoryReadResult> {
    let configuration: MemoryHostConfiguration
    try { configuration = await this.configuration(this.options.hostEntry()) }
    catch { return { ok: false, error: { code: 'RUNTIME_MISSING', message: '受管记忆运行环境不可用' } } }
    const result = await this.runEngine(configuration, ['read', ...ids])
    try {
      const parsed: unknown = JSON.parse(result.text)
      if (isRecord(parsed) && parsed.ok === true && isRecord(parsed.data) && Array.isArray(parsed.data.records)) {
        const records = parsed.data.records
          .map(toReadRecord).filter((record): record is MemoryReadRecord => record !== null)
        if (records.length !== ids.length) {
          return { ok: false, error: { code: 'INVALID_RESPONSE', message: '记忆引擎返回的记录与请求不一致。' } }
        }
        return { ok: true, data: { records } }
      }
      if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string') {
        const message = parsed.error.message
        const missing = /记忆库不存在|记忆库文件缺失/.test(message)
        return { ok: false, error: { code: missing ? 'STORE_UNAVAILABLE' : 'INTERNAL_ERROR', message } }
      }
    } catch { /* 非 JSON 输出按引擎失败处理。 */ }
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: this.describeFailure(result) } }
  }

  /**
   * 画像读取的唯一实现：`domain` 为空时读全部（设置页列表），否则只读该领域（会话注入卡展开）。
   * 不写库、不产生标注；引擎没有画像时返回空列表，不是失败——「没有画像」与「读不到」必须区分。
   */
  private async loadProfiles(domain: MemoryProfileDomain | null): Promise<MemoryProfileListResult> {
    let configuration: MemoryHostConfiguration
    try { configuration = await this.configuration(this.options.hostEntry()) }
    catch { return { ok: false, error: { code: 'RUNTIME_MISSING', message: '受管记忆运行环境不可用' } } }
    if (!configuration.available) {
      return { ok: false, error: { code: 'RUNTIME_MISSING', message: configuration.error ?? '受管记忆运行环境不可用' } }
    }
    const result = await this.runEngine(configuration, domain === null ? ['profiles'] : ['profiles', '--domain', domain])
    try {
      const parsed: unknown = JSON.parse(result.text)
      if (isRecord(parsed) && parsed.ok === true && isRecord(parsed.data) && Array.isArray(parsed.data.profiles)) {
        const profiles = parsed.data.profiles
          .map(toProfileRecord).filter((profile): profile is MemoryProfileReadRecord => profile !== null)
        return { ok: true, data: { profiles } }
      }
      if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string') {
        const message = parsed.error.message
        const missing = /记忆库不存在|记忆库文件缺失/.test(message)
        return { ok: false, error: { code: missing ? 'STORE_UNAVAILABLE' : 'INTERNAL_ERROR', message } }
      }
    } catch { /* 非 JSON 输出按引擎失败处理。 */ }
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: this.describeFailure(result) } }
  }

  /** 按领域读取画像正文：领域是固定枚举，不提供按 ID、关键词或数量扫描的入口。 */
  async readProfiles(domain: MemoryProfileDomain): Promise<MemoryProfileReadResult> {
    return this.loadProfiles(domain)
  }

  /** 设置页画像列表：读全部画像，不按领域收窄。 */
  async listProfiles(): Promise<MemoryProfileListResult> {
    return this.loadProfiles(null)
  }

  /**
   * 风格读取的唯一实现：`ids` 为空时读全部（设置页列表），否则按 ID 读（会话注入卡与按需复核）。
   * 样本按引擎顺序保留，缺字段的样本整条丢弃；按 ID 读时返回条数与请求不一致不冒充成功。
   */
  private async loadStyles(ids: readonly string[] | null): Promise<MemoryStyleListResult> {
    let configuration: MemoryHostConfiguration
    try { configuration = await this.configuration(this.options.hostEntry()) }
    catch { return { ok: false, error: { code: 'RUNTIME_MISSING', message: '受管记忆运行环境不可用' } } }
    if (!configuration.available) {
      return { ok: false, error: { code: 'RUNTIME_MISSING', message: configuration.error ?? '受管记忆运行环境不可用' } }
    }
    const result = await this.runEngine(configuration, ids === null ? ['styles'] : ['style-read', ...ids])
    try {
      const parsed: unknown = JSON.parse(result.text)
      if (isRecord(parsed) && parsed.ok === true && isRecord(parsed.data) && Array.isArray(parsed.data.styles)) {
        const styles = parsed.data.styles
          .map(toStyleRecord).filter((style): style is MemoryStyleReadRecord => style !== null)
        if (ids !== null && styles.length !== ids.length) {
          return { ok: false, error: { code: 'INVALID_RESPONSE', message: '记忆引擎返回的风格与请求不一致。' } }
        }
        return { ok: true, data: { styles } }
      }
      if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string') {
        const message = parsed.error.message
        const missing = /记忆库不存在|记忆库文件缺失/.test(message)
        return { ok: false, error: { code: missing ? 'STORE_UNAVAILABLE' : 'INTERNAL_ERROR', message } }
      }
    } catch { /* 非 JSON 输出按引擎失败处理。 */ }
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: this.describeFailure(result) } }
  }

  /** 按真实风格 ID 读取要点与全部原句：只供会话内的注入条目展开。 */
  async readStyles(ids: readonly string[]): Promise<MemoryStyleReadResult> {
    return this.loadStyles(ids)
  }

  /** 设置页风格列表：读全部风格与原句样本。 */
  async listStyles(): Promise<MemoryStyleListResult> {
    return this.loadStyles(null)
  }

  /**
   * 保存会话内卡片候选：用户在卡片上勾选并编辑后经引擎计划提交。
   * 归属按项目注册表匹配 projectPath，拿不到留空（全局记忆）；写入链固定在 planCommit 一处。
   * 会话身份由引擎生成（不传 session_id）：卡片保存是用户动作，与模型侧日记会话不同源，也不引入第二份会话映射。
   */
  async saveCandidates(request: MemorySaveCandidatesRequest): Promise<MemorySaveResult> {
    const registry = await this.projects()
    const project = request.projectPath === ''
      ? null
      : registry.projects.find(item => item.path === request.projectPath) ?? null
    const result = await this.planCommit('save', {
      agent: 'pi-desk',
      records: request.candidates.map(candidate => ({
        type: candidate.type, topic: candidate.topic, content: candidate.content,
        ...(candidate.rule_key === undefined ? {} : { rule_key: candidate.rule_key }),
        ...(candidate.status === undefined ? {} : { status: candidate.status }),
        ...(candidate.source_record_ids === undefined ? {} : { source_record_ids: candidate.source_record_ids }),
        ...(candidate.supersede_record_ids === undefined ? {} : { supersede_record_ids: candidate.supersede_record_ids }),
        ...(candidate.supersession_reason === undefined ? {} : { supersession_reason: candidate.supersession_reason })
      })),
      ...(project === null ? {} : { project_id: project.id })
    })
    if (!result.ok) return { ok: false, error: result.error }
    const recordIds = result.commit.new_record_ids
    if (!Array.isArray(recordIds) || recordIds.some(id => typeof id !== 'string')) {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: '记忆引擎提交回执缺少记录 ID。' } }
    }
    return { ok: true, data: { savedCount: recordIds.length, recordIds: recordIds as readonly string[] } }
  }

  /**
   * 保存设置页画像：引擎语义是「新增一条并替换旧条目」，因此保存等于新版本替换旧 ID。
   * 领域与作用域由契约限定；来源记录沿用原条目，已不存在的来源会在提交前剔除（引擎会整批拒绝未知来源），
   * 剔除结果随回执返回，由页面如实告知。写入锁从探测开始持有，避免并发请求重复拉起受管解释器。
   */
  async saveProfile(request: MemoryProfileSaveRequest): Promise<MemoryProfileSaveResult> {
    if (this.writing) {
      return { ok: false, error: { code: 'BUSY', message: '已有记忆写入正在进行，请等待其真实结果。' } }
    }
    this.writing = true
    try {
      let configuration: MemoryHostConfiguration
      try { configuration = await this.configuration(this.options.hostEntry()) }
      catch { return { ok: false, error: { code: 'RUNTIME_MISSING', message: '受管记忆运行环境不可用。' } } }
      if (!configuration.available) {
        return { ok: false, error: { code: 'RUNTIME_MISSING', message: configuration.error ?? '受管记忆运行环境不可用。' } }
      }
      const sources = await this.existingSources(configuration, request.sourceRecordIds)
      if (!sources.ok) return { ok: false, error: sources.error }
      const kept = new Set(sources.ids)
      const droppedSourceIds = request.sourceRecordIds.filter(id => !kept.has(id))
      const result = await this.planCommit('profile', {
        domain: request.domain,
        scope: request.scope,
        basis: request.basis,
        title: request.title,
        content: request.content,
        source_record_ids: sources.ids,
        replace_profile_ids: request.replaceProfileIds
      }, configuration, true)
      if (!result.ok) return { ok: false, error: result.error }
      // 新画像 ID 与替换目标都只在计划预览里出现，提交回执不带；缺失时如实报告「已提交但结果未确认」。
      const preview = result.plan.new_profile
      const profileId = isRecord(preview) && typeof preview.id === 'string' ? preview.id : ''
      if (!PROFILE_ID.test(profileId)) {
        return { ok: false, error: { code: 'INVALID_RESPONSE',
          message: '画像已按计划提交，但计划缺少新画像 ID；请重新读取画像列表确认结果。' } }
      }
      const replaced = result.plan.replace_profile_ids
      if (!Array.isArray(replaced)) {
        return { ok: false, error: { code: 'INVALID_RESPONSE',
          message: '画像已按计划提交，但计划缺少替换目标；请重新读取画像列表确认结果。' } }
      }
      const replacedIds = replaced.filter((id): id is string => typeof id === 'string' && PROFILE_ID.test(id))
      if (replacedIds.length !== replaced.length) {
        return { ok: false, error: { code: 'INVALID_RESPONSE',
          message: '画像已按计划提交，但替换目标形态异常；请重新读取画像列表确认结果。' } }
      }
      return { ok: true, data: {
        profileId,
        replacedProfileIds: [...new Set(replacedIds)],
        droppedSourceIds
      } }
    } finally {
      this.writing = false
    }
  }

  /**
   * 提交前过滤已失效的来源记录：引擎对任一不存在的来源 ID 都整批拒绝，
   * 而保存入口没有编辑来源的入口，不剔除会让这类画像在页面上永远保存失败。
   * 整批读成功即按记录逐条确认；引擎明确报「不存在」时逐条探测；
   * 读取本身失败（超时、非 JSON、引擎异常）直接返回错误，不把读取故障当成「来源已失效」。
   */
  private async existingSources(
    configuration: MemoryHostConfiguration,
    ids: readonly string[]
  ): Promise<{ ok: true; ids: string[] } | { ok: false; error: { code: MemoryErrorCode; message: string } }> {
    const kept: string[] = []
    for (let index = 0; index < ids.length; index += MEMORY_READ_BATCH) {
      const batch = ids.slice(index, index + MEMORY_READ_BATCH)
      const result = await this.runEngine(configuration, ['read', ...batch])
      const data = this.engineData(result)
      if (data !== null && Array.isArray(data.records)) {
        const present = new Set(data.records
          .filter((record): record is Record<string, unknown> => isRecord(record))
          .map(record => (typeof record.id === 'string' ? record.id : '')))
        for (const id of batch) if (present.has(id)) kept.push(id)
        continue
      }
      if (!this.engineMessage(result).includes('不存在')) {
        return { ok: false, error: this.engineFailure(result, '来源记录读取失败，未提交。') }
      }
      // 引擎明确报存在缺失：逐条探测，只保留真实存在的记录。
      for (const id of batch) {
        const single = this.engineData(await this.runEngine(configuration, ['read', id]))
        const present = single !== null && Array.isArray(single.records)
          && single.records.some(record => isRecord(record) && record.id === id)
        if (present) kept.push(id)
      }
    }
    return { ok: true, ids: kept }
  }

  /** 引擎 JSON 输出里的错误消息；解析不到时回落到原始输出，用于区分「读取失败」与「记录不存在」。 */
  private engineMessage(result: { code: number; text: string }): string {
    try {
      const parsed: unknown = JSON.parse(result.text)
      if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string') {
        return parsed.error.message
      }
    } catch { /* 保留原始输出。 */ }
    return result.text.trim().slice(0, 400)
  }

  /**
   * 保存设置页风格：未指定替换且同名时按合并（样本去重追加），
   * 指定 replaceStyleIds（可含本条自身）时按覆盖处理，由引擎在计划阶段判定。
   */
  async saveStyle(request: MemoryStyleSaveRequest): Promise<MemoryStyleSaveResult> {
    const styles = request.styles.map(item => ({
      name: item.name, scene: item.scene, points: item.points,
      samples: item.samples.map(sample => ({
        quote: sample.quote, source_session: sample.sourceSession, source_date: sample.sourceDate
      })),
      ...(item.replaceStyleIds.length === 0 ? {} : { replace_style_ids: item.replaceStyleIds })
    }))
    const result = await this.planCommit('style', { agent: 'pi-desk', styles })
    if (!result.ok) return { ok: false, error: result.error }
    const idList = (value: unknown): readonly string[] | null => (Array.isArray(value)
      && value.every(id => typeof id === 'string') ? value as readonly string[] : null)
    const newIds = idList(result.commit.new_style_ids)
    const mergedIds = idList(result.commit.merged_style_ids)
    const replacedIds = idList(result.commit.replaced_style_ids)
    if (newIds === null || mergedIds === null || replacedIds === null) {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: '记忆引擎提交回执缺少风格 ID。' } }
    }
    return { ok: true, data: { newStyleIds: newIds, mergedStyleIds: mergedIds, replacedStyleIds: replacedIds } }
  }

  /**
   * 写入用户库的唯一链：互斥 → 受管配置 → 体积上限 → 计划 → 提交，并核对提交与计划一致。
   * 日记候选、画像与风格三种写入共用；结果不一致时报错且不自动重试。
   * `lockHeld` 表示调用方已持有写入互斥（例如画像保存要先探测来源），此时不再重复加锁。
   */
  private async planCommit(
    operation: 'save' | 'profile' | 'style',
    input: unknown,
    prepared?: MemoryHostConfiguration,
    lockHeld = false
  ): Promise<{ ok: true; plan: Record<string, unknown>; commit: Record<string, unknown> }
    | { ok: false; error: { code: MemoryErrorCode; message: string } }> {
    if (!lockHeld) {
      if (this.writing) {
        return { ok: false, error: { code: 'BUSY', message: '已有记忆写入正在进行，请等待其真实结果。' } }
      }
      this.writing = true
    }
    try {
      let configuration: MemoryHostConfiguration
      if (prepared !== undefined) configuration = prepared
      else {
        try { configuration = await this.configuration(this.options.hostEntry()) }
        catch { return { ok: false, error: { code: 'RUNTIME_MISSING', message: '受管记忆运行环境不可用。' } } }
      }
      if (!configuration.available) {
        return { ok: false, error: { code: 'RUNTIME_MISSING', message: configuration.error ?? '受管记忆运行环境不可用。' } }
      }
      if (Buffer.byteLength(JSON.stringify(input)) > SAVE_INPUT_MAX_BYTES) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '写入内容超过输入上限，未截断或提交。' } }
      }
      const plan = await this.runEngine(configuration, ['plan', operation, '--input', '-'], input)
      const planData = this.engineData(plan)
      if (planData === null) return { ok: false, error: this.engineFailure(plan, '保存计划未能生成。') }
      const planId = planData.plan_id
      if (typeof planId !== 'string' || !ENGINE_PLAN_ID.test(planId)) {
        return { ok: false, error: { code: 'INVALID_RESPONSE', message: '记忆引擎返回了非法计划 ID；未提交。' } }
      }
      const commit = await this.runEngine(configuration, ['commit', '--plan-id', planId, '--approved'])
      const commitData = this.engineData(commit)
      if (commitData === null || commitData.committed !== planId || commitData.operation !== operation) {
        return { ok: false, error: { code: 'INTERNAL_ERROR',
          message: '提交结果与计划不一致，结果未确认；不得自动重试，请先核对记忆库实际状态。' } }
      }
      return { ok: true, plan: planData, commit: commitData }
    } finally {
      if (!lockHeld) this.writing = false
    }
  }

  /** 引擎 JSON 输出的 data 段；ok 不为真或退出码非零时按失败处理。 */
  private engineData(result: { code: number; text: string }): Record<string, unknown> | null {
    if (result.code !== 0) return null
    try {
      const parsed: unknown = JSON.parse(result.text)
      if (isRecord(parsed) && parsed.ok === true && isRecord(parsed.data)) return parsed.data
    } catch { /* 非 JSON 输出按引擎失败处理。 */ }
    return null
  }

  /** 引擎失败→桌面错误码：缺库类消息映射 STORE_UNAVAILABLE（与读取通道同一判定），其余按候选内容被拒透传原文。 */
  private engineFailure(result: { code: number; text: string }, fallback: string): { code: MemoryErrorCode; message: string } {
    if (result.code === -1) return { code: 'INTERNAL_ERROR', message: '受管记忆引擎无响应或超时；未自动重试。' }
    let message = ''
    try {
      const parsed: unknown = JSON.parse(result.text)
      if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string') {
        message = parsed.error.message
      }
    } catch { /* 保留原始输出。 */ }
    if (message === '') message = result.text.trim().slice(0, 400) || fallback
    const missing = /记忆库不存在|记忆库文件缺失/.test(message)
    return { code: missing ? 'STORE_UNAVAILABLE' : 'INVALID_REQUEST', message }
  }

  private describeFailure(result: { code: number; text: string }): string {
    if (result.code === -1) return '受管记忆引擎无响应或超时；未自动重试。'
    const text = result.text.trim()
    return text === '' ? `受管记忆引擎退出码 ${result.code}，未返回结论。` : text.slice(0, 400)
  }
}
