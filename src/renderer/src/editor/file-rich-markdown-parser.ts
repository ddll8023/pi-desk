/** 文件 Markdown 的唯一结构转换边界：预处理、schema 规范化与完整检查都先于编辑状态接管。 */
import { commands } from '@tiptap/core'
import type { CommandProps, Editor, JSONContent } from '@tiptap/core'
import { Mark } from '@tiptap/pm/model'
import type { Fragment, Node as DocumentNode, Schema } from '@tiptap/pm/model'
import { Markdown } from '@tiptap/markdown'
import { Marked } from 'marked'
import type { Token } from 'marked'
import { canPreviewFileMarkdown } from './file-markdown'
import { splitRichFrontmatter } from './file-rich-markdown-codec'
import type { RichMarkdownCodec } from './file-rich-markdown-codec'
import type { MarkdownFailure, MarkdownFailureStage } from './file-markdown-view'

const scanner = new Marked({ gfm: true })
const MESSAGES: Record<MarkdownFailureStage, string> = {
  parse: 'Markdown 暂时无法安全解析。',
  schema: '文档结构不符合当前编辑器的格式规则。',
  roundtrip: '此文档暂时无法无损往返 Markdown。',
  serialize: '当前结构无法安全写回 Markdown，输入仍保留在编辑面，未覆盖文件。',
  restore: '结构草稿暂时无法恢复，原有草稿仍被保留。',
  content: '本次内容无法安全插入，原有文档未被替换。',
  sync: '当前输入尚未同步，未用外部内容覆盖。'
}

export class RichMarkdownError extends Error {
  constructor(readonly failure: MarkdownFailure, cause?: unknown) {
    super(failure.message, { cause })
    this.name = 'RichMarkdownError'
  }
}

/** 仅保留原因类别及结构类型名；不展示节点片段、实际属性值或原始解析异常。 */
export function markdownFailure(cause: unknown, stage: MarkdownFailureStage): MarkdownFailure {
  if (cause instanceof RichMarkdownError) return cause.failure
  const nested = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause
  const patterns = [
    /^Unknown node type: [\w-]+/,
    /^There is no mark type [\w-]+ in this schema$/,
    /^Invalid content for node [\w-]+/,
    /^Invalid input for (?:Fragment|Mark|Slice|Node)\.fromJSON$/,
    /^Invalid mark data for Node\.fromJSON$/,
    /^Invalid text node in JSON$/,
    /^Empty text nodes are not allowed$/,
    /^Invalid collection of marks for node [\w-]+(?:: [\w, -]+)?$/,
    /^Unsupported attribute [\w-]+ for [\w-]+ of type [\w-]+/,
    /^No value supplied for attribute [\w-]+/,
    /^Expected value of type [\w| ]+ for attribute [\w-]+ on type [\w-]+/
  ]
  if (nested instanceof Error) {
    for (const pattern of patterns) {
      const match = pattern.exec(nested.message)
      if (match) return { stage, message: MESSAGES[stage], detail: match[0] }
    }
    const name = ['Error', 'RangeError', 'TypeError', 'SyntaxError'].includes(nested.name) ? nested.name : 'Error'
    return { stage, message: MESSAGES[stage], detail: `原因类型：${name}` }
  }
  return { stage, message: MESSAGES[stage] }
}

export function markdownFailureText(failure: MarkdownFailure): string {
  return failure.detail ? `${failure.message}（${failure.detail}）` : failure.message
}

/** 源码归属不明确的语法保留只读排版；此判定也用于粘贴及回写证明，不能只放在页面入口。 */
export function richMarkdownUnsupportedReason(source: string): string | null {
  if (!canPreviewFileMarkdown(source)) return '文档较大，已使用源码视图。'
  let issue: string | null = null
  const visit = (tokens: readonly Token[], nested: boolean): void => {
    for (const token of tokens) {
      if (token.type === 'code' || token.type === 'codespan') continue
      if (token.type === 'def') issue = '文档含引用式链接或脚注，请在源码中编辑；此处保留只读排版。'
      if (token.type === 'html' && nested) issue = '嵌套结构含原始 HTML，请在源码中编辑；此处保留只读排版，避免丢失内容。'
      if (token.type === 'html' && /^\s*<details\b/i.test(token.raw) && /^\s*\[(?:\^)?[^\]]+\]:\s/m.test(token.raw)) issue = '折叠块含引用定义，请在源码中编辑；此处保留只读排版。'
      if ('tokens' in token && Array.isArray(token.tokens)) visit(token.tokens, nested || token.type === 'blockquote')
      if (token.type === 'list') for (const item of token.items) visit(item.tokens, true)
    }
  }
  try { visit(scanner.lexer(splitRichFrontmatter(source).body), false) }
  catch { return '文档暂时无法安全解析，请在源码中编辑。' }
  return issue
}

function checkAttributes(attrs: Record<string, unknown> | undefined, declared: object | undefined, kind: string, name: string): void {
  if (!attrs) return
  for (const key of Object.keys(attrs)) {
    if (!declared || !Object.prototype.hasOwnProperty.call(declared, key)) {
      // 属性名也可能来自外部输入，错误只报告已注册的结构类型。
      throw new RichMarkdownError({ stage: 'schema', message: MESSAGES.schema, detail: `${kind} ${name} 含未声明的属性` })
    }
  }
}

