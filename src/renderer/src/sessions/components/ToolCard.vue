<!-- 工具卡：折叠时以单行三段式呈现分类徽章、真实工具名、语境化参数与状态耗时胶囊；
     展开先看有界结果卡片、文件Diff与请求说明，原始参数与结果在底部抽屉按需展开；摘要缺失时退回文本，不猜计数。
     推断Diff和截断片段明确标记；开合只上报userExpand，滚动与历史续读继续由原有链路负责。 -->
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
  clipResultPreview,
  measureResult,
  formatResultSize,
  isOversizedJsonText,
  toolCallPreview,
  getToolOperation,
  toolContextPreview,
  toolResultHeadline,
  toolFilePath,
  writeContentPreview
} from '../tool-summary'
import AppButton from '../../ui/AppButton.vue'
import ToolResultPreview from './ToolResultPreview.vue'

const props = defineProps<{
  readonly block: ChatToolBlock
  readonly historyChunks?: readonly HistoryChunk[] | undefined
  readonly chunkStates?: Readonly<Record<string, HistoryChunkLoadState>> | undefined
  readonly historyEnabled?: boolean | undefined
  readonly historyBusy?: boolean | undefined
  readonly historyMore?: string | null | undefined
  readonly historyError?: string | null | undefined
}>()
const emit = defineEmits<{
  loadChunk: [chunk: HistoryChunk]
  loadMore: []
  /** 卡片被手动展开；消息列表据此停止粘底，本组件不处理滚动位置。 */
  userExpand: []
}>()
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

/** 操作分类与抽屉统计共用；真实工具名作为第一身份突出显示，与语境化参数紧邻并列。 */
const operation = computed(() => getToolOperation(props.block.toolName))
const presentation = computed(() => execution.value?.presentation ?? null)
const resultPresentation = computed(() => presentation.value?.result ?? null)
const requestFacts = computed(() => presentation.value?.request?.facts ?? [])
const contextPreview = computed(() => toolContextPreview(presentation.value))
const subjectPreview = computed(() => presentation.value?.request?.subject ?? argsPreview.value)
const outcomePreview = computed(() => resultPresentation.value === null
  ? isRunning.value ? '等待执行结果' : '结果摘要未提供'
  : toolResultHeadline(resultPresentation.value))

/**
 * 文件类工具在摘要行显示路径而不是参数摘要：路径取自投影已算好的参数摘要，
 * 再按当前项目目录裁成相对路径；裁不动（项目目录外或跨盘）时原样显示绝对路径。
 */
const isFileTool = computed(() => FILE_TOOLS.has(props.block.toolName))
const projectRoot = computed(() => useProjectStore().currentProject?.path ?? null)
const filePath = computed(() => (isFileTool.value ? toolFilePath(argsSummary.value) : null))
const filePathText = computed(() => (filePath.value === null ? null : displayToolPath(filePath.value, projectRoot.value)))

/**
 * 格式化后的目标参数：按工具类型提供清晰的语境，避免与工具名称混淆。
 * - 文件类工具优先使用相对路径；
 * - 检索/搜索类工具自动为关键词添加双引号；
 * - 其他工具（命令、ID、URL、偏好领域等）原样显示关键参数；
 * - 无参数工具返回 null。
 */
const targetParamText = computed<string | null>(() => {
  if (filePathText.value !== null) return filePathText.value
  const subject = subjectPreview.value
  if (subject === null || subject.trim() === '') return null
  const trimmed = subject.trim()
  if (operation.value.kind.endsWith('-search')) {
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
      return trimmed
    }
    return `"${trimmed}"`
  }
  return trimmed
})

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
  /** 改动量来自参数Diff或写入内容行数时为真，不冒充执行后的文件Diff。 */
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
      inferred: currentDiff.source === 'args'
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
/** 摘要行计数来自可见结果 Diff 或工具参数推断；来源与片段标记独立显示，不当作完整文件改动量。 */
const changeCounts = computed(() => fileFacts.value.counts)
/**
 * 改动量是否来自推断：推断值可能高于文件的实际变化（例如覆盖写一个已有文件），必须在界面上标出来。
 * 没有改动量可显示时不标。
 */
const changeCountsInferred = computed(() => fileFacts.value.inferred && fileFacts.value.counts !== null)
const changeCountsPartial = computed(() => diff.value?.truncated === true)
const changeCountsTitle = computed(() => (changeCountsInferred.value
  ? '根据工具参数推断的增删行，不是执行后的实际文件 Diff'
  : changeCountsPartial.value ? '仅统计工具返回的可见 Diff 片段，不是完整改动量' : '按工具结果中的 Diff 统计新增与删除行'))

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

