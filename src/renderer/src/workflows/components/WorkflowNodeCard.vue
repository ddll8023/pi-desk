<!--
  画布上的自定义节点：类型徽标、标题与配置摘要，左右各一个连接点。

  节点只负责显示与连线锚点，所有编辑都在右侧检查器里完成：
  节点卡片上的输入会与画布的拖动、选中手势互相干扰。
  审批门节点不跑进程，外观上用实线边框与「等待审批」状态与 Agent 节点区分。
  卡片本身可聚焦：键盘用户 Tab 到节点后按 Enter／空格即选中，配置在检查器里继续；
  选中动作由画布通过 `data.onSelect` 注入，卡片不直接依赖 store。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position } from '@xyflow/vue'
import { WORKFLOW_NODE_STATUS_LABELS } from '../../../../shared/workflow-api'
import type { WorkflowNode, WorkflowNodeStatus } from '../../../../shared/workflow-api'

const props = defineProps<{
  readonly data: {
    readonly node: WorkflowNode
    readonly expertName: string | null
    readonly runStatus: WorkflowNodeStatus | null
    /** 选中该节点：由画布提供，卡片只报标识。 */
    readonly onSelect: (nodeId: string) => void
  }
}>()

const node = computed(() => props.data.node)
const runStatus = computed(() => props.data.runStatus)
const tone = computed(() => {
  if (node.value.type === 'start') return 'is-start'
  if (node.value.type === 'end') return 'is-end'
  if (node.value.type === 'approval') return 'is-approval'
  return 'is-agent'
})
const badge = computed(() => {
  if (node.value.type === 'approval') return 'APPROVAL'
  if (node.value.type === 'start') return 'START'
  if (node.value.type === 'end') return 'END'
  return 'AGENT'
})
const typeLabel = computed(() => {
  if (node.value.type === 'approval') return '审批门'
  if (node.value.type === 'start') return '开始节点'
  if (node.value.type === 'end') return '结束节点'
  return 'Agent 节点'
})
const summary = computed(() => {
  if (node.value.type !== 'agent') return ''
  const expert = props.data.expertName
  if (expert === null) return '未选专家'
  const scope = node.value.writeScope === null
    ? '可写'
    : node.value.writeScope.length === 0 ? '只读' : `写入 ${node.value.writeScope.length} 项`
  return `${expert} · ${scope}`
})
const approvalNote = computed(() => (
  node.value.type === 'approval' ? node.value.prompt.trim() : ''
))
const promptMissing = computed(() => node.value.type === 'agent' && node.value.prompt.trim() === '')

function select(): void {
  props.data.onSelect(node.value.id)
}
</script>

<template>
  <div
    class="workflow-node"
    :class="[tone, runStatus === null ? '' : `is-${runStatus}`]"
    role="button"
    tabindex="0"
    :aria-label="`${typeLabel}：${node.title}`"
    @keydown.enter.prevent="select"
    @keydown.space.prevent="select"
  >
    <Handle type="target" :position="Position.Left" />
    <div class="workflow-node-head">
      <span class="workflow-node-badge">{{ badge }}</span>
      <span class="workflow-node-title">{{ node.title }}</span>
    </div>
    <p v-if="node.type === 'agent'" class="workflow-node-summary">{{ summary }}</p>
    <p v-if="approvalNote !== ''" class="workflow-node-summary">{{ approvalNote }}</p>
    <p v-if="promptMissing" class="workflow-node-warn">还没有填写提示词</p>
    <p v-if="runStatus === 'waiting'" class="workflow-node-waiting">等待审批</p>
    <p v-else-if="runStatus !== null && runStatus !== 'idle'" class="workflow-node-status">
      {{ WORKFLOW_NODE_STATUS_LABELS[runStatus] }}
    </p>
    <Handle type="source" :position="Position.Right" />
  </div>
</template>

<style scoped>
.workflow-node {
  min-width: 168px;
  max-width: 240px;
  padding: 8px 10px;
  border: 1px solid var(--color-desk-border);
  border-radius: 8px;
  background: var(--color-desk-surface);
  font-size: 12px;
}

.workflow-node.is-start,
.workflow-node.is-end {
  border-style: dashed;
}

.workflow-node.is-approval {
  background: var(--color-desk-warning-soft);
}

.workflow-node.is-waiting {
  border-color: var(--color-desk-warning);
  box-shadow: 0 0 0 2px var(--color-desk-warning-soft);
}

.workflow-node.is-failed {
  border-color: var(--color-desk-danger);
}

.workflow-node-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.workflow-node-badge {
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--color-desk-muted);
}

.workflow-node-title {
  font-weight: 600;
}

.workflow-node-summary {
  margin: 4px 0 0;
  color: var(--color-desk-muted);
}

.workflow-node-warn {
  margin: 4px 0 0;
  color: var(--color-desk-warning);
}

.workflow-node-waiting {
  margin: 4px 0 0;
  font-weight: 600;
  color: var(--color-desk-warning);
}

.workflow-node-status {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--color-desk-muted);
}
</style>
