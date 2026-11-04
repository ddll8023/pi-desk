<!-- 参考 Lancer SessionTrajectoryPanel 的可读单轨道：目标固定、业务节点连续、交付挂在轨道中，未归属活动不参与选中或连线。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { SessionTaskTurn, SessionTaskTrack, TaskTrackNode, TaskViewTone } from '../task-flow-view'
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
const records = ref<Record<string, boolean>>({})
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
function recordKey(node: TaskTrackNode): string { return `${selected.value?.id ?? ''}:${node.id}` }
function recordsOpen(node: TaskTrackNode): boolean { return records.value[recordKey(node)] ?? false }
function toggleRecords(node: TaskTrackNode): void {
  following.value = false
  records.value = { ...records.value, [recordKey(node)]: !recordsOpen(node) }
}
function locateTurn(turn: SessionTaskTurn | null): void {
  if (turn?.messageId != null) emit('locateTurn', turn.messageId, props.ownerKey)
}
function locateNode(node: TaskTrackNode): void {
  if (node.entryId !== null) emit('locate', node.entryId, props.ownerKey)
}
function nodeRunning(node: TaskTrackNode): boolean {
  return taskRunning.value && node.id === currentNodeId.value && node.status.kind === 'running'
}
function glyph(node: TaskTrackNode): string {
  if (node.kind === 'delivery') return 'file'
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
function followCurrent(): void { following.value = true; focusCurrent(true) }
function loadTurn(turn: SessionTaskTurn): void {
  if (turn.historyId !== null && turn.history.available && !turn.history.loading) {
    emit('loadTurn', turn.historyId, turn.history.loaded && turn.history.hasMore, props.ownerKey)
  }
}
function openRecord(event: Event, turn: SessionTaskTurn): void {
  if (event.target instanceof HTMLDetailsElement && event.target.open && !turn.history.loaded) loadTurn(turn)
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
    <header class="task-track-toolbar">
      <h3>任务流程</h3>
      <details v-if="historicalTasks.length > 0" ref="historyMenu" class="task-track-history">
        <summary>历史 <span>{{ historicalTasks.length }}</span><span aria-hidden="true">⌄</span></summary>
        <div class="task-history-menu">
          <button v-for="task in historicalTasks" :key="task.id" type="button" :aria-current="selected?.id === task.id ? 'true' : undefined" @click="selectTask(task.id)">
            <span>{{ task.title }}</span><small>{{ task.status.label }}</small>
          </button>
        </div>
      </details>
      <span v-else class="task-track-session-state">{{ live ? '当前会话' : notice ? '记录待同步' : '历史记录' }}</span>
    </header>

    <header v-if="selected" class="task-lane-head">
      <div class="task-lane-meta">
        <span><i aria-hidden="true"></i>{{ pinned ? '历史任务' : selected.current ? '当前任务' : '最近任务' }}</span>
        <AppButton v-if="pinned && currentTask" variant="ghost" @click="selectTask(currentTask.id)">回到当前</AppButton>
        <span v-else class="task-lane-status" :class="tones[selected.status.tone]">{{ taskStatusLabel }}</span>
      </div>
      <h4>{{ selected.title }}</h4>
      <div class="task-lane-links">
        <AppButton v-if="selected.latest?.messageId" variant="ghost" @click="locateTurn(selected.latest)">定位对话 ↗</AppButton>
        <AppButton v-if="!following && !pinned && currentNodeId" variant="ghost" @click="followCurrent">当前节点 ↓</AppButton>
      </div>
    </header>

    <div ref="scroller" class="task-track-scroll" @scroll.passive="onScroll">
      <p v-if="notice" class="track-notice" role="status">{{ notice }}</p>
      <aside v-if="pendingTurn" class="track-unassigned" role="status">
        <span class="track-small-label">{{ running ? '新消息正在处理' : '新消息尚未关联任务' }}</span>
        <p v-if="pendingTurn.request" class="track-unassigned-request">{{ pendingTurn.request }}</p>
        <p>归属确认前保留已有任务，不自动连入轨道。</p>
        <AppButton v-if="pendingTurn.messageId" variant="ghost" @click="locateTurn(pendingTurn)">查看本轮对话 ↗</AppButton>
      </aside>

      <aside v-if="attentionText" class="track-attention" role="status">
        <span class="track-small-label">{{ attentionTitle }}</span>
        <p>{{ attentionText }}</p>
        <AppButton v-if="waitingDialog" @click="emit('showQuestion', waitingDialog.id, ownerKey)">查看问题</AppButton>
        <AppButton v-else-if="selected?.latest?.messageId" @click="locateTurn(selected.latest)">查看说明并回应</AppButton>
      </aside>

      <ol v-if="selected && selected.nodes.length > 0" :key="selected.id" class="task-trajectory" aria-label="任务业务轨道">
        <li v-for="node in selected.nodes" :key="node.id" :data-track-row="`${selected.id}:${node.id}`" class="task-trajectory-node"
          :class="{ 'is-current': node.id === currentNodeId, 'is-pending': node.status.kind === 'pending', 'is-delivery': node.kind === 'delivery' }">
          <button type="button" class="task-node-marker" :class="tones[node.status.tone]" :disabled="node.entryId === null"
            :data-task-node-owner="ownerKey" :data-task-id="selected.id" :data-task-node="node.id"
            :data-current-node="node.id === currentNodeId ? 'true' : undefined"
            :aria-label="`${node.title}：${node.entryId ? '定位对应对话' : node.status.label}`" @click="locateNode(node)">
            <svg v-if="glyph(node) === 'file'" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M6 3h5l4 4v10H6zM11 3v4h4" stroke-linejoin="round" /></svg>
            <svg v-else-if="glyph(node) === 'check'" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="m6.5 10 2.5 2.5 4.5-5" stroke-linecap="round" stroke-linejoin="round" /></svg>
            <svg v-else-if="glyph(node) === 'wait'" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M8 7v6M12 7v6" /></svg>
            <svg v-else-if="glyph(node) === 'error'" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 6v5M10 13v1" /></svg>
            <svg v-else viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="6" /><circle v-if="node.id === currentNodeId" cx="10" cy="10" r="2.5" fill="currentColor" stroke="none" /></svg>
          </button>

          <div class="task-node-card" :class="{ 'is-running': nodeRunning(node) }">
            <TaskRunningBorder v-if="nodeRunning(node)" :active="true" :radius="8" />
            <div class="task-node-heading">
              <button v-if="node.entryId" type="button" class="task-node-title" @click="locateNode(node)">{{ node.title }}</button>
              <span v-else class="task-node-title">{{ node.title }}</span>
              <span class="task-node-status" :class="tones[node.status.tone]">{{ node.status.label }}</span>
            </div>
            <p v-if="node.description" class="task-node-description">{{ node.description }}</p>

            <ul v-if="node.artifacts.length > 0" class="task-node-artifacts" aria-label="此交付的文件入口">
              <li v-for="artifact in node.artifacts" :key="artifact.path">
                <button type="button" class="task-delivery-file" :disabled="!canOpenFiles" :title="canOpenFiles ? artifact.path : `${artifact.path}（工作区当前不可用）`" @click="emit('openFile', artifact.path, ownerKey)">
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4M7.5 10h5M7.5 13h5" stroke-linejoin="round" stroke-linecap="round" /></svg>
                  <span class="task-delivery-copy"><strong>{{ artifact.title }}</strong><span v-if="artifact.description">{{ artifact.description }}</span><small>{{ artifact.kind === 'artifact' ? '交付文件' : '已记录变更' }} · {{ artifact.path }}</small></span>
                  <span class="task-delivery-open">打开 ↗</span>
                </button>
              </li>
            </ul>

            <div v-if="node.turns.length > 0" class="task-node-actions">
              <AppButton variant="ghost" :aria-expanded="recordsOpen(node)" @click="toggleRecords(node)">{{ recordsOpen(node) ? '收起过程' : '查看过程' }}<span v-if="node.turns.length > 1"> · {{ node.turns.length }}</span></AppButton>
              <span v-if="node.turns.at(-1)?.time" class="task-node-time">{{ node.turns.at(-1)?.time }}</span>
            </div>
            <Transition name="track-detail">
              <div v-if="recordsOpen(node)" class="task-node-records">
                <details v-for="turn in node.turns" :key="turn.id" class="track-record" @toggle="openRecord($event, turn)">
                  <summary><span>{{ turn.title }}</span><small :class="tones[turn.status.tone]">{{ turn.status.label }}</small></summary>
                  <div class="track-record-body">
                    <p v-if="turn.summary">{{ turn.summary }}</p>
                    <AppButton v-if="turn.messageId" variant="ghost" @click="locateTurn(turn)">定位本轮对话 ↗</AppButton>
                    <details v-if="turn.request"><summary>用户原文</summary><p class="track-original">{{ turn.request }}</p></details>
                    <details v-if="turn.responseText"><summary>助手回复</summary><p class="track-original">{{ turn.responseText }}</p></details>
                    <ul v-if="turn.activities.length > 0" class="track-operations">
                      <li v-for="activity in turn.activities" :key="activity.id"><div><span>{{ activity.title }}{{ activity.count > 1 ? ` ×${activity.count}` : '' }}</span><small :class="tones[activity.status.tone]">{{ activity.status.label }}</small></div><p v-for="subject in activity.subjects.slice(0, 2)" :key="subject" :title="subject">{{ subject }}</p></li>
                    </ul>
                    <details v-if="turn.readFiles.length > 0"><summary>参考文件 · {{ turn.readFiles.length }}</summary><ul class="track-reference-files"><li v-for="file in turn.readFiles" :key="file">{{ file }}</li></ul></details>
                    <p v-if="turn.history.error" class="text-desk-danger" role="status">{{ turn.history.error }}</p>
                    <AppButton v-if="turn.history.available && (!turn.history.loaded || turn.history.hasMore || turn.history.loading)" variant="ghost" :disabled="turn.history.loading" @click="loadTurn(turn)">{{ turn.history.loading ? '正在载入…' : turn.history.error ? '重试读取' : turn.history.loaded ? '载入后续记录' : '载入完整记录' }}</AppButton>
                  </div>
                </details>
              </div>
            </Transition>
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

      <details v-if="track.unreported.length > 0" class="track-unassigned-records">
        <summary>尚未关联的对话 <small>{{ track.unreported.length }}</small></summary>
        <div v-for="turn in track.unreported" :key="turn.id" class="track-unassigned-entry"><p>{{ turn.request || '没有可显示的用户正文' }}</p><AppButton v-if="turn.messageId" variant="ghost" @click="locateTurn(turn)">查看对话 ↗</AppButton></div>
      </details>
      <footer v-if="earlier.available || earlier.error" class="track-history-footer">
        <AppButton variant="ghost" :disabled="earlier.loading" @click="loadEarlier">{{ earlier.loading ? '正在载入…' : earlier.error ? '重试载入历史' : '载入更早记录' }}</AppButton>
        <p v-if="earlier.error" class="text-desk-danger" role="status">{{ earlier.error }}</p>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.task-track-panel { display: flex; min-height: 0; flex-direction: column; background: var(--color-desk-surface); --track-color: var(--color-desk-accent); }
.task-track-toolbar { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--color-desk-line); }
.task-track-toolbar h3 { margin: 0; font-size: 13px; font-weight: 600; }
.task-track-session-state { color: var(--color-desk-muted); font-size: 11px; }
.task-track-history { position: relative; font-size: 12px; color: var(--color-desk-muted); }
.task-track-history > summary { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: var(--radius-desk-sm); }
.task-track-history > summary:hover { background: var(--color-desk-surface-subtle); }
.task-history-menu { position: absolute; right: 0; top: calc(100% + 8px); z-index: 20; display: flex; flex-direction: column; width: min(280px, calc(100vw - 32px)); max-height: 280px; overflow-y: auto; padding: 4px; border: 1px solid var(--color-desk-line); border-radius: var(--radius-desk-md); background: var(--color-desk-surface); box-shadow: var(--shadow-desk-pop); }
.task-history-menu button { display: flex; flex-direction: column; gap: 4px; padding: 10px; border: 0; border-radius: var(--radius-desk-sm); background: none; color: var(--color-desk-ink); text-align: left; font: inherit; cursor: pointer; }
.task-history-menu button:hover, .task-history-menu button[aria-current] { background: var(--color-desk-accent-soft); }
.task-history-menu small { color: var(--color-desk-muted); font-size: 11px; }
.task-lane-head { flex-shrink: 0; position: relative; padding: 14px 16px 10px; border-bottom: 1px solid var(--color-desk-line); }
.task-lane-head::before { content: ''; position: absolute; left: 0; top: 16px; bottom: 14px; width: 2px; background: var(--track-color); }
.task-lane-meta { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; margin-bottom: 7px; color: var(--color-desk-muted); font-size: 11px; }
.task-lane-meta > span:first-child { display: inline-flex; align-items: center; gap: 6px; }
.task-lane-meta i { width: 5px; height: 5px; border-radius: 50%; background: var(--track-color); }
.task-lane-status { font-size: 11px; }
.task-lane-head h4 { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.6; overflow-wrap: anywhere; }
.task-lane-links { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
.task-track-scroll { min-height: 0; flex: 1; overflow-y: auto; overflow-x: hidden; padding: 16px 12px 20px; scrollbar-gutter: stable; overflow-anchor: none; }
.track-notice { margin: 0 4px 12px; color: var(--color-desk-warning); font-size: 12px; line-height: 1.65; }
.track-unassigned { margin: 0 4px 16px; padding: 10px 12px; border-radius: var(--radius-desk-sm); background: var(--color-desk-surface-subtle); color: var(--color-desk-muted); font-size: 11px; line-height: 1.65; }
.track-small-label { display: block; font-size: 12px; font-weight: 500; }
.track-unassigned p { margin: 4px 0; }
.track-unassigned-request { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; color: var(--color-desk-ink); font-size: 12px; }
.track-attention { margin: 0 4px 16px; padding: 12px; border: 1px solid color-mix(in srgb, var(--color-desk-warning) 25%, var(--color-desk-line)); border-radius: var(--radius-desk-md); background: var(--color-desk-warning-soft); }
.track-attention .track-small-label { color: var(--color-desk-warning); }
.track-attention p { margin: 6px 0 10px; font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.task-trajectory { list-style: none; margin: 0; padding: 0; }
.task-trajectory-node { position: relative; display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; padding: 0 0 12px; }
.task-trajectory-node:not(:last-child)::before { content: ''; position: absolute; left: 10px; top: 20px; bottom: -2px; width: 1.5px; background: color-mix(in srgb, var(--track-color) 55%, var(--color-desk-line)); }
.task-trajectory-node.is-pending:not(:last-child)::before { background: repeating-linear-gradient(to bottom, var(--color-desk-line-strong) 0 3px, transparent 3px 7px); }
.task-node-marker { position: relative; z-index: 1; display: grid; place-items: center; width: 22px; height: 22px; margin-top: 9px; padding: 0; border: 0; border-radius: 50%; background: var(--color-desk-surface); cursor: pointer; }
.task-node-marker:disabled { cursor: default; }
.task-node-marker svg { width: 20px; height: 20px; }
.is-current > .task-node-marker { color: var(--track-color); }
.is-current > .task-node-marker.text-desk-warning { color: var(--color-desk-warning); }
.is-current > .task-node-marker.text-desk-danger { color: var(--color-desk-danger); }
.task-node-card { position: relative; min-width: 0; padding: 9px 10px; border: 1px solid transparent; border-radius: var(--radius-desk-md); }
.is-current > .task-node-card { border-color: var(--color-desk-line); background: var(--color-desk-surface-subtle); }
.task-node-card.is-running { background: color-mix(in srgb, var(--color-desk-accent-soft) 35%, var(--color-desk-surface)); }
.task-node-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.task-node-title { min-width: 0; margin: 0; padding: 0; border: 0; border-radius: 2px; background: none; color: var(--color-desk-ink); text-align: left; font: inherit; font-size: 13px; font-weight: 500; line-height: 1.7; overflow-wrap: anywhere; }
button.task-node-title { cursor: pointer; }
button.task-node-title:hover { color: var(--track-color); }
.is-pending .task-node-title { color: var(--color-desk-muted); font-weight: 400; }
.task-node-status { flex-shrink: 0; font-size: 11px; }
.task-node-description { margin: 6px 0 0; color: var(--color-desk-muted); font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.task-node-actions { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 7px; }
.task-node-time { color: var(--color-desk-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.task-node-artifacts { list-style: none; display: flex; flex-direction: column; gap: 8px; margin: 10px 0 0; padding: 0; }
.task-delivery-file { display: flex; align-items: flex-start; gap: 7px; width: 100%; padding: 10px 8px; border: 1px solid var(--color-desk-line); border-radius: var(--radius-desk-sm); background: var(--color-desk-surface); color: var(--color-desk-ink); text-align: left; cursor: pointer; }
.task-delivery-file:hover:not(:disabled) { border-color: var(--color-desk-line-strong); background: var(--color-desk-surface-subtle); }
.task-delivery-file:disabled { cursor: default; }
.task-delivery-file > svg { width: 16px; height: 18px; flex-shrink: 0; margin-top: 2px; color: var(--color-desk-muted); }
.task-delivery-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; overflow-wrap: anywhere; }
.task-delivery-copy strong { font-size: 12px; font-weight: 500; }
.task-delivery-copy > span { color: var(--color-desk-muted); font-size: 11px; line-height: 1.6; }
.task-delivery-copy small { overflow: hidden; color: var(--color-desk-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.task-delivery-open { flex-shrink: 0; color: var(--track-color); font-size: 11px; }
.task-node-records { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--color-desk-line); }
.track-record { padding: 7px 0; font-size: 12px; line-height: 1.65; }
.track-record > summary { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; overflow-wrap: anywhere; }
.track-record small { flex-shrink: 0; font-size: 10px; }
.track-record-body { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin-top: 8px; color: var(--color-desk-muted); }
.track-record-body p { margin: 0; overflow-wrap: anywhere; }
.track-record-body > details, .track-operations { width: 100%; }
.track-original { max-height: 240px; overflow-y: auto; padding: 8px; margin-top: 6px !important; border-radius: var(--radius-desk-sm); background: var(--color-desk-surface); white-space: pre-wrap; }
.track-operations, .track-reference-files { list-style: none; margin: 0; padding: 0; }
.track-operations > li { padding: 6px 0; }
.track-operations li > div { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.track-operations p { overflow: hidden; margin-top: 2px; font: 10px/1.6 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.track-reference-files { margin-top: 6px; font: 10px/1.6 var(--font-mono); overflow-wrap: anywhere; }
.track-plan-attachment, .track-unassigned-records { margin: 12px 4px 0; padding-top: 12px; border-top: 1px solid var(--color-desk-line); color: var(--color-desk-muted); font-size: 12px; }
.track-plan-attachment > summary, .track-unassigned-records > summary { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.track-plan-attachment > summary small, .track-unassigned-records > summary small { font-size: 11px; }
.track-plan-content { display: flex; flex-direction: column; gap: 16px; margin-top: 12px; }
.track-unassigned-entry { padding: 10px 0; border-bottom: 1px solid var(--color-desk-line); }
.track-unassigned-entry p { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; margin: 0 0 6px; overflow: hidden; overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; }
.track-history-footer { margin-top: 16px; text-align: center; font-size: 12px; }
.track-empty { margin: 4px 8px 16px; color: var(--color-desk-muted); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.track-detail-enter-active, .track-detail-leave-active { transition: opacity var(--motion-duration-fast) ease, transform var(--motion-duration-fast) var(--motion-ease-entrance); }
.track-detail-enter-from, .track-detail-leave-to { opacity: 0; transform: translateY(-3px); }
@media (prefers-reduced-motion: reduce) { .track-detail-enter-active, .track-detail-leave-active { transition: none; } .track-detail-enter-from, .track-detail-leave-to { transform: none; } }
</style>
