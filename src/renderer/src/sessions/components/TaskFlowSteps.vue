<!-- 真实任务计划的只读步骤轨道：展示宿主状态、结果与变更，定位交给会话宿主，不提供执行控制。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { TaskFlow } from '../../../../shared/task-flow'
import { isTaskFlowActive } from '../../../../shared/task-flow'
import { taskFlowStatus } from '../task-flow-view'
import type { TaskViewTone } from '../task-flow-view'
import { displayToolPath } from '../tool-summary'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly flow: TaskFlow
  readonly live: boolean
  readonly uncertain: boolean
  readonly projectRoot: string | null
}>()
const emit = defineEmits<{ locate: [entryId: string]; inspect: [] }>()
const tones = {
  accent: 'text-desk-accent', success: 'text-desk-success', danger: 'text-desk-danger',
  warning: 'text-desk-warning', muted: 'text-desk-muted'
} satisfies Record<TaskViewTone, string>
const status = computed(() => taskFlowStatus(props.flow.phase, props.live, props.uncertain))
const completed = computed(() => props.flow.steps.filter(step => step.phase === 'completed').length)
const percent = computed(() => props.flow.steps.length === 0 ? 0 : Math.round(completed.value / props.flow.steps.length * 100))
const steps = computed(() => props.flow.steps.map(step => {
  const state = taskFlowStatus(step.phase, props.live, props.uncertain)
  const unexecuted = step.phase === 'pending' && props.flow.phase !== 'pending' && !isTaskFlowActive(props.flow.phase)
  return { ...step, status: unexecuted ? { ...state, label: '未执行' } : state }
}))
</script>

<template>
  <section class="space-y-3" :aria-label="`任务计划：${flow.title}`">
    <header class="space-y-2">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-2xs text-desk-muted">任务计划</p>
          <h4 class="mt-0.5 break-words text-xs font-medium text-desk-ink">{{ flow.title }}</h4>
        </div>
        <span class="shrink-0 text-2xs" :class="tones[status.tone]">{{ flow.phase === 'pending' ? '待启动' : status.label }}</span>
      </div>
      <div class="flex items-center gap-3">
        <div
          class="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-desk-surface-subtle"
          role="progressbar"
          :aria-label="`${flow.title}：已执行步骤`"
          :aria-valuenow="completed"
          :aria-valuemin="0"
          :aria-valuemax="flow.steps.length"
          :aria-valuetext="`${completed} / ${flow.steps.length} 步执行结束`"
        >
          <div class="h-full rounded-full bg-desk-accent" :style="{ width: `${percent}%` }"></div>
        </div>
        <span class="shrink-0 text-2xs tabular-nums text-desk-muted">{{ completed }} / {{ flow.steps.length }} 步</span>
      </div>
      <p v-if="flow.phase === 'pending'" class="text-2xs leading-relaxed text-desk-muted">
        待启动：在聊天中无附件发送“开始”或“开始执行”。
      </p>
    </header>

    <ol class="plan-steps" aria-label="计划步骤">
      <li v-for="(step, index) in steps" :key="step.id" class="relative flex gap-2.5 pb-3 last:pb-0">
        <span
          class="step-node relative z-1 mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-desk-line bg-desk-surface text-2xs tabular-nums"
          :class="tones[step.status.tone]"
          aria-hidden="true"
        >{{ step.phase === 'completed' ? '✓' : index + 1 }}</span>
        <details class="min-w-0 flex-1" :open="step.phase === 'running' || step.phase === 'stopping' || step.phase === 'failed'">
          <summary class="group flex items-start justify-between gap-2 rounded-desk-sm text-xs" @click="emit('inspect')">
            <span class="min-w-0 break-words font-medium text-desk-ink">{{ step.title }}</span>
            <span class="flex shrink-0 items-center gap-1 text-2xs" :class="tones[step.status.tone]">
              {{ step.status.label }}
              <svg class="h-3 w-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="m6 3 5 5-5 5V3Z" />
              </svg>
            </span>
          </summary>
          <div class="mt-2 space-y-2 text-2xs leading-relaxed">
            <p class="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-desk-muted">{{ step.instruction }}</p>
            <div v-if="step.changedFiles && step.changedFiles.length > 0" class="space-y-1">
              <p class="font-medium text-desk-muted">成功修改 {{ step.changedFiles.length }} 个文件</p>
              <ul class="space-y-1">
                <li v-for="file in step.changedFiles" :key="file" class="break-all font-mono text-desk-ink">
                  {{ displayToolPath(file, projectRoot) }}
                </li>
              </ul>
            </div>
            <div v-if="step.result" class="space-y-1">
              <p class="font-medium text-desk-muted">步骤回复</p>
              <p class="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-desk-ink">{{ step.result }}</p>
            </div>
            <p v-if="step.error" class="whitespace-pre-wrap break-words text-desk-danger" role="status">{{ step.error }}</p>
            <AppButton
              v-if="step.resultEntryId || step.promptEntryId"
              variant="ghost"
              @click="emit('locate', step.resultEntryId ?? step.promptEntryId ?? '')"
            >定位会话记录</AppButton>
          </div>
        </details>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.plan-steps > li:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 18px;
  bottom: -2px;
  width: 1px;
  background: var(--color-desk-line);
}
</style>
