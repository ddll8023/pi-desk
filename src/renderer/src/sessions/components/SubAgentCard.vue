<!-- 子任务入口行：委派工具在 details.subAgents 里交付的执行快照；单项与批次共用同一张入口。
     行内只给任务类型、目标、状态、调用数与耗时，点击后在弹窗里按对话阅读执行过程。
     状态与耗时都来自事件流投影，不从模型文字推断完成度，也不显示缺乏依据的进度百分比。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SubAgentPhase, SubAgentView } from '../../../../shared/sub-agent-view'
import { formatDuration } from '../clock'
import SubAgentDialog from './SubAgentDialog.vue'

const props = defineProps<{
  /** 一次委派内的所有子任务；批次时逐项独立收敛，不做成只有一个状态的整体。 */
  readonly views: readonly SubAgentView[]
}>()

/** 打开弹窗时上报，让消息列表停止粘底。 */
const emit = defineEmits<{ userExpand: [] }>()

/** 阶段文案；`cancelling` 与 `aborted` 分开，请求停止不等于已经结束。 */
const PHASE_LABELS: Readonly<Record<SubAgentPhase, string>> = {
  queued: '等待派发',
  running: '执行中',
  cancelling: '已请求停止',
  succeeded: '已完成',
  failed: '失败',
  aborted: '已中断'
}

/** 字形是第二通道：颜色缺失时仍能读出状态。 */
const PHASE_MARKS: Readonly<Record<SubAgentPhase, string>> = {
  queued: '·',
  running: '…',
  cancelling: '×',
  succeeded: '✓',
  failed: '!',
  aborted: '–'
}

const TASK_LABELS: Readonly<Record<SubAgentView['taskType'], string>> = {
  query: '代码查询',
  research: '技术调研',
  review: '代码审查',
  document: '文档编写'
}

/** 弹窗状态由入口持有：一次只开一个，切换任务在弹窗内完成。 */
const dialogOpen = ref(false)
const openTaskId = ref<string | null>(null)

function openDialog(taskId: string): void {
  openTaskId.value = taskId
  dialogOpen.value = true
  emit('userExpand')
}

function isViewLive(view: SubAgentView): boolean {
  return view.phase === 'running' || view.phase === 'cancelling'
}

function viewElapsed(view: SubAgentView): string | null {
  const { startedAt, endedAt } = view
  if (startedAt === null || endedAt === null) return null
  return formatDuration(Math.max(0, endedAt - startedAt))
}

/** 批次头只在多任务时出现：先告诉用户这一批还没全部结束，再逐项展开。 */
const isBatch = computed(() => props.views.length > 1)
const batchSummary = computed(() => {
  const counts: Record<SubAgentPhase, number> = { queued: 0, running: 0, cancelling: 0, succeeded: 0, failed: 0, aborted: 0 }
  for (const view of props.views) counts[view.phase] += 1
  const parts: string[] = []
  if (counts.running > 0) parts.push(`执行中 ${counts.running}`)
  if (counts.cancelling > 0) parts.push(`停止中 ${counts.cancelling}`)
  if (counts.queued > 0) parts.push(`等待 ${counts.queued}`)
  if (counts.succeeded > 0) parts.push(`已完成 ${counts.succeeded}`)
  if (counts.failed > 0) parts.push(`失败 ${counts.failed}`)
  if (counts.aborted > 0) parts.push(`已中断 ${counts.aborted}`)
  return parts.join(' · ')
})
/** 批次总耗时：从最早开始到最晚结束；仍有任务在跑时不编造结束时刻。 */
const batchElapsed = computed(() => {
  let started: number | null = null
  let ended: number | null = null
  for (const view of props.views) {
    if (view.startedAt !== null) started = started === null ? view.startedAt : Math.min(started, view.startedAt)
    if (view.endedAt === null) return null
    ended = ended === null ? view.endedAt : Math.max(ended, view.endedAt)
  }
  return started === null || ended === null ? null : formatDuration(Math.max(0, ended - started))
})
</script>

<template>
  <div class="subagent-stack">
    <p v-if="isBatch" class="subagent-batch-head">
      <span class="subagent-batch-title">子代理 ×{{ views.length }}</span>
      <span class="subagent-batch-status">{{ batchSummary }}</span>
      <span v-if="batchElapsed !== null" class="subagent-batch-elapsed">{{ batchElapsed }}</span>
    </p>
    <button
      v-for="view in views"
      :key="view.taskId"
      type="button"
      class="subagent-card"
      :class="isViewLive(view) ? 'is-live' : `is-${view.phase}`"
      :aria-label="`查看${TASK_LABELS[view.taskType]}子任务的执行对话：${view.objective}`"
      @click="openDialog(view.taskId)"
    >
      <span class="subagent-mark" aria-hidden="true">{{ PHASE_MARKS[view.phase] }}</span>
      <span class="subagent-type">{{ TASK_LABELS[view.taskType] }}</span>
      <span class="subagent-objective">{{ view.objective }}</span>
      <span v-if="view.activityTotal > 0" class="subagent-calls">{{ view.activityTotal }} 次调用</span>
      <span class="subagent-status" :class="`subagent-status-${view.phase}`">{{ PHASE_LABELS[view.phase] }}</span>
      <span v-if="viewElapsed(view) !== null" class="subagent-elapsed">{{ viewElapsed(view) }}</span>
    </button>
    <SubAgentDialog
      :open="dialogOpen"
      :views="views"
      :initial-task-id="openTaskId"
      @close="dialogOpen = false"
    />
  </div>
</template>

<style scoped>
/* 入口行：整行是按钮，点击后在弹窗里按对话读执行过程；行内不再就地展开内容。 */
.subagent-stack {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.subagent-batch-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  color: var(--color-desk-muted);
}
.subagent-batch-title {
  color: var(--color-desk-ink);
  font-weight: 600;
}
.subagent-batch-elapsed {
  margin-left: auto;
  font-family: var(--font-mono);
}
.subagent-card {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.375rem 0.625rem;
  min-height: 2rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface);
  color: inherit;
  font: inherit;
  font-size: 0.75rem;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--default-transition-duration) ease, box-shadow var(--default-transition-duration) ease;
}
.subagent-card:hover {
  background: var(--color-desk-surface-subtle);
}
.subagent-card.is-live {
  border-color: color-mix(in srgb, var(--color-desk-accent) 45%, var(--color-desk-line));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-desk-accent) 18%, transparent);
}
.subagent-mark {
  flex: none;
  width: 0.75rem;
  text-align: center;
  color: var(--color-desk-muted);
  font-family: var(--font-mono);
}
.subagent-type {
  flex: none;
  padding: 0 0.375rem;
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface-subtle);
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
  line-height: 1.6;
}
.subagent-objective {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-desk-ink);
}
.subagent-calls {
  flex: none;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}
.subagent-status {
  flex: none;
  color: var(--color-desk-muted);
}
.subagent-status-running,
.subagent-status-cancelling {
  color: var(--color-desk-accent);
}
.subagent-status-failed,
.subagent-status-aborted {
  color: var(--color-desk-danger, var(--color-desk-muted));
}
.subagent-elapsed {
  flex: none;
  color: var(--color-desk-muted);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
}
</style>
