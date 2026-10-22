<!--
  文件工作台：Markdown 排版面默认可编辑，源码与富文本各自持有当前编辑面的光标和撤销历史。
  富文本按快照同步源码；保存、切换和卸载先刷新输入，磁盘重载与保存更新基线分开处理。
  文件预览首次可见时才初始化，源码编辑器保持常驻；超出阅读预算的文档在解析前回退源码。
  标题定位请求按文件消费，草稿与阅读状态仅保存在当前窗口内。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PROJECT_FILE_EDIT_MAX_BYTES } from '../../../shared/project-file-api'
import type { ProjectFileTextContent } from '../../../shared/project-file-api'
import { useAnchoredPopup } from '../ui/anchored-popup'
import { copyText } from '../ui/clipboard'
import { canPreviewFileMarkdown } from '../file-markdown'
import type { FileEditorMode } from '../stores/project-editor'
import { PREVIEW_FONT_SIZES, useProjectEditorStore } from '../stores/project-editor'
import AppButton from '../ui/AppButton.vue'
import CodeMirrorEditor from './CodeMirrorEditor.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import FileMarkdownView from './FileMarkdownView.vue'

const props = defineProps<{
  /** 文件标签键；记录由编辑状态按它读取。 */
  readonly tabKey: string
  /** 是否为当前活动标签；只有活动标签响应保存快捷键与外部改动检查。 */
  readonly active: boolean
}>()

const editorStore = useProjectEditorStore()
let syncingPreview = false
const assetOwnerKey = props.tabKey
function reportAssetNotice(message: string): void { editorStore.setAssetNotice(assetOwnerKey, message) }
const editorRef = ref<InstanceType<typeof CodeMirrorEditor> | null>(null)
const previewRef = ref<InstanceType<typeof FileMarkdownView> | null>(null)
const previewVisited = ref(false)
const previewReadOnlyReason = ref<string | null>(null)
const navigationNotice = ref('')
/** 预览的已同步全文快照：由富文本提交、源码视图切入或磁盘重新载入更新，不随保存回执重置。 */
const previewText = ref('')
/** 磁盘冲突与保存失败的提示弹窗；冲突保留状态，下次保存会再次提示。 */
const conflictDialog = ref(false)
const saveErrorDialog = ref(false)
/** 路径复制的一次性提示；只在本行短暂出现，不占用主体空间。 */
const pathNotice = ref('')
let pathNoticeTimer: number | null = null
/** 头部元素：关闭目录后把焦点还给目录开关，键盘操作不丢位置。 */
const header = ref<HTMLElement | null>(null)

const record = computed(() => editorStore.recordOf(props.tabKey))
const loading = computed(() => record.value?.load.phase === 'loading')
const loadError = computed(() => (
  record.value?.load.phase === 'error' ? record.value.load.error.message : null
))
const textContent = computed<ProjectFileTextContent | null>(() => {
  const load = record.value?.load
  return load?.phase === 'ready' && load.content.kind === 'text' ? load.content : null
})
const imageSource = computed(() => {
  const load = record.value?.load
  if (load?.phase !== 'ready' || load.content.kind !== 'image') return null
  return `data:${load.content.mimeType};base64,${load.content.base64}`
})
const unsupportedReason = computed(() => {
  const load = record.value?.load
  if (load?.phase !== 'unsupported') return null
  return load.content.reason === 'binary'
    ? '这是二进制文件，不提供预览与编辑。'
    : '文件超出预览上限（文本 8 MiB、图片 8 MiB），未读取内容。'
})
/** 文本已读取但超过可编辑上限：仍可查看，但不提供编辑与保存。 */
const readOnlyNote = computed(() => {
  const content = textContent.value
  if (content === null || content.size <= PROJECT_FILE_EDIT_MAX_BYTES) return null
  return `文件超过 ${PROJECT_FILE_EDIT_MAX_BYTES / 1024 / 1024} MiB，只能查看，不能编辑。`
})
const editable = computed(() => textContent.value !== null && readOnlyNote.value === null)
/** 源码编辑器的初始/外部载入文本：优先使用已捕获草稿；已挂载时富文本同步走 applyText，保存回执不覆盖编辑面。 */
const editorText = ref('')
const dirty = computed(() => record.value?.dirty === true)
const conflict = computed(() => record.value?.conflict === true)
const saveError = computed(() => record.value?.saveError ?? null)
const requestedMode = computed(() => record.value?.mode ?? 'code')
const markdown = computed(() => record.value?.markdown === true)
const previewAllowed = computed(() => canPreviewFileMarkdown(previewText.value))
const sourceFallback = computed(() => markdown.value && requestedMode.value === 'preview' && !previewAllowed.value)
const mode = computed<FileEditorMode>(() => sourceFallback.value ? 'code' : requestedMode.value)
const previewEditingAllowed = computed(() => editable.value && previewAllowed.value)
const savedState = computed(() => record.value?.saving ? '正在保存…' : dirty.value ? '未保存' : '已保存')
/** 路径前缀：只展示目录部分，文件名单独成段并保持可见。 */
const pathPrefix = computed(() => {
  const path = record.value?.path ?? ''
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash + 1)
})
/** 宽屏目录默认展开；预览初始化时会按实际容器宽度关闭窄屏目录。 */
const showToc = ref(true)
/** 预览里实际提取到的目录条数，用于决定是否显示开关。 */
const tocCount = ref(0)

