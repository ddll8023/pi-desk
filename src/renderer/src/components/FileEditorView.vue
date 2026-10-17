<!--
  工作区文件标签的预览/编辑面板：头部是文件信息与 Markdown 显示方式，主体按内容类型渲染代码编辑器、预览或图片。

  面板按标签常驻挂载，非活动标签只隐藏不卸载，因此切回来仍是同一份编辑内容与撤销历史。
  Markdown 的「源码 / 预览」用叠放层切换而不是销毁编辑器：切到预览再切回来，未保存的修改仍在。
  保存统一走 Cmd/Ctrl+S（标签处于活动状态时全局生效），头部不设保存与重新载入按钮；
  外部改动在标签激活与窗口重新聚焦时用 `stat` 检查，未修改的文件自动重新载入，有未保存修改或保存失败时直接弹窗。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ProjectFileTextContent } from '../../../shared/project-file-api'
import { useProjectEditorStore } from '../stores/project-editor'
import AppButton from './ui/AppButton.vue'
import CodeMirrorEditor from './CodeMirrorEditor.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import MarkdownContent from './MarkdownContent.vue'

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
    : '文件超出预览上限（文本 2 MiB、图片 8 MiB），未读取内容。'
})
const editable = computed(() => textContent.value !== null)
/** 编辑区初始文本：优先用卸载前捕获的草稿，保证设置页往返或项目切换不丢未保存修改。 */
const editorText = computed(() => record.value?.draft ?? textContent.value?.text ?? '')
const dirty = computed(() => record.value?.dirty === true)
const conflict = computed(() => record.value?.conflict === true)
const saveError = computed(() => record.value?.saveError ?? null)
const mode = computed(() => record.value?.mode ?? 'code')
const markdown = computed(() => record.value?.markdown === true)

/** 内容变化只上报脏标记；文本留在编辑器里，保存时再取。 */
function onChange(): void {
  editorStore.markDirty(props.tabKey)
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

function setMode(next: 'code' | 'preview'): void {
  if (next === 'preview') previewText.value = editorRef.value?.getText() ?? editorText.value
  editorStore.setMode(props.tabKey, next)
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
  if (!props.active || event.defaultPrevented || event.isComposing) return
  if (event.key.toLowerCase() !== 's' || event.altKey || event.shiftKey) return
  if (!event.metaKey && !event.ctrlKey) return
  if (conflictDialog.value || saveErrorDialog.value) return
  event.preventDefault()
  void save()
}

watch(() => props.active, (active) => {
  if (active) checkExternal()
})

// 外部检测到冲突时直接弹窗；用户取消后保留冲突状态，下次保存会再次提示。
watch(conflict, (value) => {
  if (!value) return
  saveErrorDialog.value = false
  conflictDialog.value = true
})

// 外部重新载入后，预览文本跟着记录走；正在预览时尤其不能停在旧内容。
watch(textContent, (content) => {
  if (mode.value === 'preview') previewText.value = content?.text ?? ''
})

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
  // 卸载前把未保存文本留给状态，重新挂载时从草稿恢复。
  editorStore.captureDraft(props.tabKey, editorRef.value?.getText() ?? editorText.value)
})
</script>

<template>
  <div class="file-editor">
    <header class="file-editor-header">
      <div class="file-editor-heading">
        <p class="file-editor-name">
          {{ record?.name ?? '文件' }}
          <span v-if="dirty" class="file-editor-dirty" aria-label="有未保存的修改">●</span>
        </p>
        <p class="file-editor-path" :title="record?.path">{{ record?.path }}</p>
      </div>

      <div v-if="markdown && editable" class="file-editor-actions">
        <div class="file-editor-switch" role="group" aria-label="显示方式">
          <AppButton
            variant="unstyled"
            class="file-editor-switch-item"
            :class="{ 'is-active': mode === 'code' }"
            :aria-pressed="mode === 'code'"
            @click="setMode('code')"
          >源码</AppButton>
          <AppButton
            variant="unstyled"
            class="file-editor-switch-item"
            :class="{ 'is-active': mode === 'preview' }"
            :aria-pressed="mode === 'preview'"
            @click="setMode('preview')"
          >预览</AppButton>
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

      <!-- 代码与预览叠放：切模式不销毁编辑器，未保存的修改与撤销历史都保留。 -->
      <div v-else-if="editable" class="file-editor-surface">
        <div class="file-editor-layer" :class="{ 'is-hidden': mode !== 'code' }">
          <CodeMirrorEditor
            ref="editorRef"
            :model-value="editorText"
            :path="record?.path ?? ''"
            :read-only="false"
            @change="onChange"
          />
        </div>
        <div
          v-if="markdown"
          class="file-editor-layer file-editor-preview"
          :class="{ 'is-hidden': mode !== 'preview' }"
        >
          <MarkdownContent :text="previewText" />
        </div>
      </div>

      <div v-else-if="imageSource !== null" class="file-editor-image">
        <img :src="imageSource" :alt="record?.name ?? '图片预览'" />
      </div>
    </div>

    <Teleport to="body">
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
