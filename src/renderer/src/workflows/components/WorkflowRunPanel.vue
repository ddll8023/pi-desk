<!--
  运行面板：一次运行的状态、节点进度、审批门与历史运行。

  只读展示加两个入口：取消运行，以及等待审批时的通过与拒绝——调度在主进程，
  页面不参与推进，也不自己拼装节点状态。审批门的说明取自节点配置，解释这一步在确认什么。
  历史运行按开始时间倒序列出，选中后展示该次运行的节点与事件（只读回放）。
  状态胶囊与审批块带 live region：运行推进和「等人给决定」都是要立刻被感知的变化。
  两个入口各有自己的进行中标记，取消在飞时不禁用通过与拒绝。
-->
<script setup lang="ts">
import { computed } from 'vue'
import {
  WORKFLOW_NODE_STATUS_LABELS,
  WORKFLOW_RUN_STATUS_LABELS
} from '../../../../shared/workflow-api'
import type { WorkflowNode, WorkflowRun, WorkflowRunSummary } from '../../../../shared/workflow-api'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly run: WorkflowRun | null
  readonly runs: readonly WorkflowRunSummary[]
  readonly nodes: readonly WorkflowNode[]
  readonly waitingNodeId: string | null
  /** 取消请求进行中：只禁用取消按钮。 */
  readonly cancelling: boolean
  /** 审批请求进行中：只禁用通过与拒绝。 */
  readonly approving: boolean
}>()

const emit = defineEmits<{
  cancel: []
  approve: [approved: boolean]
  selectRun: [runId: string]
}>()

const titleOf = (nodeId: string): string => (
  props.nodes.find(node => node.id === nodeId)?.title ?? nodeId
)

/**
 * 以运行记录为基准列出节点：回放旧运行时，那次跑过但后来被删掉的节点仍要出现，
 * 标题从当前草稿里找，找不到就退回节点标识。
 */
const rows = computed(() => {
  const run = props.run
  if (run === null) return []
  const titles = new Map(props.nodes.map(node => [node.id, node.title]))
  return run.nodes.map(item => ({
    nodeId: item.nodeId,
    title: titles.get(item.nodeId) ?? item.nodeId,
    status: item.status,
    output: item.output,
    failure: item.failure
  }))
})

const waitingNode = computed(() => (
  props.waitingNodeId === null
    ? null
    : props.nodes.find(node => node.id === props.waitingNodeId) ?? null
))

const finishedAt = computed(() => {
  const run = props.run
  if (run === null || run.finishedAt === null) return null
  return new Date(run.finishedAt).toLocaleTimeString()
})

/** 事件行键：同一条事件在快照里可能出现多次（文本相同、时刻不同），时刻 + 节点 + 序号才稳定。 */
const eventKey = (at: number, nodeId: string | null, index: number): string => `${at}-${nodeId ?? ''}-${index}`
</script>

