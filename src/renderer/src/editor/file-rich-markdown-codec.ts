/** 文件富文本专用解析器与原文传输：每份文档独立注册扩展，不污染聊天和只读预览。部分机制移植自 ORCA，许可见 licenses/orca-MIT.txt。 */
import { Hooks, Lexer, Marked, Parser, Renderer, TextRenderer, Tokenizer, getDefaults } from 'marked'
import type { MarkedOptions, Token, Tokens, TokensList } from 'marked'
import { ORDERED_LIST_MARKER_PATTERN } from '@tiptap/extension-list'
import { MarkdownManager } from '@tiptap/markdown'
import { matchRichDetails } from './file-rich-markdown-details'

export interface RichMarkdownCodec {
  readonly marked: MarkdownManager['instance']
  readonly prefix: string
  envelope: (kind: 'inline' | 'block' | 'details', value: string) => string
  match: (source: string, kind: 'inline' | 'block' | 'details') => { raw: string; value: string } | null
  prepare: (source: string) => string
  prepareInline: (source: string) => string
}

const extendedItem = new RegExp(`^(\\s*(?:${ORDERED_LIST_MARKER_PATTERN})[.)])(\\s+)`)
function columns(text: string, start = 0): number {
  let column = start
  for (const character of text) column = character === '\t' ? column + 4 - column % 4 : column + 1
  return column
}
function listBeforeOuterQuote(source: string): string {
  const lines = source.split('\n')
  let indent = 0
  let outerQuote = /^>/
  for (const [index, line] of lines.entries()) {
    const item = extendedItem.exec(line)
    if (item && (index === 0 || columns(/^\s*/.exec(line)?.[0] ?? '') < indent)) {
      const markerEnd = columns(item[1] ?? '')
      const contentStart = columns(item[2] ?? '', markerEnd)
      indent = contentStart - markerEnd > 4 ? markerEnd + 1 : contentStart
      outerQuote = new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}>`)
    } else if (index > 0 && outerQuote.test(line)) return lines.slice(0, index).join('\n')
  }
  return source
}
function isListToken(token: Tokens.Generic | undefined | void): token is Tokens.List { return token?.type === 'list' && Array.isArray(token.items) }
class QuoteListTokenizer extends Tokenizer {
  override list(source: string): Tokens.List | undefined {
    const normal = super.list(source)
    if (normal || !extendedItem.test(source)) return normal
    for (const tokenize of this.options.extensions?.block ?? []) {
      const token = tokenize.call({ lexer: this.lexer }, listBeforeOuterQuote(source), [])
      if (isListToken(token)) return token
    }
    return undefined
  }
}

/** 私有注册表必须传进 Lexer 构造器；只替换 use() 不够，Tiptap 会自行 new Lexer。 */
function createMarkedFacade(): MarkdownManager['instance'] {
  const registry = new Marked()
  class RegistryLexer extends Lexer {
    constructor(options?: MarkedOptions) {
      // `extensions` 在 MarkedOptions 上是可选属性，exactOptionalPropertyTypes 下不能传显式 undefined。
      super({ ...registry.defaults, ...options, tokenizer: options?.tokenizer ?? registry.defaults.tokenizer ?? new QuoteListTokenizer(), extensions: registry.defaults.extensions ?? null })
    }
  }
  const upstream = new MarkdownManager({ extensions: [] }).instance
  const facade = new Proxy(upstream, {
    apply: (_target, _receiver, args: [string, MarkedOptions?]) => registry.parse(...args),
    get(target, property, receiver) {
      switch (property) {
        case 'defaults': return registry.defaults
        case 'getDefaults': return getDefaults
        case 'Lexer': return RegistryLexer
        case 'Parser': return Parser
        case 'Renderer': return Renderer
        case 'TextRenderer': return TextRenderer
        case 'Tokenizer': return Tokenizer
        case 'Hooks': return Hooks
        case 'parse': return facade
        case 'parseInline': return registry.parseInline.bind(registry)
        case 'parser': return registry.parser.bind(registry)
        case 'lexer': return (source: string, options?: MarkedOptions): TokensList => new RegistryLexer(options).lex(source)
        case 'walkTokens': return registry.walkTokens.bind(registry)
        case 'use': return (...extensions: Parameters<typeof registry.use>) => { registry.use(...extensions); return facade }
        case 'setOptions':
        case 'options': return (options: MarkedOptions) => { registry.setOptions(options); return facade }
        default: return Reflect.get(target, property, receiver)
      }
    }
  })
  return facade
}

/** 用本编辑器的随机键识别占位；文件中相似的普通文字不会被解码成原始内容。 */
export function createRichMarkdownCodec(): RichMarkdownCodec {
  const key = crypto.randomUUID().replaceAll('-', '')
  const prefix = `[[PI_RICH_MD:${key}:`
  const scanner = new Marked({ gfm: true })
  const envelope = (kind: 'inline' | 'block' | 'details', value: string): string => `${prefix}${kind}:${encodeURIComponent(value)}]]`
  const encodeInline = (raw: string, tokens: readonly Token[]): string => {
    const fragments: string[] = []
    const visit = (items: readonly Token[]): void => {
      for (const token of items) {
        if (token.type === 'html') fragments.push(token.raw)
        else if ('tokens' in token && Array.isArray(token.tokens)) visit(token.tokens)
      }
    }
    visit(tokens)
    let cursor = 0
    for (const fragment of fragments) {
      const index = raw.indexOf(fragment, cursor)
      if (index < 0) continue
      const encoded = envelope('inline', fragment)
      raw = raw.slice(0, index) + encoded + raw.slice(index + fragment.length)
      cursor = index + encoded.length
    }
    return raw
  }
  return {
    marked: createMarkedFacade(), prefix, envelope,
    match(source, kind) {
      const start = `${prefix}${kind}:`
      if (!source.startsWith(start)) return null
      const end = source.indexOf(']]', start.length)
      if (end < 0) return null
      try { return { raw: source.slice(0, end + 2), value: decodeURIComponent(source.slice(start.length, end)) } }
      catch { return null }
    },
    prepareInline(source) { return encodeInline(source, new Lexer(scanner.defaults).inlineTokens(source)) },
    prepare(source) {
      // Marked 会在空行处分开 details 的 HTML token；先按配对结构完整保留，再交给专用节点解析。
      let output = ''
      let scanOffset = 0
      let consumed = 0
      for (const token of scanner.lexer(source)) {
        const index = source.indexOf(token.raw, scanOffset)
        if (index < 0) continue
        scanOffset = index + token.raw.length
        if (index < consumed) continue
        output += source.slice(consumed, index)
        const details = token.type === 'html' ? matchRichDetails(source.slice(index)) : null
        if (details) {
          output += `${envelope('details', details.raw)}\n\n`
          consumed = index + details.raw.length
          continue
        }
        if (token.type === 'html') output += `${envelope('block', token.raw)}\n\n`
        else if (token.type === 'code') output += token.raw
        else output += 'tokens' in token && Array.isArray(token.tokens) ? encodeInline(token.raw, token.tokens) : token.raw
        consumed = scanOffset
      }
      return output + source.slice(consumed)
    }
  }
}

/** Front Matter 原样保留于正文外；这里只识别文件开头、有限行数内闭合且含键值的 YAML。 */
export function splitRichFrontmatter(source: string): { prefix: string; body: string } {
  if (!source.startsWith('---\n')) return { prefix: '', body: source }
  const lines = source.split('\n')
  for (let index = 1; index < Math.min(lines.length, 61); index += 1) {
    if (lines[index]?.trim() !== '---' && lines[index]?.trim() !== '...') continue
    if (!lines.slice(1, index).some(line => /^[\w.-]+\s*:/.test(line))) break
    const end = lines.slice(0, index + 1).join('\n').length + (index < lines.length - 1 ? 1 : 0)
    return { prefix: source.slice(0, end), body: source.slice(end) }
  }
  return { prefix: '', body: source }
}