/** 「更多」菜单宽度：按最长文案「显示 Front Matter」留位。 */
const MORE_MENU_WIDTH = 208
const moreMenu = useAnchoredPopup({ width: MORE_MENU_WIDTH, align: 'end' })
const {
  trigger: moreTrigger,
  popup: morePopup,
  isOpen: moreOpen,
  position: morePosition,
  open: openMoreMenu,
  close: closeMoreMenu
} = moreMenu
/** 落点直接取共用锚定工具的结果，调用点不再自行补偿高度。 */
const moreStyle = computed(() => {
  const position = morePosition.value
  return {
    left: `${position.left}px`,
    top: `${position.top}px`,
    width: `${position.width}px`,
    maxHeight: `${position.maxHeight}px`
  }
})

/** 登记源码文档的变化版本与脏状态；预览回写时同步全文回声。 */
function onChange(): void {
  if (!editable.value || syncingPreview) return
  editorStore.captureRichDraft(props.tabKey, null)
  editorStore.markDirty(props.tabKey)
  // 富文本快照同步源码也会触发此回调；追平全文后，富文本组件可识别自身回声，保留光标和撤销历史。
  if (mode.value === 'preview') previewText.value = editorRef.value?.getText() ?? editorText.value
}

/**
 * 接收富文本全文快照，先同步源码，再捕获草稿；源码未挂载时保留初始文本供挂载使用。
 */
function onPreviewEdit(text: string): void {
  previewText.value = text
  syncingPreview = true
  try { if (!editorRef.value?.applyText(text)) editorText.value = text }
  finally { syncingPreview = false }
  editorStore.captureDraft(props.tabKey, text)
}

/** 每次文档变化都登记版本，保存期间的后续输入不能被标成已保存。 */
function onPreviewPending(pending: boolean): void {
  if (pending) editorStore.markDirty(props.tabKey)
}

function flushPreview(force = false): boolean {
  return previewRef.value?.flushEdit(force) ?? true
}

/** 获取当前编辑面的全文；预览刷新受阻返回 null，force 沿刷新链透传给卸载收尾。 */
function currentText(force = false): string | null {
  if (mode.value === 'preview') return previewRef.value ? previewRef.value.getText(force) : previewText.value
  return editorRef.value?.getText() ?? editorText.value
}

function captureCurrentDraft(force = false): void {
  const text = currentText(force)
  if (text !== null) editorStore.captureDraft(props.tabKey, text)
}

function changeReadingSize(step: number): void {
  const index = (PREVIEW_FONT_SIZES as readonly number[]).indexOf(editorStore.previewFontSize)
  const size = PREVIEW_FONT_SIZES[index + step]
  if (size !== undefined) editorStore.setPreviewFontSize(size)
}

/** 预览组件提取完目录后回报条数；没有目录时开关自然隐藏。 */
function onToc(entries: readonly { readonly id: string }[]): void {
  tocCount.value = entries.length
}

/** 按保存结果决定弹窗：冲突提示覆盖保存，其余失败提示原因。两个弹窗不叠加。 */
function reportSaveFailure(): void {
  const latest = editorStore.recordOf(props.tabKey)
  if (latest === null) return
  if (latest.conflict) {
    saveErrorDialog.value = false
    conflictDialog.value = true
    return
  }
  conflictDialog.value = false
  saveErrorDialog.value = true
}

