<!--
  参数定义编辑器：定义工作流的启动参数。

  参数是运行前要填的值，节点提示词用 `{{名称}}` 引用；名称同时是占位符名，
  所以创建后不给改（改名等于改所有占位符），只能改标签、类型、必填、默认值与选项。
  名称自动生成 p1、p2……，用户只看到标签。
  弹层外壳交给 AppDialog：焦点、Escape 与遮罩关闭由它统一处理。
-->
<script setup lang="ts">
import { WORKFLOW_PARAMETER_TYPES } from '../../../../shared/workflow-api'
import type { WorkflowParameter, WorkflowParameterType } from '../../../../shared/workflow-api'
import AppButton from '../../ui/AppButton.vue'
import AppDialog from '../../ui/AppDialog.vue'

const props = defineProps<{
  readonly parameters: readonly WorkflowParameter[]
  readonly open: boolean
}>()

const emit = defineEmits<{
  close: []
  add: []
  update: [name: string, patch: Partial<Omit<WorkflowParameter, 'name'>>]
  remove: [name: string]
}>()

/** 表单取值：只接受真正带值的元素，避免把事件目标当成已知类型断言。 */
function inputValue(event: Event): string {
  const target = event.target
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return target.value
  return ''
}

function checkedValue(event: Event): boolean {
  const target = event.target
  return target instanceof HTMLInputElement ? target.checked : false
}

/** 下拉只认枚举里的值：手写选项与自定义取值都收敛到这里，非法值直接忽略。 */
function toParameterType(value: string): WorkflowParameterType | null {
  return WORKFLOW_PARAMETER_TYPES.find(type => type === value) ?? null
}

/** 选项编辑：一行一个选项，空行忽略。 */
function optionsText(parameter: WorkflowParameter): string {
  return parameter.options.join('\n')
}

function applyOptions(parameter: WorkflowParameter, text: string): void {
  const options = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  emit('update', parameter.name, { options })
}

function changeType(parameter: WorkflowParameter, value: string): void {
  const type = toParameterType(value)
  if (type === null) return
  emit('update', parameter.name, { type, options: type === 'select' ? parameter.options : [] })
}
</script>

<template>
  <AppDialog
    :open="props.open"
    title="启动参数"
    subtitle="参数在运行前填写；节点提示词里用双大括号引用参数名，未声明的占位符保存时会被拒绝。"
    panel-class="max-w-2xl"
    @close="emit('close')"
  >
    <p v-if="parameters.length === 0" class="text-xs text-desk-muted">还没有参数。</p>

    <ul v-else class="space-y-3">
      <li v-for="parameter in parameters" :key="parameter.name" class="space-y-3 rounded-desk-md border border-desk-line px-3.5 py-3">
        <div class="flex items-center gap-3">
          <code class="font-mono text-xs">&#123;&#123;{{ parameter.name }}&#125;&#125;</code>
          <label class="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              :checked="parameter.required"
              @change="emit('update', parameter.name, { required: checkedValue($event) })"
            >
            <span>必填</span>
          </label>
          <button
            type="button"
            class="ml-auto px-1.5 text-desk-muted"
            aria-label="删除参数"
            title="删除参数"
            @click="emit('remove', parameter.name)"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <label class="block space-y-1">
          <span class="field-label">标签</span>
          <input
            class="text-control"
            :value="parameter.label"
            maxlength="40"
            @input="emit('update', parameter.name, { label: inputValue($event) })"
          >
        </label>

        <label class="block space-y-1">
          <span class="field-label">类型</span>
          <select
            class="text-control"
            :value="parameter.type"
            @change="changeType(parameter, inputValue($event))"
          >
            <option v-for="type in WORKFLOW_PARAMETER_TYPES" :key="type" :value="type">
              {{ type === 'text' ? '文本' : '下拉选择' }}
            </option>
          </select>
        </label>

        <label v-if="parameter.type === 'select'" class="block space-y-1">
          <span class="field-label">选项（一行一个）</span>
          <textarea
            class="text-control resize-y [font-family:inherit]"
            rows="3"
            :value="optionsText(parameter)"
            @change="applyOptions(parameter, inputValue($event))"
          />
        </label>

        <label class="block space-y-1">
          <span class="field-label">默认值</span>
          <input
            class="text-control"
            :value="parameter.defaultValue"
            maxlength="400"
            @input="emit('update', parameter.name, { defaultValue: inputValue($event) })"
          >
        </label>
      </li>
    </ul>

    <template #footer>
      <AppButton variant="compact" @click="emit('add')">新增参数</AppButton>
      <AppButton @click="emit('close')">关闭</AppButton>
    </template>
  </AppDialog>
</template>
