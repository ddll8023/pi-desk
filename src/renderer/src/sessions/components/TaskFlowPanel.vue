<!-- 任务语义看板：紧凑轨道式时间线与节点展开交互，按业务目标、阶段与轮次组织工作流向。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SessionTaskGroup, SessionTaskTrack, SessionTaskTurn, TaskViewStatus, TaskViewTone } from '../task-flow-view'
import TaskFlowSteps from './TaskFlowSteps.vue'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly track: SessionTaskTrack
  readonly ownerKey: string
  readonly live: boolean
  readonly notice: string | null
  readonly projectRoot: string | null
  readonly earlier: { readonly available: boolean; readonly loading: boolean; readonly error: string | null }
}>()
const emit = defineEmits<{
  locate: [entryId: string, ownerKey: string]
  locateTurn: [messageId: string, ownerKey: string]
  loadEarlier: [ownerKey: string]
  loadTurn: [turnId: string, more: boolean, ownerKey: string]
}>()

const tones = {
  accent: 'text-desk-accent',
  success: 'text-desk-success',
  danger: 'text-desk-danger',
  warning: 'text-desk-warning',
  muted: 'text-desk-muted'
} satisfies Record<TaskViewTone, string>

interface BusinessSection {
  readonly id: string
  readonly title: string | null
  readonly status: TaskViewStatus | null
  readonly current: boolean
  readonly turns: readonly SessionTaskTurn[]
}

function sections(task: SessionTaskGroup): readonly BusinessSection[] {
  if (task.stages.length === 0) {
    return [{ id: 'rounds', title: null, status: null, current: task.current, turns: task.turns }]
  }
  return [
    ...task.stages.map(stage => ({ ...stage, id: `stage:${stage.id}` })),
    ...(task.unassigned.length === 0 ? [] : [{
      id: '__unassigned',
      title: '对话推进',
      status: null,
      current: task.unassigned.some(turn => turn.current),
      turns: task.unassigned
    }])
  ]
}

const plans = computed(() => [...props.track.turns.flatMap(turn => turn.plans), ...props.track.unattachedPlans])
const hasCurrentIntent = computed(() => props.track.tasks.some(task => task.current))

/** 节点展开状态缓存：默认展开当前活跃/最新轮，历史轮默认紧凑折叠 */
const expansion = ref<Record<string, boolean>>({})
/** 详情抽屉展开状态缓存 */
const detailsExpansion = ref<Record<string, boolean>>({})

const scroller = ref<HTMLElement | null>(null)
const followingLatest = ref(true)
let observer: ResizeObserver | null = null
let prependAnchor: { readonly id: string; readonly top: number; readonly ownerKey: string } | null = null

function isExpanded(turn: SessionTaskTurn): boolean {
  if (expansion.value[turn.id] !== undefined) {
    return expansion.value[turn.id]
  }
  return turn.current
}

function toggleTurn(turn: SessionTaskTurn): void {
  followingLatest.value = false
  const current = isExpanded(turn)
  expansion.value = { ...expansion.value, [turn.id]: !current }
}

function toggleDetails(turn: SessionTaskTurn): void {
  followingLatest.value = false
  const current = detailsExpansion.value[turn.id] ?? false
  detailsExpansion.value = { ...detailsExpansion.value, [turn.id]: !current }
  if (!current && turn.historyId !== null && turn.history.available && !turn.history.loaded && !turn.history.loading) {
    emit('loadTurn', turn.historyId, false, props.ownerKey)
  }
}

function locateTurn(turn: SessionTaskTurn): void {
  if (turn.messageId !== null) emit('locateTurn', turn.messageId, props.ownerKey)
}

function loadTurn(turn: SessionTaskTurn): void {
  if (turn.historyId !== null && !turn.history.loading) {
    followingLatest.value = false
    emit('loadTurn', turn.historyId, turn.history.loaded && turn.history.hasMore, props.ownerKey)
  }
}

function focusCurrent(force = false): void {
  const host = scroller.value
  const current = host?.querySelector<HTMLElement>('[data-current-focus="true"]')
  if (host === null || current == null || host.clientHeight === 0) return
  const bounds = host.getBoundingClientRect()
  const target = current.getBoundingClientRect()
  if (force || target.top < bounds.top || target.bottom > bounds.bottom) {
    host.scrollTop += target.top - bounds.top - 16
  }
}

