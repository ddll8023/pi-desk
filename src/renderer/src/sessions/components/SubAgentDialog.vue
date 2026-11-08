<!-- 子代理对话弹窗：把一次委派内的执行过程按发生顺序当对话读。
     内容全部取自 SubAgentView 快照；执行中随宿主推送刷新，关闭弹窗不中断执行。
     历史记录没有对话时间线时降级为工具活动列表，不猜测缺失的叙述。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import type {
  SubAgentActivity,
  SubAgentPhase,
  SubAgentView
} from '../../../../shared/sub-agent-view'
import { formatDuration } from '../clock'
import { formatTokens } from '../usage-format'
import { useRuntimeStore } from '../stores/runtime'

const props = defineProps<{
  readonly open: boolean
  /** 一次委派内的全部子任务；批次时在弹窗内切换查看。 */
  readonly views: readonly SubAgentView[]
  /** 打开时定位的任务；为空时取批次第一项。 */
  readonly initialTaskId?: string | null
}>()

const emit = defineEmits<{ close: [] }>()

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

const ACTIVITY_MARKS: Readonly<Record<SubAgentActivity['phase'], string>> = {
  running: '…',
  done: '✓',
  error: '!'
}

const titleId = useId()
const runtime = useRuntimeStore()
const panel = ref<HTMLElement | null>(null)
const activeTaskId = ref<string | null>(null)
const stoppingTask = ref<string | null>(null)
/** 打开前的焦点位置：关闭时还原，避免键盘用户丢失落点。 */
let restoreFocus: HTMLElement | null = null

const activeView = computed<SubAgentView | null>(() => {
  const id = activeTaskId.value
  if (id !== null) {
    const found = props.views.find(view => view.taskId === id)
    if (found !== undefined) return found
  }
  return props.views[0] ?? null
})

const isBatch = computed(() => props.views.length > 1)

