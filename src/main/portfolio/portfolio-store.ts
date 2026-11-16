/**
 * 作品库数据层：全局目录 `~/.agents/portfolio/` 下每件作品一个 `w_<ULID>` 目录，
 * `meta.json` 是唯一真源，素材与索引同目录，删除一件作品就是删一个目录。
 *
 * 本文件是作品库的唯一写入方：目录扫描、`meta.json` 原子写、素材复制与来源路径校验、
 * 删除、改名、封面落盘、素材定位都在这里完成；写操作在单队列内串行，不引入跨进程锁。
 * 它只被主进程使用，路径推导不放进共享契约（那份契约也会被 preload 与渲染层打包）。
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { shell } from 'electron'
import {
  PORTFOLIO_ASSET_TOTAL_MAX_BYTES,
  PORTFOLIO_NAME_MAX_CHARS,
  PORTFOLIO_POINTS_MAX_CHARS,
  PORTFOLIO_SCENE_MAX_CHARS,
  PORTFOLIO_SNAPSHOT_FILE_MAX_BYTES,
  PORTFOLIO_SNAPSHOT_MAX_FILES,
  isPortfolioAsset,
  isPortfolioId,
  isPortfolioRelativePath,
  isPortfolioSource,
  isPortfolioText
} from '../../shared/portfolio-api'
import type {
  PortfolioAsset,
  PortfolioDetail,
  PortfolioEntry,
  PortfolioSource
} from '../../shared/portfolio-api'

/** 作品库根目录：与记忆库同一处用户级资产目录。 */
export function globalPortfolioDirectory(): string {
  return join(homedir(), '.agents', 'portfolio')
}

/** 读盘时的结构版本；不认识的版本按不可读处理，不猜测字段含义。 */
const META_VERSION = 1
/** 清单里的要点摘要长度：列表只做辨识，全文在详情里。 */
const POINTS_SUMMARY_MAX_CHARS = 120
/** 封面图大小上限：与单个快照同口径，避免一次截图把作品目录撑大。 */
const COVER_MAX_BYTES = PORTFOLIO_SNAPSHOT_FILE_MAX_BYTES
/** 快照在库内的固定子目录；素材相对路径以此为前缀。 */
const SNAPSHOT_DIRECTORY = 'snapshots'
const COVER_RELATIVE_PATH = 'cover.png'

