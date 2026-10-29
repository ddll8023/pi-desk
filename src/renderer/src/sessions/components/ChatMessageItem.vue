<!-- 单条消息：按块展示正文、思考、工具卡、技能卡、压缩卡与计时（单条生成耗时与本轮响应耗时）与本次调用的 token 花销。
     过程块逐项展示：每段 Thinking 各自折叠成一行轻量摘要（生成中展开并跟随最新思考，结束后收起），正文按原位置展示、始终可见。
     工具调用按块相邻关系归组：连续出现且都不是生成式界面的工具调用合成一个「执行记录」面板，面板内每条仍是一张独立折叠的 ToolCard；
     单条工具不套面板，Thinking、正文与生成式界面都是分组分界，不会被归进工具面板。
     交付了生成式界面的工具调用改渲染界面本身，不再套折叠卡；界面按可见性挂载：远离视口的界面只留一行占位，展开全部轮次时不把每份界面都常驻。
     界面内的参数提交复用消息动作栏的禁用口径（运行中、未同步、正在发送等），不另做一套判断。用户消息下方使用细线图标操作栏，回退与修改后的重新发送由父级执行。
     早期轮次的整体收起由 ChatTurnItem 负责，这里只表达单条消息内部每项自己的开合；同一轮内的非首条 AI 消息用紧凑表头，不重复 π 标记与角色名。
     被取代的旧版界面折叠成一行：整行点击跳转到新版（由消息列表定位），右侧小按钮展开查看旧版。
     卡片的手动展开只上报 `userExpand`：消息列表据此停止粘底，展开的内容从摘要行下面长出来而不是把摘要行顶走；收起不上报。 -->
<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, useId, watch } from 'vue'
import { copyText } from '../../ui/clipboard'
import { userMessagePayload } from '../chat-view'
import type { ChatBlock, ChatMessageView, ChatToolBlock } from '../chat-view'
import type { HistoryChunk } from '../../../../shared/runtime-api'
import { historyChunkKey } from '../stores/runtime'
import type { HistoryChunkLoadState } from '../stores/runtime'
import HistoryLoadSentinel from './HistoryLoadSentinel.vue'
import { formatDuration, useTickingNow } from '../clock'
import { cacheHitRate, formatTokens } from '../usage-format'
import { toolGroupStats } from '../tool-summary'
import MarkdownContent from '../../ui/MarkdownContent.vue'
import ToolCard from './ToolCard.vue'
import GenuiMountGate from '../../genui/components/GenuiMountGate.vue'
import UiDocument from '../../genui/components/UiDocument.vue'
import AppButton from '../../ui/AppButton.vue'
import ImageAnnotationCanvas from './ImageAnnotationCanvas.vue'

const props = defineProps<{
  readonly message: ChatMessageView
  readonly actionsDisabled?: boolean
  /** 动作栏不可用的原因；禁用时替换默认 tooltip，用户据此知道在等什么。
   *  显式带上 `undefined`：开启 exactOptionalPropertyTypes 时，可选属性不自动接受 undefined 值。 */
  readonly disabledReason?: string | null | undefined
  /** 同一轮内的非首条 AI 消息：只留时间与用量，不重复 π 标记与角色名。 */
  readonly compactHeader?: boolean
  readonly historyChunks?: readonly HistoryChunk[] | undefined
  readonly chunkStates?: Readonly<Record<string, HistoryChunkLoadState>> | undefined
  readonly historyEnabled?: boolean | undefined
  readonly historyBusy?: boolean | undefined
  readonly historyMore?: string | null | undefined
  readonly historyError?: string | null | undefined
}>()

const emit = defineEmits<{
  rewind: [messageId: string]
  submitEdit: [messageId: string, editedText: string]
  loadChunk: [chunk: HistoryChunk]
  loadMore: []
  /** 旧版折叠行跳转到同一界面的最新版；定位由消息列表负责。 */
  jumpLatest: [documentId: string]
  /** 某张卡片被手动展开；滚动位置与跟随由消息列表处理，本组件不持有滚动逻辑。 */
  userExpand: []
}>()

/** 续载定位到原始块；工具结果按调用身份而不是助手消息的位置匹配。 */
function chunksFor(block: ChatBlock): readonly HistoryChunk[] {
  return (props.historyChunks ?? []).filter(chunk => block.kind === 'toolcall'
    ? block.toolCallId !== null && chunk.toolCallId === block.toolCallId
    : chunk.entryId === props.message.entryId && chunk.contentIndex === block.contentIndex && chunk.field === block.kind)
}
const summaryChunks = computed(() => (props.historyChunks ?? []).filter(chunk => chunk.field === 'summary'
  && chunk.entryId === props.message.entryId))
const copyFeedback = ref('')
const copying = ref(false)
const copySucceeded = computed(() => copyFeedback.value.startsWith('已复制'))
const tooltipId = useId()
let copyFeedbackTimer: number | null = null
let mounted = true

const editing = ref(false)
const editDraft = ref('')
const editTextarea = ref<HTMLTextAreaElement | null>(null)
const selectedImageAnnotations = reactive(new Map<string, number>())