/** 显式保存：使用编辑器当前文本；失败原因由弹窗展示。 */
async function save(): Promise<void> {
  if (!flushPreview()) return
  const current = editorStore.recordOf(props.tabKey)
  if (!editable.value) return
  if (current === null || !current.dirty || current.saving) return
  const text = currentText()
  if (text === null) return
  const saved = await editorStore.save(props.tabKey, text)
  captureCurrentDraft()
  if (!saved) reportSaveFailure()
}

/** 冲突弹窗的覆盖保存：用户已明确选择保留自己的修改。 */
async function forceSave(): Promise<void> {
  if (!flushPreview()) return
  const text = currentText()
  if (text === null) return
  conflictDialog.value = false
  const saved = await editorStore.save(props.tabKey, text, true)
  captureCurrentDraft()
  if (!saved) reportSaveFailure()
}

/** 读取失败时重试：重新按磁盘内容读取，不涉及保存。 */
function retryLoad(): void {
  void editorStore.reload(props.tabKey)
}

function setMode(next: FileEditorMode): void {
  if (!flushPreview()) return
  navigationNotice.value = ''
  if (next === 'preview') previewText.value = editorRef.value?.getText() ?? editorText.value
  editorStore.setMode(props.tabKey, next)
}

/**
 * 分段切换的键盘操作：左右/上下方向键在两项之间移动并直接切换，焦点跟到新选项。
 * 只有活动项进入 Tab 序列（roving tabindex），一组控件只占一个 Tab 位。
 */
function onModeKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  const group = event.currentTarget
  if (!(group instanceof HTMLElement)) return
  event.preventDefault()
  // 只有两项：左右/上下方向键都是「切到另一项」，焦点跟到新选项。
  const next: FileEditorMode = mode.value === 'code' ? 'preview' : 'code'
  setMode(next)
  void nextTick(() => {
    group.querySelectorAll<HTMLElement>('[role="radio"]')[next === 'code' ? 0 : 1]?.focus()
  })
}

/** 点击路径复制完整相对路径；结果就地提示，长路径不必先打开文件树。 */
async function copyPath(): Promise<void> {
  const path = record.value?.path ?? ''
  if (path === '') return
  const copied = await copyText(path)
  pathNotice.value = copied ? '路径已复制' : '无法复制路径'
  if (pathNoticeTimer !== null) window.clearTimeout(pathNoticeTimer)
  pathNoticeTimer = window.setTimeout(() => {
    pathNotice.value = ''
    pathNoticeTimer = null
  }, 1600)
}

/** 打开「更多」菜单：以按钮自身为锚点，再点一次收起；打开后焦点进入第一项。 */
function onMoreClick(event: MouseEvent): void {
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return
  moreTrigger.value = target
  if (moreOpen.value) {
    closeMoreMenu()
    return
  }
  openMoreMenu()
  void nextTick(() => {
    morePopup.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  })
}

/** 选中菜单项后收起，并把焦点还给触发键，键盘操作不会掉到页面末尾。 */
function closeMoreAndFocus(): void {
  closeMoreMenu()
  moreTrigger.value?.focus()
}

/** 「自动换行」的禁用原因：只在可编辑的源码模式下有意义。 */
const wrapItemTitle = computed(() => {
  if (mode.value !== 'code') return '只在源码模式生效'
  if (!editable.value) return '只读大文件不提供自动换行'
  return '长行自动折行'
})

function toggleCodeWrap(): void {
  editorStore.setCodeWrap(!editorStore.codeWrap)
  closeMoreAndFocus()
}

function toggleFrontmatter(): void {
  editorStore.setShowFrontmatter(!editorStore.showFrontmatter)
  closeMoreAndFocus()
}

/** 主动关闭时回到开关；导航和自适应收起不抢走正文焦点。 */
function closeToc(restoreFocus = true): void {
  if (!showToc.value) return
  showToc.value = false
  if (restoreFocus) void nextTick(() => {
    header.value?.parentElement?.querySelector<HTMLElement>('[data-toc-toggle]')?.focus()
  })
}

function setFontSize(size: number): void {
  editorStore.setPreviewFontSize(size)
  closeMoreAndFocus()
}

/** 标签激活或窗口重新聚焦时检查磁盘；只在活动标签上做，避免后台标签反复读盘。 */
function checkExternal(): void {
  if (!props.active) return
  void editorStore.checkExternal(props.tabKey)
}

