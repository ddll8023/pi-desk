<!-- Extension dialog 模态对话框：按 method 呈现 select / confirm / input / editor 四种形态，一次只展示队首请求；取消发送 cancelled 响应，收起只隐藏弹窗、请求仍等回应。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import type { ExtensionDialogRequest, ExtensionDialogResponseInput } from '../../../shared/extension-ui-api'
import { useExtensionUiStore } from '../stores/extension-ui'
import AppButton from './ui/AppButton.vue'

const extensionStore = useExtensionUiStore()
const { respondState } = storeToRefs(extensionStore)

const emit = defineEmits<{
  /** 本条对话已回应（含取消），队列可能仍有下一条。 */
  settled: []
}>()

const titleId = useId()
const draft = ref('')

/** 当前队首请求；没有请求或已收起时不渲染弹窗。 */
const dialog = computed<ExtensionDialogRequest | null>(() => extensionStore.dialogs[0] ?? null)

/** 被收起的对话不渲染弹窗，但请求仍在队列里等回应；底部入口负责恢复。 */
const minimized = computed(() => dialog.value !== null && extensionStore.minimizedDialogId === dialog.value.id)

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

/** 收起当前对话：不提交响应，Pi 侧继续等待，可从输入区底部恢复。 */
function minimize(): void {
  const current = dialog.value
  if (current === null) return
  extensionStore.minimizeDialog(current.id)
}

async function respondCurrent(response: ExtensionDialogResponseInput): Promise<void> {
  const current = dialog.value
  if (current === null || busy.value) return
  await extensionStore.respond(current.id, response)
  if (respondState.value.phase !== 'error') emit('settled')
}

function onKeydown(event: KeyboardEvent): void {
  // Escape 表示取消当前对话；收起状态下弹窗不在眼前，不能代替用户取消。
  if (dialog.value === null || minimized.value) return
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
  <Transition name="dialog-fade">
    <div
      v-if="dialog !== null && !minimized"
      class="dialog-overlay"
      @click.self="cancel"
    >
      <Transition name="dialog-panel-motion" appear>
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

        <ul v-if="dialog.method === 'select'" class="space-y-1.5">
          <li v-for="option in dialog.options" :key="option">
            <AppButton
              variant="unstyled"
              class="list-card text-xs"
              :disabled="busy"
              @click="choose(option)"
            >
              {{ option }}
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
          :disabled="busy"
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
