<!--
  节点检查器：选中节点的配置。

  节点类型不同可编辑的字段也不同：开始与结束节点只有标题；Agent 节点多出专家、提示词与写入范围；
  审批门只有标题与一段给人看的说明，那段说明不进模型指令，它解释的是「这一步在确认什么」。
  写入范围用一行一个路径的文本框表达，空 = 不限制，写 `/` = 只读。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SessionExpertView } from '../../../../shared/session-api'
import { MAX_WORKFLOW_APPROVAL_NOTE_LENGTH } from '../../../../shared/workflow-api'
import type { WorkflowNode } from '../../../../shared/workflow-api'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly node: WorkflowNode
  readonly experts: readonly SessionExpertView[]
}>()

const emit = defineEmits<{
  update: [patch: Partial<Omit<WorkflowNode, 'id' | 'type'>>]
  remove: []
}>()

const scopeText = ref('')
const scopeInvalid = ref<string | null>(null)

watch(() => props.node, node => {
  scopeText.value = node.writeScope === null ? '' : node.writeScope.join('\n')
  scopeInvalid.value = null
}, { immediate: true })

const isAgent = computed(() => props.node.type === 'agent')
const isApproval = computed(() => props.node.type === 'approval')
const removable = computed(() => props.node.type !== 'start' && props.node.type !== 'end')

/** 写入范围的三态：留空 = 不限制；只写 `/` = 只读；其余一行一个相对路径。 */
function applyScope(): void {
  const lines = scopeText.value.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines.length === 1 && lines[0] === '/') {
    scopeInvalid.value = null
    emit('update', { writeScope: [] })
    return
  }
  const invalid = lines.find(line => line.startsWith('/') || line.includes('\\') || line.split('/').includes('..'))
  if (invalid !== undefined) {
    scopeInvalid.value = `写法不合法：${invalid}。只接受项目内相对路径，或写 / 表示只读。`
    return
  }
  scopeInvalid.value = null
  emit('update', { writeScope: lines.length === 0 ? null : lines })
}
</script>

<template>
  <section class="workflow-inspector">
    <header class="workflow-inspector-head">
      <h2 class="text-sm font-semibold">{{ node.title }}</h2>
      <span class="text-2xs text-desk-muted">
        {{ isAgent ? 'Agent 节点' : isApproval ? '审批门' : node.type === 'start' ? '开始节点' : '结束节点' }}
      </span>
    </header>

    <label class="workflow-field">
      <span>标题</span>
      <input
        class="workflow-input"
        :value="node.title"
        maxlength="40"
        @input="emit('update', { title: ($event.target as HTMLInputElement).value })"
      >
    </label>

    <label v-if="isApproval" class="workflow-field">
      <span>说明</span>
      <textarea
        class="workflow-input workflow-textarea"
        :value="node.prompt"
        rows="4"
        :maxlength="MAX_WORKFLOW_APPROVAL_NOTE_LENGTH"
        placeholder="这一步在确认什么；给运行面板看，不进模型指令"
        @input="emit('update', { prompt: ($event.target as HTMLTextAreaElement).value })"
      />
    </label>

    <template v-if="isAgent">
      <label class="workflow-field">
        <span>专家</span>
        <select
          class="workflow-input"
          :value="node.expertId ?? ''"
          @change="emit('update', { expertId: ($event.target as HTMLSelectElement).value === '' ? null : ($event.target as HTMLSelectElement).value })"
        >
          <option value="">不选专家</option>
          <option v-for="expert in experts" :key="expert.id" :value="expert.id">{{ expert.displayName }}</option>
        </select>
      </label>

      <label class="workflow-field">
        <span>提示词</span>
        <textarea
          class="workflow-input workflow-textarea"
          :value="node.prompt"
          rows="6"
          maxlength="8000"
          placeholder="这个节点这一轮要做什么"
          @input="emit('update', { prompt: ($event.target as HTMLTextAreaElement).value })"
        />
      </label>

      <label class="workflow-field">
        <span>写入范围</span>
        <textarea
          v-model="scopeText"
          class="workflow-input workflow-textarea"
          rows="3"
          placeholder="留空不限制；写 / 表示只读；其余一行一个项目内相对路径"
          @change="applyScope"
        />
      </label>
      <p v-if="scopeInvalid !== null" class="workflow-error">{{ scopeInvalid }}</p>
    </template>

    <AppButton
      v-if="removable"
      variant="danger"
      class="mt-2 w-full"
      @click="emit('remove')"
    >
      删除节点
    </AppButton>
  </section>
</template>

<style scoped>
.workflow-inspector {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.workflow-inspector-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
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

.workflow-error {
  font-size: 12px;
  color: var(--color-desk-danger);
}
</style>
