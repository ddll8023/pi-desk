/** Markdown 图片导入：只读明确选中的外部图片或粘贴快照，生成同目录新资源，不覆盖任何既有文件。 */
import { constants } from 'node:fs'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import type { ProjectMarkdownImageRequest, ProjectMarkdownImageResult } from '../../shared/project-file-api'
import { PROJECT_FILE_IMAGE_MAX_BYTES } from '../../shared/project-file-api'
import { isInsideRoot, resolveProjectEntryAbsolute } from './project-entry-path'

/** 只识别无脚本的位图容器；SVG 与页面声明的 MIME 均不能授权图片写入。 */
function imageExtension(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return '.jpg'
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return '.gif'
  if (bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP') return '.webp'
  if (bytes[0] === 66 && bytes[1] === 77) return '.bmp'
  if (bytes.subarray(0,4).equals(Buffer.from([0,0,1,0]))) return '.ico'
  if (bytes.subarray(4,8).toString('ascii') === 'ftyp' && /avif|avis/.test(bytes.subarray(8,32).toString('ascii'))) return '.avif'
  return null
}

export class ProjectMarkdownAssets {
  constructor(private readonly resolveProject: (path: string) => Promise<string | null>) {}

  /** 路径逐层 lstat，禁止借助项目内符号链接将导入位置移到另一处。 */
  private async document(root: string, path: string): Promise<string> {
    if (!/\.(md|markdown)$/i.test(path)) throw new Error('图片只能导入 Markdown 文件的同级目录。')
    const resolved = await resolveProjectEntryAbsolute(root, path)
    if (!resolved.ok) throw new Error(resolved.error.message)
    let current = root
    for (const part of resolved.relativePath.split('/')) {
      current = join(current, part)
      if ((await lstat(current)).isSymbolicLink()) throw new Error('图片导入不支持符号链接路径。')
    }
    if (!(await lstat(resolved.absolutePath)).isFile()) throw new Error('目标 Markdown 文件不存在。')
    return resolved.absolutePath
  }

  async import(request: ProjectMarkdownImageRequest, owner: BrowserWindow | null): Promise<ProjectMarkdownImageResult> {
    try {
      const registered = await this.resolveProject(request.projectPath)
      if (!registered) throw new Error('所属项目已移除，未导入图片。')
      const root = await realpath(registered)
      const document = await this.document(root, request.path)
      let bytes: Buffer
      let stem = 'image'
      if (request.source === 'pick') {
        const options = { title: '插入图片', properties: ['openFile'] as ('openFile')[], filters: [{ name: '图片', extensions: ['png','jpg','jpeg','gif','webp','bmp','ico','avif'] }] }
        const chosen = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
        const selected = chosen.filePaths[0]
        if (chosen.canceled || !selected) return { ok: true, data: { projectPath: registered, path: null, reference: null } }
        const handle = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size > PROJECT_FILE_IMAGE_MAX_BYTES) throw new Error('图片不是普通文件或超过导入上限。')
          bytes = Buffer.alloc(stat.size + 1)
          let offset = 0
          while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
            if (!bytesRead) break
            offset += bytesRead
          }
          bytes = bytes.subarray(0, offset)
        } finally { await handle.close() }
        stem = basename(selected, extname(selected)).replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 64) || 'image'
      } else bytes = Buffer.from(request.bytes)
      if (!bytes.length || bytes.length > PROJECT_FILE_IMAGE_MAX_BYTES) throw new Error('图片为空或超过导入上限。')
      const extension = imageExtension(bytes)
      if (!extension) throw new Error('图片格式不受支持；不允许导入 SVG 或非图片内容。')
      if (!(await this.resolveProject(registered))) throw new Error('所属项目已移除，未导入图片。')
      await this.document(root, request.path)
      const parent = dirname(document)
      if (!isInsideRoot(root, await realpath(parent))) throw new Error('导入目录已越界。')
      const name = `${stem}-${randomUUID().slice(0, 12)}${extension}`
      const destination = join(parent, name)
      const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      let complete = false
      try { await handle.writeFile(bytes); await handle.sync(); complete = true }
      finally { await handle.close(); if (!complete) await unlink(destination).catch(() => {}) }
      return { ok: true, data: { projectPath: registered, path: relative(root, destination).split(sep).join('/'), reference: encodeURIComponent(name) } }
    } catch (error) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : String(error) } }
    }
  }
}
