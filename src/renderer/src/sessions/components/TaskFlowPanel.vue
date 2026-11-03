<!-- 任务流程与会话执行动态看板：提供当前焦点实时反馈、极简步骤轨道与产物定位，执行控制由聊天承接。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TaskFlow, TaskFlowPhase } from '../../../../shared/task-flow'
import { isTaskFlowActive } from '../../../../shared/task-flow'
import { useProjectStore } from '../../projects/stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { displayToolPath, toolFilePath, toolCallPreview } from '../tool-summary'
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

const runtimeStore = useRuntimeStore()
const projectStore = useProjectStore()
const projectRoot = computed(() => projectStore.currentProject?.path ?? null)

const selected = ref<string | null>(null)
let latestId: string | null = null

function formatPath(filePath: string): string {
  if (typeof filePath !== 'string') return ''
  return displayToolPath(filePath, projectRoot.value)
}

watch(() => props.flows, flows => {
  const latest = flows.at(-1)?.id ?? null
  if (latest !== latestId || !flows.some(flow => flow.id === selected.value)) selected.value = latest
  latestId = latest
}, { immediate: true })

const currentFlow = computed<TaskFlow | null>(() => {
  if (props.flows.length === 0) return null
  return props.flows.find(f => f.id === selected.value) ?? props.flows.at(-1) ?? null
})

function label(phase: TaskFlowPhase): string {
  if (isTaskFlowActive(phase) && !props.live) return '未确认结束'
  if (isTaskFlowActive(phase) && props.notice !== null) return '状态待确认'
  return {
    pending: '待执行', running: '执行中', stopping: '停止中', completed: '执行完成',
    failed: '执行失败', cancelled: '已停止', interrupted: '已中断'
  }[phase]
}

/** 提取当前轮次的目标：简单任务提取最新用户意图，多步任务提取整体目标。 */
const latestUserGoal = computed<string>(() => {
  const msgs = runtimeStore.displayMessages
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg?.role === 'user') {
      for (const b of msg.blocks) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const line = b.text.trim().split('\n')[0]?.trim() ?? ''
          return line.length > 90 ? line.slice(0, 87) + '...' : line
        }
      }
    }
  }
  return '当前对话任务'
})

/** 提取当前活跃的工具调用与实时流式状态。 */
const activeTool = computed(() => {
  return runtimeStore.displayTools.find(t => t.phase === 'running') ?? null
})
const isStreaming = computed(() => {
  return runtimeStore.view.phase === 'ready' && runtimeStore.view.snapshot.info?.isStreaming === true
})

/** 实时动态文字描述：哪怕是单轮简单任务，用户也能一眼看清当前这一秒在干什么。 */
const liveActionText = computed<string>(() => {
  if (activeTool.value) {
    const name = activeTool.value.toolName
    const tool = activeTool.value
    const filePath = toolFilePath(tool.argsSummary)
    if (name === 'read') return `正在读取文件: ${filePath ? formatPath(filePath) : '文件'}`
    if (name === 'edit' || name === 'write') return `正在修改代码: ${filePath ? formatPath(filePath) : '文件'}`
    if (name === 'bash') {
      const command = toolCallPreview(name, tool.argsSummary, tool.argsText)
      return `正在执行命令: ${command || '终端脚本'}`
    }
    if (name === 'task_plan') return '正在规划并同步任务流程...'
    const preview = toolCallPreview(name, tool.argsSummary, tool.argsText)
    return preview ? `正在调用工具: ${name} (${preview})` : `正在调用工具: ${name}`
  }
  if (isStreaming.value) return '正在分析上下文与生成回答...'
  if (currentFlow.value && isTaskFlowActive(currentFlow.value.phase)) {
    const runningStep = currentFlow.value.steps.find(s => isTaskFlowActive(s.phase))
    return runningStep ? `正在执行步骤: ${runningStep.title}` : '任务执行推进中...'
  }
  if (props.live) return '当前就绪 · 等待下一指令'
  return '当前会话连接已断开'
})

