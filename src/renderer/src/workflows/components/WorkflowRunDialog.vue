<!--
  启动对话框：运行前填参数。

  必填项没填时拦住提交，并在字段下说明缺哪一项——模板占位符要靠这些值替换，
  缺了跑到一半才发现比在这里拦住代价大。默认值预填，用户只改要改的那几个。
  弹层外壳交给 AppDialog：焦点、Escape 与遮罩关闭由它统一处理，这里只保留表单。
-->
<script setup lang="ts">
import { ref, watch } from 'vue'
import type { WorkflowParameter, WorkflowParameterValues } from '../../../../shared/workflow-api'
import AppButton from '../../ui/AppButton.vue'
import AppDialog from '../../ui/AppDialog.vue'

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
  <AppDialog
    :open="props.open"
    title="运行"
    subtitle="参数在启动前填一次；节点提示词里的占位符按这些值替换。"
    panel-class="max-w-lg"
    @close="emit('close')"
  >
    <p v-if="parameters.length === 0" class="text-xs text-desk-muted">这份工作流没有参数，直接运行即可。</p>
    <p v-if="props.error !== null" class="text-xs text-desk-danger">{{ props.error }}</p>

    <div class="space-y-4">
      <label v-for="parameter in parameters" :key="parameter.name" class="block space-y-1">
        <span class="field-label">
          {{ parameter.label }}
          <span v-if="parameter.required" class="ml-1 text-2xs text-desk-danger">必填</span>
          <code class="ml-1.5 font-mono text-2xs text-desk-muted">&#123;&#123;{{ parameter.name }}&#125;&#125;</code>
        </span>
        <select
          v-if="parameter.type === 'select'"
          v-model="values[parameter.name]"
          class="text-control"
        >
          <option value="">（不填）</option>
          <option v-for="option in parameter.options" :key="option" :value="option">{{ option }}</option>
        </select>
        <input
          v-else
          v-model="values[parameter.name]"
          class="text-control"
          maxlength="400"
        >
        <span v-if="missing.includes(parameter.name)" class="text-xs text-desk-danger">这一项必填。</span>
      </label>
    </div>

    <template #footer>
      <AppButton @click="emit('close')">取消</AppButton>
      <AppButton variant="primary" :disabled="props.busy" @click="submit">
        {{ props.busy ? '启动中…' : '开始运行' }}
      </AppButton>
    </template>
  </AppDialog>
</template>
