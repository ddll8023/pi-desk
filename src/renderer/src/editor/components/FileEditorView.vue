<!-- 文件工作台外壳：紧凑展示文件身份、保存与编辑能力，文档会话负责源码和排版视图的提交与切换。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PROJECT_FILE_EDIT_MAX_BYTES } from '../../../../shared/project-file-api'
import type { ProjectFileTextContent } from '../../../../shared/project-file-api'
import { copyText } from '../../ui/clipboard'
import { canPreviewFileMarkdown } from '../file-markdown'
import { useFileDocumentSession } from '../file-document-session'
import type { FileEditorMode } from '../stores/project-editor'
import { useProjectEditorStore } from '../stores/project-editor'
import AppButton from '../../ui/AppButton.vue'
import CodeMirrorEditor from './CodeMirrorEditor.vue'
import ConfirmDialog from '../../ui/ConfirmDialog.vue'
import FileMarkdownView from './FileMarkdownView.vue'

const props = defineProps<{ readonly tabKey: string; readonly active: boolean }>()
const editorStore = useProjectEditorStore()
const editorRef = ref<InstanceType<typeof CodeMirrorEditor> | null>(null)
const previewRef = ref<InstanceType<typeof FileMarkdownView> | null>(null)
const session = useFileDocumentSession({
  store: editorStore, key: () => props.tabKey, mode: () => mode.value, editable: () => editable.value,
  source: () => editorRef.value, markdown: () => previewRef.value
})
const { record, text: documentText, previewState, blockedAction, sourceBlocked } = session
const assetOwnerKey = props.tabKey
const previewVisited = ref(false)
const navigationNotice = ref('')
const conflictDialog = ref(false)
const saveErrorDialog = ref(false)
const pathNotice = ref('')
let pathNoticeTimer: number | null = null
let disposed = false

const loading = computed(() => record.value?.load.phase === 'loading')
const loadError = computed(() => record.value?.load.phase === 'error' ? record.value.load.error.message : null)
const textContent = computed<ProjectFileTextContent | null>(() => {
  const load = record.value?.load
  return load?.phase === 'ready' && load.content.kind === 'text' ? load.content : null
})
const imageSource = computed(() => {
  const load = record.value?.load
  return load?.phase === 'ready' && load.content.kind === 'image' ? `data:${load.content.mimeType};base64,${load.content.base64}` : null
})
const unsupportedReason = computed(() => {
  const load = record.value?.load
  if (load?.phase !== 'unsupported') return null
  return load.content.reason === 'binary' ? '这是二进制文件，不提供预览与编辑。' : '文件超出预览上限（文本 8 MiB、图片 8 MiB），未读取内容。'
})
const readOnlyNote = computed(() => {
  const content = textContent.value
  return content && content.size > PROJECT_FILE_EDIT_MAX_BYTES ? `文件超过 ${PROJECT_FILE_EDIT_MAX_BYTES / 1024 / 1024} MiB，只能查看，不能编辑。` : null
})
const editable = computed(() => textContent.value !== null && readOnlyNote.value === null)
const dirty = computed(() => record.value?.dirty === true)
const conflict = computed(() => record.value?.conflict === true)
const saveError = computed(() => record.value?.saveError ?? null)
const requestedMode = computed(() => record.value?.mode ?? 'code')
const markdown = computed(() => record.value?.markdown === true)
const previewAllowed = computed(() => canPreviewFileMarkdown(documentText.value))
const sourceFallback = computed(() => markdown.value && requestedMode.value === 'preview' && !previewAllowed.value)
const mode = computed<FileEditorMode>(() => sourceFallback.value ? 'code' : requestedMode.value)
const previewEditingAllowed = computed(() => editable.value && previewAllowed.value)
const savedState = computed(() => record.value?.saving ? '正在保存…' : dirty.value ? '未保存' : '已保存')
/** 保存状态不代表能否编辑；能力由当前编辑面给出，不能用“已保存”掩盖只读降级。 */
const editingCapability = computed(() => {
  if (!textContent.value) return null
  if (!editable.value) return { kind: 'readonly', label: '只读', detail: readOnlyNote.value ?? '此文件只读。' }
  if (mode.value === 'code') {
    return sourceBlocked.value
      ? { kind: 'readonly', label: '草稿待恢复', detail: '富文本草稿尚未恢复，未开放源码覆盖。' }
      : { kind: 'ready', label: '可编辑', detail: '当前为源码编辑。' }
  }
  const current = previewState.value
  switch (current.phase) {
    case 'initializing': return { kind: 'waiting', label: '准备中', detail: '编辑器准备完成后才能输入。' }
    case 'editable': return { kind: 'ready', label: '可编辑', detail: '点击排版正文即可放置光标并编辑。' }
    case 'blocked': return { kind: 'blocked', label: '待同步', detail: `仍可继续编辑。${current.failure.message}` }
    case 'readonly': return { kind: 'readonly', label: '只读排版', detail: current.reason }
  }
})
const pathPrefix = computed(() => {
  const path = record.value?.path ?? ''
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash + 1)
})

