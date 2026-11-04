<!-- 轨道附属的执行说明：只展示计划范围与开始/继续动作，不重复绘制主轨道；请求固定原计划和修订号。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TaskFlow } from '../../../../shared/task-flow'
import { isTaskFlowActive } from '../../../../shared/task-flow'
import { taskFlowStatus } from '../task-flow-view'
import type { TaskViewTone } from '../task-flow-view'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly flow: TaskFlow
  readonly live: boolean
  readonly uncertain: boolean
  readonly projectRoot: string | null
  readonly canExecute: boolean
  readonly starting: boolean
}>()
const emit = defineEmits<{
  locate: [entryId: string]
  start: [flowId: string, revision: number]
}>()
const tones = {
  accent: 'text-desk-accent', success: 'text-desk-success', danger: 'text-desk-danger',
  warning: 'text-desk-warning', muted: 'text-desk-muted'
} satisfies Record<TaskViewTone, string>
const expansion = ref<Record<string, boolean>>({})
const status = computed(() => taskFlowStatus(props.flow.phase, props.live, props.uncertain))
const completed = computed(() => props.flow.steps.filter(step => step.phase === 'completed').length)
const actionable = computed(() => props.flow.phase === 'pending' || props.flow.phase === 'waiting')
const disabled = computed(() => !props.canExecute || !props.live || props.uncertain || props.starting)
const disabledReason = computed(() => !props.live ? '当前仅供回看，回到已连接的对话后操作。'
  : props.uncertain ? '任务状态尚未确认，请先同步最新记录。'
    : props.starting ? '正在核对本次操作，不会重复提交。' : !props.canExecute ? '请先处理当前回应或等待会话空闲。' : undefined)
const steps = computed(() => props.flow.steps.map(step => {
  const state = taskFlowStatus(step.phase, props.live, props.uncertain)
  const unexecuted = step.phase === 'pending' && props.flow.phase !== 'pending' && !isTaskFlowActive(props.flow.phase) && props.flow.phase !== 'waiting'
  return { ...step, status: step.phase === 'completed' ? { ...state, label: '已交付' }
    : unexecuted ? { ...state, label: '未执行' } : state }
}))
function isOpen(id: string, phase: string): boolean {
  return expansion.value[id] ?? ['running', 'stopping', 'waiting', 'failed'].includes(phase)
}
function toggle(id: string, phase: string): void {
  expansion.value = { ...expansion.value, [id]: !isOpen(id, phase) }
}
</script>

<template>
  <section class="user-plan" :aria-label="`工作计划：${flow.title}`">
    <header class="user-plan-header">
      <h6>{{ flow.title }}</h6>
      <span :class="tones[status.tone]">{{ status.label }}</span>
    </header>
    <p class="user-plan-count">已交付 {{ completed }} / {{ flow.steps.length }} 步<span v-if="flow.phase === 'waiting'"> · 后续步骤尚未派发</span></p>

    <ol class="user-plan-steps" aria-label="执行步骤">
      <li v-for="(step, index) in steps" :key="step.id" :class="{ 'is-current': ['running', 'stopping', 'waiting'].includes(step.phase) }">
        <span class="user-plan-node" :class="tones[step.status.tone]" aria-hidden="true">{{ step.phase === 'completed' ? '✓' : index + 1 }}</span>
        <div class="user-plan-step-body">
          <button type="button" class="user-plan-step-trigger" :aria-expanded="isOpen(step.id, step.phase)" :aria-controls="`task-step-${step.id}`" @click="toggle(step.id, step.phase)">
            <span class="user-plan-step-title">{{ step.title }}</span>
            <span class="user-plan-step-status" :class="tones[step.status.tone]">{{ step.status.label }}</span>
            <svg class="user-plan-chevron" :class="{ 'is-open': isOpen(step.id, step.phase) }" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true"><path d="m6 4 4 4-4 4" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
          <div v-if="isOpen(step.id, step.phase)" :id="`task-step-${step.id}`" class="user-plan-step-detail">
            <p class="user-plan-instruction">{{ step.instruction }}</p>
            <p v-if="step.waitingReason && step.phase === 'waiting'" class="user-plan-waiting" role="status">{{ step.waitingReason }}</p>
            <p v-if="step.error" class="text-desk-danger" role="status">{{ step.error }}</p>
            <p v-if="step.changedFiles && step.changedFiles.length > 0" class="user-plan-change-count">记录了 {{ step.changedFiles.length }} 个文件变更，可在交付节点查看。</p>
            <details v-if="step.result" class="user-plan-response">
              <summary>本步回复</summary>
              <p>{{ step.result }}</p>
            </details>
            <AppButton v-if="step.resultEntryId || step.promptEntryId" variant="ghost" @click="emit('locate', step.resultEntryId ?? step.promptEntryId ?? '')">查看相关对话 ↗</AppButton>
          </div>
        </div>
      </li>
    </ol>

    <footer v-if="actionable" class="user-plan-action">
      <p>{{ flow.phase === 'waiting' ? '先在对话中补充信息或确认操作范围，再继续当前步骤。' : '查看步骤和范围后开始，仅推进已获授权的工作。' }}</p>
      <AppButton variant="primary" :disabled="disabled" :title="disabledReason" :aria-busy="starting" @click="emit('start', flow.id, flow.revision)">
        {{ starting ? '正在提交…' : flow.phase === 'waiting' ? '继续当前步骤' : '开始执行' }}
      </AppButton>
      <span v-if="!live" class="user-plan-readonly">历史计划，仅供回看</span>
    </footer>
  </section>
