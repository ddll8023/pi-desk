<!-- 手机待回应面板：以内联可折叠区域呈现问题，保留原始选项值；确认正文缺失时不允许批准。 -->
<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { ExtensionDialogRequest, ExtensionDialogResponseInput } from '../../../shared/extension-ui-api'
import { parseDialogTitle, parseOptionRows, parseSelectionTokens, toggleSelection } from '../../../renderer/src/sessions/extension-dialog-presentation'

const props = defineProps<{ readonly dialog: ExtensionDialogRequest; readonly busy: boolean; readonly blocked: boolean }>()
const emit = defineEmits<{ respond: [dialogId: string, response: ExtensionDialogResponseInput] }>()
const titleId = useId()
const inputId = useId()
const draft = ref('')
const content = computed(() => parseDialogTitle(props.dialog.title))
const options = computed(() => parseOptionRows(props.dialog.options))
const selected = computed(() => new Set(parseSelectionTokens(draft.value).tokens))
const toggleable = computed(() => props.dialog.method === 'input' && content.value.list !== null && /^\d/.test(props.dialog.placeholder ?? ''))
const disabled = computed(() => props.busy || props.blocked)
watch(() => props.dialog.id, () => { draft.value = props.dialog.method === 'editor' ? props.dialog.prefill ?? '' : '' }, { immediate: true })
function respond(response: ExtensionDialogResponseInput): void {
  if (disabled.value) return
  emit('respond', props.dialog.id, response)
}
</script>

<template>
  <details class="mobile-question scroll-area" open :aria-labelledby="titleId">
    <summary :id="titleId">电脑正在等待你的回应</summary>
    <div class="mobile-question-body">
      <p v-if="content.header" class="mobile-eyebrow">{{ content.header }}</p>
      <h2>{{ content.question }}</h2>
      <p v-if="dialog.message" class="mobile-question-text">{{ dialog.message }}</p>
      <template v-if="dialog.method === 'select'">
        <button v-for="option in options" :key="option.raw" type="button" class="mobile-option" :disabled="disabled" @click="respond({ kind: 'value', value: option.raw })">
          <span>{{ option.label }}</span><small v-if="option.description">{{ option.description }}</small>
        </button>
      </template>
      <template v-else-if="dialog.method === 'confirm'">
        <p v-if="!dialog.message?.trim()" class="mobile-error">缺少确认正文，请回到桌面查看；手机不会代为批准。</p>
        <div class="mobile-actions"><button type="button" class="control-button-primary" :disabled="disabled || !dialog.message?.trim()" @click="respond({ kind: 'confirm', confirmed: true })">确认</button><button type="button" class="control-button" :disabled="disabled" @click="respond({ kind: 'confirm', confirmed: false })">拒绝</button></div>
      </template>
      <template v-else>
        <div v-if="content.list" class="mobile-reference-options">
          <template v-for="(option, index) in content.list" :key="index">
            <button v-if="toggleable" type="button" class="mobile-option" :aria-pressed="selected.has(String(index + 1))" :disabled="disabled" @click="draft = toggleSelection(draft, index + 1)"><span>{{ index + 1 }}. {{ option.label }}</span><small v-if="option.description">{{ option.description }}</small></button>
            <p v-else class="mobile-question-text">{{ index + 1 }}. {{ option.label }}<small v-if="option.description" class="block mobile-muted">{{ option.description }}</small></p>
          </template>
        </div>
        <p v-if="content.hint" class="mobile-muted">{{ content.hint }}</p>
        <form @submit.prevent="respond({ kind: 'value', value: draft })">
          <label :for="inputId" class="field-label">你的回答</label>
          <textarea :id="inputId" v-model="draft" class="text-control scroll-area" :rows="dialog.method === 'editor' ? 5 : 2" :placeholder="dialog.placeholder ?? ''" :disabled="disabled" maxlength="4000" />
          <button type="submit" class="control-button-primary" :disabled="disabled || !draft.trim()">发送回答</button>
        </form>
      </template>
      <details v-for="preview in content.previews" :key="preview.index" class="mobile-detail"><summary>{{ preview.label || '选项预览' }}</summary><pre class="scroll-area">{{ preview.text }}</pre></details>
      <button type="button" class="mobile-link-button" :disabled="disabled" @click="respond({ kind: 'cancelled' })">取消本次回应</button>
      <p v-if="blocked" role="status" class="mobile-muted">当前连接未同步或有结果未知的操作，暂不能回应。</p>
    </div>
  </details>
</template>
