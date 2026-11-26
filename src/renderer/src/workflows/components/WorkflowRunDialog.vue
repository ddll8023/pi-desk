<!--
  启动对话框：运行前填参数。

  必填项没填时拦住提交，并在字段下说明缺哪一项——模板占位符要靠这些值替换，
  缺了跑到一半才发现比在这里拦住代价大。默认值预填，用户只改要改的那几个。
-->
<script setup lang="ts">
import { ref, watch } from 'vue'
import type { WorkflowParameter, WorkflowParameterValues } from '../../../../shared/workflow-api'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly open: boolean
  readonly parameters: readonly WorkflowParameter[]
  readonly busy: boolean
  /** 启动失败的原因：写在框内，否则用户点完看不出任何变化。 */
  readonly error: string | null
}>()

const emit = defineEmits<{
  close: []
  submit: [values: WorkflowParameterValues]
}>()

const values = ref<Record<string, string>>({})
const missing = ref<string[]>([])

watch(() => props.open, open => {
  if (!open) return
  const next: Record<string, string> = {}
  for (const parameter of props.parameters) next[parameter.name] = parameter.defaultValue
  values.value = next
  missing.value = []
}, { immediate: true })

function submit(): void {
  const absent = props.parameters
    .filter(parameter => parameter.required && (values.value[parameter.name] ?? '').trim() === '')
    .map(parameter => parameter.name)
  missing.value = absent
  if (absent.length > 0) return
  emit('submit', { ...values.value })
}
</script>

<template>
  <div v-if="props.open" class="workflow-overlay" role="dialog" aria-label="运行工作流">
    <section class="workflow-dialog">
      <header class="workflow-dialog-head">
        <h2 class="text-sm font-semibold">运行</h2>
        <AppButton variant="compact" @click="emit('close')">取消</AppButton>
      </header>

      <p v-if="parameters.length === 0" class="workflow-hint">这份工作流没有参数，直接运行即可。</p>
      <p v-if="props.error !== null" class="workflow-error">{{ props.error }}</p>

      <label v-for="parameter in parameters" :key="parameter.name" class="workflow-field">
        <span>
          {{ parameter.label }}
          <span v-if="parameter.required" class="workflow-required">必填</span>
          <code class="workflow-parameter-name">&#123;&#123;{{ parameter.name }}&#125;&#125;</code>
        </span>
        <select
          v-if="parameter.type === 'select'"
          v-model="values[parameter.name]"
          class="workflow-input"
        >
          <option value="">（不填）</option>
          <option v-for="option in parameter.options" :key="option" :value="option">{{ option }}</option>
        </select>
        <input
          v-else
          v-model="values[parameter.name]"
          class="workflow-input"
          maxlength="400"
        >
        <span v-if="missing.includes(parameter.name)" class="workflow-error">这一项必填。</span>
      </label>

      <div class="workflow-dialog-actions">
        <AppButton variant="primary" :disabled="props.busy" @click="submit">
          {{ props.busy ? '启动中…' : '开始运行' }}
        </AppButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
.workflow-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-desk-overlay);
}

.workflow-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(480px, calc(100vw - 48px));
  max-height: calc(100vh - 96px);
  padding: 16px;
  overflow-y: auto;
  border-radius: 10px;
  background: var(--color-desk-surface);
  border: 1px solid var(--color-desk-border);
}

.workflow-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.workflow-dialog-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}

.workflow-hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-desk-muted);
}

.workflow-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.workflow-required {
  margin-left: 4px;
  color: var(--color-desk-danger);
}

.workflow-parameter-name {
  margin-left: 6px;
  font-size: 11px;
  color: var(--color-desk-muted);
}

.workflow-input {
  padding: 5px 8px;
  border: 1px solid var(--color-desk-border);
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
}

.workflow-error {
  font-size: 12px;
  color: var(--color-desk-danger);
}
</style>
