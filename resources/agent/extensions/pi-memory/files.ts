/** 全局记忆的有界文件读取与指纹工具；不定位项目根或读取工作目录中的知识文件。 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

const MAX_FILE_BYTES = 1_048_576

export function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/** 限制读取量，不跟随尾级符号链接；文件变化时不使用混合版本。 */
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