/** 切换会话后清理反馈计时器，迟到的剪贴板结果不再写入旧消息组件。 */
onUnmounted(() => {
  mounted = false
  if (copyFeedbackTimer !== null) window.clearTimeout(copyFeedbackTimer)
  if (thinkingInputHandle !== null) cancelAnimationFrame(thinkingInputHandle)
})

/** 复制与修改预填共用同一份还原：技能消息还原成 Pi 命令形态，投影生成的附件说明不计入。 */
const messageText = computed(() => userMessagePayload(props.message).text)
const hasText = computed(() => messageText.value.trim() !== '')

/** 禁用原因只在动作栏确实不可用时展示，不影响启用态的默认说明。 */
const unavailableReason = computed(() => (props.actionsDisabled === true ? props.disabledReason ?? null : null))
const rewindTooltip = computed(() => unavailableReason.value ?? '回到这条消息之前')
const editTooltip = computed(() => unavailableReason.value ?? '修改消息')

/**
 * 操作栏的显示条件：有可复制的用户文本，或有图片附件、技能调用、附件说明这类仍需保留回退入口的内容。
 * 纯图片消息与超限附件消息的文本都不算用户输入，不能因此失去回退。
 */
const hasUserContent = computed(() => hasText.value || props.message.blocks.some(block => (
  block.kind === 'text' && (block.image !== null || block.skill !== null || block.notice)
)))

/** 成功短暂切换为勾选图标；失败保留可见反馈，截断消息仍明确说明复制范围。 */
async function copyMessage(): Promise<void> {
  if (copying.value) return
  if (copyFeedbackTimer !== null) window.clearTimeout(copyFeedbackTimer)
  copyFeedbackTimer = null
  copying.value = true
  copyFeedback.value = ''
  let copied = false
  try {
    copied = await copyText(messageText.value)
  } catch {
    // 剪贴板回退路径也可能受环境限制，不能留下永久的复制中状态。
  }
  if (!mounted) return
  // 截断提示只针对被复制的用户文本；技能正文的截断只影响卡片展示，不影响复制出来的命令。
  const truncated = props.message.blocks.some(block => (
    block.kind === 'text' && block.truncated && block.skill === null
  ))
  copyFeedback.value = copied ? (truncated ? '已复制可见文本（已截断）' : '已复制') : '复制失败'
  copying.value = false
  if (copied) {
    copyFeedbackTimer = window.setTimeout(() => {
      copyFeedback.value = ''
      copyFeedbackTimer = null
    }, 1800)
  }
}

/** 每段思考的开合只保留在当前消息组件中；没有手动选择时按「是否正在生成」决定。 */
const thinkingOverrides = reactive(new Map<string, boolean>())

/** 技能卡初始折叠，流式更新不改变手动选择。 */
const skillOverrides = reactive(new Map<string, boolean>())

/** 被取代版本的只读展开状态；键为块 key，默认收起。跳到新版不影响它。 */
const readonlyOpen = reactive(new Set<string>())

/** 切换某个历史界面的展开状态；只影响查看，不改版本与参数。展开时上报，让摘要行留在原处。 */
function toggleReadonly(key: string): void {
  if (readonlyOpen.has(key)) {
    readonlyOpen.delete(key)
    return
  }
  readonlyOpen.add(key)
  emit('userExpand')
}

const isUser = computed(() => props.message.role === 'user')

/**
 * 一条展示行：单个块，或一组相邻的工具调用。
 * 归组只发生在连续且都没有生成式界面的工具调用之间；Thinking、正文与生成式界面都是分界，
 * 因此收起或展开一个工具不会连带收起任何其它内容。
 */
type DisplayRow =
  | { readonly kind: 'block'; readonly block: ChatBlock }
  | { readonly kind: 'tools'; readonly key: string; readonly blocks: readonly ChatToolBlock[] }

/**
 * 归组键：优先用组内各调用的 `toolCallId`，而不是首个块的 `key`。
 * 块的 key 含 contentIndex，投影增量使 contentIndex 变化时 key 会变，整组连同组内卡片的展开状态一起重建；
 * toolCallId 在工具生命周期内稳定，因此用它作为组身份。缺少 id 时退回块 key。
 */
function groupKey(blocks: readonly ChatToolBlock[]): string {
  const ids = blocks.map(block => block.toolCallId ?? block.key)
  return `tools:${ids.join(',')}`
}

/** 面板头部统计：执行记录未到达的调用记为 null，不当成成功或失败。 */
const displayRows = computed<readonly DisplayRow[]>(() => {
  const rows: DisplayRow[] = []
  let group: ChatToolBlock[] = []
  const flush = (): void => {
    const first = group[0]
    // 单条工具不套面板：面板只在真有多条相邻调用时才有归组价值。
    if (first !== undefined && group.length === 1) rows.push({ kind: 'block', block: first })
    else if (first !== undefined) rows.push({ kind: 'tools', key: groupKey(group), blocks: group })
    group = []
  }
  for (const block of props.message.blocks) {
    if (block.kind === 'toolcall' && block.ui === null) {
      group.push(block)
      continue
    }
    flush()
    rows.push({ kind: 'block', block })
  }
  flush()
  return rows
})

