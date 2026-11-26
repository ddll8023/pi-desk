<!--
  参数定义编辑器：定义工作流的启动参数。

  参数是运行前要填的值，节点提示词用 `{{名称}}` 引用；名称同时是占位符名，
  所以创建后不给改（改名等于改所有占位符），只能改标签、类型、必填、默认值与选项。
  名称自动生成 p1、p2……，用户只看到标签。
-->
<script setup lang="ts">
import { WORKFLOW_PARAMETER_TYPES } from '../../../../shared/workflow-api'
import type { WorkflowParameter, WorkflowParameterType } from '../../../../shared/workflow-api'
import AppButton from '../../ui/AppButton.vue'

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

/** 选项编辑：一行一个选项，空行忽略。 */
function optionsText(parameter: WorkflowParameter): string {
  return parameter.options.join('\n')
}

function applyOptions(parameter: WorkflowParameter, text: string): void {
  const options = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  emit('update', parameter.name, { options })
}

function changeType(parameter: WorkflowParameter, type: WorkflowParameterType): void {
  emit('update', parameter.name, { type, options: type === 'select' ? parameter.options : [] })
}
</script>

<template>
  <div v-if="props.open" class="workflow-overlay" role="dialog" aria-label="工作流参数">
    <section class="workflow-dialog">
      <header class="workflow-dialog-head">
        <h2 class="text-sm font-semibold">启动参数</h2>
        <AppButton variant="compact" @click="emit('close')">关闭</AppButton>
      </header>
      <p class="workflow-hint">
        参数在运行前填写；节点提示词里用 <code>&#123;&#123;名称&#125;&#125;</code> 引用。未声明的占位符保存时会被拒绝。
      </p>

      <p v-if="parameters.length === 0" class="workflow-hint">还没有参数。</p>

      <ul class="workflow-parameter-list">
        <li v-for="parameter in parameters" :key="parameter.name" class="workflow-parameter">
          <div class="workflow-parameter-head">
            <code class="workflow-parameter-name">&#123;&#123;{{ parameter.name }}&#125;&#125;</code>
            <label class="workflow-inline">
              <input
                type="checkbox"
                :checked="parameter.required"
                @change="emit('update', parameter.name, { required: ($event.target as HTMLInputElement).checked })"
              >
              <span>必填</span>
            </label>
            <button type="button" class="workflow-parameter-remove" title="删除参数" @click="emit('remove', parameter.name)">
              ×
            </button>
          </div>

          <label class="workflow-field">
            <span>标签</span>
            <input
              class="workflow-input"
              :value="parameter.label"
              maxlength="40"
              @input="emit('update', parameter.name, { label: ($event.target as HTMLInputElement).value })"
            >
          </label>

          <label class="workflow-field">
            <span>类型</span>
            <select
              class="workflow-input"
              :value="parameter.type"
              @change="changeType(parameter, ($event.target as HTMLSelectElement).value as WorkflowParameterType)"
            >
              <option v-for="type in WORKFLOW_PARAMETER_TYPES" :key="type" :value="type">
                {{ type === 'text' ? '文本' : '下拉选择' }}
              </option>
            </select>
          </label>

          <label v-if="parameter.type === 'select'" class="workflow-field">
            <span>选项（一行一个）</span>
            <textarea
              class="workflow-input workflow-textarea"
              rows="3"
              :value="optionsText(parameter)"
              @change="applyOptions(parameter, ($event.target as HTMLTextAreaElement).value)"
            />
          </label>

          <label class="workflow-field">
            <span>默认值</span>
            <input
              class="workflow-input"
              :value="parameter.defaultValue"
              maxlength="400"
              @input="emit('update', parameter.name, { defaultValue: ($event.target as HTMLInputElement).value })"
            >
          </label>
        </li>
      </ul>

      <AppButton variant="compact" @click="emit('add')">新增参数</AppButton>
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
  width: min(560px, calc(100vw - 48px));
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

.workflow-hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-desk-muted);
}

.workflow-parameter-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.workflow-parameter {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--color-desk-border);
  border-radius: 8px;
}

.workflow-parameter-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.workflow-parameter-name {
  font-size: 12px;
}

.workflow-parameter-remove {
  margin-left: auto;
  padding: 0 6px;
  color: var(--color-desk-muted);
}

.workflow-inline {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.workflow-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.workflow-input {
  padding: 5px 8px;
  border: 1px solid var(--color-desk-border);
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
}

.workflow-textarea {
  resize: vertical;
  font-family: inherit;
}
</style>
