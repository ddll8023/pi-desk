<!-- Extension dialog 模态对话框：按 method 呈现 select / confirm / input / editor 四种形态，一次只展示队首请求；取消发送 cancelled 响应。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import type { ExtensionDialogRequest, ExtensionDialogResponseInput } from '../../../shared/extension-ui-api'
import { useExtensionUiStore } from '../stores/extension-ui'

const extensionStore = useExtensionUiStore()
const { respondState } = storeToRefs(extensionStore)

const emit = defineEmits<{
  /** 本条对话已回应（含取消），队列可能仍有下一条。 */
  settled: []
}>()

const titleId = useId()
const draft = ref('')

/** 当前展示的队首请求；由 App.vue 保证只在有请求时挂载。 */
const dialog = computed<ExtensionDialogRequest | null>(() => extensionStore.dialogs[0] ?? null)

watch(
  dialog,
  (value) => {
    // 换一条对话时重置编辑值：editor 用 prefill，input 从空白开始。
    draft.value = value?.method === 'editor' ? (value.prefill ?? '') : ''
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

async function respondCurrent(response: ExtensionDialogResponseInput): Promise<void> {
  const current = dialog.value
  if (current === null || busy.value) return
  await extensionStore.respond(current.id, response)
  if (respondState.value.phase !== 'error') emit('settled')
}

function onKeydown(event: KeyboardEvent): void {
  // Escape 表示取消当前对话；Enter 在 input/editor 中交由表单与多行语义处理。
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    v-if="dialog !== null"
    class="dialog-overlay"
    @click.self="cancel"
  >
    <div
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      class="dialog-panel max-w-lg"
    >
      <div class="dialog-header">
        <h2 :id="titleId" class="dialog-title break-words">{{ dialog.title }}</h2>
      </div>

      <div class="dialog-body">
        <p v-if="dialog.message !== null" class="whitespace-pre-wrap text-sm leading-6">
          {{ dialog.message }}
        </p>

        <ul v-if="dialog.method === 'select'" class="space-y-1">
          <li v-for="option in dialog.options" :key="option">
            <button
              type="button"
              class="list-item border-desk-line text-xs"
              :disabled="busy"
              @click="choose(option)"
            >
              {{ option }}
            </button>
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
        <button type="button" class="control-button" :disabled="busy" @click="cancel">
          取消
        </button>
        <button
          v-if="dialog.method === 'confirm'"
          type="button"
          class="control-button"
          :disabled="busy"
          @click="confirmNo"
        >
          否
        </button>
        <button
          v-if="dialog.method === 'confirm'"
          type="button"
          class="control-button-primary"
          :disabled="busy"
          @click="confirmYes"
        >
          是
        </button>
        <button
          v-if="dialog.method === 'input' || dialog.method === 'editor'"
          type="button"
          class="control-button-primary"
          :disabled="busy || draft.trim() === ''"
          @click="submitValue"
        >
          确定
        </button>
      </div>
    </div>
  </div>
</template>