</template>

<style scoped>
.user-plan { min-width: 0; }
.user-plan-header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.user-plan-header h6 { min-width: 0; margin: 0; font-size: 13px; font-weight: 500; line-height: 1.65; overflow-wrap: anywhere; }
.user-plan-header > span { flex-shrink: 0; font-size: 11px; }
.user-plan-count { margin: 4px 0 14px; color: var(--color-desk-muted); font-size: 11px; line-height: 1.6; }
.user-plan-steps { list-style: none; margin: 0; padding: 0; }
.user-plan-steps > li { position: relative; display: flex; gap: 10px; padding-bottom: 16px; }
.user-plan-steps > li:last-child { padding-bottom: 0; }
.user-plan-node { display: grid; place-items: center; flex-shrink: 0; width: 17px; height: 17px; margin-top: 2px; border: 1px solid var(--color-desk-line); border-radius: 4px; background: var(--color-desk-surface); font-size: 10px; font-variant-numeric: tabular-nums; }
.is-current > .user-plan-node { border-color: currentColor; background: var(--color-desk-surface-subtle); }
.user-plan-step-body { min-width: 0; flex: 1; }
.user-plan-step-trigger { display: flex; align-items: baseline; gap: 6px; width: 100%; padding: 0; border: 0; border-radius: var(--radius-desk-sm); background: none; color: var(--color-desk-ink); font-size: 12px; line-height: 1.65; text-align: left; cursor: pointer; }
.user-plan-step-title { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.user-plan-step-status { flex-shrink: 0; font-size: 11px; }
.user-plan-chevron { width: 12px; height: 12px; flex-shrink: 0; align-self: center; color: var(--color-desk-muted); transition: transform var(--default-transition-duration) ease; }
.user-plan-chevron.is-open { transform: rotate(90deg); }
.user-plan-step-detail { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin-top: 8px; color: var(--color-desk-muted); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.user-plan-step-detail > p { margin: 0; }
.user-plan-instruction { max-height: 160px; overflow-y: auto; white-space: pre-wrap; }
.user-plan-waiting { color: var(--color-desk-warning); }
.user-plan-change-count { font-size: 11px; }
.user-plan-response { width: 100%; }
.user-plan-response p { max-height: 240px; overflow-y: auto; margin: 6px 0 0; padding: 8px; border-radius: var(--radius-desk-sm); background: var(--color-desk-surface-subtle); color: var(--color-desk-ink); white-space: pre-wrap; }
.user-plan-action { display: flex; align-items: flex-start; flex-direction: column; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--color-desk-line); }
.user-plan-action > p { margin: 0; color: var(--color-desk-muted); font-size: 12px; line-height: 1.65; }
.user-plan-readonly { color: var(--color-desk-muted); font-size: 11px; }
@media (prefers-reduced-motion: reduce) { .user-plan-chevron { transition: none; } }
</style>
