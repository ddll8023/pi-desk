<!-- 通用工具卡片：默认折叠且仅手动开合，内联展示状态字形、工具名称、执行状态、Desktop 计算的耗时与参数摘要；
     文件类工具（edit / write）的摘要改为相对项目目录的路径与改动量，改动量不是真实 Diff 统计时带一个可见的「推断」标记。
     展开后先给带行号的变更行或写入内容预览，再给参数键值摘要与结果预览，参数原文与完整结果各自二级折叠并可一键复制，
     结果被 Pi 截断时给出完整输出路径。状态字形只是第二通道：状态文案始终保留，读屏与色弱用户都不依赖形状或颜色。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  ToolArgSummaryEntry,
  HistoryChunk,
  ToolDiff,
  ToolDiffLine,
  ToolDiffLineKind,
  ToolExecutionPhase,
  ToolNonTextPart
} from '../../../../shared/runtime-api'
import type { ChatToolBlock } from '../chat-view'
import type { ResultPreview } from '../tool-summary'
import { historyChunkKey } from '../stores/runtime'
import type { HistoryChunkLoadState } from '../stores/runtime'
import HistoryLoadSentinel from './HistoryLoadSentinel.vue'
import { copyText } from '../../ui/clipboard'
import { formatDuration, useTickingNow } from '../clock'
import { useProjectStore } from '../../projects/stores/project'
import {
  FILE_TOOLS,
  RESULT_PREVIEW_CHARS,
  RESULT_PREVIEW_LINES,
  WRITE_PREVIEW_LINES,
  diffChangeCounts,
  displayToolPath,
  formatBytes,
  formatToolArgValue,
  clipResultPreview,
  measureResult,
  formatResultSize,
  summarizeResultText,
  isOversizedJsonText,
  toolCallPreview,
  toolFilePath,
  writeContentPreview
} from '../tool-summary'
import AppButton from '../../ui/AppButton.vue'

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

/** 状态字形是第二通道：与文案、颜色同时出现，任一通道缺失都还能读懂状态。 */
const PHASE_MARKS: Readonly<Record<ToolExecutionPhase, string>> = {
  running: '…',
  succeeded: '✓',
  failed: '!',
  unknown: '?'
}

const execution = computed(() => props.block.execution)
const isRunning = computed(() => execution.value?.phase === 'running')
/** 只有运行中的卡片需要刻度；已有结束时刻的条目显示固定耗时，未确认结束与缺少时刻的条目不显示耗时。 */
const now = useTickingNow(() => isRunning.value)