function isLive(view: SubAgentView): boolean {
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

/** 被上限挡掉的条目只报数量，不伪造条目。 */
function droppedTranscript(view: SubAgentView): number {
  return Math.max(0, view.transcriptTotal - view.transcript.length)
}

function droppedActivities(view: SubAgentView): number {
  return Math.max(0, view.activityTotal - view.activities.length)
}

function activityText(activity: SubAgentActivity): string {
  return activity.target === null ? activity.tool : `${activity.tool} · ${activity.target}`
}

function activityDuration(activity: SubAgentActivity): string | null {
  return activity.durationMs === null ? null : formatDuration(activity.durationMs)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

/** 批次切换按钮的可访问名称：类型相同且状态相同时靠目标区分。 */
function tabLabel(view: SubAgentView): string {
  return `${TASK_LABELS[view.taskType]} · ${PHASE_LABELS[view.phase]}：${view.objective}`
}

function detach(): void {
  window.removeEventListener('keydown', onKeydown)
  restoreFocus?.focus()
  restoreFocus = null
}

watch(() => props.open, open => {
  if (!open) {
    detach()
    return
  }
  activeTaskId.value = props.initialTaskId ?? props.views[0]?.taskId ?? null
  restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  window.addEventListener('keydown', onKeydown)
  void nextTick(() => panel.value?.focus())
})

// 批次内任务被整体替换（新一次委派复用同一弹窗）时，回到第一项可看的内容。
watch(() => props.views, views => {
  if (!props.open) return
  if (activeTaskId.value === null || !views.some(view => view.taskId === activeTaskId.value)) {
    activeTaskId.value = views[0]?.taskId ?? null
  }
})

onBeforeUnmount(detach)

/** 定向停止：只请求这一项；终态仍由快照事件决定。 */
async function stopTask(view: SubAgentView): Promise<void> {
  if (stoppingTask.value !== null) return
  stoppingTask.value = view.taskId
  try {
    await runtime.cancelSubAgents([view.taskId])
  } finally {
    stoppingTask.value = null
  }
}

/** 弹窗底部的停止入口：当前任务不在执行中时什么都不做。 */
async function stopActive(): Promise<void> {
  const view = activeView.value
  if (view === null || !isLive(view)) return
  await stopTask(view)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="open" class="dialog-overlay" @click.self="emit('close')">
        <Transition name="dialog-panel-motion" appear>
          <div
            ref="panel"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="titleId"
            tabindex="-1"
            class="dialog-panel max-w-2xl"
          >
            <div class="dialog-header">
              <div class="min-w-0">
                <h2 :id="titleId" class="dialog-title">子代理执行</h2>
              </div>
              <button type="button" class="dialog-close-button" aria-label="关闭" @click="emit('close')"></button>
            </div>

            <div class="dialog-body">
              <div v-if="isBatch" class="flex flex-wrap gap-1.5" role="group" aria-label="切换子任务">
                <button
                  v-for="view in views"
                  :key="view.taskId"
                  type="button"
                  :aria-pressed="view.taskId === activeView?.taskId"
                  :aria-label="tabLabel(view)"
                  class="subagent-tab"
                  :class="view.taskId === activeView?.taskId ? 'subagent-tab-active' : ''"
                  @click="activeTaskId = view.taskId"
                >
                  <span aria-hidden="true">{{ PHASE_MARKS[view.phase] }}</span>
                  {{ TASK_LABELS[view.taskType] }}
                </button>
              </div>

              <template v-if="activeView !== null">
                <section class="space-y-1">
                  <div class="flex flex-wrap items-baseline gap-2 text-xs text-desk-muted">
                    <span>{{ TASK_LABELS[activeView.taskType] }}</span>
                    <span :class="isLive(activeView) ? 'text-desk-accent' : ''">
                      {{ PHASE_LABELS[activeView.phase] }}
                    </span>
                    <span v-if="viewElapsed(activeView) !== null" class="font-mono">{{ viewElapsed(activeView) }}</span>
                    <span v-if="viewUsage(activeView) !== null" class="ml-auto">{{ viewUsage(activeView) }}</span>
                  </div>
                  <p class="text-sm leading-6 break-words text-desk-ink">{{ activeView.objective }}</p>
                </section>

                <section class="space-y-2" aria-label="执行对话">
                  <ol v-if="activeView.transcript.length > 0" class="subagent-transcript">
                    <li
                      v-for="(item, index) in activeView.transcript"
                      :key="`${item.kind}-${index}`"
                      :class="item.kind === 'assistant' ? 'subagent-said' : 'subagent-call'"
                    >
                      <template v-if="item.kind === 'assistant'">
                        <span class="subagent-speaker">子代理</span>
                        <p class="subagent-text">{{ item.text }}</p>
                      </template>
                      <template v-else>
                        <span class="subagent-mark" :class="`is-${item.phase}`" aria-hidden="true">{{ ACTIVITY_MARKS[item.phase] }}</span>
                        <span class="subagent-call-text">{{ item.target === null ? item.tool : `${item.tool} · ${item.target}` }}</span>
                        <span v-if="item.durationMs !== null" class="subagent-call-time">{{ formatDuration(item.durationMs) }}</span>
                      </template>
                    </li>
                  </ol>

                  <!-- 历史记录只有工具活动，没有对话时间线：按活动列表降级展示。 -->
                  <template v-else-if="activeView.activities.length > 0">
                    <ol class="subagent-transcript">
                      <li v-for="(activity, index) in activeView.activities" :key="`${activity.tool}-${index}`" class="subagent-call">
                        <span class="subagent-mark" :class="`is-${activity.phase}`" aria-hidden="true">{{ ACTIVITY_MARKS[activity.phase] }}</span>
                        <span class="subagent-call-text">{{ activityText(activity) }}</span>
                        <span v-if="activityDuration(activity) !== null" class="subagent-call-time">{{ activityDuration(activity) }}</span>
                      </li>
                    </ol>
                    <p v-if="droppedActivities(activeView) > 0" class="subagent-note">
                      另有 {{ droppedActivities(activeView) }} 次工具调用未保留
                    </p>
                  </template>
                  <p v-else class="subagent-note">暂无执行记录</p>

                  <p v-if="droppedTranscript(activeView) > 0" class="subagent-note">
                    另有 {{ droppedTranscript(activeView) }} 条早期对话未保留
                  </p>
                </section>

                <section v-if="activeView.summary !== null" class="space-y-1" aria-label="结论">
                  <h3 class="subagent-section-title">结论</h3>
                  <p class="text-xs leading-5 break-words text-desk-ink">{{ activeView.summary }}</p>
                </section>

                <p v-if="activeView.errorCode !== null" class="subagent-error">
                  错误：{{ activeView.errorCode }}<template v-if="activeView.errorMessage !== null">，{{ activeView.errorMessage }}</template>
                </p>

                <section v-if="activeView.pending.length > 0" class="space-y-1" aria-label="未解决事项">
                  <h3 class="subagent-section-title">未解决事项</h3>
                  <ul class="subagent-list">
                    <li v-for="(item, index) in activeView.pending" :key="index">{{ item }}</li>
                  </ul>
                </section>

                <section v-if="activeView.writes.length > 0" class="space-y-1" aria-label="写入文件">
                  <h3 class="subagent-section-title">写入文件</h3>
                  <ul class="subagent-list font-mono">
                    <li v-for="file in activeView.writes" :key="file">{{ file }}</li>
                  </ul>
                </section>
              </template>
              <p v-else class="subagent-note">这次委派没有可展示的子任务</p>
            </div>

            <div class="dialog-footer">
              <button
                v-if="activeView !== null && isLive(activeView)"
                type="button"
                class="subagent-stop"
                :disabled="stoppingTask === activeView?.taskId"
                @click="stopActive()"
              >{{ stoppingTask === activeView?.taskId ? '正在停止…' : '停止此任务' }}</button>
              <button type="button" class="subagent-close" @click="emit('close')">关闭</button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 批次切换：一行标签，选中态用左侧色条而不是只靠颜色填充。 */
.subagent-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.5rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface-subtle);
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
  cursor: pointer;
}
.subagent-tab-active {
  border-color: color-mix(in srgb, var(--color-desk-accent) 45%, var(--color-desk-line));
  color: var(--color-desk-ink);
}
/* 对话时间线：说话与工具调用交错，间距靠行距而不是分隔线。 */
.subagent-transcript {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.subagent-said {
  display: grid;
  gap: 0.125rem;
  padding-left: 0.5rem;
  border-left: 2px solid color-mix(in srgb, var(--color-desk-accent) 35%, transparent);
}
.subagent-speaker {
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}
.subagent-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-desk-ink);
}
.subagent-call {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  min-width: 0;
  font-size: 0.75rem;
}
.subagent-mark {
  flex: none;
  width: 0.75rem;
  text-align: center;
  color: var(--color-desk-muted);
  font-family: var(--font-mono);
}
.subagent-mark.is-error {
  color: var(--color-desk-danger, var(--color-desk-muted));
}
.subagent-call-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
}
.subagent-call-time {
  flex: none;
  color: var(--color-desk-muted);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
}
.subagent-section-title {
  margin: 0;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}
.subagent-list {
  margin: 0;
  padding-left: 1rem;
  font-size: 0.6875rem;
  color: var(--color-desk-ink);
}
.subagent-list li {
  overflow-wrap: anywhere;
}
.subagent-note {
  margin: 0;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}
.subagent-error {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--color-desk-danger, var(--color-desk-muted));
  font-size: 0.75rem;
}
.subagent-stop,
.subagent-close {
  padding: 0.25rem 0.75rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface);
  color: var(--color-desk-ink);
  font-size: 0.75rem;
  cursor: pointer;
}
.subagent-stop:hover:not(:disabled),
.subagent-close:hover {
  border-color: color-mix(in srgb, var(--color-desk-accent) 45%, var(--color-desk-line));
}
.subagent-stop:disabled {
  cursor: default;
  opacity: 0.6;
}
</style>
