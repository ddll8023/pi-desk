<!-- 用户任务流程侧边栏：单层紧凑头部、连续业务节点微卡片展示，专注流程流转与状态追踪。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { SessionTaskTrack, TaskTrackNode, TaskViewTone } from '../task-flow-view'
import TaskFlowSteps from './TaskFlowSteps.vue'
import TaskRunningBorder from './TaskRunningBorder.vue'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly track: SessionTaskTrack
  readonly ownerKey: string
  readonly active: boolean
  readonly live: boolean
  readonly notice: string | null
  readonly projectRoot: string | null
  readonly earlier: { readonly available: boolean; readonly loading: boolean; readonly error: string | null }
  readonly running: boolean
  readonly starting: boolean
  readonly canExecute: boolean
  readonly canOpenFiles: boolean
  readonly waitingDialog: { readonly id: string; readonly title: string } | null
}>()
const emit = defineEmits<{
  locate: [entryId: string, ownerKey: string]
  locateTurn: [messageId: string, ownerKey: string]
  loadEarlier: [ownerKey: string]
  loadTurn: [turnId: string, more: boolean, ownerKey: string]
  start: [flowId: string, revision: number, ownerKey: string]
  openFile: [path: string, ownerKey: string]
  showQuestion: [dialogId: string, ownerKey: string]
}>()
const tones = {
  accent: 'text-desk-accent', success: 'text-desk-success', danger: 'text-desk-danger',
  warning: 'text-desk-warning', muted: 'text-desk-muted'
} satisfies Record<TaskViewTone, string>

const selectedId = ref<string | null>(null)
const pinned = ref(false)
const scroller = ref<HTMLElement | null>(null)
const historyMenu = ref<HTMLDetailsElement | null>(null)
const following = ref(true)
let prependAnchor: { readonly id: string; readonly top: number } | null = null

const currentTask = computed(() => [...props.track.tasks].reverse().find(task => task.current)
  ?? [...props.track.tasks].reverse().find(task => task.reported) ?? props.track.tasks.at(-1) ?? null)
const selected = computed(() => props.track.tasks.find(task => task.id === selectedId.value) ?? currentTask.value)
const historicalTasks = computed(() => [...props.track.tasks].reverse().filter(task => task.id !== currentTask.value?.id))
const pendingTurn = computed(() => props.track.unreported.find(turn => turn.current) ?? null)
const currentNodeId = computed(() => {
  const nodes = selected.value?.nodes ?? []
  return nodes.filter(node => node.current).at(-1)?.id
    ?? nodes.filter(node => node.status.kind !== 'pending').at(-1)?.id ?? nodes[0]?.id ?? null
})

const attentionText = computed(() => props.waitingDialog?.title ?? selected.value?.attention?.message ?? null)
const attentionTitle = computed(() => props.waitingDialog ? '当前会话需要你回应'
  : selected.value?.attention?.kind === 'permission' ? '需要确认操作范围'
    : selected.value?.attention?.kind === 'decision' ? '需要你决定' : '需要补充信息')

const taskRunning = computed(() => {
  const task = selected.value
  return task !== null && props.active && props.live && props.notice === null && props.running && task.current
    && pendingTurn.value === null && props.waitingDialog === null && task.attention === null
    && task.status.kind === 'running'
})
const taskStatusLabel = computed(() => props.waitingDialog && selected.value?.current ? '等你回应'
  : selected.value?.current ? selected.value.status.label : `上次记录 · ${selected.value?.status.label ?? '进展未说明'}`)

watch(() => [currentTask.value?.id, props.track.tasks] as const, () => {
  if (!pinned.value || !props.track.tasks.some(task => task.id === selectedId.value)) {
    selectedId.value = currentTask.value?.id ?? null
    pinned.value = false
  }
}, { immediate: true })

