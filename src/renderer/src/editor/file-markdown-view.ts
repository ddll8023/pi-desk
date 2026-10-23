/** Markdown 页面与渲染适配器的契约：页面拥有操作界面，适配器拥有编辑事务或只读 DOM。 */
import type { RichCommandId } from './file-rich-markdown-commands'
import type { RichMarkdownDraft } from './file-rich-markdown-draft'
import type { FileMarkdownTocEntry } from './file-markdown-dom'

export type MarkdownFailureStage = 'parse' | 'schema' | 'roundtrip' | 'serialize' | 'restore' | 'content' | 'sync'
export interface MarkdownFailure {
  readonly stage: MarkdownFailureStage
  readonly message: string
  readonly detail?: string
}

/** 提交受阻仍允许修正文档；只读降级则不再提供格式和替换能力。 */
export type MarkdownSurfaceState =
  | { readonly phase: 'initializing' }
  | { readonly phase: 'editable' }
  | { readonly phase: 'blocked'; readonly failure: MarkdownFailure }
  | { readonly phase: 'readonly'; readonly reason: string; readonly failure?: MarkdownFailure }

export interface MarkdownSearchQuery {
  readonly query: string
  readonly caseSensitive: boolean
  readonly wholeWord: boolean
}
export interface MarkdownSearchStatus {
  readonly total: number
  readonly active: number
  readonly truncated: boolean
}
export interface MarkdownFormatState {
  readonly enabled: boolean
  readonly active: readonly RichCommandId[]
}

export interface MarkdownReadingView {
  getRoot: () => HTMLElement | null
  getToc: () => readonly FileMarkdownTocEntry[]
  focus: () => void
  navigateTo: (id: string) => boolean
  setSearch: (query: MarkdownSearchQuery, reveal?: boolean) => MarkdownSearchStatus
  moveMatch: (step: number) => MarkdownSearchStatus
  clearSearch: () => void
  getSearchStatus: () => MarkdownSearchStatus
}

/** 文件会话只关心能否提交，不依赖具体编辑器或 Markdown 的内部状态。 */
export interface FileDocumentSurface {
  flushEdit: (force?: boolean) => boolean
  getText: (force?: boolean) => string | null
  getDraft: () => RichMarkdownDraft | null
}

export interface MarkdownEditingView extends MarkdownReadingView, FileDocumentSurface {
  getFormatState: () => MarkdownFormatState
  runCommand: (id: RichCommandId) => boolean
  replaceMatch: (replacement: string, all: boolean) => boolean
  focusEnd: () => void
}

export const EMPTY_MARKDOWN_SEARCH: MarkdownSearchQuery = { query: '', caseSensitive: false, wholeWord: false }
export const EMPTY_MARKDOWN_SEARCH_STATUS: MarkdownSearchStatus = { total: 0, active: 0, truncated: false }
