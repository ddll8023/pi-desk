<!-- 通用工具卡片：默认折叠且仅手动开合，内联展示工具名称、执行状态、Desktop 计算的耗时与参数摘要；展开后先给参数键值摘要、变更 Diff 与结果预览，参数原文与完整结果各自二级折叠并可一键复制，结果被 Pi 截断时给出完整输出路径。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  ToolArgSummaryEntry,
  HistoryChunk,
  ToolDiff,
  ToolDiffLine,
  ToolExecutionPhase,
  ToolNonTextPart
} from '../../../shared/runtime-api'
import type { ChatToolBlock } from '../chat-view'
import { historyChunkKey } from '../stores/runtime'
import type { HistoryChunkLoadState } from '../stores/runtime'
import HistoryLoadSentinel from './HistoryLoadSentinel.vue'
import { copyText } from '../clipboard'
import { formatDuration, useTickingNow } from '../clock'
import {
  RESULT_PREVIEW_CHARS,
  RESULT_PREVIEW_LINES,
  formatBytes,
  formatToolArgValue,
  previewTextLines,
  summarizeResultText,
  toolCallPreview
} from '../tool-summary'
import AppButton from './ui/AppButton.vue'

const props = defineProps<{
  readonly block: ChatToolBlock
  readonly historyChunks?: readonly HistoryChunk[] | undefined
  readonly chunkStates?: Readonly<Record<string, HistoryChunkLoadState>> | undefined
  readonly historyEnabled?: boolean | undefined
  readonly historyBusy?: boolean | undefined
  readonly historyMore?: string | null | undefined
  readonly historyError?: string | null | undefined
}>()
const emit = defineEmits<{ loadChunk: [chunk: HistoryChunk]; loadMore: [] }>()
const argsChunks = computed(() => (props.historyChunks ?? []).filter(chunk => chunk.field === 'arguments'))
const outputChunks = computed(() => (props.historyChunks ?? []).filter(chunk => chunk.field === 'output'))

/** 可复制的原文区块；参数与结果各自独立反馈。 */
type CopyTarget = 'args' | 'text'

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

/** 折叠时只看关键参数（路径、命令、pattern 等），保持一行可扫读；完整参数在展开后显示。 */
const argsSummary = computed<readonly ToolArgSummaryEntry[] | null>(() => execution.value?.argsSummary ?? null)
const argsPreview = computed(() => toolCallPreview(props.block.toolName, argsSummary.value, execution.value?.argsText ?? null))

/** 结果文本与它的预览；JSON 结果只给结构摘要，长文本只给前几行。 */
const resultText = computed(() => execution.value?.text ?? '')
const resultPreview = computed(() => previewTextLines(resultText.value, RESULT_PREVIEW_LINES, RESULT_PREVIEW_CHARS))
const isFailure = computed(() => execution.value?.phase === 'failed')
const resultJsonLabel = computed(() => (isFailure.value ? null : summarizeResultText(resultText.value)))

/** 参数与结果的二级折叠：默认只看摘要，展开后才渲染原文。 */
const argsExpanded = ref(false)
const textExpanded = ref(false)
/** 失败输出与手动展开都显示全文，其余情况只显示预览。 */
const showFullResult = computed(() => textExpanded.value || isFailure.value)

/** 复制反馈与资源页一致：用最近一次复制目标标记，成功后保留可见结果。 */
const copiedTarget = ref<CopyTarget | null>(null)
const failedTarget = ref<CopyTarget | null>(null)

const nonTextNotice = computed(() => {
  const current = execution.value
  if (current === null || current.nonTextBlocks === 0) return null
  const described = current.nonTextParts.map(describeNonTextPart)
  if (described.length === 0) return `含 ${current.nonTextBlocks} 个非文本内容块，暂不渲染内容。`
  return `含 ${current.nonTextBlocks} 个非文本内容块：${described.join('、')}。`
})

/** 变更展示只来自投影已解析的 diff；来源与标题只描述事实，不推断未提供的语义。 */
const diff = computed<ToolDiff | null>(() => execution.value?.diff ?? null)
const diffTitle = computed(() => (
  diff.value?.source === 'args' ? '变更（根据工具参数推断，非实际文件 Diff）' : '变更'
))

function diffLineClass(line: ToolDiffLine): string {
  switch (line.kind) {
    case 'add': return 'tool-diff-add'
    case 'remove': return 'tool-diff-remove'
    case 'fold': return 'tool-diff-fold'
    default: return 'tool-diff-context'
  }
}

/** 历史与运行中的工具均初始折叠；后续状态更新不覆盖手动选择。 */
const expanded = ref(false)

/** 点击与键盘激活共用同一开合状态，避免原生 details 与 Vue 状态不一致。 */
function toggleExpanded(): void {
  expanded.value = !expanded.value
}

function describeNonTextPart(part: ToolNonTextPart): string {
  const size = part.bytes === null ? '大小未知' : formatBytes(part.bytes)
  return part.mimeType === null ? `${part.type} ${size}` : `${part.mimeType} ${size}`
}

/** 复制完整原文；成功与失败都就地反馈，不改动其他状态。 */
async function copyTarget(target: CopyTarget, text: string): Promise<void> {
  const copied = await copyText(text)
  copiedTarget.value = copied ? target : null
  failedTarget.value = copied ? null : target
}

function copyLabel(target: CopyTarget): string {
  if (copiedTarget.value === target) return '已复制'
  return failedTarget.value === target ? '复制失败' : '复制'
}
</script>