/** 面板头部的一行统计：「N 个工具 · a 已完成 / b 失败」；状态只按已有执行记录统计。 */
function groupStats(blocks: readonly ChatToolBlock[]): string {
  return toolGroupStats(blocks.map(block => block.execution?.phase ?? null))
}

/** 只标记渲染入口，不改变界面版本、会话身份或消息的块顺序。 */
const hasGenui = computed(() => props.message.blocks.some(block => block.kind === 'toolcall' && block.ui !== null))
/** 压缩记录不是对话消息：不展示生成计时、用户操作栏与复制入口。 */
const isCompaction = computed(() => props.message.role === 'compaction')
const compaction = computed(() => props.message.compaction)
const roleLabel = computed(() => (
  isUser.value ? '你' : isCompaction.value ? '上下文压缩' : 'Assistant'
))
const generation = computed(() => props.message.generation)
/** 本轮响应计时；历史轮次与 AI 消息为 null。 */
const turn = computed(() => props.message.turn)
/** 生成中的 AI 消息与响应中的本轮订阅共享刻度，结束后都用主进程给出的固定时刻。 */
const now = useTickingNow(() => generation.value?.phase === 'running' || turn.value?.endedAt === null)

const generationText = computed(() => {
  const current = generation.value
  if (current === null) return '耗时未记录'
  const duration = formatDuration((current.endedAt ?? now.value) - current.startedAt)
  if (current.phase === 'running') return `生成中 ${duration}`
  return current.phase === 'interrupted' ? `已中断 · ${duration}` : `生成耗时 ${duration}`
})

/**
 * 本轮响应耗时：从提交到本轮收敛，含工具执行与等待；`turn` 为 null（历史轮次）时整段不渲染。
 * 与单条 AI 消息的生成耗时含义不同，两者都保留。
 */
const turnText = computed(() => {
  const current = turn.value
  if (current === null) return null
  const duration = formatDuration((current.endedAt ?? now.value) - current.startedAt)
  return current.endedAt === null ? `响应中 ${duration}` : `响应耗时 ${duration}`
})

/**
 * 正在生成的 Thinking 块：消息仍在生成且该块是最后一个块。投影按 contentIndex 排序、
 * 每个块由各自的 start 事件建立，所以非末块一定已结束，不需要块级流式标记。
 */
const liveThinkingKey = computed(() => {
  if (props.message.role !== 'assistant' || generation.value?.phase !== 'running') return null
  const last = props.message.blocks[props.message.blocks.length - 1]
  return last !== undefined && last.kind === 'thinking' ? last.key : null
})

/** 流式 Thinking 的正文；跟随滚动只在这块存在且它自己展开时生效。 */
const liveThinking = computed(() => {
  const key = liveThinkingKey.value
  if (key === null) return null
  const block = props.message.blocks.find(candidate => candidate.key === key)
  return block !== undefined && block.kind === 'thinking' ? { key, text: block.text } : null
})

/**
 * 单段思考是否展开：手动选择优先，否则只有正在生成的那段展开——
 * 结束后自动收起成一行摘要。工具调用不参与这个判断，各自独立折叠。
 */
function isThinkingExpanded(key: string): boolean {
  return thinkingOverrides.get(key) ?? key === liveThinkingKey.value
}

/** 由摘要行点击统一控制开合，键盘激活同样生效；手动选择优先于自动开合。展开时上报，收起不上报。 */
function toggleThinking(key: string): void {
  const next = !isThinkingExpanded(key)
  thinkingOverrides.set(key, next)
  if (next) emit('userExpand')
}

/** 正在生成的那段思考是否展开：流式正文跟随只在它展开时生效。 */
const liveThinkingExpanded = computed(() => {
  const key = liveThinkingKey.value
  return key !== null && isThinkingExpanded(key)
})

/** 距底部多少像素内仍视为贴在底部；与消息列表同一口径，避免流式更新与用户滚动互抢。 */
const THINKING_FOLLOW_THRESHOLD_PX = 24

/** 流式 Thinking 的正文元素：跟随滚动要读它的滚动位置与高度。 */
const thinkingBodies = new Map<string, HTMLElement>()
const thinkingFollow = ref(true)
let thinkingScrollTop = 0
/**
 * 用户滚动意图：滚轮与卡片内滚动条/触摸只记录一帧，只有它允许把位置下移判定为用户上滚。
 * 内容重渲染造成的回夹不能暂停跟随，否则流式 Thinking 会停在半途。
 */
let thinkingUserInput = false
let thinkingInputHandle: number | null = null

/** 元素卸载时移除记录，不持有已脱离文档的节点。 */
function registerThinkingBody(key: string, element: unknown): void {
  if (element instanceof HTMLElement) thinkingBodies.set(key, element)
  else thinkingBodies.delete(key)
}

/** 标记一次用户滚动输入，只对下一帧派发的 scroll 事件有效。 */
function markThinkingInput(): void {
  thinkingUserInput = true
  if (thinkingInputHandle !== null) return
  thinkingInputHandle = requestAnimationFrame(() => {
    thinkingInputHandle = null
    thinkingUserInput = false
  })
}