/** 原文只用于按需展开与摘要缺失降级，默认的结果语义来自宿主投影。 */
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
/** 摘要缺失时的降级提示；只在展开时检查原文形状，不尝试补造结构化结果。 */
const resultJsonOversized = computed(() => (expanded.value && !isFailure.value && isOversizedJsonText(resultText.value)))
/**
 * 结果标题带上行数与字节数；折叠时只说标题，展开后才给出规模。
 * 数据取自 `resultMeasure`，不依赖预览裁剪，后续预览做更贵的处理也不会连带拖慢标题。
 */
const resultLabel = computed(() => {
  const base = isFailure.value ? '错误原文' : execution.value?.textKind === 'partial' ? '当前输出原文' : '原始结果'
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

/** 原始参数与结果按需展开；语义摘要缺失时，结果保留受限的已加载文本预览。 */
const argsExpanded = ref(false)
const textExpanded = ref(false)
/** 失败或手动展开时显示当前已加载原文，尚未读取的历史内容仍需按续段载入。 */
const showFullResult = computed(() => textExpanded.value || isFailure.value)

/** 二级内容展开时上报用户意图，由消息列表处理跟随与滚动，本组件不调整位置。 */
function expandArgs(): void {
  argsExpanded.value = !argsExpanded.value
  if (argsExpanded.value) emit('userExpand')
}

function expandText(): void {
  textExpanded.value = !textExpanded.value
  if (textExpanded.value) emit('userExpand')
}

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

/**
 * 点击与键盘激活共用同一开合状态，避免原生 details 与 Vue 状态不一致。
 * 只在展开时上报：摘要行留在原处、内容从它下面长出来；收起时位置由浏览器钳到新上限，与粘底结果一致。
 * 失败首次出现时的自动展开由 watch 完成，不算用户动作，不上报。
 */
function toggleExpanded(): void {
  const next = !expanded.value
  expanded.value = next
  if (next) emit('userExpand')
}

function describeNonTextPart(part: ToolNonTextPart): string {
  const size = part.bytes === null ? '大小未知' : formatBytes(part.bytes)
  return part.mimeType === null ? `${part.type} ${size}` : `${part.mimeType} ${size}`
}

/** 复制当前已加载原文，不暗示包含尚未读取的续段；反馈保留在原位置。 */
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
  <details v-if="execution" :open="expanded" class="tool-card" :class="{ 'is-running': isRunning }">
    <summary @click.prevent="toggleExpanded">
      <span class="disclosure" aria-hidden="true"></span>
      <div class="tool-summary-row">
        <span class="tool-badge" :class="`tool-badge-${operation.tone}`">{{ operation.label }}</span>
        <span class="tool-name font-mono" :title="block.toolName">{{ block.toolName }}</span>
        <span v-if="targetParamText !== null" class="tool-target-param font-mono" :title="filePath ?? targetParamText">{{ targetParamText }}</span>
        <span v-if="changeCounts !== null" class="tool-change-count" :title="changeCountsTitle">
          <span class="tool-change-add">+{{ changeCounts.add }}</span>
          <span class="tool-change-remove">−{{ changeCounts.remove }}</span>
          <span v-if="changeCountsInferred" class="tool-change-inferred">推断</span>
          <span v-if="changeCountsPartial" class="tool-change-inferred">片段</span>
        </span>
        <span v-if="resultPresentation?.outcome === 'error'" class="tool-summary-outcome text-desk-danger font-medium" :title="outcomePreview">
          <span class="tool-outcome-text">{{ outcomePreview }}</span>
        </span>
      </div>
      <span class="tool-status-pill" :class="phaseClass">
        <svg v-if="isRunning" class="tool-spinner inline-block size-3 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
          <path class="opacity-85" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        <span v-else class="tool-status-icon font-mono" aria-hidden="true">{{ phaseMark }}</span>
        <span class="tool-status-text">{{ phaseLabel }}</span>
        <span v-if="durationText" class="tool-duration font-mono">{{ durationText }}</span>
      </span>
    </summary>
    <div class="tool-card-body">
      <p v-if="contextPreview" class="tool-card-context-note">{{ contextPreview }}</p>
      <ToolResultPreview v-if="resultPresentation" :result="resultPresentation" />
      <p v-else-if="execution.text === '' && outputChunks.length === 0" class="tool-note">{{ isRunning ? '等待工具报告结果。' : '没有可用的结果摘要。' }}</p>
      <template v-if="fileBody !== null">
        <template v-if="fileBody.rows.length > 0">
          <p v-if="fileTitle !== null" class="tool-note">{{ fileTitle }}</p>
          <div class="tool-diff scroll-area">
            <div v-for="(row, index) in fileBody.rows" :key="index" class="tool-diff-line" :data-kind="row.kind">
              <span class="tool-diff-number">{{ row.number }}</span>
              <span class="tool-diff-sign">{{ row.sign }}</span>
              <span class="tool-diff-text">{{ row.text }}</span>
            </div>
          </div>
        </template>
        <p v-if="fileBody.note !== null" class="tool-note">{{ fileBody.note }}</p>
      </template>
      <dl v-if="requestFacts.length > 0" class="tool-args-summary tool-request-facts" aria-label="请求范围与条件">
        <template v-for="entry in requestFacts" :key="entry.label">
          <dt class="tool-arg-key">{{ entry.label }}</dt>
          <dd class="tool-arg-value">{{ entry.value }}</dd>
        </template>
      </dl>
      <p v-if="presentation?.request?.truncated" class="tool-note">请求摘要有所省略，可展开原始参数查看当前已加载内容。</p>
      <div class="tool-raw-sections">
        <section v-if="execution.argsText !== null || argsChunks.length > 0" class="tool-raw-section">
          <div class="tool-fold-row">
            <AppButton variant="ghost" :aria-expanded="argsExpanded" @click="expandArgs">{{ argsExpanded ? '收起原始参数' : '原始参数' }}</AppButton>
            <AppButton v-if="execution.argsText !== null" variant="compact" title="复制当前已加载参数" @click="copyTarget('args', execution.argsText)">{{ copyLabel('args') }}</AppButton>
          </div>
          <template v-if="argsExpanded">
            <p v-if="execution.argsText !== null" class="tool-output">{{ execution.argsText }}</p>
            <HistoryLoadSentinel v-for="chunk in argsChunks" :key="historyChunkKey(chunk)"
              :cursor="`${historyChunkKey(chunk)}:${chunk.offset}`" :enabled="historyEnabled === true && expanded && argsExpanded"
              :loading="historyBusy === true" :error="chunkStates?.[historyChunkKey(chunk)]?.error" @load="emit('loadChunk', chunk)" />
            <p v-if="execution.argsTruncated && argsChunks.length === 0" class="tool-note">参数原文超出展示上限，当前内容不完整。</p>
          </template>
        </section>
        <section v-if="execution.text !== '' || outputChunks.length > 0" class="tool-raw-section">
          <div class="tool-fold-row">
            <span v-if="isFailure" class="tool-note">{{ resultLabel }}</span>
            <AppButton v-else variant="ghost" :aria-expanded="textExpanded" @click="expandText">{{ textExpanded ? '收起' : '展开' }}{{ resultLabel }}</AppButton>
            <AppButton variant="compact" title="复制当前已加载结果" @click="copyTarget('text', execution.text)">{{ copyLabel('text') }}</AppButton>
          </div>
          <template v-if="showFullResult || resultPresentation === null">
            <p class="tool-output" :class="isFailure ? 'text-desk-danger' : ''">{{ showFullResult ? execution.text : resultPreviewView.preview }}</p>
            <p v-if="!showFullResult && resultPlainNote !== null" class="tool-note">{{ resultPlainNote }}</p>
          </template>
          <HistoryLoadSentinel v-for="chunk in outputChunks" :key="historyChunkKey(chunk)"
            :cursor="`${historyChunkKey(chunk)}:${chunk.offset}`" :enabled="historyEnabled === true && expanded && showFullResult"
            :loading="historyBusy === true" :error="chunkStates?.[historyChunkKey(chunk)]?.error" @load="emit('loadChunk', chunk)" />
          <p v-if="execution.textTruncated && outputChunks.length === 0" class="tool-note">输出原文超出展示上限，当前内容不完整。</p>
          <p v-if="execution.outputPath !== null" class="tool-note">完整输出：{{ execution.outputPath }}</p>
        </section>
      </div>
      <p v-if="nonTextNotice" class="tool-note">{{ nonTextNotice }}</p>
    </div>
  </details>
  <div v-else class="tool-card">
    <div class="tool-card-body tool-missing-record">
      <div class="tool-summary-row">
        <span class="tool-badge" :class="`tool-badge-${operation.tone}`">{{ operation.label }}</span>
        <span class="tool-name font-mono" :title="block.toolName">{{ block.toolName }}</span>
      </div>
      <span class="tool-status-pill" :class="phaseClass">{{ historyEnabled ? (historyError ? '历史不可用' : historyMore ? '加载历史…' : '未记录结果') : phaseLabel }}</span>
    </div>
  </div>
</template>
