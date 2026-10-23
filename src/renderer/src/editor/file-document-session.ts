/** 文件工作台会话：协调源码与排版编辑面的提交和切换；Store 维护已接受文本及恢复草稿，编辑实例保留未提交输入。 */
import { computed, ref, shallowRef } from 'vue'
import type { FileEditorMode, useProjectEditorStore } from './stores/project-editor'
import type { RichMarkdownDraft } from './file-rich-markdown-draft'
import type { FileDocumentSurface, MarkdownSurfaceState } from './file-markdown-view'

interface SourceSurface {
  getText: () => string
  applyText: (text: string) => boolean
}
interface FileDocumentSessionOptions {
  readonly store: ReturnType<typeof useProjectEditorStore>
  readonly key: () => string
  readonly mode: () => FileEditorMode
  readonly editable: () => boolean
  readonly source: () => SourceSurface | null
  readonly markdown: () => FileDocumentSurface | null
}

export function useFileDocumentSession(options: FileDocumentSessionOptions) {
  const record = computed(() => options.store.recordOf(options.key()))
  const text = computed(() => {
    const file = record.value
    const disk = file?.load.phase === 'ready' && file.load.content.kind === 'text' ? file.load.content.text : ''
    return file?.draft ?? file?.richDraft?.text ?? disk
  })
  const previewState = shallowRef<MarkdownSurfaceState>({ phase: 'initializing' })
  const blockedAction = ref('')
  let applyingRichText = false
  let changingMode = false
  const sourceBlocked = computed(() => options.mode() === 'code' && record.value?.richDraft != null)

  function onSourceChange(): void {
    if (!options.editable() || applyingRichText || sourceBlocked.value) return
    const source = options.source()
    if (!source) return
    options.store.markDirty(options.key())
    options.store.captureDraft(options.key(), source.getText())
    blockedAction.value = ''
  }
  function onRichText(value: string): void {
    // 已证明的源文先进入唯一事实源；隐藏的源码镜像不能让一次成功提交丢失。
    options.store.captureDraft(options.key(), value)
    applyingRichText = true
    try { options.source()?.applyText(value) }
    catch { /* 镜像暂不可用时由 modelValue 同步最新源文，不回滚已经接受的草稿。 */ }
    finally { applyingRichText = false }
    blockedAction.value = ''
  }
  function onRichDraft(value: RichMarkdownDraft | null): void { options.store.captureRichDraft(options.key(), value) }
  function onPending(pending: boolean): void {
    if (pending && options.editable()) options.store.markDirty(options.key())
  }
  function flushPreview(force = false): boolean {
    const preview = options.markdown()
    const flushed = preview ? preview.flushEdit(force) : record.value?.richDraft == null
    if (!flushed) blockedAction.value = previewState.value.phase === 'initializing'
      ? '文档仍在准备，暂未执行保存或视图切换。'
      : '当前输入尚未安全同步，未执行保存或视图切换；结构草稿仍被保留。'
    else blockedAction.value = ''
    return flushed
  }
  function currentText(force = false): string | null {
    if (options.mode() === 'preview') {
      const preview = options.markdown()
      return preview ? preview.getText(force) : record.value?.richDraft ? null : text.value
    }
    // 只读降级不能把尚未恢复的结构草稿当作已提交原文，进而清除草稿及脏状态。
    if (record.value?.richDraft) return null
    return options.source()?.getText() ?? text.value
  }
  function captureCurrentDraft(force = false): boolean {
    const value = currentText(force)
    if (value === null) return false
    options.store.captureDraft(options.key(), value)
    return true
  }
  function publishMode(next: FileEditorMode): void {
    changingMode = true
    try { options.store.setMode(options.key(), next) }
    finally { changingMode = false }
  }
  function canOpenRecovery(next: FileEditorMode): boolean {
    return next === 'preview' && record.value?.richDraft != null && options.markdown() === null
  }
  function setMode(next: FileEditorMode): boolean {
    if (next === options.mode()) return true
    if (!canOpenRecovery(next) && (!flushPreview() || !captureCurrentDraft())) return false
    blockedAction.value = ''
    publishMode(next)
    return true
  }
  /** 文档链接也会经 Store 请求切换；与页面按钮共用提交门禁，失败时恢复原选择。 */
  function onModeRequested(next: FileEditorMode, previous: FileEditorMode): void {
    if (changingMode || next === previous || canOpenRecovery(next)) return
    if (!flushPreview()) publishMode(previous)
  }
  async function save(force = false): Promise<boolean | null> {
    if (!options.editable() || !flushPreview()) return null
    const file = record.value
    if (!file || !file.dirty || file.saving) return null
    const value = currentText()
    if (value === null) return null
    const saved = await options.store.save(options.key(), value, force)
    captureCurrentDraft()
    return saved
  }
  function onPreviewState(state: MarkdownSurfaceState): void {
    previewState.value = state
    if (state.phase === 'editable' || (state.phase === 'readonly' && !record.value?.richDraft)) blockedAction.value = ''
  }
  return {
    record, text, previewState, blockedAction, sourceBlocked,
    onSourceChange, onRichText, onRichDraft, onPending,
    onPreviewState,
    flushPreview, currentText, captureCurrentDraft, setMode, onModeRequested, save
  }
}