function onThinkingBodyWheel(event: WheelEvent): void {
  if (event.deltaY !== 0) markThinkingInput()
}

function onThinkingBodyPointerDown(event: PointerEvent): void {
  // 卡片内滚动条的指针事件落在正文容器；点在文本上不算滚动意图。
  if (event.target === event.currentTarget) markThinkingInput()
}

/** 内容变高不算上滚：只有用户输入造成的实际向上移动才暂停跟随，回到底部再恢复。 */
function onThinkingBodyScroll(event: Event): void {
  const element = event.currentTarget
  if (!(element instanceof HTMLElement)) return
  const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= THINKING_FOLLOW_THRESHOLD_PX
  if (nearBottom) thinkingFollow.value = true
  else if (thinkingUserInput && element.scrollTop < thinkingScrollTop) thinkingFollow.value = false
  thinkingScrollTop = element.scrollTop
}

/**
 * 流式思考的正文跟随：换块或该块重新展开时重置为跟随，跟随中每次文本更新滚到底部。
 * 折叠期间元素不可见，滚动位置没有参考价值，因此重新展开一律从头跟随。
 */
watch([liveThinking, liveThinkingExpanded], ([current, expanded], previous) => {
  if (current === null) return
  if (previous[0] === null || previous[0].key !== current.key || !previous[1]) {
    thinkingFollow.value = true
    thinkingScrollTop = 0
  }
  if (!expanded || !thinkingFollow.value) return
  const element = thinkingBodies.get(current.key)
  if (element === undefined) return
  element.scrollTop = element.scrollHeight
  thinkingScrollTop = element.scrollTop
}, { flush: 'post' })

/** 未手动调整的技能卡一律折叠；流式更新不改变手动选择。 */
function isSkillExpanded(key: string): boolean {
  return skillOverrides.get(key) ?? false
}

/** 由 summary 的点击统一控制开合，键盘激活同样生效；展开时上报，收起不上报。 */
function toggleSkill(key: string): void {
  const next = !isSkillExpanded(key)
  skillOverrides.set(key, next)
  if (next) emit('userExpand')
}

/** 本次模型调用的 token 花销；未上报或全零（失败调用）时为 null，整段不渲染。 */
const usageText = computed(() => {
  const current = props.message.usage
  return current === null ? null : `↑${formatTokens(current.input)} ↓${formatTokens(current.output)}`
})

/**
 * 单轮缓存命中率：本次调用的缓存读 /（输入 + 缓存读 + 缓存写）。
 * 没有任何缓存活动时不显示，与 Pi footer 的口径一致。
 */
const cacheHitText = computed(() => {
  const current = props.message.usage
  if (current === null || (current.cacheRead === 0 && current.cacheWrite === 0)) return null
  const hit = cacheHitRate(current)
  return hit === null ? null : `缓存 ${(hit * 100).toFixed(1)}%`
})

/** 压缩来源：实时记录带触发原因，历史条目没有原因时按「历史记录」展示。 */
const compactionOrigin = computed(() => {
  switch (compaction.value?.reason) {
    case 'manual': return '手动'
    case 'threshold': return '自动 · 阈值'
    case 'overflow': return '自动 · 溢出'
    default: return '历史记录'
  }
})

/** 压缩前后的 token 对比；两侧都缺失时整段不渲染，不推算压缩量。 */
const compactionTokens = computed(() => {
  const current = compaction.value
  if (current === null || (current.tokensBefore === null && current.tokensAfter === null)) return null
  return `${formatTokens(current.tokensBefore)} → ${formatTokens(current.tokensAfter)} tokens`
})

/** 取消与失败的说明；成功时为空，由摘要正文表达。 */
const compactionNotice = computed(() => {
  const current = compaction.value
  if (current === null) return null
  if (current.aborted) return '上下文压缩已取消。'
  if (current.errorMessage !== null) return `上下文压缩失败：${current.errorMessage}`
  return null
})

/** 只有带错误文本的压缩按错误展示；取消与成功都不用错误样式。 */
const compactionFailed = computed(() => (compaction.value?.errorMessage ?? null) !== null)

/** 压缩摘要与技能卡一样初始折叠，手动开合只影响当前块。 */
const compactionOverrides = reactive(new Map<string, boolean>())

function isCompactionExpanded(key: string): boolean {
  return compactionOverrides.get(key) ?? false
}

function toggleCompaction(key: string): void {
  const next = !isCompactionExpanded(key)
  compactionOverrides.set(key, next)
  if (next) emit('userExpand')
}

/** 进入编辑态：预填用户实际输入（技能消息还原为 `/skill:` 命令形态），聚焦输入框，禁用其他操作。 */
function startEdit(): void {
  if (editing.value || props.actionsDisabled || !hasText.value) return
  editDraft.value = messageText.value
  editing.value = true
  // 下一帧聚焦，确保 textarea 已挂载
  requestAnimationFrame(() => editTextarea.value?.focus())
}

/** 取消编辑：恢复原气泡，不发起回退。 */
function cancelEdit(): void {
  editing.value = false
  editDraft.value = ''
}

