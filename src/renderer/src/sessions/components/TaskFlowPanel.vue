<!-- 右侧任务页只展示宿主状态、步骤、结果及变更产物，并提供记录定位与节点状态反馈；执行控制统一由聊天承接。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TaskFlow, TaskFlowPhase } from '../../../../shared/task-flow'
import { isTaskFlowActive } from '../../../../shared/task-flow'
import { useProjectStore } from '../../projects/stores/project'
import { displayToolPath } from '../tool-summary'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly flows: readonly TaskFlow[]
  readonly ownerKey: string
  readonly live: boolean
  readonly notice: string | null
}>()
const emit = defineEmits<{
  locate: [entryId: string, ownerKey: string]
  expand: []
}>()
const selected = ref<string | null>(null)
let latestId: string | null = null
const projectStore = useProjectStore()
const projectRoot = computed(() => projectStore.currentProject?.path ?? null)
function formatPath(filePath: string): string {
  return displayToolPath(filePath, projectRoot.value)
}
watch(() => props.flows, flows => {
  const latest = flows.at(-1)?.id ?? null
  if (latest !== latestId || !flows.some(flow => flow.id === selected.value)) selected.value = latest
  latestId = latest
}, { immediate: true })
function label(phase: TaskFlowPhase): string {
  if (isTaskFlowActive(phase) && !props.live) return '未确认结束'
  if (isTaskFlowActive(phase) && props.notice !== null) return '状态待确认'
  return { pending: '待执行', running: '执行中', stopping: '停止中', completed: '执行完成',
    failed: '执行失败', cancelled: '已停止', interrupted: '已中断' }[phase]
}
function glyph(phase: TaskFlowPhase): string {
  if (isTaskFlowActive(phase) && (!props.live || props.notice !== null)) return '?'
  return { pending: '○', running: '●', stopping: '◐', completed: '✓', failed: '!', cancelled: '–', interrupted: '?' }[phase]
}
</script>

<template>
  <section v-if="flows.length" class="task-flow-panel" aria-label="任务执行流程">
    <header class="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-desk-line bg-desk-surface px-3 py-2">
      <span class="text-md font-semibold">任务记录</span>
      <select v-if="flows.length > 1" v-model="selected" class="min-w-0 max-w-full rounded-desk-sm border border-desk-line bg-desk-surface px-2 py-1 text-xs" aria-label="选择任务记录" @change="emit('expand')">
        <option v-for="flow in flows" :key="flow.id" :value="flow.id">{{ flow.title }}</option>
      </select>
    </header>
    <template v-for="flow in flows" :key="flow.id">
      <div v-if="flow.id === selected" class="p-3">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <h3 class="min-w-0 flex-1 break-words text-md font-semibold">{{ flow.title }}</h3>
          <span class="text-xs text-desk-muted" role="status">{{ label(flow.phase) }}<template v-if="flow.steps.some(step => isTaskFlowActive(step.phase))"> · {{ flow.steps.find(step => isTaskFlowActive(step.phase))?.title }}</template></span>
        </div>
        <p v-if="notice" class="mb-3 text-xs text-desk-warning" role="status">{{ notice }}</p>
        <p v-if="flow.phase === 'pending'" class="mb-3 text-xs text-desk-muted">在无附件聊天中发送“开始／开始执行”；需要停止时，使用聊天输入坞的停止键。本计划不新增操作授权。</p>
        <ol class="task-flow-track">
          <li v-for="step in flow.steps" :key="step.id" class="task-flow-node" :data-phase="step.phase">
            <span class="task-flow-glyph" aria-hidden="true">{{ glyph(step.phase) }}</span>
            <details class="min-w-0 flex-1" @toggle="emit('expand')">
              <summary class="flex cursor-pointer list-none items-start justify-between gap-3 rounded-desk-sm py-1 text-xs">
                <span class="min-w-0 break-words font-medium">{{ step.title }}</span>
                <span class="shrink-0 text-2xs text-desk-muted">{{ step.phase === 'pending' && flow.phase !== 'pending' && !isTaskFlowActive(flow.phase) ? '未执行' : label(step.phase) }}</span>
              </summary>
              <div class="mt-1 space-y-2 rounded-desk-sm bg-desk-surface-subtle p-2 text-xs">
                <p class="whitespace-pre-wrap break-words text-desk-muted">{{ step.instruction }}</p>
                <div v-if="step.changedFiles && step.changedFiles.length > 0" class="space-y-1 rounded-desk-xs border border-desk-line bg-desk-surface p-2">
                  <div class="flex items-center justify-between text-2xs font-medium text-desk-muted">
                    <span>变更产物</span>
                    <span>{{ step.changedFiles.length }} 个文件</span>
                  </div>
                  <div class="flex flex-wrap gap-1">
                    <span
                      v-for="file in step.changedFiles"
                      :key="file"
                      class="inline-block max-w-full truncate rounded-desk-xs border border-desk-line bg-desk-surface-subtle px-1.5 py-0.5 font-mono text-2xs text-desk-ink"
                      :title="file"
                    >
                      {{ formatPath(file) }}
                    </span>
                  </div>
                </div>
                <p v-if="step.result" class="whitespace-pre-wrap break-words">{{ step.result }}</p>
                <p v-if="step.error" class="whitespace-pre-wrap break-words text-desk-danger">{{ step.error }}</p>
                <AppButton v-if="step.resultEntryId || step.promptEntryId" variant="ghost" @click="emit('locate', step.resultEntryId ?? step.promptEntryId ?? '', props.ownerKey)">定位会话记录</AppButton>
              </div>
            </details>
          </li>
        </ol>
        <p v-if="flow.phase === 'completed'" class="mt-3 text-2xs text-desk-muted">步骤执行已结束；不代表产出已经过检查或目标必然达成。</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.task-flow-panel { min-height: 0; background: var(--color-desk-surface); }
.task-flow-track { position: relative; margin: 0; padding: 0; list-style: none; }
.task-flow-track::before { content: ''; position: absolute; top: 10px; bottom: 10px; left: 8px; width: 1px; background: var(--color-desk-line-strong); }
.task-flow-node { position: relative; display: flex; gap: 10px; padding-block: 4px; }
.task-flow-glyph { z-index: 1; display: grid; place-items: center; flex: none; width: 17px; height: 23px; background: var(--color-desk-surface); color: var(--color-desk-muted); font-size: 12px; }
.task-flow-node[data-phase='running'] .task-flow-glyph {
  color: var(--color-desk-accent);
  animation: pulse-glyph 1.8s ease-in-out infinite;
}
.task-flow-node[data-phase='running'] summary {
  border-left: 2px solid var(--color-desk-accent);
  padding-left: 6px;
  background-color: var(--color-desk-surface-subtle);
}
.task-flow-node[data-phase='completed'] .task-flow-glyph { color: var(--color-desk-success); }
.task-flow-node[data-phase='failed'] .task-flow-glyph { color: var(--color-desk-danger); }
summary {
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
summary:hover {
  background-color: var(--color-desk-surface-subtle);
}
summary::-webkit-details-marker { display: none; }
@keyframes pulse-glyph {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.2); opacity: 0.65; }
}
@media (prefers-reduced-motion: reduce) {
  .task-flow-node[data-phase='running'] .task-flow-glyph {
    animation: none;
  }
}
</style>
