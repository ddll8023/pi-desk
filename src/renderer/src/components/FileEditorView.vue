<!--
  工作区文件标签的预览/编辑面板：头部是单行文件信息、视图选项与「源码 / 预览」切换，主体按内容类型渲染代码编辑器、预览或图片。

  面板按标签常驻挂载，非活动标签只隐藏不卸载，因此切回来仍是同一份编辑内容与撤销历史。
  Markdown 的「源码 / 预览」用叠放层切换而不是销毁编辑器：切到预览再切回来，未保存的修改仍在。
  超过可编辑上限的文本仍可预览：这类文件只挂载当前需要的一层，避免大文本同时进入编辑器与渲染器。
  保存统一走 Cmd/Ctrl+S（标签处于活动状态时全局生效），头部不设保存与重新载入按钮；
  外部改动在标签激活与窗口重新聚焦时用 `stat` 检查，未修改的文件自动重新载入，有未保存修改或保存失败时直接弹窗。

  头部按编辑器 chrome 处理：路径单行、目录前缀左侧省略、整行可点复制；右侧是图标键与分段切换，
  字号、Front Matter 与自动换行收进「更多」菜单，避免头部堆控件。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PROJECT_FILE_EDIT_MAX_BYTES } from '../../../shared/project-file-api'
import type { ProjectFileTextContent } from '../../../shared/project-file-api'
import { useAnchoredPopup } from '../anchored-popup'
import { copyText } from '../clipboard'
import type { FileEditorMode } from '../stores/project-editor'
import { PREVIEW_FONT_SIZES, useProjectEditorStore } from '../stores/project-editor'
import AppButton from './ui/AppButton.vue'
import CodeMirrorEditor from './CodeMirrorEditor.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import FileMarkdownView from './FileMarkdownView.vue'

const props = defineProps<{
  /** 文件标签键；记录由编辑状态按它读取。 */
  readonly tabKey: string
  /** 是否为当前活动标签；只有活动标签响应保存快捷键与外部改动检查。 */
  readonly active: boolean
}>()

const editorStore = useProjectEditorStore()
const editorRef = ref<InstanceType<typeof CodeMirrorEditor> | null>(null)
/** Markdown 预览文本：切到预览或外部重新载入时从编辑器/记录取值。 */
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
/** 文本已读取但超过可编辑上限：仍可预览，但不提供编辑与保存。 */
const readOnlyNote = computed(() => {
  const content = textContent.value
  if (content === null || content.size <= PROJECT_FILE_EDIT_MAX_BYTES) return null
  return `文件超过 ${PROJECT_FILE_EDIT_MAX_BYTES / 1024 / 1024} MiB，只能预览，不能编辑。`
})
const editable = computed(() => textContent.value !== null && readOnlyNote.value === null)
/** 编辑区初始文本：优先用卸载前捕获的草稿，保证设置页往返或项目切换不丢未保存修改。 */
const editorText = computed(() => record.value?.draft ?? textContent.value?.text ?? '')
const dirty = computed(() => record.value?.dirty === true)
const conflict = computed(() => record.value?.conflict === true)
const saveError = computed(() => record.value?.saveError ?? null)
const mode = computed(() => record.value?.mode ?? 'code')
const markdown = computed(() => record.value?.markdown === true)
/** 路径前缀：只展示目录部分，文件名单独成段并保持可见。 */
const pathPrefix = computed(() => {
  const path = record.value?.path ?? ''
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash + 1)
})
/** 目录栏开关：只在预览模式下有目录时才有意义，默认展开。 */
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

/** 内容变化只上报脏标记；文本留在编辑器里，保存时再取。 */
function onChange(): void {
  if (!editable.value) return
  editorStore.markDirty(props.tabKey)
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
  const current = editorStore.recordOf(props.tabKey)
  if (!editable.value) return
  if (current === null || !current.dirty || current.saving) return
  const text = editorRef.value?.getText() ?? editorText.value
  if (await editorStore.save(props.tabKey, text)) return
  reportSaveFailure()
}

/** 冲突弹窗的覆盖保存：用户已明确选择保留自己的修改。 */
async function forceSave(): Promise<void> {
  const text = editorRef.value?.getText() ?? editorText.value
  conflictDialog.value = false
  if (await editorStore.save(props.tabKey, text, true)) return
  reportSaveFailure()
}

/** 读取失败时重试：重新按磁盘内容读取，不涉及保存。 */
function retryLoad(): void {
  void editorStore.reload(props.tabKey)
}

function setMode(next: FileEditorMode): void {
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

/** 关闭左侧目录面板：焦点回到头部目录开关，避免停在已卸载的按钮上。 */
function closeToc(): void {
  showToc.value = false
  void nextTick(() => {
    header.value?.querySelector<HTMLElement>('[data-toc-toggle]')?.focus()
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
})

// 换文件或重新载入后目录条数归零，避免开关停在上一份文档的按下态。
watch(() => record.value?.path, () => { tocCount.value = 0 })

// 外部检测到冲突时直接弹窗；用户取消后保留冲突状态，下次保存会再次提示。
watch(conflict, (value) => {
  if (!value) return
  saveErrorDialog.value = false
  conflictDialog.value = true
})

// 所有进入预览的入口共用同一同步点；外部菜单改 mode 也要取当前未保存的编辑文本。
watch([mode, textContent], () => {
  if (mode.value === 'preview') previewText.value = editorRef.value?.getText() ?? editorText.value
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
  window.removeEventListener('focus', onWindowFocus)
  window.removeEventListener('keydown', onSaveShortcut)
  if (pathNoticeTimer !== null) window.clearTimeout(pathNoticeTimer)
  // 卸载前把未保存文本留给状态，重新挂载时从草稿恢复。
  editorStore.captureDraft(props.tabKey, editorRef.value?.getText() ?? editorText.value)
})
</script>

<template>
  <div class="file-editor">
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
        <AppButton
          v-if="mode === 'preview' && tocCount > 0"
          variant="unstyled"
          class="file-editor-icon-button"
          :class="{ 'is-active': showToc }"
          :aria-pressed="showToc"
          aria-label="目录"
          title="目录"
          data-toc-toggle
          @click="showToc = !showToc"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M3 4h10M3 8h10M3 12h6" />
          </svg>
        </AppButton>
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
            ref="editorRef"
            :model-value="editorText"
            :path="record?.path ?? ''"
            :read-only="!editable"
            :wrap="editable && editorStore.codeWrap"
            @change="onChange"
          />
        </div>
        <div
          v-if="markdown"
          class="file-editor-layer file-editor-preview"
          :class="{ 'is-hidden': mode !== 'preview' }"
        >
          <FileMarkdownView
            :text="previewText"
            :path="record?.path ?? ''"
            :project-path="record?.projectPath ?? ''"
            :show-toc="showToc"
            :font-size="editorStore.previewFontSize"
            :show-frontmatter="editorStore.showFrontmatter"
            :active="active && mode === 'preview'"
            @toc="onToc"
            @close-toc="closeToc"
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
