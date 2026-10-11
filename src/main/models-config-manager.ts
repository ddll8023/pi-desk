/**
 * 第三方自定义供应商的唯一读写者：读取 Pi 的 `<agent-dir>/models.json`、按单个条目新增或替换、
 * 删除条目，并把结果投影成页面契约（`shared/models-config-api.ts`）。
 *
 * 边界：
 * - 只处理顶层 `providers` 映射。其他顶层键、其他供应商条目、以及被编辑条目里未涉及的字段
 *   （`modelOverrides`、`compat`、`thinkingLevelMap`、`cost` 等）一律原样保留；不读也不写 Pi 的
 *   其他配置文件（`settings.json`、`auth.json`、`mcp.json`）。
 * - 凭据边界：回传前把 `apiKey` 与 `headers` 的值替换为哨兵，保存时按位置还原为磁盘上的原值。
 *   本模块不把密钥写进日志、错误文本或页面快照。
 * - 写入是同目录临时文件加改名替换；写入前比对上次读盘记录的文件标识，磁盘被其他写入者改过
 *   就放弃本次保存，不用过期内容覆盖它。新文件沿用原文件的权限位，不因重写把可能装着密钥的
 *   文件放宽。
 * - 文件存在但无法读取或解析时只报告错误并拒绝写入，绝不用空内容覆盖用户的文件。
 * - 校验只保证写入的是形状合法的 JSON 对象；字段合法性最终由 Pi 在加载时判定，这里不重算它的 schema。
 */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ModelsConfigErrorCode, ModelsConfigProvider, ModelsConfigSnapshot } from '../shared/models-config-api'
import { MODELS_CONFIG_MAX_PROVIDERS, MODELS_CONFIG_SECRET_SENTINEL } from '../shared/models-config-api'
import { getPiAgentDir } from './pi-paths'

/** 与 Pi 一致：自定义供应商配置固定放在 agent 目录下的 models.json。 */
const CONFIG_FILE_NAME = 'models.json'
/** 配置文件的读取上限；与仓库其他有界读取一致，超限不读入内存。 */
const MAX_CONFIG_BYTES = 512 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 读写失败：错误码直接映射到共享契约，`message` 只放面向用户的一句话结论。 */
export class ModelsConfigError extends Error {
  constructor(readonly code: ModelsConfigErrorCode, message: string) {
    super(message)
  }
}

/**
 * 回传前的脱敏：`apiKey` 与非字符串以外的每个 `headers` 值都替换为哨兵。
 * 只处理这两个位置，其他字段原样展示，避免猜造哪些值算凭据。
 */
function maskSecrets(entry: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = { ...entry }
  if (typeof masked.apiKey === 'string') masked.apiKey = MODELS_CONFIG_SECRET_SENTINEL
  if (isRecord(entry.headers)) {
    const headers: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(entry.headers)) {
      headers[name] = typeof value === 'string' ? MODELS_CONFIG_SECRET_SENTINEL : value
    }
    masked.headers = headers
  }
  return masked
}

/**
 * 保存前的还原：把等于哨兵的值换回磁盘上同名位置的原值。
 * 原值已经不存在（例如用户在表单里改了 header 名）时删除该字段，不留下一个假的密钥。
 */
function restoreSecrets(entry: Record<string, unknown>, current: Record<string, unknown> | undefined): void {
  if (entry.apiKey === MODELS_CONFIG_SECRET_SENTINEL) {
    if (current !== undefined && typeof current.apiKey === 'string') entry.apiKey = current.apiKey
    else delete entry.apiKey
  }
  if (!isRecord(entry.headers)) return

  const currentHeaders = current !== undefined && isRecord(current.headers) ? current.headers : undefined
  for (const [name, value] of Object.entries(entry.headers)) {
    if (value !== MODELS_CONFIG_SECRET_SENTINEL) continue
    const original = currentHeaders === undefined ? undefined : currentHeaders[name]
    if (typeof original === 'string') entry.headers[name] = original
    else delete entry.headers[name]
  }
}