/** 提取当前任务或最近活动关联的文件微胶囊（最多 5 个）。 */
const touchedFiles = computed<readonly string[]>(() => {
  const list: string[] = []
  const seen = new Set<string>()

  // 1. 若有多步流当前步产生的 changedFiles，优先收集
  if (currentFlow.value) {
    for (const step of currentFlow.value.steps) {
      for (const file of step.changedFiles ?? []) {
        if (typeof file === 'string' && file.trim() && !seen.has(file)) {
          seen.add(file)
          list.push(file)
        }
      }
    }
  }
  // 2. 从最近工具调用中提取读写的文件
  if (list.length < 5) {
    for (let i = runtimeStore.displayTools.length - 1; i >= 0 && list.length < 5; i--) {
      const tool = runtimeStore.displayTools[i]
      if (tool && ['read', 'edit', 'write'].includes(tool.toolName)) {
        const filePath = toolFilePath(tool.argsSummary)
        if (filePath && !seen.has(filePath)) {
          seen.add(filePath)
          list.push(filePath)
        }
      }
    }
  }
  // 3. 从活动摘要中兜底提取最近触及的文件
  if (list.length < 5 && runtimeStore.activity?.files) {
    for (const f of runtimeStore.activity.files) {
      if (typeof f?.path === 'string' && f.path.trim() && !seen.has(f.path)) {
        seen.add(f.path)
        list.push(f.path)
      }
      if (list.length >= 5) break
    }
  }
  return list.slice(0, 5)
})

/** 多步任务进度统计。 */
const flowProgress = computed(() => {
  if (!currentFlow.value) return null
  const total = currentFlow.value.steps.length
  if (total === 0) return null
  const completed = currentFlow.value.steps.filter(s => s.phase === 'completed').length
  const percent = Math.round((completed / total) * 100)
  return { completed, total, percent }
})

const activeStep = computed(() => {
  if (!currentFlow.value) return null
  return currentFlow.value.steps.find(s => isTaskFlowActive(s.phase)) ?? null
})

/** 步骤连接线是否应当点亮高亮。 */
function isLineLit(stepIndex: number, steps: readonly { readonly phase: TaskFlowPhase }[]): boolean {
  const current = steps[stepIndex]?.phase
  const next = steps[stepIndex + 1]?.phase
  return current === 'completed' && (next === 'completed' || isTaskFlowActive(next ?? 'pending'))
}
</script>

