<!-- 通用工具卡片：在消息流内联展示工具名称、执行状态、Desktop 计算的耗时与参数摘要，展开后显示参数、结果或错误输出与非文本内容描述。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ToolExecutionPhase, ToolNonTextPart } from '../../../shared/runtime-api'
import type { ChatToolBlock } from '../chat-view'
import { useTickingNow } from '../clock'

const props = defineProps<{
  readonly block: ChatToolBlock
}>()

/** 参数首行预览的长度上限；只用于摘要，不代替展开后的完整参数。 */
const ARGS_PREVIEW_CHARS = 120

/** 工具状态只做文案映射，不推断工具是否真的成功结束。 */
const PHASE_LABELS: Readonly<Record<ToolExecutionPhase, string>> = {
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  unknown: '未确认结束'
}

const execution = computed(() => props.block.execution)
const isRunning = computed(() => execution.value?.phase === 'running')
/** 只有运行中的卡片需要刻度；已有结束时刻的条目显示固定耗时，未确认结束与缺少时刻的条目不显示耗时。 */
const now = useTickingNow(() => isRunning.value)

const phaseLabel = computed(() => (
  execution.value === null ? '执行记录未到达' : PHASE_LABELS[execution.value.phase]
))
const phaseClass = computed(() => {
  if (execution.value === null) return 'text-desk-muted'
  if (execution.value.phase === 'failed') return 'text-desk-danger'
  return execution.value.phase === 'running' ? 'text-desk-accent' : 'text-desk-muted'
})
const textLabel = computed(() => {
  if (execution.value?.textKind === 'partial') return '部分输出'
  return execution.value?.phase === 'failed' ? '错误输出' : '结果'
})

/** 耗时需要有开始时刻；缺少结束时刻时只对运行中的条目按当前时刻估算，其余情况不显示时长。 */
const durationText = computed(() => {
  const current = execution.value
  if (current === null || current.startedAt === null) return null
  const endedAt = current.endedAt ?? (current.phase === 'running' ? now.value : null)
  if (endedAt === null) return null
  return formatDuration(Math.max(0, endedAt - current.startedAt))
})

/** 折叠时只看参数首行，保持一行可扫读；完整参数在展开后显示。 */
const argsPreview = computed(() => {
  const argsText = execution.value?.argsText
  if (argsText === null || argsText === undefined) return null
  const firstLine = (argsText.split('\n', 1)[0] ?? '').trim()
  if (firstLine === '') return null
  return firstLine.length > ARGS_PREVIEW_CHARS
    ? `${firstLine.slice(0, ARGS_PREVIEW_CHARS)}…`
    : firstLine
})

const nonTextNotice = computed(() => {
  const current = execution.value
  if (current === null || current.nonTextBlocks === 0) return null
  const described = current.nonTextParts.map(describeNonTextPart)
  if (described.length === 0) return `含 ${current.nonTextBlocks} 个非文本内容块，暂不渲染内容。`
  return `含 ${current.nonTextBlocks} 个非文本内容块：${described.join('、')}。`
})

/** 运行中的卡片自动展开一次；此后交给用户，不强制收起也不再自动打开。 */
const expanded = ref(false)
watch(isRunning, (running) => {
  if (running) expanded.value = true
}, { immediate: true })

function describeNonTextPart(part: ToolNonTextPart): string {
  const size = part.bytes === null ? '大小未知' : formatBytes(part.bytes)
  return part.mimeType === null ? `${part.type} ${size}` : `${part.mimeType} ${size}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 只表达量级：该时长是 Desktop 收到事件的间隔，不是工具的真实执行时间。 */
function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} 秒`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.round((milliseconds % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}
</script>

<template>
  <details v-if="execution" :open="expanded" class="tool-card">
    <summary class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
      <span class="font-mono">{{ block.toolName }}</span>
      <span :class="phaseClass">{{ phaseLabel }}</span>
      <span v-if="durationText" class="text-desk-muted">{{ durationText }}</span>
      <span v-if="argsPreview" class="min-w-0 flex-1 truncate text-desk-muted">{{ argsPreview }}</span>
    </summary>
    <div class="mt-2 space-y-2">
      <template v-if="execution.argsText !== null">
        <p class="tool-note">参数</p>
        <p class="tool-output">{{ execution.argsText }}</p>
        <p v-if="execution.argsTruncated" class="tool-note">此参数超出展示上限，已截断。</p>
      </template>
      <template v-if="execution.text !== ''">
        <p class="tool-note">{{ textLabel }}</p>
        <p class="tool-output" :class="execution.phase === 'failed' ? 'text-desk-danger' : ''">
          {{ execution.text }}
        </p>
        <p v-if="execution.textTruncated" class="tool-note">此输出超出展示上限，已截断。</p>
      </template>
      <p v-else class="tool-note">无文本输出。</p>
      <p v-if="nonTextNotice" class="tool-note">{{ nonTextNotice }}</p>
    </div>
  </details>

  <!-- 没有对应工具条目时的占位：只显示消息块已有的名称与状态，不猜测参数或结果。 -->
  <p v-else class="flex flex-wrap items-baseline gap-2 text-xs">
    <span class="font-mono">{{ block.toolName }}</span>
    <span :class="phaseClass">{{ phaseLabel }}</span>
  </p>
</template>