/** 提交编辑：通知父级执行回退+发送。 */
function submitEdit(): void {
  const text = editDraft.value.trim()
  if (text === '') return
  emit('submitEdit', props.message.id, text)
  // 父级负责回退与重新发送；回退成功后本条消息离开历史，组件随之卸载，历史未变时保持编辑态供重试；
  // 分叉已发生时由父级把文本交回输入框。
}

/** Esc 取消，Enter 提交（非 Shift+Enter）。 */
function onEditKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelEdit()
  } else if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submitEdit()
  }
}
</script>

<template>
  <article class="chat-message" :class="[
    isUser ? 'chat-message-user' : isCompaction ? 'chat-message-compaction' : 'chat-message-assistant',
    { 'chat-message-has-genui': hasGenui }
  ]">
    <header class="chat-meta" :class="{ 'chat-meta-continued': compactHeader === true }">
      <span v-if="!isUser && !isCompaction && compactHeader !== true" class="chat-role-mark" aria-hidden="true">π</span>
      <span v-if="compactHeader !== true" class="chat-role">{{ roleLabel }}</span>
      <span v-if="message.time || turnText !== null || (!isUser && !isCompaction)" class="chat-time inline-flex flex-wrap items-center gap-x-3 gap-y-1">
        <span v-if="message.time">{{ message.time }}</span>
        <span
          v-if="!isUser && !isCompaction"
          class="font-mono"
          title="按客户端事件计时；生成中更新，消息结束、事件配对中断或 Agent 收敛时固定；历史无记录不推算。"
        >{{ generationText }}</span>
        <span
          v-if="turnText !== null"
          class="font-mono"
          title="从提交到本轮结束（含工具执行与等待），按客户端事件计时；历史轮次无记录。"
        >{{ turnText }}</span>
        <span
          v-if="usageText !== null"
          class="font-mono"
          title="本次模型调用的输入 / 输出 tokens；由模型上报，未上报或全零不显示。"
        >{{ usageText }}</span>
        <span
          v-if="cacheHitText !== null"
          class="font-mono"
          title="单轮缓存命中率：缓存读 /（输入 + 缓存读 + 缓存写），本次模型调用。"
        >{{ cacheHitText }}</span>
      </span>
    </header>

    <!-- 压缩记录：摘要初始折叠，只展示 Pi 给出的内容；取消与失败没有摘要，用一行提示说明结果。 -->
    <template v-if="isCompaction && compaction !== null">
      <details
        v-if="compaction.summary !== ''"
        class="chat-compaction self-start w-full"
        :open="isCompactionExpanded(message.id)"
      >
        <summary @click.prevent="toggleCompaction(message.id)">
          <span class="disclosure"></span>
          <span class="chat-compaction-origin">{{ compactionOrigin }}</span>
          <span v-if="compactionTokens !== null" class="chat-compaction-tokens">{{ compactionTokens }}</span>
          <span class="chat-compaction-hint">摘要正文</span>
        </summary>
        <div class="chat-compaction-body">
          <MarkdownContent :text="compaction.summary" />
          <HistoryLoadSentinel
            v-for="chunk in summaryChunks"
            :key="historyChunkKey(chunk)"
            :cursor="`${historyChunkKey(chunk)}:${chunk.offset}`"
            :enabled="historyEnabled === true && isCompactionExpanded(message.id)"
            :loading="historyBusy === true"
            :error="chunkStates?.[historyChunkKey(chunk)]?.error"
            @load="emit('loadChunk', chunk)"
          />
        </div>
      </details>
      <p
        v-else-if="compactionNotice !== null"
        class="status-notice self-start"
        :class="compactionFailed ? 'status-notice-error' : 'status-notice-info'"
      >{{ compactionNotice }}</p>
    </template>

    <!-- 响应过程逐项展示：每段思考各自折叠成一行，正文按原位置排在各块之间；
         连续且非生成式界面的工具调用归入一个执行记录面板，单条工具仍是一张独立折叠卡。 -->
    <template v-for="row in displayRows" :key="row.kind === 'tools' ? row.key : row.block.key">
      <!-- 工具组：面板只提供归组与统计，组内每条仍是一张独立折叠的 ToolCard。 -->
      <section v-if="row.kind === 'tools'" class="execution-panel" aria-label="工具执行记录">
        <div class="execution-panel-head">
          <span class="execution-panel-title">执行记录</span>
          <span class="execution-panel-stats">{{ groupStats(row.blocks) }}</span>
        </div>
        <ToolCard
          v-for="block in row.blocks"
          :key="block.key"
          :block="block"
          :history-chunks="chunksFor(block)"
          :chunk-states="chunkStates"
          :history-enabled="historyEnabled"
          :history-busy="historyBusy"
          :history-more="historyMore"
          :history-error="historyError"
          @load-more="emit('loadMore')"
          @load-chunk="emit('loadChunk', $event)"
          @user-expand="emit('userExpand')"
        />
      </section>
      <template v-else>
        <details
          v-if="row.block.kind === 'thinking'"
          class="chat-thinking self-start w-full"
          :open="isThinkingExpanded(row.block.key)"
        >
          <summary @click.prevent="toggleThinking(row.block.key)">
            <span class="disclosure"></span>
            <span class="chat-thinking-label">Thinking</span>
            <span v-if="row.block.key === liveThinkingKey" class="chat-thinking-hint">
              <span class="status-dots text-desk-accent" aria-hidden="true"><span></span><span></span><span></span></span>
              思考中
            </span>
          </summary>
          <div
            class="chat-thinking-body"
            :ref="element => registerThinkingBody(row.block.key, element)"
            @scroll.passive="onThinkingBodyScroll"
            @wheel.passive="onThinkingBodyWheel"
            @pointerdown.passive="onThinkingBodyPointerDown"
          >
            <MarkdownContent :text="row.block.text" />
            <HistoryLoadSentinel
              v-for="chunk in chunksFor(row.block)"
              :key="historyChunkKey(chunk)"
              :cursor="`${historyChunkKey(chunk)}:${chunk.offset}`"
              :enabled="historyEnabled === true && isThinkingExpanded(row.block.key)"
              :loading="historyBusy === true"
              :error="chunkStates?.[historyChunkKey(chunk)]?.error"
              @load="emit('loadChunk', chunk)"
            />
            <p v-if="row.block.truncated && chunksFor(row.block).length === 0" class="tool-note">此内容超出展示上限，已截断。</p>
          </div>
        </details>
        <!-- 交付了生成式界面的工具调用直接渲染界面，不再套一层折叠卡；其余工具仍走通用 ToolCard。
             同一份界面只有最高版本可交互：被取代的版本折叠成一行只读记录，展开后控件与提交都禁用。
             按 documentId 作 key：文档被替换时整个界面连同内存参数一起重建。
             界面由 GenuiMountGate 按可见性挂载：长会话里展开全部轮次时，不把每份界面的组件都常驻。
             旧版折叠行的整行点击是「跳到新版」，右侧小按钮才是查看旧版，两种意图不混用。 -->
        <template v-else-if="row.block.kind === 'toolcall'">
          <!-- 被取代的旧版折叠成一行：整行是跳转到新版的按钮，右侧单独切换查看旧版。
               两者分成两个按钮而不是套在 details 的 summary 里：点击意图不同，嵌套交互控件也不合语义。 -->
          <template v-if="row.block.ui !== null && row.block.supersededBy !== null">
            <div class="genui-history">
              <button
                type="button"
                class="genui-history-main"
                :title="`跳到《${row.block.ui.document.title}》第 ${row.block.supersededBy} 版`"
                @click="emit('jumpLatest', row.block.ui.documentId)"
              >
                <span class="genui-history-label">历史界面</span>
                <span class="genui-history-title">{{ row.block.ui.document.title }}</span>
                <span class="genui-history-version">已被第 {{ row.block.supersededBy }} 版取代 · 跳到新版</span>
              </button>
              <button
                type="button"
                class="genui-history-toggle"
                :aria-expanded="readonlyOpen.has(row.block.key)"
                @click="toggleReadonly(row.block.key)"
              >
                {{ readonlyOpen.has(row.block.key) ? '收起' : '查看旧版' }}
              </button>
            </div>
            <div v-if="readonlyOpen.has(row.block.key)" class="genui-history-body">
              <GenuiMountGate :payload="row.block.ui">
                <UiDocument
                  :key="row.block.ui.documentId"
                  :payload="row.block.ui"
                  :submit-disabled="actionsDisabled === true"
                  :submit-disabled-reason="disabledReason ?? null"
                  :superseded-by="row.block.supersededBy"
                />
              </GenuiMountGate>
            </div>
          </template>
          <GenuiMountGate v-else-if="row.block.ui !== null" :payload="row.block.ui">
            <UiDocument
              :key="row.block.ui.documentId"
              :payload="row.block.ui"
              :submit-disabled="actionsDisabled === true"
              :submit-disabled-reason="disabledReason ?? null"
            />
          </GenuiMountGate>
          <ToolCard
            v-else
            :block="row.block"
            :history-chunks="chunksFor(row.block)"
            :chunk-states="chunkStates"
            :history-enabled="historyEnabled"
            :history-busy="historyBusy"
            :history-more="historyMore"
            :history-error="historyError"
            @load-more="emit('loadMore')"
            @load-chunk="emit('loadChunk', $event)"
            @user-expand="emit('userExpand')"
          />
        </template>
        <!-- 正文块保持原有样式：用户气泡、图片、技能卡与 AI 回答都不进折叠卡。 -->
        <template v-else-if="row.block.kind === 'text'">
          <!-- 图片附件仍只来自用户消息的本地附件，不交给 Markdown 解析。 -->
          <div v-if="row.block.image !== null && row.block.annotations !== undefined" class="max-w-full self-end">
            <ImageAnnotationCanvas :src="row.block.image.dataUrl" alt="带编号标注的图片附件" :document="row.block.annotations"
              :selected-id="selectedImageAnnotations.get(row.block.key) ?? null" max-height="24rem"
              @select="selectedImageAnnotations.set(row.block.key, $event)" />
          </div>
          <img
            v-else-if="row.block.image !== null"
            :src="row.block.image.dataUrl"
            :alt="`附件图片（${row.block.image.mimeType}）`"
            class="max-h-48 self-end rounded-desk-md border border-desk-line object-contain"
          />
          <section v-if="row.block.annotations !== undefined" class="w-full max-w-xl self-end rounded-desk-md border border-desk-line bg-desk-surface p-3 text-xs" aria-label="对应图片的标注说明">
            <p class="mb-2 font-medium">图片标注说明</p>
            <p v-if="row.block.annotations.overview" class="mb-2 whitespace-pre-wrap break-words">整图：{{ row.block.annotations.overview }}</p>
            <ol class="space-y-1">
              <li v-for="annotation in row.block.annotations.annotations" :key="annotation.id">
                <button type="button" class="block w-full rounded-desk-sm p-2 text-left whitespace-pre-wrap break-words"
                  :class="selectedImageAnnotations.get(row.block.key) === annotation.id ? 'bg-desk-accent-soft text-desk-accent' : 'hover:bg-desk-surface-subtle'"
                  :aria-pressed="selectedImageAnnotations.get(row.block.key) === annotation.id"
                  @click="selectedImageAnnotations.set(row.block.key, annotation.id)"><span class="font-semibold">{{ annotation.id }} · </span>{{ annotation.text }}</button>
              </li>
            </ol>
          </section>
          <!-- 技能调用是被 Pi 展开的机器内容，单独折叠展示；用户追加文本仍走原气泡。 -->
          <details
            v-if="row.block.skill !== null"
            class="chat-skill self-start w-full"
            :open="isSkillExpanded(row.block.key)"
          >
            <summary @click.prevent="toggleSkill(row.block.key)">
              <span class="disclosure"></span>
              <span class="chat-skill-label">技能</span>
              <span class="chat-skill-name">{{ row.block.skill.name }}</span>
              <span class="chat-skill-hint">技能正文</span>
            </summary>
            <div class="chat-skill-body">
              <MarkdownContent :text="row.block.skill.content" />
              <p v-if="row.block.truncated && chunksFor(row.block).length === 0" class="tool-note">此内容超出展示上限，已截断。</p>
            </div>
          </details>
          <!-- 图片块只渲染图片；空文本块（仅图片或仅技能调用的消息）不渲染气泡，避免多出一个空气泡。 -->
          <div
            v-if="row.block.text !== ''"
            :class="isUser ? 'chat-bubble chat-bubble-user self-end' : 'chat-assistant-content'"
          >
            <p v-if="isUser">{{ row.block.text }}</p>
            <MarkdownContent v-else :text="row.block.text" />
            <p v-if="row.block.truncated && chunksFor(row.block).length === 0" class="chat-truncation-note">此内容超出展示上限，已截断。</p>
          </div>
          <HistoryLoadSentinel
            v-for="chunk in chunksFor(row.block)"
            :key="historyChunkKey(chunk)"
            :cursor="`${historyChunkKey(chunk)}:${chunk.offset}`"
            :enabled="historyEnabled === true"
            :loading="historyBusy === true"
            :error="chunkStates?.[historyChunkKey(chunk)]?.error"
            @load="emit('loadChunk', chunk)"
          />
        </template>
      </template>
    </template>

    <div v-if="isUser && hasUserContent && !editing" class="chat-message-actions" role="group" aria-label="用户消息操作">
      <span
        v-if="copyFeedback"
        role="status"
        :class="copySucceeded ? 'sr-only' : 'chat-message-action-feedback'"
      >{{ copyFeedback }}</span>
      <div class="chat-message-action-toolbar">
        <AppButton
          variant="unstyled"
          class="chat-message-action chat-message-action-rewind"
          :disabled="actionsDisabled"
          aria-label="回退"
          :aria-describedby="`${tooltipId}-rewind`"
          @click="emit('rewind', message.id)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 10a8 8 0 1 1 1.8 7.1" />
            <path d="M4 4v6h6M12 7v5l3 2" />
          </svg>
          <span :id="`${tooltipId}-rewind`" role="tooltip" class="chat-message-action-tooltip">{{ rewindTooltip }}</span>
        </AppButton>
        <AppButton
          variant="unstyled"
          class="chat-message-action"
          :class="{ 'chat-message-action-copied': copySucceeded }"
          :disabled="copying || !hasText"
          aria-label="复制"
          :aria-describedby="`${tooltipId}-copy`"
          @click="copyMessage"
        >
          <svg v-if="copySucceeded" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5 12 4 4L19 6" />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
          </svg>
          <span :id="`${tooltipId}-copy`" role="tooltip" class="chat-message-action-tooltip">{{ copySucceeded ? '已复制' : '复制消息' }}</span>
        </AppButton>
        <AppButton
          variant="unstyled"
          class="chat-message-action"
          :disabled="actionsDisabled || !hasText"
          aria-label="修改"
          :aria-describedby="`${tooltipId}-edit`"
          @click="startEdit"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m15 5 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z" />
          </svg>
          <span :id="`${tooltipId}-edit`" role="tooltip" class="chat-message-action-tooltip">{{ editTooltip }}</span>
        </AppButton>
      </div>
    </div>

    <div v-if="isUser && editing" class="chat-message-edit" role="group" aria-label="编辑消息">
      <textarea
        ref="editTextarea"
        v-model="editDraft"
        class="chat-message-edit-textarea"
        rows="3"
        :disabled="actionsDisabled"
        @keydown="onEditKeydown"
      />
      <div class="chat-message-edit-actions">
        <p class="chat-message-edit-hint">提交将回退到该消息之前并用修改后的文本重新发送；原消息的图片附件会一起重发，超出大小上限或投影已丢弃的除外。</p>
        <div class="chat-message-edit-buttons">
          <AppButton variant="default" :disabled="actionsDisabled" @click="cancelEdit">取消</AppButton>
          <AppButton variant="primary" :disabled="actionsDisabled || editDraft.trim() === ''" @click="submitEdit">提交</AppButton>
        </div>
      </div>
    </div>

    <p v-if="message.failure" role="alert" class="status-notice status-notice-error self-start">
      {{ message.failure }}
    </p>
  </article>
