<!-- 子代理对话弹窗：把一次委派内的执行过程按发生顺序当对话读。
     内容全部取自 SubAgentView 快照；执行中随宿主推送刷新，关闭弹窗不中断执行。
     历史记录没有对话时间线时降级为工具活动列表，不猜测缺失的叙述。
     视觉上头部只承载身份与状态（标题、状态药丸、耗时、用量），任务目标单独作引言块，
     时间线用一条竖轨串起节点与叙述；运行中复用主对话同一枚光点边框，进场只做一次轻编排。 -->
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
import TaskRunningBorder from './TaskRunningBorder.vue'

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
            class="dialog-panel subagent-panel max-w-2xl"
          >
            <div class="dialog-header subagent-header">
              <h2 :id="titleId" class="dialog-title">子代理执行</h2>
              <div v-if="activeView !== null" class="subagent-header-meta">
                <span class="subagent-phase" :class="`is-${activeView.phase}`">{{ PHASE_LABELS[activeView.phase] }}</span>
                <span v-if="viewElapsed(activeView) !== null" class="subagent-header-elapsed">{{ viewElapsed(activeView) }}</span>
                <span v-if="viewUsage(activeView) !== null" class="subagent-header-usage">{{ viewUsage(activeView) }}</span>
              </div>
              <button type="button" class="dialog-close-button" aria-label="关闭" @click="emit('close')"></button>
            </div>

            <div class="dialog-body">
              <div v-if="isBatch" class="subagent-tabs" role="group" aria-label="切换子任务">
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
                <section class="subagent-lead" aria-label="任务目标">
                  <span class="subagent-lead-type">{{ TASK_LABELS[activeView.taskType] }}</span>
                  <p class="subagent-lead-text">{{ activeView.objective }}</p>
                </section>

                <section class="subagent-flow space-y-2" aria-label="执行对话" :aria-busy="isLive(activeView)">
                  <ol v-if="activeView.transcript.length > 0" class="subagent-transcript">
                    <li
                      v-for="(item, index) in activeView.transcript"
                      :key="`${item.kind}-${index}`"
                      :class="item.kind === 'assistant' ? 'subagent-said' : 'subagent-call'"
                    >
                      <template v-if="item.kind === 'assistant'">
                        <div class="subagent-said-body">
                          <span class="subagent-speaker">子代理</span>
                          <p class="subagent-text">{{ item.text }}</p>
                        </div>
                      </template>
                      <template v-else>
                        <span class="subagent-node" :class="`is-${item.phase}`" aria-hidden="true">{{ ACTIVITY_MARKS[item.phase] }}</span>
                        <span class="subagent-call-text">{{ item.target === null ? item.tool : `${item.tool} · ${item.target}` }}</span>
                        <span v-if="item.durationMs !== null" class="subagent-call-time">{{ formatDuration(item.durationMs) }}</span>
                      </template>
                    </li>
                  </ol>

                  <!-- 历史记录只有工具活动，没有对话时间线：按活动列表降级展示。 -->
                  <template v-else-if="activeView.activities.length > 0">
                    <ol class="subagent-transcript">
                      <li v-for="(activity, index) in activeView.activities" :key="`${activity.tool}-${index}`" class="subagent-call">
                        <span class="subagent-node" :class="`is-${activity.phase}`" aria-hidden="true">{{ ACTIVITY_MARKS[activity.phase] }}</span>
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

            <!-- 运行中的光点边框与主对话的「进行中」用同一资产；放在内容之后，描边才绘制在头尾底色之上。 -->
            <TaskRunningBorder v-if="activeView !== null" :active="isLive(activeView)" :radius="12" />
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 面板需要相对定位承载运行边框；圆角由 .dialog-panel 的 rounded-desk-lg 提供，边框层用 inherit 继承。 */
.subagent-panel {
  position: relative;
}
/* 头部：状态药丸与耗时、用量收到标题右侧，关闭按钮仍是最右一格。
   药丸的文字本身承载状态，圆点只做同色强调，不是唯一通道。 */
