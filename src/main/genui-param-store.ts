/**
 * 生成式界面参数取值的本机旁路存储：`<userData>/genui-params.json` 的唯一读写者。
 *
 * 与 `desktop-config-store.ts` 分开是刻意的：参数是高频变化、可再生的小缓存，配置文件装着项目列表
 * 这类关键记录，且是整文件写入；把参数混进去会把整文件写入的频率与覆盖风险放大到项目记录上。
 * 因此这里不读、不写、也不参与 `desktop-config.json` 的文件标识比对。
 *
 * 文件形状为 `{ version, entries: { [documentId]: { revision, updatedAt, values } } }`：
 * 键是界面标识，不带会话与分支；`revision` 供渲染端判断能否按参数 id 迁移旧取值；
 * `updatedAt` 用于载入时丢弃超期记录、写满上限时淘汰最旧的一条。
 *
 * 载入是逐条容错的：结构损坏先备份再重建，单条记录非法只丢这一条，不整份放弃；
 * 文件超过字节上限则整体重建——在损坏或膨胀的文件上做逐条裁剪没有收益。
 * 写入串行执行、同目录临时文件加改名替换，中断时不会留下半份文件。
 * 任何失败都只回传错误：参数取值可再生产，丢一次不应阻断其他操作。
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { GenuiParamRecord, GenuiParamRecordMap } from '../shared/genui-params-api'
import {
  GENUI_PARAM_RECORD_TTL_MS,
  MAX_GENUI_PARAMS_FILE_BYTES,
  MAX_GENUI_PARAM_RECORDS,
  isGenuiDocumentId,
  isGenuiParamRecord
} from '../shared/genui-params-api'

const FILE_BASE_NAME = 'genui-params'
const FILE_NAME = `${FILE_BASE_NAME}.json`
/** 文件结构版本；形状变化必须显式升级，不静默改写既有文件。 */
const FILE_VERSION = 1

/** 存储层异常：消息可直接展示给用户，调用方据此组装失败结果。 */
export class GenuiParamStorageError extends Error {}

interface StoredFile {
  readonly version: number
  readonly entries: GenuiParamRecordMap
}

