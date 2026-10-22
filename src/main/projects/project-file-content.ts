/**
 * 项目文件内容读写：为工作区文件标签提供「读内容、写内容、查磁盘基线」三个能力。
 *
 * 根路径由请求固定并经已登记项目解析器复核，页面只能给出项目内相对路径；解析与越界判定复用
 * `project-entry-path` 的同一套规则。符号链接一律拒绝读写，避免链接把访问带出项目。
 *
 * 读取按内容分类：图片按扩展名映射 MIME 后回 base64；文本按 UTF-8 严格解码，识别并剥离 BOM、
 * 统计换行符主类型，编辑区统一使用 `\n`；二进制（含 NUL 字节）与非法 UTF-8 按「不支持」返回；
 * 超过读取上限同样按「不支持」返回，不截断、不假装可读。读取上限高于可编辑上限：
 * 大文件仍可只读预览，但写入会按可编辑上限拒绝。
 *
 * 写入只接受文本，并带回读取时的磁盘基线：`expected` 不为空且与当前 size/mtimeMs 不一致时回
 * CONFLICT，由界面提示用户继续编辑或强制覆盖；写入走同目录临时文件 + rename 的原子替换，
 * 并保留原文件权限位。
 */
import { chmod, lstat, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { DesktopError, DesktopErrorCode } from '../../shared/desktop-api'
import {
  PROJECT_FILE_EDIT_MAX_BYTES,
  PROJECT_FILE_IMAGE_MAX_BYTES,
  PROJECT_FILE_TEXT_MAX_BYTES
} from '../../shared/project-file-api'
import type {
  ProjectFileEol,
  ProjectFileReadRequest,
  ProjectFileReadResult,
  ProjectFileStatRequest,
  ProjectFileStatResult,
  ProjectFileWriteRequest,
  ProjectFileWriteResult
} from '../../shared/project-file-api'
import { resolveProjectEntryAbsolute } from './project-entry-path'

/** 二进制判定只看开头这么多字节：文本文件里出现 NUL 的概率极低，足够区分图片、压缩包与可执行文件。 */
const BINARY_SNIFF_BYTES = 8192

/** 只读预览的图片类型；SVG 是文本，按代码处理以便编辑，不在此列。 */
const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

export interface ProjectFileContentOptions {
  /** 只解析已登记项目，返回规范项目路径；不按变化中的当前项目解释请求。 */
  readonly resolveProjectPath: (requested: string) => Promise<string | null>
}

export class ProjectFileContent {
  constructor(private readonly options: ProjectFileContentOptions) {}

  /** 读取一个项目内文件；分类由主进程判定，页面只按返回的 kind 展示。 */
  async read(request: ProjectFileReadRequest): Promise<ProjectFileReadResult> {
    const root = await this.options.resolveProjectPath(request.projectPath)
    if (root === null) return failure('INVALID_REQUEST', '文件所属项目未登记或已被移除。')
    const resolved = await resolveProjectEntryAbsolute(root, request.path)
    if (!resolved.ok) return resolved

    const info = await statEntry(resolved.absolutePath)
    if (!info.ok) return info
    if (!info.exists) {
      return failure('INVALID_REQUEST', `文件不存在，可能已被移动或删除：${resolved.relativePath}`)
    }
    if (info.data.isSymbolicLink()) {
      return failure('INVALID_REQUEST', `符号链接不提供预览与编辑：${resolved.relativePath}`)
    }
    if (!info.data.isFile()) {
      return failure('INVALID_REQUEST', `不是普通文件，无法读取：${resolved.relativePath}`)
    }

    const size = info.data.size
    const mtimeMs = info.data.mtimeMs
    const mimeType = IMAGE_MIME_TYPES[extname(resolved.relativePath).slice(1).toLowerCase()] ?? null
    if (mimeType !== null) {
      if (size > PROJECT_FILE_IMAGE_MAX_BYTES) return unsupported(resolved.relativePath, 'too-large', size, mtimeMs)
      const buffer = await readBuffer(resolved.absolutePath, resolved.relativePath)
      if (!buffer.ok) return buffer
      return {
        ok: true,
        data: {
          kind: 'image',
          path: resolved.relativePath,
          mimeType,
          base64: buffer.data.toString('base64'),
          size,
          mtimeMs
        }
      }
    }

    if (size > PROJECT_FILE_TEXT_MAX_BYTES) return unsupported(resolved.relativePath, 'too-large', size, mtimeMs)
    const buffer = await readBuffer(resolved.absolutePath, resolved.relativePath)
    if (!buffer.ok) return buffer
    if (looksBinary(buffer.data)) return unsupported(resolved.relativePath, 'binary', size, mtimeMs)

    const decoded = decodeText(buffer.data)
    if (decoded === null) return unsupported(resolved.relativePath, 'binary', size, mtimeMs)
    return {
      ok: true,
      data: {
        kind: 'text',
        path: resolved.relativePath,
        text: decoded.text,
        eol: decoded.eol,
        bom: decoded.bom,
        size,
        mtimeMs
      }
    }
  }

  /**
   * 写入文本文件。`expected` 为空表示用户已确认覆盖；否则先比对磁盘基线，不一致直接回 CONFLICT，
   * 不写入任何内容。
   */
  async write(request: ProjectFileWriteRequest): Promise<ProjectFileWriteResult> {
    const root = await this.options.resolveProjectPath(request.projectPath)
    if (root === null) return failure('INVALID_REQUEST', '文件所属项目未登记或已被移除。')
    const resolved = await resolveProjectEntryAbsolute(root, request.path)
    if (!resolved.ok) return resolved

    const info = await statEntry(resolved.absolutePath)
    if (!info.ok) return info
    if (!info.exists) {
      return failure('INVALID_REQUEST', `文件不存在，可能已被移动或删除：${resolved.relativePath}`)
    }
    if (info.data.isSymbolicLink()) {
      return failure('INVALID_REQUEST', `符号链接不提供预览与编辑：${resolved.relativePath}`)
    }
    if (!info.data.isFile()) {
      return failure('INVALID_REQUEST', `不是普通文件，无法保存：${resolved.relativePath}`)
    }

    const expected = request.expected
    if (expected !== null
      && (info.data.size !== expected.size || info.data.mtimeMs !== expected.mtimeMs)) {
      return failure(
        'CONFLICT',
        `文件已在磁盘上被修改，未写入：${resolved.relativePath}。可以继续编辑，或确认覆盖。`
      )
    }

    const bytes = encodeText(request.text, request.eol, request.bom)
    if (bytes.byteLength > PROJECT_FILE_EDIT_MAX_BYTES) {
      return failure('INVALID_REQUEST', `内容超出可保存上限（${PROJECT_FILE_EDIT_MAX_BYTES} 字节），未写入。`)
    }

    const written = await replaceAtomically(resolved.absolutePath, bytes, info.data.mode)
    if (!written.ok) return written
    return {
      ok: true,
      data: { path: resolved.relativePath, size: bytes.byteLength, mtimeMs: written.data.mtimeMs }
    }
  }

  /** 查询磁盘基线；文件不存在或不是普通文件时 `exists` 为 false，不视为错误。 */
  async stat(request: ProjectFileStatRequest): Promise<ProjectFileStatResult> {
    const root = await this.options.resolveProjectPath(request.projectPath)
    if (root === null) return failure('INVALID_REQUEST', '文件所属项目未登记或已被移除。')
    const resolved = await resolveProjectEntryAbsolute(root, request.path)
    if (!resolved.ok) return resolved

    const info = await statEntry(resolved.absolutePath)
    if (!info.ok) return info
    if (!info.exists || !info.data.isFile() || info.data.isSymbolicLink()) {
      return { ok: true, data: { path: resolved.relativePath, exists: false, size: 0, mtimeMs: 0 } }
    }
    return {
      ok: true,
      data: {
        path: resolved.relativePath,
        exists: true,
        size: info.data.size,
        mtimeMs: info.data.mtimeMs
      }
    }
  }
}

type StatEntryResult =
  | { readonly ok: true; readonly exists: true; readonly data: Stats }
  | { readonly ok: true; readonly exists: false }
  | { readonly ok: false; readonly error: DesktopError }

/** 读取文件元数据；ENOENT 收敛为 exists=false，由调用方决定是报错还是当作已删除。 */
async function statEntry(absolutePath: string): Promise<StatEntryResult> {
  try {
    return { ok: true, exists: true, data: await lstat(absolutePath) }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { ok: true, exists: false }
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: fileFailureMessage(error, absolutePath) } }
  }
}