.subagent-header {
  align-items: center;
  gap: 0.75rem;
  animation: subagent-entry-in var(--motion-duration-slow) var(--motion-ease-entrance) both;
}
.subagent-header-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-left: auto;
}
.subagent-phase {
  display: inline-flex;
  align-items: center;
  gap: 0.3125rem;
  padding: 0.0625rem 0.4375rem;
  border: 1px solid var(--color-desk-line);
  border-radius: 999px;
  background: var(--color-desk-surface);
  color: var(--color-desk-muted);
  font-size: var(--text-2xs);
  line-height: 1.5;
  white-space: nowrap;
  transition: border-color var(--default-transition-duration) ease, color var(--default-transition-duration) ease;
}
.subagent-phase::before {
  content: "";
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 999px;
  background: currentColor;
}
.subagent-phase.is-running,
.subagent-phase.is-cancelling {
  border-color: color-mix(in srgb, var(--color-desk-accent) 45%, var(--color-desk-line));
  color: var(--color-desk-accent);
}
.subagent-phase.is-succeeded {
  border-color: color-mix(in srgb, var(--color-desk-success) 40%, var(--color-desk-line));
  color: var(--color-desk-success);
}
.subagent-phase.is-failed,
.subagent-phase.is-aborted {
  border-color: color-mix(in srgb, var(--color-desk-danger) 40%, var(--color-desk-line));
  color: var(--color-desk-danger);
}
.subagent-header-elapsed,
.subagent-header-usage {
  color: var(--color-desk-muted);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  white-space: nowrap;
}
/* 任务目标作为阅读起点：左侧强调条给出归属，底色比正文区略深一档。 */
.subagent-lead {
  display: grid;
  gap: 0.375rem;
  padding: 0.625rem 0.75rem;
  border-left: 2px solid color-mix(in srgb, var(--color-desk-accent) 42%, transparent);
  border-radius: 0 var(--radius-desk-sm) var(--radius-desk-sm) 0;
  background: color-mix(in srgb, var(--color-desk-accent-soft) 55%, var(--color-desk-surface));
  animation: subagent-entry-in var(--motion-duration-slow) var(--motion-ease-entrance) both;
  animation-delay: 50ms;
}
.subagent-lead-type {
  justify-self: start;
  padding: 0 0.375rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface);
  color: var(--color-desk-muted);
  font-size: var(--text-2xs);
  line-height: 1.6;
}
.subagent-lead-text {
  margin: 0;
  color: var(--color-desk-ink);
  font-size: var(--text-md);
  line-height: 1.7;
  overflow-wrap: anywhere;
}
/* 对话区最后一档入场：面板与头部先落位，内容随后淡入，避免整块同时出现。 */
.subagent-flow {
  animation: subagent-entry-in var(--motion-duration-slow) var(--motion-ease-entrance) both;
  animation-delay: 100ms;
}
/* 时间线：左侧一条竖轨串起全部条目，工具调用是轨上的节点；
   叙述不占节点，用浅底块自己成一块，两者不再共用同一条左边线。 */