/** 缺失文件与权限错误的区分：只有前者按空记录处理，后者按读取失败上报。 */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class GenuiParamStore {
  /** 内存里的全量记录；载入后即真源，写入时先改它再落盘。 */
  private entries: Map<string, GenuiParamRecord> = new Map()
  private loaded = false
  /** 串行队列：同一时刻只有一个写入者，避免两次改名互相踩。 */
  private writing: Promise<unknown> = Promise.resolve()

  /** 读取全量记录；失败时抛出可展示的原因，不返回半份数据。 */
  async read(): Promise<GenuiParamRecordMap> {
    await this.load()
    return this.snapshot()
  }

  /** 保存或删除一份界面的取值；返回落盘后的单条记录（删除时为 null）。 */
  async save(documentId: string, record: GenuiParamRecord | null): Promise<GenuiParamRecord | null> {
    await this.load()
    if (record === null) {
      this.entries.delete(documentId)
    } else {
      // 保存时按当前时间刷新时间戳：有效期与淘汰顺序都按最后一次真实写入算。
      this.entries.set(documentId, {
        revision: record.revision,
        updatedAt: Date.now(),
        values: { ...record.values }
      })
    }
    this.trim()
    await this.persist()
    return this.entries.get(documentId) ?? null
  }

  /** 删除全部记录并返回删除条数；没有记录时不写文件。 */
  async clear(): Promise<number> {
    await this.load()
    const removed = this.entries.size
    if (removed === 0) return 0
    this.entries.clear()
    await this.persist()
    return removed
  }

  /** 首次访问时载入；后续调用直接复用内存状态。 */
  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const file = this.filePath()
    let text: string
    try {
      const info = await stat(file)
      if (info.size > MAX_GENUI_PARAMS_FILE_BYTES) {
        // 文件异常膨胀时整体重建，不在它上面做逐条裁剪。
        await this.quarantine(file)
        return
      }
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return
      throw new GenuiParamStorageError(
        error instanceof Error
          ? `无法读取已保存的界面参数：${error.message}`
          : '无法读取已保存的界面参数。'
      )
    }
    const parsed = this.parse(text)
    if (parsed === null) {
      await this.quarantine(file)
      return
    }
    this.entries = new Map(Object.entries(parsed))
    // 上限在载入后统一收敛：文件里条数偏多不算损坏，按 `updatedAt` 淘汰最旧的即可。
    this.trim()
  }

  /** 解析并逐条过滤；只有顶层结构无法识别时返回 null（按损坏处理）。 */
  private parse(text: string): Record<string, GenuiParamRecord> | null {
    let value: unknown
    try {
      value = JSON.parse(text) as unknown
    } catch {
      return null
    }
    if (!isRecord(value)) return null
    if (typeof value.version !== 'number' || !Number.isInteger(value.version)) return null
    if (value.version !== FILE_VERSION) {
      // 未来版本的文件不解释也不改写：参数是可再生产的数据，宁可当作没有。
      return null
    }
    const raw = value.entries
    if (!isRecord(raw)) return null
    const now = Date.now()
    const entries: Record<string, GenuiParamRecord> = {}
    for (const [documentId, record] of Object.entries(raw)) {
      // 键与记录各自校验：单条非法只丢这一条，不整份放弃，也不把任意字符串当界面标识。
      if (!isGenuiDocumentId(documentId)) continue
      if (!isGenuiParamRecord(record)) continue
      // 超期记录直接丢弃：短有效期会把「上次调好的值」变成噪音，但无限留着同样没有意义。
      if (now - record.updatedAt > GENUI_PARAM_RECORD_TTL_MS) continue
      entries[documentId] = {
        revision: record.revision,
        updatedAt: record.updatedAt,
        values: { ...record.values }
      }
    }
    return entries
  }

  /** 记录超出上限时按 `updatedAt` 淘汰最旧的，直到回到上限内。 */
  private trim(): void {
    if (this.entries.size <= MAX_GENUI_PARAM_RECORDS) return
    const ordered = [...this.entries.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    for (const [key] of ordered) {
      if (this.entries.size <= MAX_GENUI_PARAM_RECORDS) break
      this.entries.delete(key)
    }
  }

  /** 当前内存记录的快照；返回普通对象，跨 IPC 传得出去。 */
  private snapshot(): GenuiParamRecordMap {
    const entries: Record<string, GenuiParamRecord> = {}
    for (const [documentId, record] of this.entries) {
      entries[documentId] = { revision: record.revision, updatedAt: record.updatedAt, values: { ...record.values } }
    }
    return entries
  }

  /** 备份无法解析的文件；失败只影响提示，不影响本次运行。 */
  private async quarantine(file: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(dirname(file), `${FILE_BASE_NAME}.corrupt-${stamp}.json`)
    try {
      await rename(file, target)
    } catch {
      // 备份失败时原文件保持不动：下次启动会再试一次，不在这里覆盖它。
    }
  }

  /** 串行落盘；同目录临时文件加改名替换，中断时不会留下半份文件。 */
  private async persist(): Promise<void> {
    const run = this.writing.then(async () => {
      const file = this.filePath()
      const temporary = `${file}.${process.pid}-${Date.now()}.tmp`
      const payload: StoredFile = { version: FILE_VERSION, entries: this.snapshot() }
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
        await rename(temporary, file)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw new GenuiParamStorageError(
          error instanceof Error
            ? `无法保存界面参数：${error.message}`
            : '无法保存界面参数。'
        )
      }
    })
    // 队列本身不能因为一次失败而断掉：后续写入仍要排在前一次之后执行。
    this.writing = run.catch(() => undefined)
    await run
  }

  private filePath(): string {
    return join(app.getPath('userData'), FILE_NAME)
  }
}