function onScroll(): void {
  const host = scroller.value
  const current = host?.querySelector<HTMLElement>('[data-current-focus="true"]')
  if (host === null || current == null || prependAnchor !== null) return
  const bounds = host.getBoundingClientRect()
  const target = current.getBoundingClientRect()
  followingLatest.value = target.top >= bounds.top && target.bottom <= bounds.bottom
}

function scrollLatest(): void {
  followingLatest.value = true
  prependAnchor = null
  focusCurrent(true)
}

/** 历史前插保持侧栏自己的阅读位置，不接管主聊天区滚动。 */
function loadEarlier(): void {
  const host = scroller.value
  followingLatest.value = false
  if (host !== null) {
    const top = host.getBoundingClientRect().top
    const anchor = [...host.querySelectorAll<HTMLElement>('[data-task-turn-id]')].find(element => {
      const bounds = element.getBoundingClientRect()
      return bounds.height > 0 && bounds.bottom > top
    })
    if (anchor?.dataset.taskTurnId !== undefined) {
      prependAnchor = { id: anchor.dataset.taskTurnId, top: anchor.getBoundingClientRect().top - top, ownerKey: props.ownerKey }
    }
  }
  emit('loadEarlier', props.ownerKey)
}

watch(() => [props.track, props.earlier.loading] as const, () => {
  void nextTick(() => {
    const host = scroller.value
    if (host === null) return
    const anchor = prependAnchor
    if (anchor !== null && anchor.ownerKey === props.ownerKey) {
      const element = host.querySelector<HTMLElement>(`[data-task-turn-id="${CSS.escape(anchor.id)}"]`)
      if (element !== null) host.scrollTop += element.getBoundingClientRect().top - host.getBoundingClientRect().top - anchor.top
      if (!props.earlier.loading) prependAnchor = null
    } else if (followingLatest.value) focusCurrent()
  })
}, { flush: 'post', immediate: true })

onMounted(() => {
  observer = new ResizeObserver(() => { if (followingLatest.value) focusCurrent() })
  if (scroller.value !== null) observer.observe(scroller.value)
})

onBeforeUnmount(() => { observer?.disconnect() })
</script>