function reportAssetNotice(message: string): void { editorStore.setAssetNotice(assetOwnerKey, message) }
function reportSaveFailure(): void {
  const latest = editorStore.recordOf(props.tabKey)
  if (!latest) return
  if (latest.conflict) { saveErrorDialog.value = false; conflictDialog.value = true }
  else { conflictDialog.value = false; saveErrorDialog.value = true }
}
async function save(): Promise<void> { if (await session.save() === false) reportSaveFailure() }
async function forceSave(): Promise<void> {
  conflictDialog.value = false
  if (await session.save(true) === false) reportSaveFailure()
}
function retryLoad(): void { void editorStore.reload(props.tabKey) }
function setMode(next: FileEditorMode): void { if (session.setMode(next)) navigationNotice.value = '' }
function onModeKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  const group = event.currentTarget
  if (!(group instanceof HTMLElement)) return
  event.preventDefault()
  setMode(mode.value === 'code' ? 'preview' : 'code')
  // 被提交门禁拒绝时仍聚焦实际选中项，不能让键盘焦点假装已经切换。
  void nextTick(() => group.querySelectorAll<HTMLElement>('[role="radio"]')[mode.value === 'code' ? 0 : 1]?.focus())
}
async function copyPath(): Promise<void> {
  const path = record.value?.path ?? ''
  if (!path) return
  const copied = await copyText(path)
  if (disposed) return
  pathNotice.value = copied ? '路径已复制' : '无法复制路径'
  if (pathNoticeTimer !== null) window.clearTimeout(pathNoticeTimer)
  pathNoticeTimer = window.setTimeout(() => { pathNotice.value = ''; pathNoticeTimer = null }, 1600)
}
function checkExternal(): void { if (props.active) void editorStore.checkExternal(props.tabKey) }
function onSaveShortcut(event: KeyboardEvent): void {
  if (!props.active || !editable.value || event.defaultPrevented || event.isComposing || event.key.toLowerCase() !== 's' || event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey) || conflictDialog.value || saveErrorDialog.value) return
  event.preventDefault(); void save()
}
watch(() => props.active, active => { if (active) checkExternal(); else session.flushPreview() })
watch(conflict, value => { if (value) { saveErrorDialog.value = false; conflictDialog.value = true } })
watch(requestedMode, session.onModeRequested, { flush: 'sync' })
watch([() => props.active, mode, previewAllowed], () => {
  if (props.active && mode.value === 'preview' && previewAllowed.value) previewVisited.value = true
}, { immediate: true })
watch(() => record.value?.anchorRequest, request => {
  if (!request || !sourceFallback.value) return
  navigationNotice.value = `此文档使用源码阅读，请在源码中查找标题「${request.anchor}」。`
  editorStore.consumeAnchor(props.tabKey, request.id)
}, { flush: 'post' })
onMounted(() => {
  window.addEventListener('focus', checkExternal)
  window.addEventListener('keydown', onSaveShortcut)
  if (conflict.value) conflictDialog.value = true
})
onBeforeUnmount(() => {
  disposed = true
  session.captureCurrentDraft(true)
  window.removeEventListener('focus', checkExternal)
  window.removeEventListener('keydown', onSaveShortcut)
  if (pathNoticeTimer !== null) window.clearTimeout(pathNoticeTimer)
})
</script>

