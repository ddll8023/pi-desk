/**
 * Pi 默认模型的唯一读写者：读写 Pi 的 `<agent-dir>/settings.json` 里的 `defaultProvider` 与
 * `defaultModel`，并把结果投影成页面契约（`shared/pi-settings-api.ts`）。
 *
 * 边界：
 * - 只处理顶层 `defaultProvider` 与 `defaultModel` 两个键。settings.json 的其他键（主题、包声明、
 *   思考等级、changelog 版本等）一律原样保留；不读也不写 Pi 的其他配置文件
 *   （`models.json`、`auth.json`、`mcp.json`）。
 * - 写入是同目录临时文件加改名替换；写入前比对上次读盘记录的文件标识，磁盘被其他写入者
 *   （例如 Pi 进程自己）改过就放弃本次保存，不用过期内容覆盖它。新文件沿用原文件的权限位。
 * - 文件存在但无法读取或解析时只报告错误并拒绝写入，绝不用空内容覆盖用户的文件。
 * - 校验只保证写入的是非空字符串；默认模型是否真实可用最终由 Pi 在加载时判定，这里不重算它的 schema。
 */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ModelIdentity } from '../shared/runtime-api'
import type { PiDefaultModelErrorCode } from '../shared/pi-settings-api'
import { getPiAgentDir } from './pi-paths'

/** 与 Pi 一致：用户级设置固定在 agent 目录下的 settings.json。 */
const SETTINGS_FILE_NAME = 'settings.json'
/** 配置文件的读取上限；与仓库其他有界读取一致，超限不读入内存。 */
const MAX_SETTINGS_BYTES = 512 * 1024

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
export class PiSettingsError extends Error {
  constructor(readonly code: PiDefaultModelErrorCode, message: string) {
    super(message)
  }
}

/** 只把成对的非空字符串当作已设置的默认模型；缺一个或类型不符都按未设置处理。 */
function readDefaultModel(parsed: Record<string, unknown> | null): ModelIdentity | null {
  if (parsed === null) return null
  const provider = parsed.defaultProvider
  const modelId = parsed.defaultModel
  if (typeof provider !== 'string' || provider.trim() === '') return null
  if (typeof modelId !== 'string' || modelId.trim() === '') return null
  return { provider, modelId }
}

export class PiSettingsManager {
  /** 上次读盘的结果与文件标识；写入前用它发现「磁盘在读取后被其他写入者改过」。 */
  private loaded = false
  private parsed: Record<string, unknown> | null = null
  private parseError: string | null = null
  private stamp: string | null = null
  /** 原文件的权限位（已去掉文件类型位）；文件不存在时为 null，新建时用默认权限。 */
  private mode: number | null = null

  /** 读取 Pi 的默认模型；文件不存在或未设置这两个键时返回 null。 */
  async getDefaultModel(): Promise<ModelIdentity | null> {
    await this.read()
    if (this.parseError !== null) throw new PiSettingsError('INTERNAL_ERROR', this.parseError)
    return readDefaultModel(this.parsed)
  }

  /** 写入默认模型：覆盖 `defaultProvider` 与 `defaultModel`，其他键原样保留。 */
  async setDefaultModel(model: ModelIdentity): Promise<ModelIdentity> {
    await this.ensureLoaded()
    this.requireWritable()
    await this.persist({
      ...(this.parsed ?? {}),
      defaultProvider: model.provider,
      defaultModel: model.modelId
    })
    return { provider: model.provider, modelId: model.modelId }
  }

  /** 解析失败时不允许写入：既不能拿空内容覆盖，也不能在一个已损坏的对象上做局部修改。 */
  private requireWritable(): void {
    if (this.parseError !== null) {
      throw new PiSettingsError('INVALID_REQUEST', `settings.json 当前无法解析，已拒绝保存：${this.parseError}`)
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.read()
  }

  /** 每次都重新读盘；文件缺失不是错误，解析或格式错误如实进入 `parseError`。 */
  private async read(): Promise<void> {
    const file = this.filePath()
    this.loaded = true
    this.parsed = null
    this.parseError = null
    this.stamp = null
    this.mode = null

    let text: string
    try {
      const info = await stat(file)
      if (info.size > MAX_SETTINGS_BYTES) {
        this.parseError = `${file}：文件超过 ${MAX_SETTINGS_BYTES} 字节上限，未读取。`
        return
      }
      text = await readFile(file, 'utf8')
      this.mode = info.mode & 0o777
    } catch (error) {
      // 文件不存在按「还没有用户级设置」处理，不创建文件、也不算错误。
      if (isMissingPath(error)) return
      this.parseError = `${file}：无法读取（${describeError(error)}）。`
      return
    }

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
    this.parsed = value
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
      throw new PiSettingsError(
        'INTERNAL_ERROR',
        'settings.json 已被其他程序修改，本次保存已放弃；请重新读取后再试。'
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
      throw new PiSettingsError('INTERNAL_ERROR', `无法保存 settings.json：${describeError(error)}`)
    }

    this.parsed = next
    this.stamp = await this.stampOf(file)
  }

  private filePath(): string {
    return join(getPiAgentDir(), SETTINGS_FILE_NAME)
  }
}
