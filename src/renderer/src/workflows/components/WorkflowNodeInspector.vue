<!--
  节点检查器：选中节点的配置。

  节点类型不同可编辑的字段也不同：开始与结束节点只有标题；Agent 节点多出专家、提示词与写入范围；
  审批门只有标题与一段给人看的说明，那段说明不进模型指令，它解释的是「这一步在确认什么」。
  写入范围用一行一个路径的文本框表达，空 = 不限制，写 `/` = 只读。
  连线除画布拖拽外还在这里给一个下拉入口：键盘用户选中节点后可选目标并建边，
  路由取工具栏当前的「新连线路由」，与拖拽写同一份草稿。
  表单控件沿用全局 field-label 与 text-control，取值走本地帮助函数，不再对事件目标做类型断言。
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
  /** 同图的全部节点：连线下拉用它列出可选目标。 */
  readonly nodes: readonly WorkflowNode[]
}>()

const emit = defineEmits<{
  update: [patch: Partial<Omit<WorkflowNode, 'id' | 'type'>>]
  remove: []
  connect: [targetId: string]
}>()

const scopeText = ref('')
const scopeInvalid = ref<string | null>(null)
const connectTarget = ref('')

watch(() => props.node, node => {
  scopeText.value = node.writeScope === null ? '' : node.writeScope.join('\n')
  scopeInvalid.value = null
  // 换选中节点时丢掉上一条已选目标：否则会对另一张卡片的旧目标建边。
  connectTarget.value = ''
}, { immediate: true })

const isAgent = computed(() => props.node.type === 'agent')
const isApproval = computed(() => props.node.type === 'approval')
const removable = computed(() => props.node.type !== 'start' && props.node.type !== 'end')
/** 可选连线目标：除自己以外的节点；具体合法性（重复边、自连、上限）仍由 store 判定并提示。 */
const connectCandidates = computed(() => props.nodes.filter(item => item.id !== props.node.id))

function connect(): void {
  if (connectTarget.value === '') return
  emit('connect', connectTarget.value)
  connectTarget.value = ''
}

/** 表单取值：只接受真正带值的元素，不把事件目标当成已知类型断言。 */
function inputValue(event: Event): string {
  const target = event.target
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return target.value
  return ''
}

/** 专家下拉：空串表示「不选专家」，其余按标识原样上报。 */
function selectExpertId(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  emit('update', { expertId: target.value === '' ? null : target.value })
}

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

    <label class="block space-y-1">
      <span class="field-label">标题</span>
      <input
        class="text-control"
        :value="node.title"
        maxlength="40"
        @input="emit('update', { title: inputValue($event) })"
      >
    </label>

    <label v-if="isApproval" class="block space-y-1">
      <span class="field-label">说明</span>
      <textarea
        class="text-control resize-y [font-family:inherit]"
        :value="node.prompt"
        rows="4"
        :maxlength="MAX_WORKFLOW_APPROVAL_NOTE_LENGTH"
        placeholder="这一步在确认什么；给运行面板看，不进模型指令"
        @input="emit('update', { prompt: inputValue($event) })"
      />
    </label>

    <template v-if="isAgent">
      <label class="block space-y-1">
        <span class="field-label">专家</span>
        <select class="text-control" :value="node.expertId ?? ''" @change="selectExpertId($event)">
          <option value="">不选专家</option>
          <option v-for="expert in experts" :key="expert.id" :value="expert.id">{{ expert.displayName }}</option>
        </select>
      </label>

      <label class="block space-y-1">
        <span class="field-label">提示词</span>
        <textarea
          class="text-control resize-y [font-family:inherit]"
          :value="node.prompt"
          rows="6"
          maxlength="8000"
          placeholder="这个节点这一轮要做什么"
          @input="emit('update', { prompt: inputValue($event) })"
        />
      </label>

      <label class="block space-y-1">
        <span class="field-label">写入范围</span>
        <textarea
          v-model="scopeText"
          class="text-control resize-y [font-family:inherit]"
          rows="3"
          placeholder="留空不限制；写 / 表示只读；其余一行一个项目内相对路径"
          @change="applyScope"
        />
      </label>
      <p v-if="scopeInvalid !== null" class="text-xs text-desk-danger">{{ scopeInvalid }}</p>
    </template>

    <div v-if="connectCandidates.length > 0" class="space-y-1 border-t border-desk-line pt-2.5">
      <label class="block space-y-1">
        <span class="field-label">连到节点</span>
        <select v-model="connectTarget" class="text-control">
          <option value="">选择目标节点</option>
          <option v-for="item in connectCandidates" :key="item.id" :value="item.id">{{ item.title }}</option>
        </select>
      </label>
      <AppButton variant="compact" class="w-full" :disabled="connectTarget === ''" @click="connect">
        建立连线
      </AppButton>
    </div>

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
</style>