/** `meta.json` 的落盘形状；它与共享类型共用素材与来源的字段语义。 */
interface PortfolioMeta {
  readonly version: typeof META_VERSION
  readonly id: string
  readonly name: string
  readonly scene: string
  readonly points: string
  readonly sources: readonly PortfolioSource[]
  readonly assets: readonly PortfolioAsset[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** 登记一件作品需要的输入；`files` 是相对会话执行根的路径清单。 */
export interface PortfolioCreateInput {
  readonly name: string
  readonly scene: string
  readonly points: string
  readonly sources: readonly PortfolioSource[]
  readonly files: readonly string[]
}

/** 作品库的业务错误：消息直接面向用户，由 IPC 转成 `{ ok: false, error }`。 */
export class PortfolioStoreError extends Error {}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 生成 `w_` + 26 位 Crockford base32（48bit 时间戳 + 80bit 随机）；形态与共享契约一致。 */
function createPortfolioId(now = Date.now()): string {
  let rest = BigInt(now)
  const timeChars = new Array<string>(10)
  for (let index = 9; index >= 0; index -= 1) {
    timeChars[index] = ULID_ALPHABET[Number(rest % 32n)] ?? '0'
    rest /= 32n
  }
  const random = randomBytes(16)
  let randomChars = ''
  for (let index = 0; index < 16; index += 1) {
    randomChars += ULID_ALPHABET[(random[index] ?? 0) & 31] ?? '0'
  }
  return `w_${timeChars.join('')}${randomChars}`
}

/** 目标必须严格位于根目录内部；相等、越界与跨盘符都拒绝。 */
function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 快照文件名清洗：只保留单个普通文件名，去掉可能影响路径语义的字符。 */
function safeFileName(raw: string, used: Set<string>): string {
  const extension = extname(raw).slice(0, 16)
  const stem = basename(raw, extname(raw)).replace(/[\\/:*?"<>|\0]/g, '_').trim() || 'snapshot'
  let candidate = `${stem.slice(0, 100)}${extension}`
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${stem.slice(0, 100)}-${suffix}${extension}`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

function pointsSummary(points: string): string {
  const flat = points.replace(/\s+/g, ' ').trim()
  return flat.length <= POINTS_SUMMARY_MAX_CHARS ? flat : `${flat.slice(0, POINTS_SUMMARY_MAX_CHARS)}…`
}

function toEntry(meta: PortfolioMeta): PortfolioEntry {
  return {
    id: meta.id,
    name: meta.name,
    scene: meta.scene,
    pointsSummary: pointsSummary(meta.points),
    assetCount: meta.assets.length,
    hasCover: meta.assets.some(asset => asset.kind === 'cover'),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt
  }
}

function toDetail(meta: PortfolioMeta): PortfolioDetail {
  return { ...toEntry(meta), points: meta.points, assets: [...meta.assets], sources: [...meta.sources] }
}

/** 落盘结构校验：版本、身份与字段形状任一不符都按不可读处理。 */
function parseMeta(value: unknown, expectedId: string): PortfolioMeta | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.version !== META_VERSION || raw.id !== expectedId || !isPortfolioId(raw.id)) return null
  if (typeof raw.name !== 'string' || typeof raw.scene !== 'string' || typeof raw.points !== 'string') return null
  if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') return null
  if (!Array.isArray(raw.assets) || !raw.assets.every(isPortfolioAsset)) return null
  if (!Array.isArray(raw.sources) || !raw.sources.every(isPortfolioSource)) return null
  const assets = raw.assets as PortfolioAsset[]
  const sources = raw.sources as PortfolioSource[]
  return {
    version: META_VERSION,
    id: raw.id,
    name: raw.name,
    scene: raw.scene,
    points: raw.points,
    sources,
    assets,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  }
}

/** 作品库：目录、`meta.json` 与素材的唯一读写者。 */
export class PortfolioStore {
  /** 写队列：写操作串行执行；读取不进队列，依赖 `meta.json` 的临时文件 + rename 保证单条记录不半写。 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly rootDirectory: () => string = globalPortfolioDirectory) {}

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private root(): string { return this.rootDirectory() }

  private directoryOf(id: string): string { return join(this.root(), id) }

  /** 读取一件作品的真实内容；目录缺失与结构不可读都返回 null，读盘故障则如实报错。 */
  private async readMeta(id: string): Promise<PortfolioMeta | null> {
    let text: string
    try {
      text = await fs.readFile(join(this.directoryOf(id), 'meta.json'), 'utf8')
    } catch (error) {
      // 只有「文件不存在」等价于作品缺失；权限与 IO 故障不能伪装成数据不存在。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new PortfolioStoreError('读取作品失败，请检查目录权限。')
    }
    try {
      return parseMeta(JSON.parse(text), id)
    } catch {
      return null
    }
  }

  /** 临时文件 + rename：同一目录内替换，不会留下半份 `meta.json`。 */
  private async writeMeta(id: string, meta: PortfolioMeta): Promise<void> {
    const directory = this.directoryOf(id)
    const temporary = join(directory, 'meta.json.tmp')
    await fs.writeFile(temporary, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    await fs.rename(temporary, join(directory, 'meta.json'))
  }

  private async requireMeta(id: string): Promise<PortfolioMeta> {
    if (!isPortfolioId(id)) throw new PortfolioStoreError('作品标识不合法。')
    const meta = await this.readMeta(id)
    if (meta === null) throw new PortfolioStoreError(`找不到这件作品：${id}`)
    return meta
  }

  private async allocateId(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = createPortfolioId()
      try {
        await fs.access(this.directoryOf(id))
      } catch {
        return id
      }
    }
    throw new PortfolioStoreError('生成作品标识失败，请重试。')
  }

  private async copySnapshots(
    directory: string,
    files: readonly string[],
    executionRoot: string
  ): Promise<PortfolioAsset[]> {
    if (files.length > PORTFOLIO_SNAPSHOT_MAX_FILES) {
      throw new PortfolioStoreError(`快照最多 ${PORTFOLIO_SNAPSHOT_MAX_FILES} 个文件。`)
    }
    const snapshots: PortfolioAsset[] = []
    const used = new Set<string>()
    let total = 0
    // 真实根只算一次：字面比较挡不住工作区内的符号链接，复制与 stat 默认都跟随链接。
    const realRoot = await fs.realpath(executionRoot).catch(() => null)
    if (realRoot === null) throw new PortfolioStoreError('当前会话工作区不存在，不能复制快照。')
    for (const file of files) {
      if (typeof file !== 'string' || file.trim() === '') throw new PortfolioStoreError('快照路径不能为空。')
      // 绝对路径经 resolve 后由同一条边界校验拒绝，不按「看着像相对路径」放行。
      const source = resolve(executionRoot, file)
      if (!isInside(executionRoot, source)) {
        throw new PortfolioStoreError(`快照来源必须位于当前会话工作区内：${file}`)
      }
      const info = await fs.lstat(source).catch(() => null)
      if (info === null) throw new PortfolioStoreError(`快照来源不存在：${file}`)
      if (info.isSymbolicLink()) throw new PortfolioStoreError(`快照来源不能是符号链接：${file}`)
      if (!info.isFile()) throw new PortfolioStoreError(`快照来源不是文件：${file}`)
      const realSource = await fs.realpath(source).catch(() => null)
      if (realSource === null || !isInside(realRoot, realSource)) {
        throw new PortfolioStoreError(`快照来源必须位于当前会话工作区内：${file}`)
      }
      if (info.size > PORTFOLIO_SNAPSHOT_FILE_MAX_BYTES) {
        throw new PortfolioStoreError(`单个快照不能超过 ${Math.round(PORTFOLIO_SNAPSHOT_FILE_MAX_BYTES / (1024 * 1024))} MB：${file}`)
      }
      total += info.size
      if (total > PORTFOLIO_ASSET_TOTAL_MAX_BYTES) {
        throw new PortfolioStoreError(`素材合计不能超过 ${Math.round(PORTFOLIO_ASSET_TOTAL_MAX_BYTES / (1024 * 1024))} MB。`)
      }
      const target = `${SNAPSHOT_DIRECTORY}/${safeFileName(file, used)}`
      await fs.copyFile(realSource, join(directory, target))
      snapshots.push({ kind: 'snapshot', path: target, sourcePath: source, bytes: info.size })
    }
    return snapshots
  }

  /** 列表：只读目录与 `meta.json`，结构不可读的作品跳过且不伪造条目。 */
  async list(): Promise<readonly PortfolioEntry[]> {
    let dirents: Dirent[]
    try {
      dirents = await fs.readdir(this.root(), { withFileTypes: true })
    } catch {
      return []
    }
    const entries: PortfolioEntry[] = []
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !isPortfolioId(dirent.name)) continue
      const meta = await this.readMeta(dirent.name)
      if (meta !== null) entries.push(toEntry(meta))
    }
    return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /** 详情：返回要点全文、素材清单与来源；不返回图片二进制。 */
  async read(id: string): Promise<PortfolioDetail> {
    return toDetail(await this.requireMeta(id))
  }

  /** 新增作品：只登记新增，不覆盖既有作品；失败时清理本次新建的半成品目录。 */
  async create(input: PortfolioCreateInput, executionRoot: string): Promise<PortfolioDetail> {
    if (!isPortfolioText(input.name, PORTFOLIO_NAME_MAX_CHARS)) throw new PortfolioStoreError('作品名称不能为空且不能超过 100 字。')
    if (!isPortfolioText(input.scene, PORTFOLIO_SCENE_MAX_CHARS)) throw new PortfolioStoreError('适用场景不能为空且不能超过 200 字。')
    if (!isPortfolioText(input.points, PORTFOLIO_POINTS_MAX_CHARS, true)) throw new PortfolioStoreError('设计要点不能超过 8000 字。')
    return this.enqueue(async () => {
      if (!isAbsolute(executionRoot)) throw new PortfolioStoreError('当前会话工作区不可用于复制快照。')
      const root = this.root()
      await fs.mkdir(root, { recursive: true })
      const id = await this.allocateId()
      const directory = this.directoryOf(id)
      try {
        await fs.mkdir(join(directory, SNAPSHOT_DIRECTORY), { recursive: true })
        const assets = await this.copySnapshots(directory, input.files, executionRoot)
        const now = new Date().toISOString()
        const meta: PortfolioMeta = {
          version: META_VERSION,
          id,
          name: input.name.trim(),
          scene: input.scene.trim(),
          points: input.points,
          sources: [...input.sources],
          assets,
          createdAt: now,
          updatedAt: now
        }
        await this.writeMeta(id, meta)
        return toDetail(meta)
      } catch (error) {
        // 本次刚创建、尚未登记成功的目录属于半成品，直接移除，不留在库里。
        await fs.rm(directory, { recursive: true, force: true })
        throw error
      }
    })
  }

  /** 改名只改 `name`，目录与素材路径不变。 */
  async rename(id: string, name: string): Promise<PortfolioEntry> {
    if (!isPortfolioText(name, PORTFOLIO_NAME_MAX_CHARS)) throw new PortfolioStoreError('作品名称不能为空且不能超过 100 字。')
    return this.enqueue(async () => {
      const meta = await this.requireMeta(id)
      const next: PortfolioMeta = { ...meta, name: name.trim(), updatedAt: new Date().toISOString() }
      await this.writeMeta(id, next)
      return toEntry(next)
    })
  }

  /** 删除走系统废纸篓：作品是资产，只做可恢复的软删除。 */
  async remove(id: string): Promise<void> {
    await this.enqueue(async () => {
      await this.requireMeta(id)
      try {
        await shell.trashItem(this.directoryOf(id))
      } catch (error) {
        throw new PortfolioStoreError(`移入废纸篓失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  /** 封面落盘：替换旧封面并更新 `meta.json`，图片字节只在这里写。 */
  async captureCover(id: string, png: Buffer): Promise<PortfolioEntry> {
    if (png.byteLength === 0) throw new PortfolioStoreError('截图内容为空。')
    if (png.byteLength > COVER_MAX_BYTES) throw new PortfolioStoreError('封面图过大，已放弃写入。')
    return this.enqueue(async () => {
      const meta = await this.requireMeta(id)
      // 先写临时文件再 rename：中途失败不会把已登记的封面覆盖成半个 PNG。
      const target = join(this.directoryOf(id), COVER_RELATIVE_PATH)
      const temporary = `${target}.tmp`
      try {
        await fs.writeFile(temporary, png)
        await fs.rename(temporary, target)
      } catch (error) {
        await fs.rm(temporary, { force: true })
        throw new PortfolioStoreError(`封面写入失败：${error instanceof Error ? error.message : String(error)}`)
      }
      const others = meta.assets.filter(asset => asset.kind !== 'cover')
      const next: PortfolioMeta = {
        ...meta,
        assets: [{ kind: 'cover', path: COVER_RELATIVE_PATH, sourcePath: null, bytes: png.byteLength }, ...others],
        updatedAt: new Date().toISOString()
      }
      await this.writeMeta(id, next)
      return toEntry(next)
    })
  }

  /** 素材定位：只认 `meta.json` 登记过的相对路径，解析后仍须位于作品目录内。 */
  async resolveAsset(id: string, path: string): Promise<string> {
    if (!isPortfolioRelativePath(path)) throw new PortfolioStoreError('素材路径不合法。')
    const meta = await this.requireMeta(id)
    if (!meta.assets.some(asset => asset.path === path)) throw new PortfolioStoreError('这件作品没有登记该素材。')
    const absolute = join(this.directoryOf(id), path)
    if (!isInside(this.directoryOf(id), absolute)) throw new PortfolioStoreError('素材路径越界。')
    try {
      await fs.access(absolute)
    } catch {
      throw new PortfolioStoreError('素材文件已不存在。')
    }
    return absolute
  }
}