type BufferResult =
  | { readonly ok: true; readonly data: Buffer }
  | { readonly ok: false; readonly error: DesktopError }

async function readBuffer(absolutePath: string, relativePath: string): Promise<BufferResult> {
  try {
    return { ok: true, data: await readFile(absolutePath) }
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: fileFailureMessage(error, relativePath) } }
  }
}

type WriteResult =
  | { readonly ok: true; readonly data: { readonly mtimeMs: number } }
  | { readonly ok: false; readonly error: DesktopError }

/**
 * 同目录临时文件 + rename 的原子替换：目标文件不会出现写了一半的中间态。
 * 临时文件写完先按原文件权限位 chmod，再覆盖目标；失败时清理临时文件，不留残余。
 */
async function replaceAtomically(absolutePath: string, bytes: Buffer, mode: number): Promise<WriteResult> {
  const temporary = join(
    dirname(absolutePath),
    `.${basename(absolutePath)}.pi-desk-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
  )
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await chmod(temporary, mode & 0o777)
    await rename(temporary, absolutePath)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {
      // 临时文件可能根本没建出来；清理失败不覆盖原始错误。
    }
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: fileFailureMessage(error, absolutePath) } }
  }

  try {
    const info = await stat(absolutePath)
    return { ok: true, data: { mtimeMs: info.mtimeMs } }
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: fileFailureMessage(error, absolutePath) } }
  }
}

/** 前若干字节出现 NUL 即按二进制处理；这是文本编辑器与图片/压缩包的常见分界。 */
function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES)
  for (let index = 0; index < end; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

/**
 * UTF-8 严格解码；非法字节序列返回 null，由调用方按二进制处理。
 * 返回的 `text` 已统一为 `\n`，`eol` 记录原文件的主换行符，`bom` 记录是否需要保存时补回。
 */
function decodeText(buffer: Buffer): { readonly text: string; readonly eol: ProjectFileEol; readonly bom: boolean } | null {
  const bom = buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)
  const body = bom ? buffer.subarray(3) : buffer

  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    return null
  }

  const crlfCount = countOccurrences(decoded, '\r\n')
  const lfCount = countOccurrences(decoded, '\n')
  const lfOnlyCount = lfCount - crlfCount
  const eol: ProjectFileEol = crlfCount > 0 && crlfCount >= lfOnlyCount ? 'crlf' : 'lf'
  const text = decoded.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
  return { text, eol, bom }
}

/** 把编辑区文本按原换行符与 BOM 还原为磁盘字节。 */
function encodeText(text: string, eol: ProjectFileEol, bom: boolean): Buffer {
  const normalized = text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
  const body = eol === 'crlf' ? normalized.replace(/\n/gu, '\r\n') : normalized
  return bom ? Buffer.concat([UTF8_BOM, Buffer.from(body, 'utf8')]) : Buffer.from(body, 'utf8')
}

function countOccurrences(text: string, needle: string): number {
  let count = 0
  let index = text.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

/** 文件系统失败的可展示原因：区分不存在、没有权限与其余失败。 */
function fileFailureMessage(error: unknown, target: string): string {
  const code = errorCode(error)
  if (code === 'ENOENT') return `文件不存在，可能已被移动或删除：${target}`
  if (code === 'EACCES' || code === 'EPERM') return `没有权限访问文件：${target}`
  if (code === 'EISDIR') return `目标不是普通文件：${target}`
  return `访问文件失败：${target}`
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined
}

function unsupported(
  path: string,
  reason: 'binary' | 'too-large',
  size: number,
  mtimeMs: number
): ProjectFileReadResult {
  return { ok: true, data: { kind: 'unsupported', path, reason, size, mtimeMs } }
}

function failure(code: DesktopErrorCode, message: string): { ok: false; error: DesktopError } {
  return { ok: false, error: { code, message } }
}