/** addToSet 只用于求规范集合；一旦它删除非重复信息就拒绝转换，而非以丢格式换取合法文档。 */
function normalizeJSON(node: JSONContent, schema: Schema): JSONContent {
  const type = node.type ? schema.nodes[node.type] : undefined
  if (!type) throw new RichMarkdownError({ stage: 'schema', message: MESSAGES.schema, detail: '包含未注册的节点类型' })
  checkAttributes(node.attrs, type.spec.attrs, '节点', type.name)
  if (node.content !== undefined && !Array.isArray(node.content)) throw new RangeError('Invalid input for Fragment.fromJSON')
  if (node.marks !== undefined && !Array.isArray(node.marks)) throw new RangeError('Invalid mark data for Node.fromJSON')
  const unique: Mark[] = []
  for (const json of node.marks ?? []) {
    const markType = schema.marks[json.type]
    if (!markType) throw new RichMarkdownError({ stage: 'schema', message: MESSAGES.schema, detail: '包含未注册的标记类型' })
    checkAttributes(json.attrs, markType.spec.attrs, '标记', markType.name)
    const mark = schema.markFromJSON(json)
    if (!unique.some(previous => previous.eq(mark))) unique.push(mark)
  }
  const marks = unique.reduce<readonly Mark[]>((set, mark) => mark.addToSet(set), Mark.none)
  if (marks.length !== unique.length || !unique.every(mark => marks.some(candidate => candidate.eq(mark)))) {
    throw new RichMarkdownError({ stage: 'schema', message: MESSAGES.schema, detail: `互斥或属性冲突的标记：${[...new Set(unique.map(mark => mark.type.name))].join(', ')}` })
  }
  return {
    ...node,
    ...(node.marks !== undefined ? { marks: marks.map(mark => mark.toJSON()) } : {}),
    ...(node.content !== undefined ? { content: node.content.map(child => normalizeJSON(child, schema)) } : {})
  }
}

/**
 * 将 Markdown 正文或插入片段转换为经 schema 规范化及完整检查的文档，不安装到编辑实例。
 * 整篇文件的 Front Matter 由会话预先分离；此入口不负责元信息保留或序列化往返证明。
 * 不支持的语法、解析或结构检查失败时抛出 RichMarkdownError，现有编辑状态不变。
 */
export function parseRichMarkdown(editor: Pick<Editor, 'schema' | 'markdown'>, codec: RichMarkdownCodec, source: string): DocumentNode {
  const issue = richMarkdownUnsupportedReason(source)
  if (issue) throw new RichMarkdownError({ stage: 'parse', message: issue })
  if (!editor.markdown) throw new RichMarkdownError({ stage: 'parse', message: 'Markdown 解析器尚未就绪。' })
  let json: JSONContent
  try { json = editor.markdown.parse(codec.prepare(source)) }
  catch (cause) { throw new RichMarkdownError(markdownFailure(cause, 'parse'), cause) }
  try {
    if (json.type !== editor.schema.topNodeType.name) throw new RangeError('Invalid input for Node.fromJSON')
    const normalized = normalizeJSON(json, editor.schema)
    const doc = normalized.content?.length ? editor.schema.nodeFromJSON(normalized) : editor.schema.topNodeType.createAndFill()
    if (!doc) throw new RichMarkdownError({ stage: 'schema', message: '无法建立合法的空文档。' })
    doc.check()
    return doc
  } catch (cause) { throw new RichMarkdownError(markdownFailure(cause, 'schema'), cause) }
}

/** 单段 Markdown 按行内片段插入，多块内容保留块边界；剪贴板与 Markdown 命令共用这一语义。 */
export function richMarkdownFragment(document: DocumentNode): Fragment {
  const first = document.firstChild
  return document.childCount === 1 && first?.type.name === 'paragraph' ? first.content : document.content
}

/** 父扩展只负责初始化 manager；整篇初始输入由会话显式装载，命令中的 Markdown 也必须经过同一边界。 */
export function createRichMarkdownExtension(codec: RichMarkdownCodec, onFailure: (failure: MarkdownFailure) => void) {
  return Markdown.extend({
    addCommands() {
      const convert = (content: unknown): DocumentNode => {
        if (typeof content !== 'string') throw new RichMarkdownError({ stage: 'content', message: 'Markdown 输入必须是文本。' })
        return parseRichMarkdown(this.editor, codec, content)
      }
      const reject = (cause: unknown, props: CommandProps): false => {
        if (props.dispatch) onFailure(markdownFailure(cause, 'content'))
        return false
      }
      return {
        setContent: (content, options) => props => {
          if (options?.contentType !== 'markdown') return commands.setContent(content, options)(props)
          try { return commands.setContent(convert(content).toJSON(), { ...options, contentType: 'json', errorOnInvalidContent: true })(props) }
          catch (cause) { return reject(cause, props) }
        },
        insertContent: (content, options) => props => {
          if (options?.contentType !== 'markdown') return commands.insertContent(content, options)(props)
          try {
            const fragment = richMarkdownFragment(convert(content))
            return commands.insertContent(fragment, { ...options, contentType: 'json' })(props)
          } catch (cause) { return reject(cause, props) }
        },
        insertContentAt: (position, content, options) => props => {
          if (options?.contentType !== 'markdown') return commands.insertContentAt(position, content, options)(props)
          try {
            const fragment = richMarkdownFragment(convert(content))
            return commands.insertContentAt(position, fragment, { ...options, contentType: 'json', errorOnInvalidContent: true })(props)
          } catch (cause) { return reject(cause, props) }
        }
      }
    }
  }).configure({ marked: codec.marked, markedOptions: { gfm: true } })
}