.subagent-transcript {
  position: relative;
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.subagent-transcript::before {
  content: "";
  position: absolute;
  top: 0.5rem;
  bottom: 0.5rem;
  left: calc(0.5rem - 0.5px);
  width: 1px;
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--color-desk-accent) 45%, transparent),
    var(--color-desk-line) 28%,
    transparent
  );
}
/* 新条目随推送自然淡入：挂载即播放一次，已存在的条目不会重播。 */
.subagent-transcript > li {
  animation: subagent-line-in var(--motion-duration-base) var(--motion-ease-entrance) both;
}
.subagent-said {
  display: grid;
  grid-template-columns: 1rem 1fr;
  column-gap: 0.5rem;
}
.subagent-said-body {
  grid-column: 2;
  display: grid;
  gap: 0.125rem;
  padding: 0.3125rem 0.5rem;
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface-subtle);
}
.subagent-speaker {
  color: var(--color-desk-muted);
  font-size: var(--text-2xs);
}
.subagent-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--color-desk-ink);
}
.subagent-call {
  display: grid;
  grid-template-columns: 1rem 1fr auto;
  column-gap: 0.5rem;
  align-items: center;
  font-size: var(--text-2xs);
}
/* 节点：圆形徽记，字符是颜色之外的第二通道；已完成压低对比，运行中与错误才着色。 */
.subagent-node {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
  border: 1px solid var(--color-desk-line-strong);
  border-radius: 999px;
  background: var(--color-desk-surface);
  color: var(--color-desk-muted);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 1;
}
.subagent-node.is-running {
  border-color: color-mix(in srgb, var(--color-desk-accent) 55%, var(--color-desk-line));
  color: var(--color-desk-accent);
}
.subagent-node.is-done {
  border-color: transparent;
  background: var(--color-desk-canvas-sunken);
}
.subagent-node.is-error {
  border-color: color-mix(in srgb, var(--color-desk-danger) 45%, var(--color-desk-line));
  background: var(--color-desk-danger-soft);
  color: var(--color-desk-danger);
}
.subagent-call-text {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
}
.subagent-call-time {
  color: var(--color-desk-muted);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
}
/* 小节标题自成一行：上方的细线把它与时间线切开，字号压到元信息档。 */
.subagent-section-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding-top: 0.5rem;
  border-top: 1px solid var(--color-desk-line);
  color: var(--color-desk-muted);
  font-size: var(--text-2xs);
  font-weight: 500;
  letter-spacing: 0.04em;
}
.subagent-list {
  margin: 0;
  padding-left: 1rem;
  color: var(--color-desk-ink);
  font-size: var(--text-2xs);
  line-height: 1.6;
}
.subagent-list li {
  overflow-wrap: anywhere;
}
.subagent-note {
  margin: 0;
  color: var(--color-desk-muted);
  font-size: var(--text-2xs);
}
/* 错误块：语义底色加左条，与时间线里的错误节点同一套色。 */
.subagent-error {
  margin: 0;
  padding: 0.5rem 0.625rem;
  border-left: 2px solid var(--color-desk-danger);
  border-radius: 0 var(--radius-desk-sm) var(--radius-desk-sm) 0;
  background: var(--color-desk-danger-soft);
  color: var(--color-desk-danger);
  font-size: 0.75rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
/* 批次切换做成沉陷槽里的分段按钮：选中项用面板底色浮起，未选中项静止时完全安静。 */
.subagent-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.125rem;
  padding: 0.1875rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-md);
  background: var(--color-desk-canvas-sunken);
}
.subagent-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.5rem;
  border: 1px solid transparent;
  border-radius: var(--radius-desk-sm);
  background: transparent;
  color: var(--color-desk-muted);
  font-size: var(--text-2xs);
  cursor: pointer;
  transition:
    background-color var(--default-transition-duration) ease,
    border-color var(--default-transition-duration) ease,
    color var(--default-transition-duration) ease;
}
.subagent-tab:hover {
  color: var(--color-desk-ink);
  background: color-mix(in srgb, var(--color-desk-surface) 70%, transparent);
}
.subagent-tab-active {
  border-color: var(--color-desk-line-strong);
  background: var(--color-desk-surface);
  color: var(--color-desk-ink);
  box-shadow: var(--shadow-desk-raise);
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
/* 入场位移只有 3–4px：面板本身已在落位，内容再做大位移会显得晃动。 */
@keyframes subagent-entry-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes subagent-line-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .subagent-header,
  .subagent-lead,
  .subagent-flow,
  .subagent-transcript > li {
    animation: none;
  }
  .subagent-tab,
  .subagent-phase {
    transition: none;
  }
}
</style>
