/** 富文本文档会话：先准备并证明候选，再接管编辑状态；提交受阻时保留结构草稿而非退回旧文本。 */
import { ref } from 'vue'
import type { Editor } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import type { Node as DocumentNode } from '@tiptap/pm/model'
import { splitRichFrontmatter } from './file-rich-markdown-codec'
import type { RichMarkdownCodec } from './file-rich-markdown-codec'
import { captureRichDraft, prepareRichDraft, replaceRichEditorState, restoreRichDraft } from './file-rich-markdown-draft'
import type { RichMarkdownDraft } from './file-rich-markdown-draft'
import { equivalentRichDocuments, installLiteralSerialization, serializeRichDocument, serializeRichSource } from './file-rich-markdown-source'
import type { RichSourceBaseline } from './file-rich-markdown-source'
import { markdownFailure, markdownFailureText, parseRichMarkdown, RichMarkdownError } from './file-rich-markdown-parser'
import type { MarkdownFailure, MarkdownFailureStage, MarkdownSurfaceState } from './file-markdown-view'

interface RichSessionOptions {
  readonly text: string
  readonly codec: RichMarkdownCodec
  readonly recovery: RichMarkdownDraft | null
  readonly onText: (text: string) => void
  readonly onPending: (pending: boolean) => void
  readonly onDraft: (draft: RichMarkdownDraft | null) => void
  readonly onState: (state: MarkdownSurfaceState) => void
  readonly onOperationError: (message: string) => void
  readonly onReplace: () => void
}
interface PreparedDocument {
  readonly body: string
  readonly prefix: string
  readonly doc: DocumentNode
  readonly canonical: string
}

/** 刷新尚未转换成事务的 DOM 输入；force 只影响组合输入等待，不放宽文档证明。 */
function flushDomInput(editor: Editor): void {
  const view: unknown = editor.view
  if (!view || typeof view !== 'object' || !('domObserver' in view)) return
  const observer = view.domObserver
  if (observer && typeof observer === 'object' && 'flush' in observer && typeof observer.flush === 'function') observer.flush()
}

