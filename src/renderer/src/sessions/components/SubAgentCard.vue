<!-- 子任务卡片：委派工具在 details.subAgents 里交付的执行快照；单项与批次共用同一张卡。
     折叠头给出任务类型、目标、状态与耗时；展开后按执行顺序看真实工具活动、写入文件、用量、结论与错误。
     状态、活动与用量都来自事件流投影，不从模型文字推断完成度，也不显示缺乏依据的进度百分比。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SubAgentActivity, SubAgentPhase, SubAgentView } from '../../../../shared/sub-agent-view'
import { formatDuration } from '../clock'
import { formatTokens } from '../usage-format'
import { useRuntimeStore } from '../stores/runtime'

const props = defineProps<{
  /** 一次委派内的所有子任务；批次时逐项独立收敛，不做成只有一个状态的整体。 */
  readonly views: readonly SubAgentView[]
}>()

/** 卡片开合由原生 details 控制；展开时上报，让消息列表停止粘底。 */
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
  review: '代码审查',
  document: '文档编写'
}

const ACTIVITY_MARKS: Readonly<Record<SubAgentActivity['phase'], string>> = {
  running: '…',
  done: '✓',
  error: '!'
}

/** 单任务展示口径：耗时、用量与隐藏活动数只依据该任务自己的快照字段。 */
function isViewLive(view: SubAgentView): boolean {
  return view.phase === 'running' || view.phase === 'cancelling'
}

function viewElapsed(view: SubAgentView): string | null {
  const { startedAt, endedAt } = view
  if (startedAt === null || endedAt === null) return null
  return formatDuration(Math.max(0, endedAt - startedAt))
}

/** 用量缺失按未知展示，不写成 0。 */
function viewUsage(view: SubAgentView): string | null {
  const { totalTokens, inputTokens, outputTokens } = view.usage
  if (totalTokens !== null) return `${formatTokens(totalTokens)} tokens`
  if (inputTokens === null && outputTokens === null) return null
  return `输入 ${formatTokens(inputTokens)} / 输出 ${formatTokens(outputTokens)}`
}

/** 被上限挡掉的活动只报数量，不伪造条目。 */
function hiddenActivities(view: SubAgentView): number {
  return Math.max(0, view.activityTotal - view.activities.length)
}

/** 定向停止：只请求这一项；重复点击在请求期间无效，终态仍由快照事件决定。 */
const runtime = useRuntimeStore()
const stoppingTask = ref<string | null>(null)