<template>
  <section class="task-flow-panel flex flex-col min-h-0 bg-desk-surface" aria-label="任务执行看板">
    <!-- 顶部状态栏：任务记录切换与实时连接感知 -->
    <header class="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-b border-desk-line bg-desk-surface/90 backdrop-blur-sm px-3 py-2.5">
      <div class="flex items-center gap-2 min-w-0">
        <span class="relative flex h-2 w-2">
          <span v-if="live && (activeTool || isStreaming || (currentFlow && isTaskFlowActive(currentFlow.phase)))" class="animate-ping absolute inline-flex h-full w-full rounded-full bg-desk-accent opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2 w-2" :class="live ? 'bg-desk-accent' : 'bg-desk-muted'"></span>
        </span>
        <span class="text-xs font-semibold text-desk-ink truncate">
          {{ currentFlow ? currentFlow.title : '当前会话动态' }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="currentFlow" class="text-2xs font-medium px-1.5 py-0.5 rounded-desk-xs border border-desk-line bg-desk-surface-subtle text-desk-muted">
          {{ label(currentFlow.phase) }}
        </span>
        <select
          v-if="flows.length > 1"
          v-model="selected"
          class="rounded-desk-sm border border-desk-line bg-desk-surface px-2 py-0.5 text-2xs text-desk-ink focus:outline-none focus:border-desk-accent"
          aria-label="选择历史任务计划"
          @change="emit('expand')"
        >
          <option v-for="flow in flows" :key="flow.id" :value="flow.id">{{ flow.title }}</option>
        </select>
      </div>
    </header>

    <div class="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
      <!-- 异常或核对提示 -->
      <div v-if="notice" class="rounded-desk-sm border border-desk-warning/40 bg-desk-warning-soft/50 p-2 text-xs text-desk-warning" role="status">
        {{ notice }}
      </div>

      <!-- 【置顶当前焦点卡片（Current Focus）】：无论简单任务还是多步任务，永远居顶直观呈现当前正在干什么 -->
      <section
        class="focus-card rounded-desk-md border border-desk-line bg-desk-surface-subtle p-3 space-y-2.5 transition-all"
        :class="{ 'is-active-running': activeTool || isStreaming || activeStep }"
        aria-label="当前执行焦点"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-2xs font-semibold uppercase tracking-wider text-desk-muted">
            {{ currentFlow ? '当前步骤焦点' : '当前对话任务' }}
          </span>
          <span
            v-if="activeTool || isStreaming || activeStep"
            class="inline-flex items-center gap-1.5 text-2xs font-medium text-desk-accent"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-desk-accent animate-pulse"></span>
            运行中
          </span>
          <span v-else class="text-2xs text-desk-muted">就绪</span>
        </div>

        <!-- 目标与步骤简述 -->
        <h4 class="text-xs font-medium text-desk-ink break-words leading-relaxed">
          {{ activeStep ? activeStep.title : latestUserGoal }}
        </h4>

        <!-- 实时执行动作反馈（Lancer Light UI 流动状态行） -->
        <div class="flow-action-strip flex items-center gap-2 rounded-desk-sm border border-desk-line/70 bg-desk-surface px-2.5 py-1.5 text-2xs text-desk-ink">
          <div class="shrink-0 flex items-center justify-center">
            <template v-if="activeTool || isStreaming || activeStep">
              <span class="relative flex h-2 w-2">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-desk-accent opacity-75"></span>
                <span class="relative inline-flex rounded-full h-2 w-2 bg-desk-accent"></span>
              </span>
            </template>
            <template v-else>
              <span class="inline-flex h-2 w-2 rounded-full bg-desk-success"></span>
            </template>
          </div>
          <span class="min-w-0 truncate font-mono text-desk-ink">{{ liveActionText }}</span>
        </div>

        <!-- 当前关联/读写的文件微胶囊 -->
        <div v-if="touchedFiles.length > 0" class="space-y-1 pt-1 border-t border-desk-line/60">
          <div class="text-2xs text-desk-muted font-medium">涉及文件产物</div>
          <div class="flex flex-wrap gap-1">
            <span
              v-for="file in touchedFiles"
              :key="file"
              class="file-badge inline-flex items-center gap-1 max-w-full truncate rounded-desk-xs border border-desk-line bg-desk-surface px-1.5 py-0.5 font-mono text-2xs text-desk-ink"
              :title="file"
            >
              <svg class="w-3 h-3 text-desk-muted shrink-0" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 1.75C4 .784 4.784 0 5.75 0h5.586a1.75 1.75 0 0 1 1.237.513l2.914 2.914c.328.328.513.774.513 1.237v9.586A1.75 1.75 0 0 1 14.25 16h-8.5A1.75 1.75 0 0 1 4 14.25V1.75zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V4.75h-2.75A1.75 1.75 0 0 1 10 3V1.5H5.75z"/>
              </svg>
              <span class="truncate">{{ formatPath(file) }}</span>
            </span>
          </div>
        </div>
      </section>

      <!-- 【简单任务说明】：当没有多步计划时呈现轻量说明，不显示空态死区 -->
      <div v-if="!currentFlow" class="rounded-desk-sm border border-desk-line/60 bg-desk-surface p-3 text-2xs text-desk-muted space-y-1">
        <p class="font-medium text-desk-ink">当前为实时单轮对话</p>
        <p>日常问答与单步代码修改自动在此同步状态；遇复杂长任务时，Agent 可通过 task_plan 登记多步计划并生成下方追踪轨道。</p>
      </div>

      <!-- 【多步计划详情区】：仅当存在结构化 TaskFlow 时呈现 -->
      <template v-else>
        <!-- 进度条（参考 EvoFlow 紧凑进度指示） -->
        <div v-if="flowProgress" class="space-y-1.5 px-0.5">
          <div class="flex items-center justify-between text-2xs text-desk-muted">
            <span>执行进度</span>
            <span class="font-mono font-medium text-desk-ink">{{ flowProgress.completed }} / {{ flowProgress.total }} 步 ({{ flowProgress.percent }}%)</span>
          </div>
          <div class="h-1.5 w-full rounded-full bg-desk-surface-subtle overflow-hidden border border-desk-line/70">
            <div
              class="h-full bg-desk-accent transition-all duration-300 ease-out"
              :style="{ width: `${flowProgress.percent}%` }"
            ></div>
          </div>
        </div>

        <!-- 启动与控制提示 -->
        <p v-if="currentFlow.phase === 'pending'" class="text-2xs text-desk-muted bg-desk-surface-subtle/80 rounded-desk-sm p-2 border border-desk-line/70 leading-relaxed">
          待启动：在无附件聊天中发送“开始／开始执行”；需要停止时，使用聊天输入坞的停止键。本计划不新增操作授权。
        </p>

        <!-- 步骤执行紧凑轨道（EvoFlow 阶梯 + Lancer 流动动效） -->
        <ol class="task-flow-track space-y-2" aria-label="执行步骤列表">
          <li
            v-for="(step, index) in currentFlow.steps"
            :key="step.id"
            class="step-item relative flex items-start gap-2.5 rounded-desk-sm p-2 transition-all"
            :class="{
              'is-running': isTaskFlowActive(step.phase),
              'is-completed': step.phase === 'completed',
              'is-failed': step.phase === 'failed',
              'is-pending': step.phase === 'pending'
            }"
            :data-phase="step.phase"
          >
            <!-- 左侧状态节点（精致 SVG 徽章） -->
            <div class="step-node-glyph shrink-0 mt-0.5 flex items-center justify-center w-5 h-5 rounded-full border bg-desk-surface z-1">
              <!-- running: 脉冲核 -->
              <template v-if="isTaskFlowActive(step.phase)">
                <span class="relative flex h-3 w-3">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-desk-accent opacity-75"></span>
                  <span class="relative inline-flex rounded-full h-3 w-3 bg-desk-accent"></span>
                </span>
              </template>
              <!-- completed: 绿勾 -->
              <template v-else-if="step.phase === 'completed'">
                <svg class="w-3.5 h-3.5 text-desk-success" viewBox="0 0 16 16" fill="currentColor">
                  <path fill-rule="evenodd" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/>
                </svg>
              </template>
              <!-- failed: 红色警告 -->
              <template v-else-if="step.phase === 'failed'">
                <svg class="w-3.5 h-3.5 text-desk-danger" viewBox="0 0 16 16" fill="currentColor">
                  <path fill-rule="evenodd" d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14zM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>
                </svg>
              </template>
              <!-- pending: 序号环 -->
              <template v-else>
                <span class="text-2xs font-mono font-medium text-desk-muted">{{ index + 1 }}</span>
              </template>
            </div>

            <!-- 右侧步骤内容：紧凑卡片并支持折叠展开 -->
            <details
              class="min-w-0 flex-1 group"
              :open="isTaskFlowActive(step.phase) || (step.phase === 'completed' && index === currentFlow.steps.length - 1)"
              @toggle="emit('expand')"
            >
              <summary class="flex cursor-pointer list-none items-center justify-between gap-2 py-0.5 text-xs select-none">
                <span class="font-medium text-desk-ink break-words min-w-0">
                  {{ step.title }}
                </span>
                <div class="shrink-0 flex items-center gap-1.5">
                  <span class="text-2xs text-desk-muted font-mono">
                    {{ step.phase === 'pending' && currentFlow.phase !== 'pending' && !isTaskFlowActive(currentFlow.phase) ? '未执行' : label(step.phase) }}
                  </span>
                  <svg class="w-3 h-3 text-desk-muted transition-transform duration-200 group-open:rotate-90" viewBox="0 0 16 16" fill="currentColor">
                    <path fill-rule="evenodd" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z"/>
                  </svg>
                </div>
              </summary>

              <!-- 折叠展开的明细内容 -->
              <div class="mt-2 space-y-2 rounded-desk-xs bg-desk-surface-subtle p-2 text-xs border border-desk-line/60">
                <p class="whitespace-pre-wrap break-words text-2xs text-desk-muted leading-relaxed">
                  {{ step.instruction }}
                </p>

                <!-- 变更产物胶囊 -->
                <div v-if="step.changedFiles && step.changedFiles.length > 0" class="space-y-1.5 rounded-desk-xs border border-desk-line bg-desk-surface p-2">
                  <div class="flex items-center justify-between text-2xs font-medium text-desk-muted">
                    <span>步骤变更产物</span>
                    <span class="font-mono">{{ step.changedFiles.length }} 个文件</span>
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

                <p v-if="step.result" class="whitespace-pre-wrap break-words text-2xs font-mono text-desk-ink bg-desk-surface p-1.5 rounded-desk-xs border border-desk-line/70">
                  {{ step.result }}
                </p>
                <p v-if="step.error" class="whitespace-pre-wrap break-words text-2xs text-desk-danger bg-desk-danger-soft p-1.5 rounded-desk-xs border border-desk-danger/40">
                  {{ step.error }}
                </p>

                <div v-if="step.resultEntryId || step.promptEntryId" class="pt-1">
                  <AppButton
                    variant="ghost"
                    @click="emit('locate', step.resultEntryId ?? step.promptEntryId ?? '', props.ownerKey)"
                  >
                    定位会话记录
                  </AppButton>
                </div>
              </div>
            </details>
          </li>
        </ol>

        <p v-if="currentFlow.phase === 'completed'" class="text-2xs text-desk-muted text-center pt-2">
          步骤执行已结束；不代表产出已经过检查或目标必然达成。
        </p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.task-flow-panel {
  min-height: 0;
}