/**
 * 写入前的形状校验：只拒绝会让 Pi 无法解析的类型错误与缺失模型 id。
 * 未知字段一律放行（Pi 的 schema 不禁止额外属性），由 Pi 在加载时给出结论。
 */
function validateEntry(value: unknown): string | null {
  if (!isRecord(value)) return '供应商配置必须是一个 JSON 对象。'
  for (const key of ['name', 'baseUrl', 'api', 'apiKey'] as const) {
    const field = value[key]
    if (field !== undefined && typeof field !== 'string') return `${key} 必须是字符串。`
  }
  if (value.headers !== undefined) {
    if (!isRecord(value.headers)) return 'headers 必须是对象。'
    for (const headerValue of Object.values(value.headers)) {
      if (typeof headerValue !== 'string') return 'headers 的每个值都必须是字符串。'
    }
  }
  if (value.models !== undefined) {
    if (!Array.isArray(value.models)) return 'models 必须是数组。'
    for (const model of value.models) {
      if (!isRecord(model)) return 'models 的每一项都必须是对象。'
      if (typeof model.id !== 'string' || model.id.trim() === '') return '每个模型都需要一个非空的 id。'
    }
  }
  return null
}

/** 从解析结果里投影出页面需要的供应商条目；形状不符的条目跳过，不猜造。 */
function readProviders(
  parsed: Record<string, unknown> | null
): { readonly entries: readonly ModelsConfigProvider[]; readonly truncated: boolean } {
  const raw = parsed === null ? undefined : parsed.providers
  if (!isRecord(raw)) return { entries: [], truncated: false }

  const entries: ModelsConfigProvider[] = []
  let truncated = false
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue
    if (entries.length >= MODELS_CONFIG_MAX_PROVIDERS) {
      truncated = true
      break
    }
    const models = Array.isArray(value.models) ? value.models : []
    entries.push({
      id,
      json: JSON.stringify(maskSecrets(value), null, 2),
      hasApiKey: typeof value.apiKey === 'string' && value.apiKey.trim() !== '',
      modelCount: models.filter((model) => (
        isRecord(model) && typeof model.id === 'string' && model.id.trim() !== ''
      )).length
    })
  }
  return { entries, truncated }
}

export class ModelsConfigManager {
  /** 上次读盘的结果与文件标识；写入前用它发现「磁盘在读取后被其他写入者改过」。 */
  private loaded = false
  private exists = false
  private parsed: Record<string, unknown> | null = null
  private parseError: string | null = null
  private stamp: string | null = null
  /** 原文件的权限位（已去掉文件类型位）；文件不存在时为 null，新建时用默认权限。 */
  private mode: number | null = null

  /** 重新读盘并返回快照；这次读取同时成为后续保存的比对基线。 */
  async getSnapshot(): Promise<ModelsConfigSnapshot> {
    await this.read()
    return this.snapshot()
  }

  /** 新增或整体替换一个供应商条目；`json` 必须是形状合法的 JSON 对象文本。 */
  async saveProvider(providerId: string, json: string): Promise<ModelsConfigSnapshot> {
    await this.ensureLoaded()
    this.requireWritable()

    let submitted: unknown
    try {
      submitted = JSON.parse(json)
    } catch (error) {
      throw new ModelsConfigError('INVALID_REQUEST', `供应商配置不是合法 JSON：${describeError(error)}`)
    }
    const problem = validateEntry(submitted)
    if (problem !== null) throw new ModelsConfigError('INVALID_REQUEST', problem)

    const entry = submitted as Record<string, unknown>
    restoreSecrets(entry, this.providerEntry(providerId))

    const currentProviders = this.parsed === null ? undefined : this.parsed.providers
    const providers: Record<string, unknown> = isRecord(currentProviders) ? { ...currentProviders } : {}
    providers[providerId] = entry
    await this.persist({ ...(this.parsed ?? {}), providers })
    return this.snapshot()
  }