<template>
  <div class="file-editor" :class="{ 'is-markdown-workspace': markdown }">
    <header class="file-editor-header">
      <div class="file-editor-path-row">
        <span v-if="dirty" class="file-editor-dirty" role="img" aria-label="有未保存的修改"></span>
        <button type="button" class="file-editor-path" :title="`${record?.path ?? ''}（点击复制路径）`" @click="copyPath">
          <span class="file-editor-path-prefix"><bdi>{{ pathPrefix }}</bdi></span>
          <span class="file-editor-path-name">{{ record?.name ?? '文件' }}</span>
        </button>
        <span v-if="pathNotice" class="file-editor-path-toast" role="status">{{ pathNotice }}</span>
        <span v-if="readOnlyNote && !markdown" class="file-editor-badge" role="status" :title="readOnlyNote">只读</span>
      </div>
      <div class="file-editor-actions">
        <span
          v-if="markdown && editingCapability"
          class="file-editor-capability"
          :class="`is-${editingCapability.kind}`"
          :title="editingCapability.detail"
          role="status"
        >{{ editingCapability.label }}</span>
        <span v-if="markdown && textContent" class="file-reader-save-state" :class="{ 'is-dirty': dirty }" role="status">{{ savedState }}</span>
        <div v-if="markdown && textContent" class="file-editor-mode" role="radiogroup" aria-label="显示方式" @keydown="onModeKeydown">
          <span class="file-editor-mode-thumb" :class="{ 'is-preview': mode === 'preview' }" aria-hidden="true"></span>
          <button type="button" role="radio" class="file-editor-mode-item" :class="{ 'is-active': mode === 'code' }" :aria-checked="mode === 'code'" :tabindex="mode === 'code' ? 0 : -1" @click="setMode('code')">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" /></svg><span>源码</span>
          </button>
          <button type="button" role="radio" class="file-editor-mode-item" :class="{ 'is-active': mode === 'preview' }" :aria-checked="mode === 'preview'" :tabindex="mode === 'preview' ? 0 : -1" @click="setMode('preview')">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 8h4M6 10.5h4" /></svg><span>排版</span>
          </button>
        </div>
      </div>
    </header>
    <div v-if="textContent && mode === 'code'" class="file-editor-source-tools">
      <button type="button" class="file-reader-tool" :aria-pressed="editorStore.codeWrap" :disabled="!editable" :title="editable ? '长行自动折行' : '只读大文件不提供自动换行'" @click="editorStore.setCodeWrap(!editorStore.codeWrap)">{{ editorStore.codeWrap ? '✓ ' : '' }}自动换行</button>
    </div>
    <p v-if="sourceFallback && textContent" class="file-reader-limit" role="status">文档较大，已使用源码阅读，避免完整排版占用过多资源。</p>
    <p v-if="sourceBlocked" class="file-reader-limit" role="status">有尚未恢复的富文本草稿，请切回预览处理；未用源码覆盖草稿。</p>
    <p v-if="blockedAction" class="file-reader-limit" role="status">{{ blockedAction }}</p>
    <p v-if="navigationNotice" class="file-reader-limit" role="status">{{ navigationNotice }}</p>
    <div v-if="record?.assetNotice" class="file-editor-notice" role="status"><span>{{ record.assetNotice }}</span><button type="button" aria-label="关闭图片导入提示" @click="editorStore.setAssetNotice(tabKey, null)">×</button></div>
    <div class="file-editor-body">
      <p v-if="loading" class="file-editor-notice">正在读取…</p>
      <div v-else-if="loadError" class="file-editor-notice is-error" role="alert"><span class="min-w-0 flex-1">{{ loadError }}</span><AppButton variant="compact" @click="retryLoad">重试</AppButton></div>
      <p v-else-if="unsupportedReason" class="file-editor-notice">{{ unsupportedReason }}</p>
      <div v-else-if="textContent" class="file-editor-surface">
        <div v-if="editable || mode === 'code'" class="file-editor-layer" :class="{ 'is-hidden': mode !== 'code' }" :inert="mode !== 'code' || sourceBlocked" :aria-hidden="mode !== 'code'">
          <CodeMirrorEditor
            :key="`${tabKey}:${record?.loadRevision ?? 0}`"
            ref="editorRef"
            :model-value="documentText"
            :path="record?.path ?? ''"
            :read-only="!editable"
            :wrap="editable && editorStore.codeWrap"
            @change="session.onSourceChange"
          />
        </div>
        <div v-if="markdown && previewVisited && previewAllowed" class="file-editor-layer file-editor-preview" :class="{ 'is-hidden': mode !== 'preview' }" :inert="mode !== 'preview'" :aria-hidden="mode !== 'preview'">
          <FileMarkdownView
            :key="`${tabKey}:${record?.loadRevision ?? 0}`"
            ref="previewRef"
            :text="documentText"
            :path="record?.path ?? ''"
            :project-path="record?.projectPath ?? ''"
            :font-size="editorStore.previewFontSize"
            :show-frontmatter="editorStore.showFrontmatter"
            :active="active && mode === 'preview'"
            :editable="previewEditingAllowed"
            :anchor-request="record?.anchorRequest ?? null"
            :recovery="record?.richDraft ?? null"
            :report-asset-notice="reportAssetNotice"
            @draft="session.onRichDraft"
            @anchor-handled="editorStore.consumeAnchor(tabKey, $event)"
            @pending-edit="session.onPending"
            @state="session.onPreviewState"
            @edit="session.onRichText"
            @font-size="editorStore.setPreviewFontSize($event)"
            @frontmatter="editorStore.setShowFrontmatter($event)"
            @source="setMode('code')"
          />
        </div>
      </div>
      <div v-else-if="imageSource" class="file-editor-image"><img :src="imageSource" :alt="record?.name ?? '图片预览'" /></div>
    </div>
    <Teleport to="body">
      <ConfirmDialog :open="conflictDialog" title="文件已在磁盘上被修改" description="保存前检测到磁盘内容与打开时不同。覆盖保存会丢弃磁盘上的外部修改；取消则保留当前编辑，下次保存会再次提示。" :detail="record?.path ?? ''" confirm-label="覆盖保存" @confirm="forceSave" @cancel="conflictDialog = false" />
      <ConfirmDialog :open="saveErrorDialog" title="保存失败" :description="saveError ?? '未知原因，文件未写入。'" :detail="record?.path ?? ''" confirm-label="知道了" confirm-variant="default" @confirm="saveErrorDialog = false" @cancel="saveErrorDialog = false" />
    </Teleport>
  </div>
</template>
