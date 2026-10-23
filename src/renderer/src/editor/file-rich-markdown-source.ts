/** 富文本 Markdown 的必要转义与原文差异回写：格式复用失败可退回规范输出，异常或语义不等价时拒绝同步。保真机制参考 ORCA，许可见 licenses/orca-MIT.txt。 */
import { applyPatches, cleanupEfficiency, cleanupSemantic, makeDiff, makePatches } from '@sanity/diff-match-patch'
import type { Editor, JSONContent } from '@tiptap/core'
import type { Node as DocumentNode } from '@tiptap/pm/model'
import type { RichMarkdownCodec } from './file-rich-markdown-codec'
import { serializationDocument } from './file-rich-markdown-nodes'
import { reconcileBlockSource } from './file-rich-markdown-block-source'

export interface RichSourceBaseline { original: string; canonical: string }
const LITERAL_BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'taskList'])

/** 比较语义时排除公式原始定界符与重复记录的 open 属性；折叠状态本身及真正的属性值仍参与比较。 */
export function equivalentRichDocuments(before: DocumentNode, after: DocumentNode): boolean {
  const normalize = (node: JSONContent): JSONContent => {
    const attrs = { ...node.attrs }
    if (node.type === 'inlineMath' || node.type === 'blockMath') attrs.original = ''
    if (typeof attrs.sourceAttributes === 'string') {
      // open 已由结构属性单独表达；整段匹配引号值，不能误删 data-* 值里的同名文字。
      attrs.sourceAttributes = attrs.sourceAttributes.replace(/(?:^|\s+)([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?/g, (attribute: string, name: string) => name.toLowerCase() === 'open' ? '' : attribute).trim()
    }
    return { ...node, attrs, ...(node.content ? { content: node.content.map(normalize) } : {}) }
  }
  try { return before.type.schema.nodeFromJSON(normalize(before.toJSON())).eq(after.type.schema.nodeFromJSON(normalize(after.toJSON()))) }
  catch { return false }
}

function repeatedDiffSeed(before: string, after: string): boolean {
  let start = 0
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start += 1
  let suffix = 0
  while (suffix < Math.min(before.length, after.length) - start && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix += 1
  const a = before.slice(start, before.length - suffix)
  const b = after.slice(start, after.length - suffix)
  const longer = a.length > b.length ? a : b
  const shorter = a.length > b.length ? b : a
  if (longer.length < 4 || shorter.length * 2 < longer.length) return false
  const length = Math.floor(longer.length / 4)
  return [Math.ceil(longer.length / 4), Math.ceil(longer.length / 2)].some(index => {
    const seed = longer.slice(index, index + length)
    const first = shorter.indexOf(seed)
    return first >= 0 && shorter.indexOf(seed, first + 1) >= 0
  })
}

/** 只移除经重新解析证明不影响节点、标记与属性的转义，不能无条件删除反斜杠。 */
export function installLiteralSerialization(editor: Editor, codec: RichMarkdownCodec): void {
  const manager = editor.markdown
  if (!manager) throw new Error('Markdown 扩展尚未初始化。')
  const render = manager.renderNodeToMarkdown.bind(manager)
  const cache = new WeakMap<DocumentNode, { markdown: string; result: string }>()
  let blocks: Map<JSONContent, DocumentNode> | undefined
  manager.renderNodeToMarkdown = (node, ...args) => {
    const markdown = render(node, ...args)
    const block = blocks?.get(node)
    if (!block || !/\\[_\[\]~`*]/.test(markdown) || markdown.length > 50_000) return markdown
    const cached = cache.get(block)
    if (cached?.markdown === markdown) return cached.result
    let result = markdown
    const candidates = [
      (text: string) => text.replace(/\\\\|(?<=[\p{L}\p{N}\p{M}])(?:\\_)+(?=[\p{L}\p{N}\p{M}])|\\[[\]]/gu, escaped => escaped === '\\\\' ? escaped : escaped.replaceAll('\\', '')),
      ...['~', '`', '*'].map(character => (text: string) => text.replace(/\\([\\_~`*])/g, (escaped: string, value: string) => value === character ? value : escaped))
    ]
    for (const unescape of candidates) {
      const candidate = unescape(result)
      if (candidate === result) continue
      try {
        const parsed = manager.parse(codec.prepare(candidate))
        const first = parsed.content?.[0]
        if (parsed.content?.length === 1 && first && equivalentRichDocuments(editor.schema.nodeFromJSON(first), block)) result = candidate
      } catch { /* 无法证明等价时保留原转义。 */ }
    }
    cache.set(block, { markdown, result })
    return result
  }
  editor.getMarkdown = () => {
    const document = serializationDocument(editor)
    const json: JSONContent = document.toJSON()
    const initial = manager.serialize(json)
    if (!/\\[_\[\]~`*]/.test(initial)) return initial
    blocks = new Map()
    json.content?.forEach((node, index) => { if (node.type && LITERAL_BLOCKS.has(node.type)) blocks?.set(node, document.child(index)) })
    try { return manager.serialize(json) } finally { blocks = undefined }
  }
}

/** diff 库应用补丁时按 UTF-8 解码起点；把 UTF-16 下标转换过去，避免中文与 emoji 错位。 */
function utf8Offsets(source: string, indices: number[]): Map<number, number> {
  const offsets = new Map<number, number>()
  let cursor = 0
  let bytes = 0
  for (const index of [...new Set(indices)].sort((a, b) => a - b)) {
    const end = Math.max(0, Math.min(index, source.length))
    while (cursor < end) {
      const point = source.codePointAt(cursor) ?? 0
      bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
      cursor += point > 0xffff ? 2 : 1
    }
    offsets.set(index, bytes)
  }
  return offsets
}

/** 同一编码链路的重新序列化是安全证明；任何无法定位或不等价的补丁都被放弃。 */
export function reconcileSource(original: string, canonical: string, edited: string, roundTrip: (source: string) => string | null): string {
  if (canonical === edited) return original
  const trailing = original.match(/\n+$/)?.[0] ?? ''
  if (trailing.length <= 1 && !edited.endsWith('\n') && original.replace(/\n+$/, '') === canonical.replace(/\n+$/, '')) return edited + trailing
  if (Math.max(original.length, canonical.length, edited.length) > 50_000) return edited
  // 重复长串会让模糊匹配退化，保真是尽力而为，不以阻塞输入换取格式保留。
  if (repeatedDiffSeed(canonical, edited)) return edited
  let diffs = makeDiff(canonical, edited, { checkLines: true, timeout: 0.01 })
  if (diffs.length > 2) diffs = cleanupEfficiency(cleanupSemantic(diffs))
  const patches = makePatches(canonical, diffs)
  const offsets = utf8Offsets(original, patches.flatMap(patch => [patch.start1, patch.start2]))
  for (const patch of patches) {
    patch.start1 = offsets.get(patch.start1) ?? 0
    patch.start2 = offsets.get(patch.start2) ?? 0
  }
  const [candidate, applied] = applyPatches(patches, original)
  return applied.every(Boolean) && roundTrip(candidate) === edited ? candidate : edited
}

/**
 * 生成可回写的全文，语义校验通过后原地更新 baseline；序列化结果未变时返回原文。
 * 发生编辑后尽量复用原格式，失败可使用规范 Markdown，不保证逐字节保真。
 * 处理异常或语义不等价时抛错，不推进基线，也不写磁盘。
 */
export function serializeRichSource(editor: Editor, codec: RichMarkdownCodec, baseline: RichSourceBaseline): string {
  const edited = editor.getMarkdown()
  const proofs = new Map<string, string | null>()
  const proveDocument = (source: string): string | null => {
    try {
      const parsed = editor.markdown?.parse(codec.prepare(source))
      if (!parsed) return null
      const doc = parsed.content?.length ? editor.schema.nodeFromJSON(parsed) : editor.schema.topNodeType.createAndFill()
      if (!doc) return null
      doc.check()
      return equivalentRichDocuments(doc, serializationDocument(editor)) ? edited : null
    } catch { return null }
  }
  const proof = (source: string): string | null => {
    if (proofs.has(source)) return proofs.get(source) ?? null
    const result = proveDocument(source)
    proofs.set(source, result)
    return result
  }
  let result = reconcileSource(baseline.original, baseline.canonical, edited, proof)
  if (result === edited && edited !== baseline.canonical) {
    result = reconcileBlockSource(editor, codec, baseline.original, edited, proof) ?? edited
  }
  if (proof(result) !== edited) throw new Error('当前结构无法安全写回 Markdown，输入仍保留在编辑面，未覆盖文件。')
  baseline.original = result
  baseline.canonical = edited
  return result
}