<template>
  <details v-if="execution" :open="expanded" class="tool-card">
    <summary @click.prevent="toggleExpanded">
      <span class="disclosure"></span>
      <span class="font-mono text-desk-ink">{{ block.toolName }}</span>
      <span :class="phaseClass">{{ phaseLabel }}</span>
      <span
        v-if="durationText"
        class="font-mono text-desk-muted"
        title="客户端收到工具开始与结束事件的间隔"
      >{{ durationText }}</span>
      <span v-if="argsPreview" class="min-w-0 flex-1 truncate text-desk-muted">{{ argsPreview }}</span>
    </summary>
    <div class="tool-card-body">
      <template v-if="diff !== null && diff.lines.length > 0">
        <p class="tool-note">{{ diffTitle }}</p>
        <div class="tool-output">
          <p v-for="(line, index) in diff.lines" :key="index" :class="diffLineClass(line)">{{ line.text }}</p>
        </div>
        <p v-if="diff.truncated" class="tool-note">此变更超出展示上限，已截断。</p>
      </template>
      <template v-if="execution.argsText !== null">
        <div class="tool-fold-row">
          <p class="tool-note">参数</p>
          <AppButton variant="compact" @click="copyTarget('args', execution.argsText)">{{ copyLabel('args') }}</AppButton>
        </div>
        <!-- 默认只看键值摘要，源码不进界面；摘要不可得（参数不是对象）时退回原文。 -->
        <template v-if="argsSummary !== null && !argsExpanded">
          <dl class="tool-args-summary">
            <template v-for="entry in argsSummary" :key="entry.key">
              <dt class="tool-arg-key">{{ entry.key }}</dt>
              <dd class="tool-arg-value">{{ formatToolArgValue(entry.value) }}</dd>
            </template>
          </dl>
          <AppButton variant="compact" @click="argsExpanded = true">显示原始参数</AppButton>
        </template>
        <p v-else class="tool-output">{{ execution.argsText }}</p>
        <HistoryLoadSentinel
          v-for="chunk in argsChunks"
          :key="historyChunkKey(chunk)"
          :cursor="`${historyChunkKey(chunk)}:${chunk.offset}`"
          :enabled="historyEnabled === true && expanded && (argsExpanded || argsSummary === null)"
          :loading="historyBusy === true"
          :error="chunkStates?.[historyChunkKey(chunk)]?.error"
          @load="emit('loadChunk', chunk)"
        />
        <p v-if="execution.argsTruncated && argsChunks.length === 0" class="tool-note">此参数超出展示上限，已截断。</p>
      </template>
      <template v-if="execution.text !== '' || outputChunks.length > 0">
        <div class="tool-fold-row">
          <p class="tool-note">{{ textLabel }}</p>
          <AppButton variant="compact" @click="copyTarget('text', execution.text)">{{ copyLabel('text') }}</AppButton>
        </div>
        <!-- JSON 结果只给结构摘要，避免把单行 JSON 原文铺进界面；展开后才看原文。 -->
        <template v-if="resultJsonLabel !== null && !textExpanded">
          <p class="tool-note">{{ resultJsonLabel }}</p>
          <AppButton variant="compact" @click="textExpanded = true">显示原文</AppButton>
        </template>
        <template v-else>
          <p class="tool-output" :class="isFailure ? 'text-desk-danger' : ''">
            {{ showFullResult ? execution.text : resultPreview.preview }}
          </p>
          <div v-if="!showFullResult && resultPreview.clipped" class="tool-fold-row">
            <p class="tool-note">共 {{ resultPreview.totalLines }} 行，已显示前 {{ RESULT_PREVIEW_LINES }} 行</p>
            <AppButton variant="compact" @click="textExpanded = true">显示全部</AppButton>
          </div>
        </template>
        <HistoryLoadSentinel
          v-for="chunk in outputChunks"
          :key="historyChunkKey(chunk)"
          :cursor="`${historyChunkKey(chunk)}:${chunk.offset}`"
          :enabled="historyEnabled === true && expanded && (showFullResult || execution.text === '')"
          :loading="historyBusy === true"
          :error="chunkStates?.[historyChunkKey(chunk)]?.error"
          @load="emit('loadChunk', chunk)"
        />
        <p v-if="execution.textTruncated && outputChunks.length === 0" class="tool-note">此输出超出展示上限，已截断。</p>
        <p v-if="execution.outputPath !== null" class="tool-note">完整输出：{{ execution.outputPath }}</p>
      </template>
      <p v-else class="tool-note">无文本输出。</p>
      <p v-if="nonTextNotice" class="tool-note">{{ nonTextNotice }}</p>
    </div>
  </details>

  <!-- 没有对应工具条目时的占位：只显示消息块已有的名称与状态，不猜测参数或结果。 -->
  <div v-else>
    <p class="flex flex-wrap items-baseline gap-2 px-1 text-xs">
      <span class="font-mono">{{ block.toolName }}</span>
      <span :class="phaseClass">{{ historyEnabled ? (historyError ? '历史内容暂不可用' : historyMore ? '正在加载历史记录…' : '未记录执行结果') : phaseLabel }}</span>
    </p>
    <HistoryLoadSentinel
      v-if="historyMore"
      :cursor="`tool:${block.toolCallId}:${historyMore}`"
      :enabled="historyEnabled === true"
      :loading="historyBusy === true"
      :error="historyError"
      quiet-error
      @load="emit('loadMore')"
    />
  </div>
</template>