const phaseLabel = computed(() => (
  execution.value === null ? '执行记录未到达' : PHASE_LABELS[execution.value.phase]
))
const phaseMark = computed(() => (execution.value === null ? '' : PHASE_MARKS[execution.value.phase]))
const phaseClass = computed(() => {
  if (execution.value === null) return 'text-desk-muted'
  if (execution.value.phase === 'failed') return 'text-desk-danger'
  return execution.value.phase === 'running' ? 'text-desk-accent' : 'text-desk-muted'
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

/**
 * 文件类工具在摘要行显示路径而不是参数摘要：路径取自投影已算好的参数摘要，
 * 再按当前项目目录裁成相对路径；裁不动（项目目录外或跨盘）时原样显示绝对路径。
 */
const isFileTool = computed(() => FILE_TOOLS.has(props.block.toolName))
const projectRoot = computed(() => useProjectStore().currentProject?.path ?? null)
const filePath = computed(() => (isFileTool.value ? toolFilePath(argsSummary.value) : null))
const filePathText = computed(() => (filePath.value === null ? null : displayToolPath(filePath.value, projectRoot.value)))

/** 变更展示只来自投影已解析的 diff；来源与标题只描述事实，不推断未提供的语义。 */
const diff = computed<ToolDiff | null>(() => execution.value?.diff ?? null)

/** 一条展示用变更行：行号列、符号列与内容列分开，内容保留原始缩进。 */
interface DiffRow {
  readonly number: string
  readonly sign: string
  readonly kind: ToolDiffLineKind
  readonly text: string
}

/** 行号优先取变更后行号，删除行退回变更前行号；来源没有行号时留空，不编造。 */
function toDiffRow(line: ToolDiffLine): DiffRow {
  const number = line.newLine ?? line.oldLine
  const sign = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
  return { number: number === null ? '' : String(number), sign, kind: line.kind, text: line.text }
}

/** 展开后的变更区：优先真实 Diff；write 没有 Diff 时退回写入内容预览；两者都没有时只给一句说明。 */
interface FileBody {
  readonly rows: readonly DiffRow[]
  readonly note: string | null
}

/**
 * 文件类工具的全部变更事实：展开区、标题、摘要行改动量与推断标记都从这里取数。
 * 单一出口是为了不让后续代码绕开 `total` 用 `lines.length + remaining` 重新推导改动量。
 * 推断标记会随结果到达而切换：`write` 先有参数、后有 `details.diff`，所以「推断」标签与改动量数字
 * 在流式过程中会变一次；这是数据本身变化，不是状态抖动，不要给它加缓存或过渡动画。
 */
interface FileFacts {
  readonly body: FileBody | null
  /** 展开区标题：真实 Diff、按参数推断的 Diff、写入内容预览三种来源各用一句话，不混用「变更」。 */
  readonly title: string | null
  readonly counts: { readonly add: number; readonly remove: number } | null
  /** 改动量是否只来自推断：没有真实 Diff、按写入内容行数估算时为真。 */
  readonly inferred: boolean
}

const fileFacts = computed<FileFacts>(() => {
  const currentDiff = diff.value
  if (currentDiff !== null && currentDiff.lines.length > 0) {
    return {
      body: {
        rows: currentDiff.lines.map(toDiffRow),
        note: currentDiff.truncated ? '此变更超出展示上限，已截断。' : null
      },
      // Pi 结束结果里的 diff 是真实文件 Diff；参数推断的降级来源必须自己说明。
      title: currentDiff.source === 'args' ? '变更（根据工具参数推断，非实际文件 Diff）' : '变更',
      counts: diffChangeCounts(currentDiff),
      inferred: false
    }
  }
  // 非文件类工具没有变更区，也没有改动量；推断与真实 Diff 两条路都不成立。
  if (!isFileTool.value) return { body: null, title: null, counts: null, inferred: false }
  const preview = writeContentPreview(execution.value?.argsText ?? null, WRITE_PREVIEW_LINES)
  if (preview !== null) {
    const rows = preview.lines.map((text, index) => ({
      number: String(index + 1),
      sign: '+',
      kind: 'add' as const,
      text
    }))
    return {
      body: {
        rows,
        note: preview.remaining > 0 ? `… 还有 ${preview.remaining} 行（共 ${preview.total} 行）` : null
      },
      // 写入内容预览只说明文件将被写成什么，不包含旧内容，不能叫「变更」。
      title: '写入内容预览（根据工具参数推断，非实际文件 Diff）',
      counts: preview.total === 0 ? null : { add: preview.total, remove: 0 },
      inferred: true
    }
  }
  const waiting = execution.value?.phase === 'running'
  // 已经结束但没有 Diff 也没有可解析的写入内容：区分「没改动」与「取不到数据」，
  // 后者不能暗示文件没变，否则用户会误以为编辑未生效。
  const settledWithoutData = !waiting && execution.value?.argsTruncated === true
  const note = waiting
    ? '等待工具执行结果。'
    : settledWithoutData
      ? '未取到 Diff，无法统计改动行数（参数可能被截断）。'
      : '本次调用没有可展示的改动内容。'
  return { body: { rows: [], note }, title: null, counts: null, inferred: false }
})
/** 展开后的变更区；null 表示该工具没有变更展示。 */
const fileBody = computed(() => fileFacts.value.body)
/** 展开区标题；只在真有变更行时显示，没有内容时只留一句说明。 */
const fileTitle = computed(() => fileFacts.value.title)
/** 摘要行的改动量：真实 Diff 统计，或 write 的内容行数推断；都没有时不显示，不写 0。 */
const changeCounts = computed(() => fileFacts.value.counts)
/**
 * 改动量是否来自推断：推断值可能高于文件的实际变化（例如覆盖写一个已有文件），必须在界面上标出来。
 * 没有改动量可显示时不标。
 */
const changeCountsInferred = computed(() => fileFacts.value.inferred && fileFacts.value.counts !== null)
const changeCountsTitle = computed(() => (changeCountsInferred.value
  ? '根据写入内容行数推断的新增行，不是实际文件 Diff：覆盖写已有文件时实际变化可能更少'
  : '按工具结果中的 Diff 统计的新增与删除行'))

/**
 * 历史与运行中的工具均初始折叠；运行中首次转为失败时自动展开一次，之后不覆盖用户的手动选择。
 * 恢复的历史条目不会因为本身已是失败状态就全部展开：长会话里几十条失败会堆成一片错误输出，
 * 用户要的是能点开，而不是默认铺满。
 */
const expanded = ref(false)
watch(() => execution.value?.phase, (phase, previous) => {
  if (phase === 'failed' && previous !== undefined && previous !== 'failed') expanded.value = true
})

/** 折叠状态下模板读到的是这个空预览，不参与任何计算。 */
const EMPTY_RESULT_PREVIEW: ResultPreview = { preview: '', clipped: false, totalLines: 0, clipReason: 'none' }

/** 结果文本与它的预览；JSON 结果只给结构摘要，长文本只给前几行。 */
const resultText = computed(() => execution.value?.text ?? '')
/**
 * 结果规模：只在展开时才计算。折叠状态下标题不显示行数与字节数，
 * 也就不必对整段输出做一次全文扫描——长会话里大多数工具卡都是折叠的。
 */
const resultMeasure = computed(() => (expanded.value ? measureResult(resultText.value) : null))
/** 预览只在展开时裁剪；行数直接复用 `resultMeasure`，不再为同一段文本数两次换行。 */
const resultPreview = computed(() => (expanded.value
  ? clipResultPreview(resultText.value, RESULT_PREVIEW_LINES, RESULT_PREVIEW_CHARS, resultMeasure.value?.totalLines)
  : null))
/**
 * 模板用的预览：`<details>` 的正文即使折叠也会被 Vue 渲染，因此不能直接读可能为 null 的 `resultPreview`。
 * 折叠时返回空预览，展开后立刻换成真实裁剪结果。
 */
const resultPreviewView = computed<ResultPreview>(() => resultPreview.value ?? EMPTY_RESULT_PREVIEW)
const isFailure = computed(() => execution.value?.phase === 'failed')
/** 形状像 JSON 但超出解析上限：只在展开时判断，与 `resultJsonLabel` 同一道展开门控。 */
const resultJsonOversized = computed(() => (expanded.value && !isFailure.value && isOversizedJsonText(resultText.value)))
/**
 * JSON 结构摘要：只有展开时才解析（`summarizeResultText` 内部先做廉价形状检查）。
 * 字节数复用 `resultMeasure`，不为一个展示数字再编码一遍全文。
 * 拿不到摘要时返回 null，界面统一退回纯文本分支，不再单开一个「按纯文本展示」的提示分支。
 */
const resultJsonLabel = computed(() => (expanded.value && !isFailure.value
  ? summarizeResultText(resultText.value, resultMeasure.value?.totalBytes)
  : null))

/**
 * 结果标题带上行数与字节数；折叠时只说标题，展开后才给出规模。
 * 数据取自 `resultMeasure`，不依赖预览裁剪，后续预览做更贵的处理也不会连带拖慢标题。
 */
const resultLabel = computed(() => {
  const base = isFailure.value ? '错误输出' : execution.value?.textKind === 'partial' ? '部分输出' : '结果'
  const measure = resultMeasure.value
  if (measure === null || measure.totalLines === 0) return base
  return `${base} · ${formatResultSize(measure.totalLines, measure.totalBytes)}`
})

/**
 * 纯文本分支的说明：把「JSON 过大没能做结构摘要」与「预览被裁剪」合并成一句，
 * 不让同一屏出现两条竞争口径的提示；两者都不成立时返回 null。
 */
const resultPlainNote = computed(() => {
  const parts: string[] = []
  if (resultJsonOversized.value) parts.push('结果过大，按纯文本展示')
  const preview = resultPreviewView.value
  if (preview.clipped) {
    parts.push(preview.clipReason === 'chars'
      ? `共 ${preview.totalLines} 行，单行过长，已截断显示开头部分`
      : `共 ${preview.totalLines} 行，已显示前 ${RESULT_PREVIEW_LINES} 行`)
  }
  return parts.length === 0 ? null : `${parts.join('；')}。`
})

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
      <span class="disclosure" aria-hidden="true"></span>
      <span class="tool-status-mark" :class="phaseClass" aria-hidden="true">{{ phaseMark }}</span>
      <!-- 工具名是摘要行里最长的一项（MCP 工具名可达几十字符），限宽截断才能把宽度让给路径与参数摘要。 -->
      <span class="max-w-[40%] shrink-0 truncate font-mono text-desk-ink" :title="block.toolName">{{ block.toolName }}</span>
      <span class="tool-phase-label" :class="phaseClass">{{ phaseLabel }}</span>
      <span
        v-if="durationText"
        class="tool-duration font-mono text-desk-muted"
        title="客户端收到工具开始与结束事件的间隔"
      >{{ durationText }}</span>
      <!-- 文件类工具先给路径与改动量，其余工具给参数摘要；两者都不可得时这一格留空。 -->
      <span
        v-if="filePathText !== null"
        class="min-w-0 flex-1 truncate font-mono text-desk-muted"
        :title="filePath ?? filePathText"
      >{{ filePathText }}</span>
      <span v-if="changeCounts !== null" class="tool-change-count" :title="changeCountsTitle">
        <span class="tool-change-add">+{{ changeCounts.add }}</span>
        <span class="tool-change-remove">−{{ changeCounts.remove }}</span>
        <!-- 推断值不能只靠悬停提示表达：可见的「推断」二字是主通道，title 只是补充口径。 -->
        <span v-if="changeCountsInferred" class="tool-change-inferred">推断</span>
      </span>
      <span v-else-if="filePathText === null && argsPreview" class="min-w-0 flex-1 truncate text-desk-muted">{{ argsPreview }}</span>
    </summary>
    <div class="tool-card-body">
      <!-- 变更先于参数：真实 Diff 带行号，write 没有 Diff 时给内容预览；两者都不可得时只给一句说明。 -->
      <template v-if="fileBody !== null">
        <template v-if="fileBody.rows.length > 0">
          <p v-if="fileTitle !== null" class="tool-note">{{ fileTitle }}</p>
          <div class="tool-diff scroll-area">
            <div
              v-for="(row, index) in fileBody.rows"
              :key="index"
              class="tool-diff-line"
              :data-kind="row.kind"
            >
              <span class="tool-diff-number">{{ row.number }}</span>
              <span class="tool-diff-sign">{{ row.sign }}</span>
              <span class="tool-diff-text">{{ row.text }}</span>
            </div>
          </div>
        </template>
        <p v-if="fileBody.note !== null" class="tool-note">{{ fileBody.note }}</p>
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
          <p class="tool-note">{{ resultLabel }}</p>
          <AppButton variant="compact" @click="copyTarget('text', execution.text)">{{ copyLabel('text') }}</AppButton>
        </div>
        <!-- JSON 结果只给结构摘要，避免把单行 JSON 原文铺进界面；展开后才看原文。
             分支条件只看「展开后确实拿到了摘要」：拿不到摘要（过大或解析失败）就统一退回纯文本分支，
             说明由 `resultPlainNote` 与预览一起给出，不另开一个「按纯文本展示」的提示分支。 -->
        <template v-if="expanded && resultJsonLabel !== null && !textExpanded">
          <p class="tool-note">{{ resultJsonLabel }}</p>
          <AppButton variant="compact" @click="textExpanded = true">显示原文</AppButton>
        </template>
        <template v-else>
          <p class="tool-output" :class="isFailure ? 'text-desk-danger' : ''">
            {{ showFullResult ? execution.text : resultPreviewView.preview }}
          </p>
          <div v-if="!showFullResult && resultPlainNote !== null" class="tool-fold-row">
            <p class="tool-note">{{ resultPlainNote }}</p>
            <AppButton v-if="resultPreviewView.clipped" variant="compact" @click="textExpanded = true">显示全部</AppButton>
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

  <!-- 没有对应工具条目时的占位：只显示消息块已有的名称与状态，不猜测参数或结果。
       同样带 `tool-card` 类，才能在执行记录面板里与相邻卡片共用分隔线与内边距。 -->
  <div v-else class="tool-card">
    <div class="tool-card-body border-t-0">
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
  </div>
</template>
