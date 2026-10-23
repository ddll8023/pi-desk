<!-- Extension dialog 模态对话框：按 method 呈现 select / confirm / input / editor 四种形态，一次只展示队首请求；打开时接管焦点、关闭或收起后归还，select 支持数字键与方向键选择、多选 input 的编号参考行可点击切换，取消发送 cancelled 响应，收起只隐藏弹窗、请求仍等回应。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import type { ExtensionDialogRequest, ExtensionDialogResponseInput } from '../../../../shared/extension-ui-api'
import { parseDialogTitle, parseOptionRows, parseSelectionTokens, toggleSelection } from '../extension-dialog-presentation'
import type { DialogOption } from '../extension-dialog-presentation'
import { useExtensionUiStore } from '../stores/extension-ui'
import AppButton from '../../ui/AppButton.vue'

const extensionStore = useExtensionUiStore()
const { respondState } = storeToRefs(extensionStore)

const emit = defineEmits<{
  /** 本条对话已回应（含取消），队列可能仍有下一条。 */
  settled: []
}>()

const titleId = useId()
const draft = ref('')
/**
 * select 的键盘高亮行（0 基）；-1 表示没有高亮。
 * 打开时不预选第一行：这里点选即提交且不可撤回，避免误按 Enter 直接作答。
 */
const highlighted = ref(-1)
const optionList = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const inputControl = ref<HTMLInputElement | null>(null)
/** 打开弹窗前持有焦点的元素；关闭或收起后把焦点还回去，避免键盘用户停在文档开头。 */
let restoreFocus: HTMLElement | null = null

/** 当前队首请求；没有请求或已收起时不渲染弹窗。 */
const dialog = computed<ExtensionDialogRequest | null>(() => extensionStore.dialogs[0] ?? null)

/** 被收起的对话不渲染弹窗，但请求仍在队列里等回应；底部入口负责恢复。 */
const minimized = computed(() => dialog.value !== null && extensionStore.minimizedDialogId === dialog.value.id)

/** 标题与选项的展示拆解；无法识别的内容按原文回退。 */
const content = computed(() => parseDialogTitle(dialog.value?.title ?? ''))
/** 确认正文与标题是两个协议字段，不能只显示标题就允许批准。 */
const confirmationMessage = computed(() => dialog.value?.method === 'confirm' ? dialog.value.message ?? '' : '')
const confirmationAvailable = computed(() => confirmationMessage.value.trim().length > 0)

/** select 的选项行；其他 method 为空数组。 */
const optionRows = computed<readonly DialogOption[]>(
  () => (dialog.value?.method === 'select' ? parseOptionRows(dialog.value.options) : [])
)

/** 标题内嵌的编号清单：input / editor 的参考行（多选作答时可点击切换编号），select 以 options 为准，不重复渲染。 */
const referenceRows = computed<readonly DialogOption[]>(
  () => (dialog.value !== null && dialog.value.method !== 'select' ? content.value.list ?? [] : [])
)

/**
 * 参考清单能否点击切换编号：上游把「按编号作答」写进多选输入的 placeholder（`1,3; custom answer`），
 * 而自定义回答的 placeholder 为空，据此区分两者，避免把编号插进自由文本答案；
 * placeholder 变化时只是失去点击切换，仍按只读清单展示。
 */
const toggleableReference = computed(
  () => dialog.value?.method === 'input'
    && referenceRows.value.length > 0
    && /^\d/.test(dialog.value.placeholder ?? '')
)

/** 草稿里已选中的编号 token；点击参考行与手输编号共用同一份解析结果。 */
const selectedTokens = computed(() => new Set(parseSelectionTokens(draft.value).tokens))

/** 参考行的选中态。 */
function isReferenceSelected(position: number): boolean {
  return selectedTokens.value.has(String(position))
}

/** 点击参考行切换编号；焦点回到输入框并把光标放到末尾，方便接着补自定义文本。 */
function toggleReference(position: number): void {
  if (busy.value) return
  draft.value = toggleSelection(draft.value, position)
  const control = inputControl.value
  if (control === null) return
  control.focus()
  control.setSelectionRange(control.value.length, control.value.length)
}

watch(
  dialog,
  (value) => {
    // 换一条对话时重置编辑值：editor 用 prefill，input 从空白开始；高亮一并回到未选中。
    draft.value = value?.method === 'editor' ? (value.prefill ?? '') : ''
    highlighted.value = -1
  },
  { immediate: true }
)