function selectTask(id: string): void {
  selectedId.value = id
  pinned.value = id !== currentTask.value?.id
  following.value = !pinned.value
  prependAnchor = null
  if (historyMenu.value !== null) historyMenu.value.open = false
  void nextTick(() => {
    if (pinned.value && scroller.value !== null) scroller.value.scrollTop = 0
    else focusCurrent(true)
  })
}

function nodeRunning(node: TaskTrackNode): boolean {
  return taskRunning.value && node.id === currentNodeId.value && node.status.kind === 'running'
}

function glyph(node: TaskTrackNode): string {
  if (node.status.kind === 'failed' || node.status.kind === 'blocked') return 'error'
  if (node.status.kind === 'waiting') return 'wait'
  if (node.status.kind === 'responded' || node.status.kind === 'delivered') return 'check'
  return 'circle'
}

function focusCurrent(force = false): void {
  const host = scroller.value
  const marker = host?.querySelector<HTMLElement>('[data-current-node="true"]')
  if (!props.active || pinned.value || host === null || marker == null || host.clientHeight === 0) return
  const bounds = host.getBoundingClientRect(), target = marker.getBoundingClientRect()
  if (force || target.top < bounds.top + 12 || target.bottom > bounds.bottom - 12) {
    host.scrollTop += target.top - bounds.top - Math.min(64, host.clientHeight / 4)
  }
}

function onScroll(): void {
  const host = scroller.value
  const marker = host?.querySelector<HTMLElement>('[data-current-node="true"]')
  if (host === null || marker == null || prependAnchor !== null) return
  const bounds = host.getBoundingClientRect(), target = marker.getBoundingClientRect()
  following.value = target.top >= bounds.top && target.bottom <= bounds.bottom
}

function loadEarlier(): void {
  const host = scroller.value
  following.value = false
  if (host !== null) {
    const top = host.getBoundingClientRect().top
    const element = [...host.querySelectorAll<HTMLElement>('[data-track-row]')].find(row => row.getBoundingClientRect().bottom > top)
    if (element?.dataset.trackRow !== undefined) prependAnchor = { id: element.dataset.trackRow, top: element.getBoundingClientRect().top - top }
  }
  emit('loadEarlier', props.ownerKey)
}

watch(() => [props.track, props.active, props.earlier.loading] as const, () => {
  void nextTick(() => {
    const host = scroller.value
    if (host === null) return
    if (prependAnchor !== null) {
      const element = host.querySelector<HTMLElement>(`[data-track-row="${CSS.escape(prependAnchor.id)}"]`)
      if (element !== null) host.scrollTop += element.getBoundingClientRect().top - host.getBoundingClientRect().top - prependAnchor.top
      if (!props.earlier.loading) prependAnchor = null
    } else if (following.value) focusCurrent()
  })
}, { flush: 'post' })
</script>