function onWindowFocus(): void {
  checkExternal()
}

/** Cmd/Ctrl+S：活动文件标签内全局生效，编辑器未聚焦时也能保存。 */
function onSaveShortcut(event: KeyboardEvent): void {
  if (!props.active || !editable.value || event.defaultPrevented || event.isComposing) return
  if (event.key.toLowerCase() !== 's' || event.altKey || event.shiftKey) return
  if (!event.metaKey && !event.ctrlKey) return
  if (conflictDialog.value || saveErrorDialog.value) return
  event.preventDefault()
  void save()
}

watch(() => props.active, (active) => {
  if (active) checkExternal()
  else flushPreview()
})

// 换文件或重新载入后目录条数归零，避免开关停在上一份文档的按下态。
watch(() => record.value?.path, () => { tocCount.value = 0 })

// 外部检测到冲突时直接弹窗；用户取消后保留冲突状态，下次保存会再次提示。
watch(conflict, (value) => {
  if (!value) return
  saveErrorDialog.value = false
  conflictDialog.value = true
})

// 切换视图取当前编辑器内容；外部重新读取则取新记录，不能拿尚未更新的旧编辑器覆盖磁盘结果。
watch(requestedMode, (next) => {
  flushPreview()
  if (next === 'preview') previewText.value = editorRef.value?.getText() ?? editorText.value
}, { flush: 'sync' })
watch(() => record.value?.loadRevision, () => {
  const content = textContent.value
  if (content === null) return
  const text = record.value?.draft ?? record.value?.richDraft?.text ?? content.text
  editorText.value = text
  previewText.value = text
}, { immediate: true, flush: 'sync' })

watch([() => props.active, mode, previewAllowed], () => {
  if (props.active && mode.value === 'preview' && previewAllowed.value) previewVisited.value = true
}, { immediate: true })

watch(() => record.value?.anchorRequest, (request) => {
  if (request === undefined || request === null || !sourceFallback.value) return
  navigationNotice.value = `此文档使用源码阅读，请在源码中查找标题「${request.anchor}」。`
  editorStore.consumeAnchor(props.tabKey, request.id)
}, { flush: 'post' })

onMounted(() => {
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener('keydown', onSaveShortcut)
  // 重新挂载时仍有未处理的磁盘冲突：直接弹窗，避免状态只在记录里、界面看不出来。
  if (conflict.value) conflictDialog.value = true
  // 以预览模式重新挂载时，先按草稿/磁盘内容填好预览文本。
  if (mode.value === 'preview') previewText.value = editorText.value
})

onBeforeUnmount(() => {
  flushPreview(true)
  window.removeEventListener('focus', onWindowFocus)
  window.removeEventListener('keydown', onSaveShortcut)
  if (pathNoticeTimer !== null) window.clearTimeout(pathNoticeTimer)
  // 卸载前把未保存文本留给状态，重新挂载时从草稿恢复。
  captureCurrentDraft(true)
})
</script>