export function createRichMarkdownSession(options: RichSessionOptions) {
  const initial = splitRichFrontmatter(options.text)
  const frontmatter = ref(initial.prefix)
  const baseline: RichSourceBaseline = { original: initial.body, canonical: '' }
  let current: Editor | null = null
  let lastText = options.text
  let pending = false
  let initialized = false
  let applying = true
  let disposed = false
  let timer: number | null = null

  function clearTimer(): void {
    if (timer !== null) window.clearTimeout(timer)
    timer = null
  }
  function snapshot(): RichMarkdownDraft | null {
    return current && initialized && pending ? captureRichDraft(current, lastText, frontmatter.value, baseline) : null
  }
  function fail(cause: unknown, stage: MarkdownFailureStage): void {
    const failure = markdownFailure(cause, stage)
    if (pending) {
      options.onDraft(snapshot())
      options.onState({ phase: 'blocked', failure })
    } else {
      current?.setEditable(false, false)
      options.onState({ phase: 'readonly', reason: markdownFailureText(failure), failure })
    }
  }
  function prepare(text: string): PreparedDocument {
    if (!current) throw new Error('Markdown 解析器尚未就绪。')
    const parts = splitRichFrontmatter(text)
    const doc = parseRichMarkdown(current, options.codec, parts.body)
    try {
      const canonical = serializeRichDocument(current, doc)
      const roundtrip = parseRichMarkdown(current, options.codec, canonical)
      if (!equivalentRichDocuments(doc, roundtrip)) throw new Error('Markdown 语义不等价。')
      return { ...parts, doc, canonical }
    } catch (cause) { throw new RichMarkdownError(markdownFailure(cause, 'roundtrip'), cause) }
  }

  /** 初始化或真正的外部替换才重建历史；用户自身的文本回声不重新装载。 */
  function initialize(editor: Editor): boolean {
    current = editor
    try {
      installLiteralSerialization(editor, options.codec)
      const prepared = prepare(lastText)
      const recovery = options.recovery?.text === lastText ? options.recovery : null
      if (options.recovery && !recovery) throw new RichMarkdownError({ stage: 'restore', message: '结构草稿与当前源文不匹配，未覆盖已有草稿。' })
      const restored = recovery ? prepareRichDraft(editor, recovery) : null
      const next = restored ?? EditorState.create({ schema: editor.schema, doc: prepared.doc, plugins: editor.state.plugins })
      // 在接管实例前准备所有可能失败的内容；恢复草稿允许随后处于提交受阻态。
      const nextBaseline = recovery ? { ...recovery.baseline } : { original: prepared.body, canonical: prepared.canonical }
      const nextPrefix = recovery?.frontmatter ?? prepared.prefix
      if (recovery && recovery.frontmatter + recovery.baseline.original !== recovery.text) {
        throw new RichMarkdownError({ stage: 'restore', message: '结构草稿的原文基线不一致，未覆盖已有草稿。' })
      }
      if (recovery) restoreRichDraft(editor, recovery, next)
      else replaceRichEditorState(editor, next)
      Object.assign(baseline, nextBaseline)
      frontmatter.value = nextPrefix
      initialized = true
      pending = recovery !== null
      applying = false
      editor.setEditable(true, false)
      options.onReplace()
      options.onState({ phase: 'editable' })
      if (pending) { options.onPending(true); options.onDraft(snapshot()); scheduleCommit() }
      return true
    } catch (cause) { fail(cause, options.recovery ? 'restore' : 'schema'); return false }
    finally { applying = false }
  }

  function syncText(text: string): boolean {
    if (text === lastText) return true
    if (!current || current.isDestroyed || !initialized || disposed) return false
    if (pending) {
      fail(new RichMarkdownError({ stage: 'sync', message: '当前输入尚未同步，未用外部内容覆盖。' }), 'sync')
      return false
    }
    try {
      const prepared = prepare(text)
      const next = EditorState.create({ schema: current.schema, doc: prepared.doc, plugins: current.state.plugins })
      applying = true
      clearTimer()
      replaceRichEditorState(current, next)
      baseline.original = prepared.body
      baseline.canonical = prepared.canonical
      frontmatter.value = prepared.prefix
      lastText = text
      options.onReplace()
      options.onState({ phase: 'editable' })
      return true
    } catch (cause) { fail(cause, 'schema'); return false }
    finally { applying = false }
  }

  function flushEdit(force = false): boolean {
    if (!current || current.isDestroyed || !initialized || disposed) return false
    flushDomInput(current)
    clearTimer()
    if (!pending) return true
    options.onDraft(snapshot())
    if (current.view.composing && !force) return false
    try {
      const text = frontmatter.value + serializeRichSource(current, options.codec, baseline)
      lastText = text
      pending = false
      options.onDraft(null)
      options.onText(text)
      options.onPending(false)
      options.onState({ phase: 'editable' })
      return true
    } catch (cause) { fail(cause, 'serialize'); return false }
  }
  function scheduleCommit(): void {
    clearTimer()
    if (!disposed) timer = window.setTimeout(() => { timer = null; flushEdit() }, 300)
  }
  function changed(): boolean {
    if (applying || !initialized || disposed) return false
    pending = true
    options.onPending(true)
    scheduleCommit()
    return true
  }
  function operationFailure(failure: MarkdownFailure): void { options.onOperationError(markdownFailureText(failure)) }
  function contentError(cause: unknown): void {
    if (!current || !initialized) { fail(cause, 'schema'); return }
    try { current.state.doc.check() }
    catch (invalid) {
      pending = true
      options.onPending(true)
      fail(invalid, 'schema')
      return
    }
    // 被拒绝的插入并不意味着现有文档失效，不能因此销毁仍有未提交输入的编辑面。
    operationFailure(markdownFailure(cause, 'content'))
  }
  function dispose(): void {
    if (disposed) return
    flushEdit(true)
    clearTimer()
    disposed = true
    current = null
  }
  return {
    frontmatter, initialize, syncText, changed, flushEdit, scheduleCommit,
    getText: (force = false): string | null => flushEdit(force) ? lastText : null,
    getDraft: snapshot, operationFailure, contentError, fail, dispose
  }
}