  /** 删除一个供应商条目；条目不存在时不动文件，直接返回当前快照。 */
  async deleteProvider(providerId: string): Promise<ModelsConfigSnapshot> {
    await this.ensureLoaded()
    this.requireWritable()

    const current = this.parsed === null ? undefined : this.parsed.providers
    if (!isRecord(current) || !(providerId in current)) return this.snapshot()

    const providers: Record<string, unknown> = { ...current }
    delete providers[providerId]
    await this.persist({ ...(this.parsed ?? {}), providers })
    return this.snapshot()
  }

  private providerEntry(providerId: string): Record<string, unknown> | undefined {
    const providers = this.parsed === null ? undefined : this.parsed.providers
    if (!isRecord(providers)) return undefined
    const entry = providers[providerId]
    return isRecord(entry) ? entry : undefined
  }

  /** 解析失败时不允许写入：既不能拿空内容覆盖，也不能在一个已损坏的对象上做局部修改。 */
  private requireWritable(): void {
    if (this.parseError !== null) {
      throw new ModelsConfigError('INVALID_REQUEST', `models.json 当前无法解析，已拒绝保存：${this.parseError}`)
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.read()
  }

  /** 每次都重新读盘；文件缺失不是错误，解析或格式错误如实进入 `parseError`。 */
  private async read(): Promise<void> {
    const file = this.filePath()
    this.loaded = true
    this.exists = false
    this.parsed = null
    this.parseError = null
    this.stamp = null
    this.mode = null

    let text: string
    try {
      const info = await stat(file)
      if (info.size > MAX_CONFIG_BYTES) {
        this.parseError = `${file}：文件超过 ${MAX_CONFIG_BYTES} 字节上限，未读取。`
        return
      }
      text = await readFile(file, 'utf8')
      this.mode = info.mode & 0o777
    } catch (error) {
      // 文件不存在按「还没有配置」处理，不创建文件、也不算错误。
      if (isMissingPath(error)) return
      this.parseError = `${file}：无法读取（${describeError(error)}）。`
      return
    }

    this.exists = true
    this.stamp = await this.stampOf(file)

    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      this.parseError = `${file}：无法解析 JSON（${describeError(error)}）。`
      return
    }
    if (!isRecord(value)) {
      this.parseError = `${file}：顶层必须是一个对象。`
      return
    }
    if (value.providers !== undefined && !isRecord(value.providers)) {
      this.parseError = `${file}：providers 必须是一个对象。`
      return
    }
    this.parsed = value
  }

  private snapshot(): ModelsConfigSnapshot {
    const file = this.filePath()
    if (this.parseError !== null) {
      return { filePath: file, exists: this.exists, providers: [], parseError: this.parseError, truncated: false }
    }
    const { entries, truncated } = readProviders(this.parsed)
    return { filePath: file, exists: this.exists, providers: entries, parseError: null, truncated }
  }

  /** 文件标识；文件不存在返回 null。只用于发现外部写入，不参与内容校验。 */
  private async stampOf(file: string): Promise<string | null> {
    try {
      const info = await stat(file)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return null
    }
  }

  /** 同目录临时文件加改名替换，中断时不会留下半份配置。 */
  private async persist(next: Record<string, unknown>): Promise<void> {
    const file = this.filePath()
    const temporary = `${file}.${process.pid}-${Date.now()}.tmp`

    // 磁盘在读取后被别的写入者改过时，宁可放弃本次保存，也不用过期内容覆盖它。
    if (await this.stampOf(file) !== this.stamp) {
      throw new ModelsConfigError(
        'INTERNAL_ERROR',
        'models.json 已被其他程序修改，本次保存已放弃；请重新读取后再试。'
      )
    }

    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      // 权限调整失败不阻断保存：宁可用默认权限，也不要因为 chmod 失败而丢掉本次写入。
      if (this.mode !== null) await chmod(temporary, this.mode).catch(() => undefined)
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new ModelsConfigError('INTERNAL_ERROR', `无法保存 models.json：${describeError(error)}`)
    }

    this.exists = true
    this.parsed = next
    this.stamp = await this.stampOf(file)
  }

  private filePath(): string {
    return join(getPiAgentDir(), CONFIG_FILE_NAME)
  }
}