// 键盘移动高亮时把该行带进视野；行已可见时 scrollIntoView 不产生位移。
watch(highlighted, (position) => {
  const row = optionList.value?.children[position]
  if (row instanceof HTMLElement) row.scrollIntoView({ block: 'nearest' })
})

// 弹窗声明了 aria-modal，焦点就不能留在背后的输入区：打开时移进面板，关闭或收起后还给原元素。
// 队列推进到下一条对话时面板不重建，保留打开时记录的还原目标。
watch(
  [dialog, minimized],
  ([current, isMinimized]) => {
    if (current !== null && !isMinimized) {
      if (restoreFocus === null) {
        restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      }
      void nextTick(() => panel.value?.focus())
      return
    }
    const target = restoreFocus
    restoreFocus = null
    if (target !== null && target.isConnected) target.focus()
  },
  { immediate: true }
)

const busy = computed(() => respondState.value.phase === 'sending')

/** select 的选项被点击即提交；不提供“不选择”以外的空值路径。 */
function choose(option: string): void {
  if (dialog.value === null || busy.value) return
  void extensionStore.respond(dialog.value.id, { kind: 'value', value: option }).then(() => {
    if (respondState.value.phase !== 'error') emit('settled')
  })
}

function confirmYes(): void {
  void respondCurrent({ kind: 'confirm', confirmed: true })
}

function confirmNo(): void {
  void respondCurrent({ kind: 'confirm', confirmed: false })
}

function submitValue(): void {
  const value = draft.value
  if (value.trim() === '') return
  void respondCurrent({ kind: 'value', value })
}

function cancel(): void {
  void respondCurrent({ kind: 'cancelled' })
}

/** 收起当前对话：不提交响应，Pi 侧继续等待，可从输入区底部恢复。 */
function minimize(): void {
  const current = dialog.value
  if (current === null) return
  extensionStore.minimizeDialog(current.id)
}

async function respondCurrent(response: ExtensionDialogResponseInput): Promise<void> {
  const current = dialog.value
  if (current === null || busy.value) return
  if (current.method === 'confirm' && response.kind === 'confirm' && response.confirmed && !confirmationAvailable.value) return
  await extensionStore.respond(current.id, response)
  if (respondState.value.phase !== 'error') emit('settled')
}

/**
 * 按键落在可编辑控件里时不算弹窗快捷键：弹窗不接管焦点，用户仍可能在输入区打字，
 * 此时数字与 Enter 属于正文输入，不能被当成选项选择。
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable
    || target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
}

/** select 的键盘选择：数字键按序号直接提交，方向键移动高亮，Enter 提交高亮行。 */
function onSelectKeydown(event: KeyboardEvent): void {
  const rows = optionRows.value
  if (rows.length === 0) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    highlighted.value = highlighted.value === -1
      ? (step === 1 ? 0 : rows.length - 1)
      : (highlighted.value + step + rows.length) % rows.length
    return
  }
  if (event.key === 'Enter') {
    const row = rows[highlighted.value]
    if (row === undefined) return
    event.preventDefault()
    choose(row.raw)
    return
  }
  // 只认单位数序号：两位数选项仍可用方向键与鼠标。
  if (/^[1-9]$/.test(event.key)) {
    const position = Number(event.key) - 1
    const row = rows[position]
    if (row === undefined) return
    event.preventDefault()
    highlighted.value = position
    choose(row.raw)
  }
}