<template>
  <section class="task-flow-panel flex min-h-0 flex-col bg-desk-surface" aria-label="任务意图与业务流程">
    <!-- 顶部状态栏 -->
    <header class="flex shrink-0 items-center justify-between gap-2 border-b border-desk-line bg-desk-surface/90 px-3 py-2.5 backdrop-blur-xs">
      <div class="flex items-center gap-2 min-w-0">
        <span class="relative flex h-2 w-2 shrink-0">
          <span v-if="live" class="absolute inline-flex h-full w-full animate-ping rounded-full bg-desk-accent opacity-75 motion-reduce:animate-none"></span>
          <span class="relative inline-flex h-2 w-2 rounded-full" :class="live ? 'bg-desk-accent' : 'bg-desk-muted'"></span>
        </span>
        <h3 class="text-xs font-semibold text-desk-ink truncate">任务流程</h3>
      </div>
      <div class="flex items-center gap-2 text-2xs text-desk-muted shrink-0">
        <span v-if="track.tasks.length > 0">{{ track.tasks.length }} 项任务</span>
        <AppButton v-if="!followingLatest && hasCurrentIntent" variant="ghost" @click="scrollLatest">当前轮 ↓</AppButton>
      </div>
    </header>

    <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto p-3 space-y-3 [overflow-anchor:none]" @scroll.passive="onScroll">
      <!-- 异常或状态待确认提示 -->
      <div v-if="notice" class="rounded-desk-sm border border-desk-warning/30 bg-desk-warning-soft p-2 text-2xs text-desk-warning" role="status">
        {{ notice }}
      </div>

      <!-- 载入更早对话入口 -->
      <div v-if="earlier.available || earlier.error" class="py-1 text-center">
        <AppButton variant="ghost" :disabled="earlier.loading" @click="loadEarlier">
          {{ earlier.loading ? '正在载入…' : earlier.error ? '重试载入历史' : '载入更早对话' }}
        </AppButton>
        <p v-if="earlier.error" class="mt-1 text-left text-2xs text-desk-danger" role="status">{{ earlier.error }}</p>
      </div>

      <!-- 任务列表 -->
      <div class="space-y-4">
        <article
          v-for="task in track.tasks"
          :key="task.id"
          class="task-card rounded-desk-sm border border-desk-line bg-desk-surface p-3 transition-colors"
          :class="{ 'border-desk-line-strong shadow-desk-raise': task.current }"
          :aria-label="task.title"
        >
          <!-- 任务主标题栏 -->
          <header class="mb-3 space-y-1">
            <div class="flex items-start justify-between gap-2.5">
              <h4 class="min-w-0 break-words text-xs font-semibold leading-relaxed text-desk-ink">
                {{ task.title }}
              </h4>
              <span
                class="shrink-0 rounded-desk-xs px-1.5 py-0.5 font-mono text-2xs"
                :class="[tones[task.status.tone], task.current && task.status.kind === 'running' ? 'bg-desk-accent/10 font-medium' : 'bg-desk-surface-subtle']"
              >
                {{ task.status.label }}
              </span>
            </div>
            <p class="text-2xs text-desk-muted">
              {{ task.stages.length > 0 ? '业务阶段 · 流程跟踪' : '工作意图 · 单轮推进' }}
            </p>
          </header>

          <!-- 业务阶段或轮次轨迹轨道 -->
          <div class="task-sections space-y-4">
            <section
              v-for="section in sections(task)"
              :key="section.id"
              class="task-section relative"
              :class="{ 'is-staged pl-4': section.title }"
            >
              <!-- 业务阶段标题（仅长任务多阶段存在） -->
              <div v-if="section.title" class="stage-header relative mb-2 flex items-center justify-between gap-2 text-xs">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span
                    class="stage-indicator h-2 w-2 rounded-full border shrink-0"
                    :class="section.current ? 'border-desk-accent bg-desk-accent shadow-xs' : 'border-desk-line-strong bg-desk-surface-subtle'"
                    aria-hidden="true"
                  ></span>
                  <h5 class="break-words font-medium truncate" :class="section.current ? 'text-desk-accent' : 'text-desk-ink'">
                    {{ section.title }}
                  </h5>
                </div>
                <span v-if="section.status" class="shrink-0 text-2xs font-mono" :class="tones[section.status.tone]">
                  {{ section.status.label }}
                </span>
              </div>

              <!-- 连贯的垂直时间线轨道（Timeline Track） -->
              <ol class="timeline-track relative space-y-2.5" aria-label="轮次工作流向">
                <li
                  v-for="(turn, turnIdx) in section.turns"
                  :key="turn.id"
                  :data-task-turn-id="turn.id"
                  :data-current-focus="turn.current ? 'true' : undefined"
                  class="timeline-item relative flex gap-2.5"
                  :class="{ 'is-current': turn.current, 'is-expanded': isExpanded(turn) }"
                >
                  <!-- 垂直连接线（由 CSS 绘制）与状态节点图标（Glyph） -->
                  <div class="timeline-node shrink-0 pt-0.5 flex flex-col items-center">
                    <button
                      type="button"
                      class="node-disc flex h-4 w-4 items-center justify-center rounded-full border bg-desk-surface transition-all select-none"
                      :class="[
                        turn.current
                          ? 'border-desk-accent text-desk-accent ring-2 ring-desk-accent/20'
                          : turn.status.kind === 'failed'
                            ? 'border-desk-danger text-desk-danger bg-desk-danger-soft'
                            : turn.status.kind === 'interrupted'
                              ? 'border-desk-warning text-desk-warning bg-desk-warning-soft'
                              : 'border-desk-line text-desk-muted hover:border-desk-line-strong'
                      ]"
                      :title="isExpanded(turn) ? '收起此轮' : '展开此轮'"
                      :aria-label="isExpanded(turn) ? `收起第 ${turnIdx + 1} 轮` : `展开第 ${turnIdx + 1} 轮`"
                      @click="toggleTurn(turn)"
                    >
                      <!-- 进行中：微光脉冲点 -->
                      <span v-if="turn.status.kind === 'running'" class="relative flex h-2 w-2">
                        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-desk-accent opacity-75 motion-reduce:animate-none"></span>
                        <span class="relative inline-flex rounded-full h-2 w-2 bg-desk-accent"></span>
                      </span>
                      <!-- 完成：小点或序号 -->
                      <span v-else-if="turn.status.kind === 'responded'" class="h-1.5 w-1.5 rounded-full bg-desk-muted"></span>
                      <!-- 异常态：小警告点 -->
                      <span v-else-if="turn.status.kind === 'failed' || turn.status.kind === 'interrupted'" class="h-1.5 w-1.5 rounded-full bg-current"></span>
                      <!-- 默认空点 -->
                      <span v-else class="h-1.5 w-1.5 rounded-full border border-desk-line-strong"></span>
                    </button>
                  </div>

                  <!-- 节点内容主体 -->
                  <div class="timeline-content min-w-0 flex-1 space-y-1">
                    <!-- 紧凑概要行（点击可折叠/展开） -->
                    <div
                      class="group flex cursor-pointer items-start justify-between gap-2 select-none"
                      @click="toggleTurn(turn)"
                    >
                      <div class="flex items-baseline gap-1.5 min-w-0">
                        <span v-if="turn.time" class="shrink-0 font-mono text-2xs text-desk-muted">
                          {{ turn.time }}
                        </span>
                        <span v-if="turn.current" class="shrink-0 font-medium text-2xs text-desk-accent">
                          本轮
                        </span>
                        <p
                          class="break-words text-xs leading-relaxed transition-colors"
                          :class="[
                            turn.current ? 'font-medium text-desk-ink' : 'text-desk-muted group-hover:text-desk-ink',
                            !isExpanded(turn) ? 'line-clamp-1' : ''
                          ]"
                        >
                          {{ turn.title }}
                        </p>
                      </div>
                      <div class="flex items-center gap-1 shrink-0 text-desk-muted group-hover:text-desk-ink">
                        <svg
                          class="h-3 w-3 transition-transform duration-150 motion-reduce:transition-none"
                          :class="{ 'rotate-90': isExpanded(turn) }"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path fill-rule="evenodd" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z" clip-rule="evenodd" />
                        </svg>
                      </div>
                    </div>

                    <!-- 展开的详细卡片（Current 或被展开项可见） -->
                    <div
                      v-if="isExpanded(turn)"
                      class="turn-detail mt-1.5 rounded-desk-xs border border-desk-line/70 bg-desk-surface-subtle/50 p-2 text-2xs leading-relaxed space-y-2"
                    >
                      <!-- 正在执行的实时动作反馈 -->
                      <p v-if="turn.action" class="flex items-center gap-1.5 break-all font-mono text-desk-accent">
                        <span class="h-1.5 w-1.5 rounded-full bg-desk-accent animate-pulse shrink-0 motion-reduce:animate-none"></span>
                        <span>当前工具：{{ turn.action }}</span>
                      </p>

                      <!-- 本轮简要交付或结果总结 -->
                      <div v-if="turn.summary" class="rounded-desk-xs bg-desk-surface border border-desk-line/60 p-1.5 text-desk-ink">
                        <span class="font-medium text-desk-muted block mb-0.5">交付总结</span>
                        <p class="break-words leading-relaxed">{{ turn.summary }}</p>
                      </div>

                      <!-- 成功修改的文件标签胶囊 -->
                      <div v-if="turn.changedFiles.length > 0" class="space-y-1">
                        <span class="font-medium text-desk-success block">已记录修改 {{ turn.changedFiles.length }} 个文件</span>
                        <div class="flex flex-wrap gap-1">
                          <span
                            v-for="file in turn.changedFiles"
                            :key="file"
                            class="inline-block max-w-full truncate rounded-desk-xs border border-desk-line bg-desk-surface px-1.5 py-0.2 font-mono text-desk-ink"
                            :title="file"
                          >
                            {{ file }}
                          </span>
                        </div>
                      </div>

                      <!-- 操作栏：展开依据 / 定位对话 -->
                      <div class="flex items-center justify-between gap-2 pt-1 border-t border-desk-line/50">
                        <AppButton
                          variant="ghost"
                          :aria-expanded="detailsExpansion[turn.id] === true"
                          @click="toggleDetails(turn)"
                        >
                          {{ detailsExpansion[turn.id] ? '收起依据' : '查看依据' }}
                        </AppButton>
                        <AppButton
                          v-if="turn.messageId"
                          variant="ghost"
                          :aria-label="`定位对话：${turn.title}`"
                          @click="locateTurn(turn)"
                        >
                          定位对话 ↗
                        </AppButton>
                      </div>

                      <!-- 深层下钻依据：用户原文、回复文本、完整工具记录 -->
                      <div v-if="detailsExpansion[turn.id]" class="space-y-2.5 pt-1.5 border-t border-desk-line/40 text-desk-muted">
                        <details v-if="turn.request" class="group">
                          <summary class="cursor-pointer font-medium hover:text-desk-ink select-none">用户原文</summary>
                          <p class="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-desk-xs bg-desk-surface p-1.5 font-mono text-desk-ink border border-desk-line/60">
                            {{ turn.request }}
                          </p>
                        </details>

                        <details v-if="turn.responseText" class="group">
                          <summary class="cursor-pointer font-medium hover:text-desk-ink select-none">助手原始回复</summary>
                          <p class="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-desk-xs bg-desk-surface p-1.5 font-mono text-desk-ink border border-desk-line/60">
                            {{ turn.responseText }}
                          </p>
                        </details>

                        <!-- 工具活动列表 -->
                        <div v-if="turn.activities.length > 0" class="space-y-1">
                          <span class="font-medium block">底层操作流水（{{ turn.activities.reduce((s, a) => s + a.count, 0) }} 项）</span>
                          <ul class="space-y-1">
                            <li
                              v-for="activity in turn.activities"
                              :key="activity.id"
                              class="rounded-desk-xs bg-desk-surface px-1.5 py-1 border border-desk-line/50 flex items-start justify-between gap-2"
                            >
                              <div class="min-w-0">
                                <span class="font-medium text-desk-ink">
                                  {{ activity.title }}
                                  <span v-if="activity.count > 1" class="font-normal text-desk-muted">×{{ activity.count }}</span>
                                </span>
                                <p v-for="subject in activity.subjects.slice(0, 2)" :key="subject" class="truncate font-mono text-desk-muted" :title="subject">
                                  {{ subject }}
                                </p>
                              </div>
                              <span class="shrink-0 font-mono" :class="tones[activity.status.tone]">
                                {{ activity.status.label }}
                              </span>
                            </li>
                          </ul>
                        </div>

                        <!-- 读取参考的文件 -->
                        <details v-if="turn.readFiles.length > 0" class="group">
                          <summary class="cursor-pointer font-medium hover:text-desk-ink select-none">
                            读取参考 · {{ turn.readFiles.length }} 个文件
                          </summary>
                          <ul class="mt-1 space-y-0.5 rounded-desk-xs bg-desk-surface p-1.5 font-mono border border-desk-line/60">
                            <li v-for="file in turn.readFiles" :key="file" class="truncate" :title="file">{{ file }}</li>
                          </ul>
                        </details>

                        <!-- 历史未载入时的补读入口 -->
                        <div v-if="turn.history.available" class="pt-1">
                          <p v-if="turn.history.error" class="text-desk-danger" role="status">{{ turn.history.error }}</p>
                          <AppButton
                            v-if="!turn.history.loaded || turn.history.hasMore || turn.history.loading"
                            variant="ghost"
                            :disabled="turn.history.loading"
                            @click="loadTurn(turn)"
                          >
                            {{ turn.history.loading ? '正在载入…' : turn.history.error ? '重试读取' : turn.history.loaded ? '载入后续记录' : '载入完整执行记录' }}
                          </AppButton>
                        </div>
                      </div>
                    </div>
                  </div>
                </li>
              </ol>
            </section>
          </div>
        </article>
      </div>

      <!-- 结构化任务计划抽屉（若注册了 task_plan） -->
      <details v-if="plans.length > 0" class="border-t border-desk-line pt-3" @click="followingLatest = false">
        <summary class="cursor-pointer rounded-desk-sm text-2xs font-medium text-desk-muted hover:text-desk-ink select-none">
          已登记的计划步骤（{{ plans.length }} 项）
        </summary>
        <div class="mt-2.5 space-y-3">
          <TaskFlowSteps
            v-for="flow in plans"
            :key="flow.id"
            :flow="flow"
            :live="live"
            :uncertain="notice !== null"
            :project-root="projectRoot"
            @locate="entryId => emit('locate', entryId, ownerKey)"
            @inspect="followingLatest = false"
          />
        </div>
      </details>

      <!-- 完全空态 -->
      <p v-if="track.tasks.length === 0 && plans.length === 0" class="py-8 text-center text-xs text-desk-muted">
        暂无可展示的任务信息
      </p>
    </div>
  </section>
</template>

<style scoped>
.task-flow-panel {
  min-height: 0;
}

/* 垂直轨道连续线：连接前后节点 */
.timeline-item:not(:last-child) .timeline-node::after {
  content: '';
  position: absolute;
  top: 18px;
  bottom: -10px;
  left: 7.5px;
  width: 1px;
  background: var(--color-desk-line);
  z-index: 0;
}

/* 阶段缩进时左侧的阶段轨道线 */
.task-section.is-staged::before {
  content: '';
  position: absolute;
  left: 3.5px;
  top: 10px;
  bottom: 0;
  width: 1px;
  background: var(--color-desk-line);
  z-index: 0;
}

.timeline-item.is-current .node-disc {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-desk-accent) 15%, transparent);
}
</style>