<template>
  <section class="task-track-panel" aria-label="任务流程">
    <!-- 单层紧凑头部 -->
    <header class="task-flow-header">
      <div class="task-flow-meta">
        <div class="task-flow-status-group">
          <span v-if="pinned" class="task-pill task-pill-history">
            <i class="task-dot" aria-hidden="true"></i>历史任务
          </span>
          <button v-if="pinned && currentTask" type="button" class="task-return-btn" @click="selectTask(currentTask.id)">
            返回当前
          </button>
          <span v-else-if="selected" class="task-pill" :class="tones[selected.status.tone]">
            <i class="task-dot" aria-hidden="true"></i>{{ taskStatusLabel }}
          </span>
        </div>
        <details v-if="historicalTasks.length > 0" ref="historyMenu" class="task-track-history">
          <summary>历史 <span>{{ historicalTasks.length }}</span><span aria-hidden="true">⌄</span></summary>
          <div class="task-history-menu">
            <button v-for="task in historicalTasks" :key="task.id" type="button" :aria-current="selected?.id === task.id ? 'true' : undefined" @click="selectTask(task.id)">
              <span>{{ task.title }}</span><small>{{ task.status.label }}</small>
            </button>
          </div>
        </details>
        <span v-else class="task-track-session-state">{{ live ? '当前会话' : notice ? '待同步' : '历史记录' }}</span>
      </div>
      <h3 class="task-flow-title" :title="selected?.title ?? '任务流程'">{{ selected?.title ?? '任务流程' }}</h3>
    </header>

    <div ref="scroller" class="task-track-scroll" @scroll.passive="onScroll">
      <p v-if="notice" class="track-notice" role="status">{{ notice }}</p>

      <aside v-if="pendingTurn" class="track-unassigned" role="status">
        <span class="track-small-label">{{ running ? '新消息正在处理' : '新消息尚未关联任务' }}</span>
        <p v-if="pendingTurn.request" class="track-unassigned-request">{{ pendingTurn.request }}</p>
        <p>归属确认前保留已有任务，不自动连入轨道。</p>
      </aside>

      <aside v-if="attentionText" class="track-attention" role="status">
        <span class="track-small-label">{{ attentionTitle }}</span>
        <p>{{ attentionText }}</p>
        <AppButton v-if="waitingDialog" @click="emit('showQuestion', waitingDialog.id, ownerKey)">查看问题</AppButton>
      </aside>

      <!-- 纯流程展示时间线轨道 -->
      <ol v-if="selected && selected.nodes.length > 0" :key="selected.id" class="task-trajectory" aria-label="任务业务轨道">
        <li v-for="node in selected.nodes" :key="node.id" :data-track-row="`${selected.id}:${node.id}`" class="task-trajectory-node"
          :class="{ 'is-current': node.id === currentNodeId, 'is-pending': node.status.kind === 'pending' }">
          <span class="task-node-marker" :class="tones[node.status.tone]"
            :data-task-node-owner="ownerKey" :data-task-id="selected.id" :data-task-node="node.id"
            :data-current-node="node.id === currentNodeId ? 'true' : undefined"
            :aria-label="`${node.title}：${node.status.label}`">
            <svg v-if="glyph(node) === 'check'" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="m6.5 10 2.5 2.5 4.5-5" stroke-linecap="round" stroke-linejoin="round" /></svg>
            <svg v-else-if="glyph(node) === 'wait'" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M8 7v6M12 7v6" /></svg>
            <svg v-else-if="glyph(node) === 'error'" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 6v5M10 13v1" /></svg>
            <svg v-else viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="6" /><circle v-if="node.id === currentNodeId" cx="10" cy="10" r="2.5" fill="currentColor" stroke="none" /></svg>
          </span>

          <div class="task-node-card" :class="{ 'is-running': nodeRunning(node) }">
            <TaskRunningBorder v-if="nodeRunning(node)" :active="true" :radius="8" />
            <div class="task-node-heading">
              <span class="task-node-title">{{ node.title }}</span>
              <span class="task-node-pill" :class="tones[node.status.tone]">{{ node.status.label }}</span>
            </div>
            <p v-if="node.description" class="task-node-description">{{ node.description }}</p>
            <div v-if="node.turns.at(-1)?.time" class="task-node-footer">
              <span class="task-node-time">{{ node.turns.at(-1)?.time }}</span>
            </div>
          </div>
        </li>
      </ol>
      <p v-else-if="selected" class="track-empty">{{ selected.intent }}</p>
      <p v-else-if="!pendingTurn" class="track-empty">任务说明尚未更新。</p>

      <details v-if="selected && selected.plans.length > 0" class="track-plan-attachment">
        <summary><span>执行计划</span><small>{{ selected.plans.some(flow => flow.phase === 'pending') ? '查看并开始' : selected.plans.some(flow => flow.phase === 'waiting') ? '等待继续' : `${selected.plans.length} 份记录` }}</small></summary>
        <div class="track-plan-content">
          <TaskFlowSteps v-for="flow in selected.plans" :key="flow.id" :flow="flow" :live="live" :uncertain="notice !== null" :project-root="projectRoot" :can-execute="canExecute" :starting="starting"
            @locate="entryId => emit('locate', entryId, ownerKey)" @start="(flowId, revision) => emit('start', flowId, revision, ownerKey)" />
        </div>
      </details>

      <footer v-if="earlier.available || earlier.error" class="track-history-footer">
        <AppButton variant="ghost" :disabled="earlier.loading" @click="loadEarlier">{{ earlier.loading ? '正在载入…' : earlier.error ? '重试载入历史' : '载入更早记录' }}</AppButton>
        <p v-if="earlier.error" class="text-desk-danger" role="status">{{ earlier.error }}</p>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.task-track-panel {
  display: flex;
  min-height: 0;
  flex-direction: column;
  background: var(--color-desk-surface);
  --track-color: var(--color-desk-accent);
}