function onKeydown(event: KeyboardEvent): void {
  // Escape 表示取消当前对话；收起状态下弹窗不在眼前，不能代替用户取消。
  if (dialog.value === null || minimized.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
    return
  }
  if (dialog.value.method !== 'select' || busy.value || isTypingTarget(event.target)) return
  onSelectKeydown(event)
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Transition name="dialog-fade">
    <div
      v-if="dialog !== null && !minimized"
      class="dialog-overlay"
      @click.self="cancel"
    >
      <Transition name="dialog-panel-motion" appear>
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          :aria-describedby="dialog.method === 'confirm' ? `${titleId}-message` : undefined"
          tabindex="-1"
          :class="dialog.method === 'confirm' ? 'max-w-lg' : 'max-w-xl'"
          class="dialog-panel"
        >
      <div class="dialog-header">
        <div class="min-w-0">
          <span v-if="content.header !== null" class="dialog-header-chip">{{ content.header }}</span>
          <h2 :id="titleId" class="dialog-title whitespace-pre-wrap break-words">{{ content.question }}</h2>
        </div>
      </div>

      <div class="dialog-body">
        <div v-if="dialog.method === 'confirm'" :id="`${titleId}-message`">
          <p v-if="confirmationAvailable" class="scroll-area max-h-[55vh] overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed">{{ confirmationMessage }}</p>
          <p v-else role="alert" class="status-notice status-notice-error">缺少操作说明，无法确认。可取消此次请求。</p>
        </div>
        <!-- 选项预览：模型给出的 ASCII 版式，必须保留换行与列对齐，超长时块内滚动。 -->
        <div
          v-for="preview in content.previews"
          :key="preview.index"
          class="dialog-preview-block scroll-area"
        >
          <p class="dialog-preview-title">{{ preview.index }}. {{ preview.label }} 预览</p>
          <p class="dialog-preview-text">{{ preview.text }}</p>
        </div>

        <!-- 标题内嵌的编号清单：多选作答时点击行即切换编号，否则作为只读参考。 -->
        <ul v-if="referenceRows.length > 0" class="space-y-1.5">
          <li v-for="(row, position) in referenceRows" :key="position">
            <AppButton
              variant="unstyled"
              class="dialog-reference-row"
              :class="{
                'dialog-reference-row-toggle': toggleableReference,
                'dialog-reference-row-selected': toggleableReference && isReferenceSelected(position + 1)
              }"
              :disabled="!toggleableReference || busy"
              :aria-pressed="toggleableReference ? isReferenceSelected(position + 1) : undefined"
              @click="toggleReference(position + 1)"
            >
              <span class="dialog-option-index">{{ position + 1 }}</span>
              <span class="min-w-0">
                <span class="dialog-option-label">{{ row.label }}</span>
                <span v-if="row.description !== null" class="dialog-option-desc">{{ row.description }}</span>
              </span>
            </AppButton>
          </li>
        </ul>

        <p v-if="content.hint !== null" class="hint-text whitespace-pre-wrap">{{ content.hint }}</p>

        <ul v-if="dialog.method === 'select'" ref="optionList" class="space-y-1.5">
          <li v-for="(row, position) in optionRows" :key="row.raw">
            <AppButton
              variant="unstyled"
              class="dialog-option-row"
              :class="{ 'dialog-option-row-active': position === highlighted }"
              :disabled="busy"
              @mouseenter="highlighted = position"
              @click="choose(row.raw)"
            >
              <span class="dialog-option-index">{{ position + 1 }}</span>
              <span class="min-w-0">
                <span class="dialog-option-label">{{ row.label }}</span>
                <span v-if="row.description !== null" class="dialog-option-desc">{{ row.description }}</span>
              </span>
            </AppButton>
          </li>
        </ul>

        <textarea
          v-else-if="dialog.method === 'editor'"
          v-model="draft"
          rows="8"
          class="text-control resize-y"
          autocomplete="off"
          spellcheck="false"
          :disabled="busy"
        ></textarea>

        <input
          v-else-if="dialog.method === 'input'"
          ref="inputControl"
          v-model="draft"
          type="text"
          class="text-control"
          :placeholder="dialog.placeholder ?? ''"
          autocomplete="off"
          spellcheck="false"
          :disabled="busy"
          @keydown.enter.prevent="submitValue"
        />

        <p v-if="respondState.phase === 'error'" role="alert" class="status-notice status-notice-error">
          {{ respondState.message }}
        </p>
      </div>

      <div class="dialog-footer">
        <p v-if="dialog.method === 'select'" class="mr-auto self-center text-2xs text-desk-muted">
          1-9 选择 · ↑↓ 移动 · Enter 确认
        </p>
        <AppButton :disabled="busy" @click="minimize">
          收起
        </AppButton>
        <AppButton :disabled="busy" @click="cancel">
          取消
        </AppButton>
        <AppButton
          v-if="dialog.method === 'confirm'"
          :disabled="busy"
          @click="confirmNo"
        >
          否
        </AppButton>
        <AppButton
          v-if="dialog.method === 'confirm'"
          variant="primary"
          :disabled="busy || !confirmationAvailable"
          @click="confirmYes"
        >
          是
        </AppButton>
        <AppButton
          v-if="dialog.method === 'input' || dialog.method === 'editor'"
          variant="primary"
          :disabled="busy || draft.trim() === ''"
          @click="submitValue"
        >
          确定
        </AppButton>
      </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