</template>

<style scoped>
/* 样式只作用于本消息的操作栏，沿用现有主题色，不调整全局按钮或消息气泡。 */
.chat-message-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  align-self: flex-end;
  justify-content: flex-end;
  gap: 8px;
  min-height: 29px;
}

.chat-message-action-toolbar {
  display: flex;
  align-items: center;
  gap: 3px;
}

.chat-message-action {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 29px;
  height: 29px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-desk-sm);
  background: transparent;
  color: var(--color-desk-muted);
  cursor: pointer;
  transition: color var(--motion-duration-fast), background-color var(--motion-duration-fast);
}

.chat-message-action:not(:disabled):hover {
  background: var(--color-desk-surface-subtle);
  color: var(--color-desk-ink);
}

.chat-message-action-rewind:not(:disabled):hover {
  background: var(--color-desk-danger-soft);
  color: var(--color-desk-danger);
}

.chat-message-action-copied,
.chat-message-action-copied:not(:disabled):hover {
  color: var(--color-desk-accent);
}

.chat-message-action:focus-visible {
  outline: 2px solid var(--color-desk-accent);
  outline-offset: 2px;
}

.chat-message-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.chat-message-action svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.65;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.chat-message-action-tooltip {
  position: absolute;
  z-index: 5;
  bottom: calc(100% + 7px);
  left: 50%;
  padding: 5px 8px;
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-ink);
  color: var(--color-desk-surface);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.5;
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translate(-50%, 3px);
  transition: opacity var(--motion-duration-fast), transform var(--motion-duration-fast);
}