/* 单层紧凑头部 */
.task-flow-header {
  flex-shrink: 0;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--color-desk-line);
  background: var(--color-desk-surface);
}
.task-flow-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.task-flow-status-group {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.task-flow-title {
  margin: 7px 0 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--color-desk-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-return-btn {
  padding: 1.5px 7px;
  border: 1px solid var(--color-desk-line-strong);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface);
  color: var(--color-desk-muted);
  font-size: 11px;
  cursor: pointer;
  transition: all var(--default-transition-duration);
}
.task-return-btn:hover {
  background: var(--color-desk-surface-subtle);
  color: var(--color-desk-ink);
}
.task-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1.5px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
  background: var(--color-desk-surface-subtle);
  border: 1px solid var(--color-desk-line);
}
.task-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.task-pill.text-desk-accent {
  background: var(--color-desk-accent-soft);
  color: var(--color-desk-accent);
  border-color: transparent;
}
.task-pill.text-desk-success {
  background: var(--color-desk-success-soft);
  color: var(--color-desk-success);
  border-color: transparent;
}
.task-pill.text-desk-warning {
  background: var(--color-desk-warning-soft);
  color: var(--color-desk-warning);
  border-color: transparent;
}
.task-pill.text-desk-danger {
  background: var(--color-desk-danger-soft);
  color: var(--color-desk-danger);
  border-color: transparent;
}
.task-pill.text-desk-muted {
  color: var(--color-desk-muted);
}
.task-pill-history {
  background: var(--color-desk-surface-subtle);
  color: var(--color-desk-muted);
}

.task-track-session-state {
  color: var(--color-desk-muted);
  font-size: 11px;
}
.task-track-history {
  position: relative;
  font-size: 12px;
  color: var(--color-desk-muted);
}
.task-track-history > summary {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 6px;
  border-radius: var(--radius-desk-sm);
  cursor: pointer;
}
.task-track-history > summary:hover {
  background: var(--color-desk-surface-subtle);
  color: var(--color-desk-ink);
}
.task-history-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 20;
  display: flex;
  flex-direction: column;
  width: min(280px, calc(100vw - 32px));
  max-height: 280px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-md);
  background: var(--color-desk-surface);
  box-shadow: var(--shadow-desk-pop);
}
.task-history-menu button {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--radius-desk-sm);
  background: none;
  color: var(--color-desk-ink);
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.task-history-menu button:hover,
.task-history-menu button[aria-current] {
  background: var(--color-desk-accent-soft);
}
.task-history-menu small {
  color: var(--color-desk-muted);
  font-size: 11px;
}

