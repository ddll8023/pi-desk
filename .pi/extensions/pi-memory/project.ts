/** 项目知识只读适配：只沿 cwd 祖先定位项目，索引和主题始终限制在当前项目内。 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_FILE_BYTES = 1_048_576
const TOPIC = /^topics\/(?:(?:conventions|gotchas)\/)?[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

export function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

export function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** 限制读取量，不跟随文件尾级符号链接；文件读取期间改变时不使用混合版本。 */
export async function readText(path: string, maxBytes = MAX_FILE_BYTES): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error(`文件不是普通文件或超过读取上限：${path}`)
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const buffer = Buffer.alloc(Math.min(65_536, maxBytes + 1 - total))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      total += bytesRead
      if (total > maxBytes) throw new Error(`文件超过读取上限，未截断使用：${path}`)
      chunks.push(buffer.subarray(0, bytesRead))
    }
    const after = await handle.stat({ bigint: true })
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error(`文件读取期间发生变化：${path}`)
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
  } finally { await handle.close() }
}

export function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 不调用 Git 或扫描其他仓库；worktree 的 .git 文件同样是祖先边界。 */
export async function projectRoot(cwd: string): Promise<string | null> {
  const start = await realpath(cwd)
  const home = await realpath(homedir())
  let agent = resolve(process.env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'))
  try { agent = await realpath(agent) } catch (error) { if (!missing(error)) throw error }
  if (start === home || dirname(start) === start || inside(agent, start)) return null
  for (let current = start; ; current = dirname(current)) {
    if (current === home || dirname(current) === current) break
    try {
      const marker = await lstat(join(current, '.git'))
      if (marker.isDirectory() || marker.isFile()) return current
    } catch (error) { if (!missing(error)) throw error }
  }
  return start
}

/** 每个现存路径组件都核实 realpath；坏链接和权限错误不能被解释为没有知识库。 */
async function memoryDirectory(root: string, parts: string[] = []): Promise<string | null> {
  let current = root
  let base: string | undefined
  for (const [index, part] of ['.agents', 'memory', ...parts].entries()) {
    const candidate = join(current, part)
    try { await lstat(candidate) } catch (error) {
      if (missing(error)) return null
      throw error
    }
    current = await realpath(candidate)
    if (!inside(root, current) || (base !== undefined && !inside(base, current))) {
      throw new Error(`项目知识路径越出当前项目或记忆目录：${candidate}`)
    }
    if (index === 1) base = current
    if (!(await lstat(current)).isDirectory()) throw new Error(`项目知识路径不是目录：${candidate}`)
  }
  return current
}

async function memoryFile(root: string, name: string): Promise<string | null> {
  if (name !== 'INDEX.md' && !TOPIC.test(name)) throw new Error('仅允许 INDEX.md 或规范内的 topics 主题路径')
  const base = await memoryDirectory(root)
  if (base === null) return null
  const parts = name.split('/')
  const directory = await memoryDirectory(root, parts.slice(0, -1))
  if (directory === null) return null
  const target = join(directory, parts.at(-1)!)
  try { await lstat(target) } catch (error) {
    if (missing(error)) return null
    throw error
  }
  const path = await realpath(target)
  if (!inside(base, path)) throw new Error(`项目知识文件越出记忆目录：${name}`)
  return path
}

export interface ProjectPage {
  root: string
  path: string
  sha256: string
  offset: number
  next_offset: number | null
  has_more: boolean
  total_lines: number
  content: string
}

export async function readProject(root: string, name: string, offset = 0, limit = 100): Promise<ProjectPage> {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('项目原文 offset 必须非负，limit 必须为 1..200')
  }
  const path = await memoryFile(root, name)
  if (path === null) throw new Error(`项目知识文件不存在：${name}；未创建或修复`)
  const text = await readText(path)
  const lines = text.split('\n')
  const end = Math.min(offset + limit, lines.length)
  return { root, path: join(root, '.agents', 'memory', name), sha256: fingerprint(text), offset,
    next_offset: end < lines.length ? end : null, has_more: end < lines.length,
    total_lines: lines.length, content: lines.slice(offset, end).join('\n') }
}

/** 索引缺失时只列一层主题名，不读取全部正文，也不修复导航。 */
export async function listTopics(root: string): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = []
  for (const suffix of ['topics', 'topics/conventions', 'topics/gotchas']) {
    const directory = await memoryDirectory(root, suffix.split('/'))
    if (directory === null) continue
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${suffix}/${entry.name}`
      if ((entry.isFile() || entry.isSymbolicLink()) && TOPIC.test(name)) {
        // 只列安全、可定位的主题；坏链接不是不存在，直接报错。
        await memoryFile(root, name)
        paths.push(name)
        if (paths.length > 200) return { paths: paths.slice(0, 200), truncated: true }
      }
    }
  }
  return { paths, truncated: false }
}

export async function projectIndex(root: string | null): Promise<string> {
  if (root === null) return '当前目录未激活项目知识。'
  const path = await memoryFile(root, 'INDEX.md')
  if (path === null) {
    const topics = await listTopics(root)
    return topics.paths.length
      ? `项目索引缺失，未修复。可按需读取主题：\n${JSON.stringify(topics)}`
      : '当前项目无可读取索引或主题，未创建目录。'
  }
  const text = await readText(path)
  if (text.length > 12_000) return '项目索引超过自动注入预算，未截断条件；请用 memory_project_read 分页读取 INDEX.md。'
  return `来源：${join(root, '.agents', 'memory', 'INDEX.md')}\nsha256：${fingerprint(text)}\n${text}`
}