/* 焦点卡片流动边框动效（Lancer Light UI 流动光线） */
.focus-card {
  position: relative;
  background: var(--color-desk-surface-subtle);
  border: 1px solid var(--color-desk-line);
}

.focus-card.is-active-running {
  border-color: var(--color-desk-accent);
  background: color-mix(in srgb, var(--color-desk-accent) 4%, var(--color-desk-surface));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-desk-accent) 25%, transparent),
              0 2px 8px color-mix(in srgb, var(--color-desk-accent) 10%, transparent);
}

.flow-action-strip {
  position: relative;
  overflow: hidden;
}

.is-active-running .flow-action-strip::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -100%;
  width: 50%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--color-desk-accent) 20%, transparent) 50%,
    transparent 100%
  );
  animation: light-beam 2.4s ease-in-out infinite;
}

/* 步骤项目与连接线 */
.step-item {
  position: relative;
  border: 1px solid var(--color-desk-line);
  background: var(--color-desk-surface);
}

.step-item:not(:last-child)::before {
  content: '';
  position: absolute;
  top: 24px;
  bottom: -10px;
  left: 17px;
  width: 1px;
  background: var(--color-desk-line);
  z-index: 0;
}

.step-item.is-completed:not(:last-child)::before {
  background: color-mix(in srgb, var(--color-desk-success) 50%, var(--color-desk-line));
}

.step-item.is-running {
  border-color: var(--color-desk-accent);
  background: color-mix(in srgb, var(--color-desk-accent) 5%, var(--color-desk-surface));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-desk-accent) 30%, transparent);
}

.step-item.is-running .step-node-glyph {
  border-color: var(--color-desk-accent);
  box-shadow: 0 0 6px color-mix(in srgb, var(--color-desk-accent) 40%, transparent);
}

.step-item.is-completed .step-node-glyph {
  border-color: var(--color-desk-success);
  background: var(--color-desk-success-soft);
}

.step-item.is-failed .step-node-glyph {
  border-color: var(--color-desk-danger);
  background: var(--color-desk-danger-soft);
}

.step-item.is-pending {
  opacity: 0.85;
}

summary::-webkit-details-marker {
  display: none;
}

@keyframes light-beam {
  0% { transform: translateX(0); }
  100% { transform: translateX(350%); }
}

@media (prefers-reduced-motion: reduce) {
  .is-active-running .flow-action-strip::after {
    animation: none;
    display: none;
  }
  .animate-ping, .animate-pulse {
    animation: none !important;
  }
}
</style>