<template>
  <section class="workflow-run-panel">
    <header class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold">运行</h2>
        <span v-if="run !== null" class="workflow-run-status" :class="`is-${run.status}`" role="status">
          {{ WORKFLOW_RUN_STATUS_LABELS[run.status] }}
        </span>
        <span v-if="finishedAt !== null" class="text-2xs text-desk-muted">结束于 {{ finishedAt }}</span>
      </div>
      <AppButton v-if="run !== null && run.status === 'running'" :disabled="cancelling" @click="emit('cancel')">
        {{ cancelling ? '取消中…' : '取消运行' }}
      </AppButton>
    </header>

    <!-- 审批门：等人给决定，说明文字来自节点配置。阻塞性提示，用 alert 播报。 -->
    <div v-if="waitingNode !== null" class="workflow-approval" role="alert">
      <p class="workflow-approval-title">等待审批：{{ waitingNode.title }}</p>
      <p v-if="waitingNode.prompt.trim() !== ''" class="workflow-approval-note">{{ waitingNode.prompt }}</p>
      <div class="flex gap-2">
        <AppButton variant="primary" :disabled="approving" @click="emit('approve', true)">通过</AppButton>
        <AppButton variant="quiet-danger" :disabled="approving" @click="emit('approve', false)">拒绝</AppButton>
      </div>
    </div>

    <p v-if="run === null" class="mt-2 text-xs text-desk-muted">还没有运行。保存后点「运行」会在当前项目里按图推进。</p>

    <template v-else>
      <ul class="workflow-run-nodes">
        <li v-for="row in rows" :key="row.nodeId" class="workflow-run-node">
          <span class="workflow-run-node-title">{{ row.title }}</span>
          <span class="workflow-run-node-status" :class="`is-${row.status}`">
            {{ WORKFLOW_NODE_STATUS_LABELS[row.status] }}<template v-if="row.failure !== null">（{{ row.failure }}）</template>
          </span>
          <p v-if="row.output !== null" class="workflow-run-node-output">{{ row.output }}</p>
        </li>
      </ul>

      <details class="workflow-run-events">
        <summary>事件（{{ run.events.length }}）</summary>
        <ul>
          <li
            v-for="(event, index) in run.events"
            :key="eventKey(event.at, event.nodeId, index)"
            :class="`is-${event.level}`"
          >
            <span class="text-2xs text-desk-muted">{{ new Date(event.at).toLocaleTimeString() }}</span>
            <span v-if="event.nodeId !== null"> · {{ titleOf(event.nodeId) }}</span>
            · {{ event.message }}
          </li>
        </ul>
      </details>
    </template>

    <details v-if="runs.length > 0" class="workflow-run-history">
      <summary>历史运行（{{ runs.length }}）</summary>
      <ul>
        <li v-for="item in runs" :key="item.runId">
          <button
            type="button"
            class="workflow-run-history-item"
            :class="{ 'is-active': run?.runId === item.runId }"
            @click="emit('selectRun', item.runId)"
          >
            <span>{{ new Date(item.startedAt).toLocaleString() }}</span>
            <span class="text-2xs text-desk-muted">{{ WORKFLOW_RUN_STATUS_LABELS[item.status] }} · {{ item.nodeCount }} 个节点</span>
          </button>
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
/* 容器约束归本组件：面板在任何宿主里都是「下方可滚动的运行区」。 */
.workflow-run-panel {
  display: flex;
  flex-direction: column;
  max-height: 40%;
  padding: 10px 12px;
  border-top: 1px solid var(--color-desk-border);
  overflow-y: auto;
}

.workflow-run-status {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid currentColor;
}

.workflow-approval {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--color-desk-warning);
  border-radius: 8px;
  background: var(--color-desk-warning-soft);
}

.workflow-approval-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}

.workflow-approval-note {
  margin: 0;
  font-size: 12px;
  color: var(--color-desk-muted);
  white-space: pre-wrap;
}

.workflow-run-nodes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.workflow-run-node {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

.workflow-run-node-title {
  font-size: 12px;
}

.workflow-run-node-status {
  font-size: 11px;
  color: var(--color-desk-muted);
}

.workflow-run-node-status.is-completed { color: var(--color-desk-success); }
.workflow-run-node-status.is-failed { color: var(--color-desk-danger); }
.workflow-run-node-status.is-running { color: var(--color-desk-accent); }
.workflow-run-node-status.is-waiting { color: var(--color-desk-warning); }

.workflow-run-node-output {
  width: 100%;
  margin: 0;
  font-size: 11px;
  color: var(--color-desk-muted);
  white-space: pre-wrap;
  max-height: 96px;
  overflow: hidden;
}

.workflow-run-events,
.workflow-run-history {
  margin-top: 10px;
  font-size: 11px;
}

.workflow-run-events ul,
.workflow-run-history ul {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.workflow-run-events .is-warn { color: var(--color-desk-warning); }
.workflow-run-events .is-error { color: var(--color-desk-danger); }

.workflow-run-history-item {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 1px;
  padding: 4px 6px;
  border-radius: 6px;
  text-align: left;
  font-size: 11px;
}

.workflow-run-history-item:hover {
  background: var(--color-desk-surface-subtle);
}

.workflow-run-history-item.is-active {
  background: var(--color-desk-accent-soft);
}
</style>