async function stopTask(view: SubAgentView): Promise<void> {
  if (stoppingTask.value !== null) return
  stoppingTask.value = view.taskId
  try { await runtime.cancelSubAgents([view.taskId]) } finally { stoppingTask.value = null }
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

function activityText(activity: SubAgentActivity): string {
  return activity.target === null ? activity.tool : `${activity.tool} · ${activity.target}`
}

function activityDuration(activity: SubAgentActivity): string | null {
  return activity.durationMs === null ? null : formatDuration(activity.durationMs)
}
</script>

<template>
  <div class="subagent-stack">
    <p v-if="isBatch" class="subagent-batch-head">
      <span class="subagent-batch-title">子代理 ×{{ views.length }}</span>
      <span class="subagent-batch-status">{{ batchSummary }}</span>
      <span v-if="batchElapsed !== null" class="subagent-batch-elapsed">{{ batchElapsed }}</span>
    </p>
    <details v-for="view in views" :key="view.taskId" class="subagent-card"
      :class="isViewLive(view) ? 'is-live' : `is-${view.phase}`" @toggle="emit('userExpand')">
      <summary>
        <span class="disclosure" aria-hidden="true"></span>
        <span class="subagent-mark" aria-hidden="true">{{ PHASE_MARKS[view.phase] }}</span>
        <span class="subagent-type">{{ TASK_LABELS[view.taskType] }}</span>
        <span class="subagent-objective">{{ view.objective }}</span>
        <span class="subagent-status" :class="`subagent-status-${view.phase}`">{{ PHASE_LABELS[view.phase] }}</span>
        <span v-if="viewElapsed(view) !== null" class="subagent-elapsed">{{ viewElapsed(view) }}</span>
      </summary>
      <div class="subagent-body">
        <div v-if="isViewLive(view)" class="subagent-actions">
          <button type="button" class="subagent-stop"
            :disabled="stoppingTask === view.taskId"
            @click="stopTask(view)"
          >{{ stoppingTask === view.taskId ? '正在停止…' : '停止此任务' }}</button>
        </div>
        <template v-if="view.writes.length > 0">
          <p class="subagent-section-title">写入文件</p>
          <ul class="subagent-writes">
            <li v-for="file in view.writes" :key="file">{{ file }}</li>
          </ul>
        </template>
        <p v-if="viewUsage(view) !== null" class="subagent-usage">用量：{{ viewUsage(view) }}</p>
        <template v-if="view.activities.length > 0">
          <p class="subagent-section-title">执行活动</p>
          <ol class="subagent-activity-list">
            <li v-for="(activity, index) in view.activities" :key="`${activity.tool}-${index}`" class="subagent-activity">
              <span class="subagent-activity-mark" :class="`is-${activity.phase}`" aria-hidden="true">{{ ACTIVITY_MARKS[activity.phase] }}</span>
              <span class="subagent-activity-text">{{ activityText(activity) }}</span>
              <span v-if="activityDuration(activity) !== null" class="subagent-activity-time">{{ activityDuration(activity) }}</span>
            </li>
          </ol>
          <p v-if="hiddenActivities(view) > 0" class="subagent-note">另有 {{ hiddenActivities(view) }} 次工具调用未展开</p>
        </template>
        <p v-else class="subagent-note">暂无工具活动记录</p>
        <p v-if="view.summary !== null" class="subagent-summary">{{ view.summary }}</p>
        <p v-if="view.errorCode !== null" class="subagent-error">
          错误：{{ view.errorCode }}<template v-if="view.errorMessage !== null">，{{ view.errorMessage }}</template>
        </p>
        <template v-if="view.pending.length > 0">
          <p class="subagent-section-title">未解决事项</p>
          <ul class="subagent-pending">
            <li v-for="(item, index) in view.pending" :key="index">{{ item }}</li>
          </ul>
        </template>
      </div>
    </details>
  </div>
</template>

<style scoped>
/* 批次容器：多任务时先给一行汇总，再逐项展开；单项时不增加额外间距。 */
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
.subagent-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 0.25rem;
}
.subagent-stop {
  padding: 0.125rem 0.5rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface-subtle);
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
  cursor: pointer;
}
.subagent-stop:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--color-desk-accent) 45%, var(--color-desk-line));
  color: var(--color-desk-ink);
}
.subagent-stop:disabled {
  cursor: default;
  opacity: 0.6;
}
.subagent-card {
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface);
  transition: border-color var(--default-transition-duration) ease, box-shadow var(--default-transition-duration) ease;
}
.subagent-card.is-live {
  border-color: color-mix(in srgb, var(--color-desk-accent) 45%, var(--color-desk-line));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-desk-accent) 18%, transparent);
}
.subagent-card > summary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.625rem;
  min-height: 2rem;
  font-size: 0.75rem;
  cursor: pointer;
  user-select: none;
}
.subagent-card > summary:hover {
  background: var(--color-desk-surface-subtle);
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
.subagent-body {
  display: grid;
  gap: 0.375rem;
  padding: 0.5rem 0.625rem 0.625rem;
  border-top: 1px solid var(--color-desk-line);
  font-size: 0.75rem;
  color: var(--color-desk-ink);
}
.subagent-section-title {
  margin: 0;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}
.subagent-activity-list {
  display: grid;
  gap: 0.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.subagent-activity {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  min-width: 0;
}
.subagent-activity-mark {
  flex: none;
  width: 0.75rem;
  color: var(--color-desk-muted);
  font-family: var(--font-mono);
}
.subagent-activity-mark.is-error {
  color: var(--color-desk-danger, var(--color-desk-muted));
}
.subagent-activity-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
}
.subagent-activity-time {
  flex: none;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}
.subagent-summary {
  margin: 0;
  overflow-wrap: anywhere;
}
.subagent-writes {
  margin: 0 0 0.375rem;
  padding-left: 1rem;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
}
.subagent-writes li {
  overflow-wrap: anywhere;
}
.subagent-note {
  margin: 0;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}
.subagent-error {
  margin: 0;
  color: var(--color-desk-danger, var(--color-desk-muted));
  overflow-wrap: anywhere;
}
.subagent-pending {
  margin: 0;
  padding-left: 1rem;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}
</style>
