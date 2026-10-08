<!-- Prompt 输入区：处理输入法组合态、Enter 发送与 Shift+Enter 换行、焦点回归与重复提交，并在 Agent 运行期间原位提供停止入口。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import type { PromptDisposition } from '../../../shared/runtime-api'
import { useRuntimeStore } from '../stores/runtime'

const runtimeStore = useRuntimeStore()
const { view: runtimeView, promptView, abortView, projectionSync } = storeToRefs(runtimeStore)

const draft = ref('')
/** 输入法组合态：此期间的 Enter 只确认候选词，不能当发送。 */
const composing = ref(false)
const textarea = ref<HTMLTextAreaElement | null>(null)

const runtimeReady = computed(() => runtimeView.value.phase === 'ready')
const runtimeInfo = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const streaming = computed(() => runtimeInfo.value?.isStreaming === true)
const sending = computed(() => promptView.value.phase === 'sending')
const stopVisible = computed(() => (
  runtimeReady.value && (streaming.value || abortView.value.phase === 'requesting')
))
/** 与主进程的拒绝条件一致：未就绪、发送中、投影未同步或已有运行中的操作都不提交。 */
const canSend = computed(() => runtimeReady.value
  && draft.value.trim() !== ''
  && !sending.value
  && projectionSync.value === 'synced'
  && !streaming.value)

const status = computed(() => {
  if (abortView.value.phase === 'error') {
    return { kind: 'error' as const, text: abortView.value.error.message }
  }
  if (abortView.value.phase === 'requesting') {
    return { kind: 'info' as const, text: '正在停止当前操作，等待本轮结束。' }
  }
  if (promptView.value.phase === 'error') {
    return { kind: 'error' as const, text: promptView.value.error.message }
  }
  if (sending.value) return { kind: 'info' as const, text: '正在提交 Prompt，等待 Pi 回应。' }
  if (promptView.value.phase === 'accepted') {
    return { kind: 'info' as const, text: acceptedText(promptView.value.disposition) }
  }
  if (!runtimeReady.value) {
    return { kind: 'info' as const, text: '没有已就绪的 Runtime；先在左侧打开或新建会话。' }
  }
  if (streaming.value) {
    return { kind: 'info' as const, text: 'Agent 正在运行，本轮结束前不能提交新输入。' }
  }
  if (projectionSync.value !== 'synced') {
    return { kind: 'info' as const, text: '消息仍在同步，稍后才能提交输入。' }
  }
  return { kind: 'info' as const, text: 'Enter 发送，Shift+Enter 换行。' }
})

function acceptedText(disposition: PromptDisposition): string {
  if (disposition === 'started') return 'Pi 已接受并开始执行。'
  if (disposition === 'queued') return 'Pi 已将本次输入排队。'
  return '本次输入已被处理，未发起新的 Agent run。'
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  // keyCode 229 是部分输入法在组合态下上报的值，一并排除。
  if (composing.value || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  void submit()
}

/** 提交当前输入；只有本次请求被接受时清空，且不覆盖发送期间新输入的文字。 */
async function submit(): Promise<void> {
  if (!canSend.value) return

  const message = draft.value
  const before = promptView.value
  await runtimeStore.send(message)
  if (promptView.value === before || promptView.value.phase !== 'accepted') return

  if (draft.value === message) draft.value = ''
  textarea.value?.focus()
}

function stop(): void {
  void runtimeStore.stopOperation()
}

onMounted(() => {
  textarea.value?.focus()
})
</script>

<template>
  <section class="border-t border-desk-line bg-desk-surface px-4 py-3 sm:px-8">
    <div class="mx-auto max-w-3xl">
      <label for="prompt-input" class="sr-only">输入要发送给 Pi 的内容</label>
      <textarea
        id="prompt-input"
        ref="textarea"
        v-model="draft"
        rows="3"
        class="text-control resize-none"
        placeholder="输入要发送给 Pi 的内容"
        autocomplete="off"
        spellcheck="false"
        aria-describedby="prompt-status"
        @keydown="onKeydown"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      ></textarea>

      <div class="mt-2 flex flex-wrap items-center justify-between gap-3">
        <p
          id="prompt-status"
          :role="status.kind === 'error' ? 'alert' : 'status'"
          class="text-xs"
          :class="status.kind === 'error' ? 'text-desk-danger' : 'text-desk-muted'"
        >
          {{ status.text }}
        </p>
        <button
          v-if="stopVisible"
          type="button"
          class="control-button"
          :disabled="abortView.phase === 'requesting'"
          @click="stop"
        >
          {{ abortView.phase === 'requesting' ? '正在停止…' : '停止' }}
        </button>
        <button v-else type="button" class="control-button" :disabled="!canSend" @click="submit">
          发送
        </button>
      </div>
    </div>
  </section>
</template>