.chat-message-action-tooltip::after {
  position: absolute;
  top: 100%;
  left: calc(50% - 4px);
  border: 4px solid transparent;
  border-top-color: var(--color-desk-ink);
  content: '';
}

/* 禁用时也展示 tooltip：回退不可用的原因必须能看到，否则只剩一个灰按钮。 */
.chat-message-action:hover .chat-message-action-tooltip,
.chat-message-action:focus-visible .chat-message-action-tooltip {
  opacity: 1;
  visibility: visible;
  transform: translate(-50%, 0);
}

/* 最右侧提示向左展开，避免越过聊天正文的右边界。 */
.chat-message-action:last-child .chat-message-action-tooltip {
  right: 0;
  left: auto;
  transform: translate(0, 3px);
}

.chat-message-action:last-child:hover .chat-message-action-tooltip,
.chat-message-action:last-child:focus-visible .chat-message-action-tooltip {
  transform: translate(0, 0);
}

.chat-message-action:last-child .chat-message-action-tooltip::after {
  right: 10px;
  left: auto;
}

.chat-message-action-feedback {
  color: var(--color-desk-danger);
  font-size: 11px;
  line-height: 1.5;
}

/* 编辑态：气泡替换为输入框，下方提示 + 按钮。 */
.chat-message-edit {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  align-self: flex-end;
}

.chat-message-edit-textarea {
  display: block;
  width: 100%;
  max-width: 86%;
  min-height: 70px;
  max-height: 200px;
  padding: 10px 12px;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-lg);
  background: var(--color-desk-surface);
  color: var(--color-desk-ink);
  font: 13px/1.7 var(--font-sans);
  resize: vertical;
  font-family: var(--font-sans);
}

.chat-message-edit-textarea:focus-visible {
  outline: 2px solid var(--color-desk-accent);
  outline-offset: 1px;
}

.chat-message-edit-textarea:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.chat-message-edit-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  width: 100%;
  max-width: 86%;
}

.chat-message-edit-hint {
  margin: 0;
  color: var(--color-desk-muted);
  font-size: 11px;
  line-height: 1.5;
  text-align: right;
}

.chat-message-edit-buttons {
  display: flex;
  align-items: center;
  gap: 6px;
}

@media (prefers-reduced-motion: reduce) {
  .chat-message-action,
  .chat-message-action-tooltip {
    transition: none;
  }
}
</style>