/* 滚动主容器 */
.task-track-scroll {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px 12px 18px;
  scrollbar-gutter: stable;
  overflow-anchor: none;
}
.track-notice {
  margin: 0 4px 12px;
  color: var(--color-desk-warning);
  font-size: 12px;
  line-height: 1.6;
}
.track-unassigned {
  margin: 0 4px 14px;
  padding: 9px 11px;
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface-subtle);
  color: var(--color-desk-muted);
  font-size: 11px;
  line-height: 1.6;
}
.track-small-label {
  display: block;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--color-desk-ink);
}
.track-unassigned p { margin: 3px 0; }
.track-unassigned-request {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
  color: var(--color-desk-ink);
  font-size: 11.5px;
}
.track-attention {
  margin: 0 4px 14px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--color-desk-warning) 30%, var(--color-desk-line));
  border-radius: var(--radius-desk-md);
  background: var(--color-desk-warning-soft);
}
.track-attention .track-small-label { color: var(--color-desk-warning); }
.track-attention p {
  margin: 5px 0 8px;
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 时间线轨道 */
.task-trajectory {
  list-style: none;
  margin: 0;
  padding: 0;
}
.task-trajectory-node {
  position: relative;
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 10px;
  padding: 0 0 12px;
}
.task-trajectory-node:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 9.5px;
  top: 22px;
  bottom: -4px;
  width: 1.5px;
  background: color-mix(in srgb, var(--track-color) 45%, var(--color-desk-line));
}
.task-trajectory-node.is-pending:not(:last-child)::before {
  background: repeating-linear-gradient(to bottom, var(--color-desk-line-strong) 0 3px, transparent 3px 7px);
}
.task-node-marker {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  margin-top: 6px;
  padding: 0;
  border-radius: 50%;
  background: var(--color-desk-surface);
  color: var(--color-desk-muted);
}
.task-node-marker svg { width: 18px; height: 18px; }
.is-current > .task-node-marker { color: var(--track-color); }
.is-current > .task-node-marker.text-desk-warning { color: var(--color-desk-warning); }
.is-current > .task-node-marker.text-desk-danger { color: var(--color-desk-danger); }

/* 现代微卡片 */
.task-node-card {
  position: relative;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-md);
  background: var(--color-desk-surface);
  box-shadow: var(--shadow-desk-raise);
  transition: border-color var(--default-transition-duration), background-color var(--default-transition-duration);
}
.task-node-card:hover {
  border-color: var(--color-desk-line-strong);
}
.is-current > .task-node-card {
  border-color: color-mix(in srgb, var(--track-color) 40%, var(--color-desk-line));
  background: var(--color-desk-surface);
}
.task-node-card.is-running {
  background: color-mix(in srgb, var(--color-desk-accent-soft) 30%, var(--color-desk-surface));
  border-color: color-mix(in srgb, var(--track-color) 60%, var(--color-desk-line));
}
.task-node-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.task-node-title {
  min-width: 0;
  color: var(--color-desk-ink);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.is-pending .task-node-title {
  color: var(--color-desk-muted);
  font-weight: 400;
}
.task-node-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
  background: var(--color-desk-surface-subtle);
  border: 1px solid var(--color-desk-line);
}
.task-node-pill.text-desk-accent {
  background: var(--color-desk-accent-soft);
  color: var(--color-desk-accent);
  border-color: transparent;
}
.task-node-pill.text-desk-success {
  background: var(--color-desk-success-soft);
  color: var(--color-desk-success);
  border-color: transparent;
}
.task-node-pill.text-desk-warning {
  background: var(--color-desk-warning-soft);
  color: var(--color-desk-warning);
  border-color: transparent;
}
.task-node-pill.text-desk-danger {
  background: var(--color-desk-danger-soft);
  color: var(--color-desk-danger);
  border-color: transparent;
}
.task-node-pill.text-desk-muted {
  color: var(--color-desk-muted);
}
.task-node-description {
  margin: 6px 0 0;
  color: var(--color-desk-muted);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.task-node-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
}
.task-node-time {
  color: var(--color-desk-muted);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.track-plan-attachment {
  margin: 12px 2px 0;
  padding-top: 12px;
  border-top: 1px solid var(--color-desk-line);
  color: var(--color-desk-muted);
  font-size: 12px;
}
.track-plan-attachment > summary {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  cursor: pointer;
}
.track-plan-attachment > summary small { font-size: 11px; }
.track-plan-content {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 10px;
}
.track-history-footer {
  margin-top: 16px;
  text-align: center;
  font-size: 12px;
}
.track-empty {
  margin: 4px 6px 16px;
  color: var(--color-desk-muted);
  font-size: 12px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
</style>
