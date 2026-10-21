/** 按文档节点复用未修改块的原始 Markdown；移植 ORCA 的块级保真策略，许可见 licenses/orca-MIT.txt。 */
import type { Editor } from '@tiptap/core'
import type { Node as DocumentNode } from '@tiptap/pm/model'
import { extractAbsorbedBlankLines } from '@tiptap/markdown'
import { diffArrays } from 'diff'
import type { RichMarkdownCodec } from './file-rich-markdown-codec'
import { serializationDocument } from './file-rich-markdown-nodes'
import { reconcileSource } from './file-rich-markdown-source'

interface SourceBlock { node: DocumentNode; source: string; separator: string }
interface SourceDocument { leading: string; blocks: SourceBlock[] }

/** 每个暂定区间最终都要经过整篇解析证明，不能仅凭 token 数量猜测源码归属。 */
function readDocument(editor: Editor, codec: RichMarkdownCodec, source: string, expected?: DocumentNode): SourceDocument | null {
  const json = editor.markdown?.parse(codec.prepare(source))
  if (!json) return null
  const document = expected ?? editor.schema.nodeFromJSON(json)
  const tokens = extractAbsorbedBlankLines(codec.marked.lexer(codec.prepare(source)))
  // 原始内容传输会改变字面长度；这类文档保留字符级回写，不猜测传输标记的原文区间。
  if (tokens.map(token => token.raw).join('') !== source) return null
  const blocks: SourceBlock[] = []
  let leading = ''
  const lastContent = tokens.findLastIndex(token => token.type !== 'space')
  for (const [tokenIndex, token] of tokens.entries()) {
    const raw = token.raw
    if (typeof raw !== 'string') return null
    if (token.type === 'space') {
      const pieces: string[] = []
      let offset = 0
      for (const match of raw.matchAll(/\n\n/g)) { pieces.push(raw.slice(offset, match.index + 2)); offset = match.index + 2 }
      const remainder = raw.slice(offset)
      const previous = blocks.at(-1)
      if (!pieces.length) {
        if (previous) previous.separator += remainder
        else leading += remainder
        continue
      }
      if (previous) previous.separator += pieces.shift() ?? ''
      const paragraph = editor.schema.nodes.paragraph
      if (!paragraph) return null
      for (const separator of pieces) blocks.push({ node: paragraph.create(), source: '', separator })
      if (previous && tokenIndex > lastContent) blocks.push({ node: paragraph.create(), source: '', separator: remainder })
      else {
        const last = blocks.at(-1)
        if (last) last.separator += remainder
        else leading += remainder
      }
      continue
    }
    if (blocks.length >= document.childCount) return null
    const text = raw.replace(/\n+$/, '')
    blocks.push({ node: document.child(blocks.length), source: text, separator: raw.slice(text.length) })
  }
  if (document.childCount !== blocks.length) return null
  return { leading, blocks }
}

export function reconcileBlockSource(editor: Editor, codec: RichMarkdownCodec, original: string, edited: string, proof: (source: string) => string | null): string | null {
  try {
    const before = readDocument(editor, codec, original)
    const after = readDocument(editor, codec, edited, serializationDocument(editor))
    if (!before || !after) return null
    const changes = diffArrays(before.blocks, after.blocks, { comparator: (a, b) => a.node.eq(b.node), maxEditLength: 256 })
    if (!changes) return null
    const blocks: SourceBlock[] = []
    let originalIndex = 0
    let removed: SourceBlock[] = []
    for (const change of changes) {
      if (change.added) {
        for (const [index, block] of change.value.entries()) {
          const previous = removed.length === change.count ? removed[index] : undefined
          let source = block.source
          if (previous) {
            const canonical = editor.markdown?.serialize(editor.markdown.parse(codec.prepare(previous.source)))
            if (canonical !== undefined) {
              const blockProof = (candidate: string): string | null => {
                const parsed = editor.markdown?.parse(codec.prepare(candidate))
                const first = parsed?.content?.[0]
                return first && parsed?.content?.length === 1 && editor.schema.nodeFromJSON(first).eq(block.node) ? block.source : null
              }
              source = reconcileSource(previous.source, canonical, block.source, blockProof)
            }
          }
          blocks.push({ ...block, source, separator: previous?.separator ?? block.separator })
        }
        removed = []
      } else if (change.removed) {
        removed = before.blocks.slice(originalIndex, originalIndex + change.count)
        originalIndex += change.count
      } else {
        removed = []
        blocks.push(...before.blocks.slice(originalIndex, originalIndex + change.count))
        originalIndex += change.count
      }
    }
    for (let index = 0; index < blocks.length - 1; index += 1) {
      const block = blocks[index]
      if (block && !block.separator) blocks[index] = { ...block, separator: '\n\n' }
    }
    const assemble = (): string => before.leading + blocks.map(block => block.source + block.separator).join('')
    let candidate = assemble()
    if (proof(candidate) === edited) return candidate
    const indices = new Map(before.blocks.map((block, index) => [block, index]))
    for (let index = 0; index < blocks.length - 1; index += 1) {
      const block = blocks[index]
      const next = blocks[index + 1]
      if (!block || !next) continue
      const originalPosition = indices.get(block)
      if (!(originalPosition !== undefined && indices.get(next) === originalPosition + 1) && !block.separator.includes('\n\n')) blocks[index] = { ...block, separator: '\n\n' }
    }
    candidate = assemble()
    return proof(candidate) === edited ? candidate : null
  } catch { return null }
}