<template>
  <div class="file-editor" :class="{ 'is-markdown-workspace': markdown }">
    <header ref="header" class="file-editor-header">
      <div class="file-editor-path-row">
        <span v-if="dirty" class="file-editor-dirty" role="img" aria-label="有未保存的修改"></span>
        <button
          type="button"
          class="file-editor-path"
          :title="`${record?.path ?? ''}（点击复制路径）`"
          @click="copyPath"
        >
          <span class="file-editor-path-prefix"><bdi>{{ pathPrefix }}</bdi></span>
          <span class="file-editor-path-name">{{ record?.name ?? '文件' }}</span>
        </button>
        <span v-if="pathNotice !== ''" class="file-editor-path-toast" role="status">{{ pathNotice }}</span>
        <span v-if="readOnlyNote !== null" class="file-editor-badge" role="status" :title="readOnlyNote">只读</span>
      </div>

      <div class="file-editor-actions">
        <span v-if="markdown && textContent !== null" class="file-reader-save-state" :class="{ 'is-dirty': dirty }" role="status">{{ savedState }}</span>
        <AppButton
          v-if="textContent !== null"
          variant="unstyled"
          class="file-editor-icon-button"
          :class="{ 'is-active': moreOpen }"
          :aria-expanded="moreOpen"
          aria-haspopup="dialog"
          aria-label="更多视图选项"
          title="更多视图选项"
          @click="onMoreClick"
        >
          <svg class="file-editor-dots" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="3.5" cy="8" r="1.15" />
            <circle cx="8" cy="8" r="1.15" />
            <circle cx="12.5" cy="8" r="1.15" />
          </svg>
        </AppButton>

        <div
          v-if="markdown && textContent !== null"
          class="file-editor-mode"
          role="radiogroup"
          aria-label="显示方式"
          @keydown="onModeKeydown"
        >
          <span class="file-editor-mode-thumb" :class="{ 'is-preview': mode === 'preview' }" aria-hidden="true"></span>
          <button
            type="button"
            role="radio"
            class="file-editor-mode-item"
            :class="{ 'is-active': mode === 'code' }"
            :aria-checked="mode === 'code'"
            :tabindex="mode === 'code' ? 0 : -1"
            @click="setMode('code')"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />
            </svg>
            <span>源码</span>
          </button>
          <button
            type="button"
            role="radio"
            class="file-editor-mode-item"
            :class="{ 'is-active': mode === 'preview' }"
            :aria-checked="mode === 'preview'"
            :tabindex="mode === 'preview' ? 0 : -1"
            @click="setMode('preview')"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M1.5 8S3.9 4 8 4s6.5 4 6.5 4-2.4 4-6.5 4S1.5 8 1.5 8Z" />
              <circle cx="8" cy="8" r="1.75" />
            </svg>
            <span>预览</span>
          </button>
        </div>
      </div>
    </header>

    <div v-if="markdown && mode === 'preview' && textContent !== null" class="file-reader-toolbar">
      <div class="file-reader-toolbar-group">
        <button type="button" class="file-reader-tool" data-toc-toggle :class="{ 'is-active': showToc }"
          :aria-pressed="showToc" :disabled="tocCount === 0" @click="showToc = !showToc">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6" /></svg>
          目录
        </button>
        <button type="button" class="file-reader-tool" @click="previewRef?.openSearch()">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4"/><path d="m10 10 3.5 3.5" /></svg>
          查找
        </button>
      </div>
      <p v-if="previewReadOnlyReason" class="file-reader-context">只读排版 · 在源码中编辑</p>
      <div class="file-reader-toolbar-group">
        <div class="file-reader-font-control" role="group" aria-label="阅读字号">
          <button type="button" aria-label="缩小字号" :disabled="editorStore.previewFontSize === PREVIEW_FONT_SIZES[0]" @click="changeReadingSize(-1)">A−</button>
          <span>{{ editorStore.previewFontSize }}</span>
          <button type="button" aria-label="放大字号" :disabled="editorStore.previewFontSize === PREVIEW_FONT_SIZES[PREVIEW_FONT_SIZES.length - 1]" @click="changeReadingSize(1)">A＋</button>
        </div>
      </div>
    </div>
    <p v-if="sourceFallback && textContent !== null" class="file-reader-limit" role="status">文档较大，已使用源码阅读，避免完整排版占用过多资源。</p>
    <p v-if="navigationNotice !== ''" class="file-reader-limit" role="status">{{ navigationNotice }}</p>
    <div v-if="record?.assetNotice" class="file-editor-notice" role="status"><span>{{ record.assetNotice }}</span><button type="button" aria-label="关闭图片导入提示" @click="editorStore.setAssetNotice(tabKey, null)">×</button></div>

    <div class="file-editor-body">
      <p v-if="loading" class="file-editor-notice">正在读取…</p>
      <div v-else-if="loadError !== null" class="file-editor-notice is-error" role="alert">
        <span class="min-w-0 flex-1">{{ loadError }}</span>
        <AppButton variant="compact" @click="retryLoad">重试</AppButton>
      </div>
      <p v-else-if="unsupportedReason !== null" class="file-editor-notice">{{ unsupportedReason }}</p>

      <!-- 代码与预览叠放：切模式不销毁编辑器，未保存的修改与撤销历史都保留。
           超过可编辑上限的文本只挂载当前需要的一层，不让大文本同时进编辑器和渲染器。 -->
      <div v-else-if="textContent !== null" class="file-editor-surface">
        <div
          v-if="editable || mode === 'code'"
          class="file-editor-layer"
          :class="{ 'is-hidden': mode !== 'code' }"
        >
          <CodeMirrorEditor
            :key="`${tabKey}:${record?.loadRevision ?? 0}`"
            ref="editorRef"
            :model-value="editorText"
            :path="record?.path ?? ''"
            :read-only="!editable"
            :wrap="editable && editorStore.codeWrap"
            @change="onChange"
          />
        </div>
        <div
          v-if="markdown && previewVisited && previewAllowed"
          class="file-editor-layer file-editor-preview"
          :class="{ 'is-hidden': mode !== 'preview' }"
        >
          <FileMarkdownView
            :key="`${tabKey}:${record?.loadRevision ?? 0}`"
            ref="previewRef"
            :text="previewText"
            :path="record?.path ?? ''"
            :project-path="record?.projectPath ?? ''"
            :show-toc="showToc"
            :font-size="editorStore.previewFontSize"
            :show-frontmatter="editorStore.showFrontmatter"
            :active="active && mode === 'preview'"
            :editable="previewEditingAllowed"
            :anchor-request="record?.anchorRequest ?? null"
            :recovery="record?.richDraft ?? null"
            :report-asset-notice="reportAssetNotice"
            @draft="editorStore.captureRichDraft(tabKey, $event)"
            @anchor-handled="editorStore.consumeAnchor(tabKey, $event)"
            @pending-edit="onPreviewPending"
            @editing-status="previewReadOnlyReason = $event"
            @toc="onToc"
            @close-toc="closeToc"
            @edit="onPreviewEdit"
          />
        </div>
      </div>

      <div v-else-if="imageSource !== null" class="file-editor-image">
        <img :src="imageSource" :alt="record?.name ?? '图片预览'" />
      </div>
    </div>

    <Teleport to="body">
      <Transition name="pop-motion">
        <div
          v-if="moreOpen"
          ref="morePopup"
          class="project-sidebar-menu file-editor-menu flex flex-col"
          :style="moreStyle"
          role="dialog"
          tabindex="-1"
          aria-label="视图选项"
          @keydown.escape="closeMoreAndFocus"
        >
          <AppButton
            variant="unstyled"
            class="project-sidebar-menu-item file-editor-menu-item"
            :disabled="mode !== 'code' || !editable"
            :title="wrapItemTitle"
            @click="toggleCodeWrap"
          >
            <span class="file-editor-menu-check" aria-hidden="true">{{ editorStore.codeWrap ? '✓' : '' }}</span>
            自动换行
          </AppButton>
          <AppButton
            variant="unstyled"
            class="project-sidebar-menu-item file-editor-menu-item"
            :disabled="mode !== 'preview'"
            :title="mode === 'preview' ? '显示或隐藏 Front Matter' : '只在预览模式生效'"
            @click="toggleFrontmatter"
          >
            <span class="file-editor-menu-check" aria-hidden="true">{{ editorStore.showFrontmatter ? '✓' : '' }}</span>
            显示 Front Matter
          </AppButton>
          <div v-if="mode === 'preview'" class="file-editor-menu-section">
            <p class="file-editor-menu-label">预览字号</p>
            <div class="file-editor-font-sizes" role="group" aria-label="预览字号">
              <button
                v-for="size in PREVIEW_FONT_SIZES"
                :key="size"
                type="button"
                class="file-editor-font-size"
                :class="{ 'is-active': editorStore.previewFontSize === size }"
                :aria-pressed="editorStore.previewFontSize === size"
                :title="`${size} 像素`"
                @click="setFontSize(size)"
              >{{ size }}</button>
            </div>
          </div>
        </div>
      </Transition>

      <ConfirmDialog
        :open="conflictDialog"
        title="文件已在磁盘上被修改"
        description="保存前检测到磁盘内容与打开时不同。覆盖保存会丢弃磁盘上的外部修改；取消则保留当前编辑，下次保存会再次提示。"
        :detail="record?.path ?? ''"
        confirm-label="覆盖保存"
        @confirm="forceSave"
        @cancel="conflictDialog = false"
      />
      <ConfirmDialog
        :open="saveErrorDialog"
        title="保存失败"
        :description="saveError ?? '未知原因，文件未写入。'"
        :detail="record?.path ?? ''"
        confirm-label="知道了"
        confirm-variant="default"
        @confirm="saveErrorDialog = false"
        @cancel="saveErrorDialog = false"
      />
    </Teleport>
  </div>
</template>
