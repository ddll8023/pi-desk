<!-- 单条消息：按块展示正文、过程区块、技能卡、压缩卡与计时（单条生成耗时与本轮响应耗时）与本次调用的 token 花销；Thinking 与工具调用合并成一个可折叠的过程区块（生成中展开并跟随最新思考，结束后收起，折叠态显示摘要与流式预览，手动开合优先，全局折叠开关可一次性收起全部过程），回答正文不进过程区块、始终可见；用户消息下方使用细线图标操作栏，回退与修改后的重新发送由父级执行。 -->
<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, useId, watch } from 'vue'
import { copyText } from '../clipboard'
import { userMessagePayload } from '../chat-view'
import type { ChatMessageView } from '../chat-view'
import { formatDuration, useTickingNow } from '../clock'
import { cacheHitRate, formatTokens } from '../usage-format'
import { thinkingPreviewText } from '../thinking-preview'
import MarkdownContent from './MarkdownContent.vue'
import ToolCard from './ToolCard.vue'
import AppButton from './ui/AppButton.vue'

const props = defineProps<{
  readonly message: ChatMessageView
  readonly actionsDisabled?: boolean
  /** 动作栏不可用的原因；禁用时替换默认 tooltip，用户据此知道在等什么。 */
  readonly disabledReason?: string | null
  /** 全局折叠：为 true 时所有过程区块都收起，最终回答正文不受影响。 */
  readonly processCollapsed?: boolean
}>()

const emit = defineEmits<{
  rewind: [messageId: string]
  submitEdit: [messageId: string, editedText: string]
}>()
const copyFeedback = ref('')
const copying = ref(false)
const copySucceeded = computed(() => copyFeedback.value.startsWith('已复制'))
const tooltipId = useId()
let copyFeedbackTimer: number | null = null
let mounted = true

const editing = ref(false)
const editDraft = ref('')
const editTextarea = ref<HTMLTextAreaElement | null>(null)

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

/** 过程区块的手动开合只保留在当前消息组件中；没有手动选择时按全局开关与生成状态决定。 */
const processOverrides = reactive(new Map<string, boolean>())

/** 技能卡初始折叠，流式更新不改变手动选择。 */
const skillOverrides = reactive(new Map<string, boolean>())

const isUser = computed(() => props.message.role === 'user')
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

/** 流式 Thinking 的正文；跟随滚动只在这块存在且所属过程区块展开时生效。 */
const liveThinking = computed(() => {
  const key = liveThinkingKey.value
  if (key === null) return null
  const block = props.message.blocks.find(candidate => candidate.key === key)
  return block !== undefined && block.kind === 'thinking' ? { key, text: block.text } : null
})

/**
 * 正文块与响应过程分开：正文（用户文本、图片、技能卡、AI 回答）保持原样展示，
 * Thinking 与工具调用合并成一个可折叠的过程区块，回答正文不随过程收起。
 */
const textBlocks = computed(() => props.message.blocks.filter(block => block.kind === 'text'))
const processBlocks = computed(() => props.message.blocks.filter(block => block.kind !== 'text'))

/** 过程区块的一行摘要：只数段数与次数，不解析正文。 */
const processSummary = computed(() => {
  let thinking = 0
  let tools = 0
  for (const block of processBlocks.value) {
    if (block.kind === 'thinking') thinking += 1
    else if (block.kind === 'toolcall') tools += 1
  }
  const parts: string[] = []
  if (thinking > 0) parts.push(`思考 ${thinking} 段`)
  if (tools > 0) parts.push(`工具 ${tools} 次`)
  return parts.join(' · ')
})

/**
 * 过程区块的开合：手动选择优先，其次是全局折叠开关，最后是生成状态——
 * 生成中展开（流式思考与工具状态要能看见），结束后收起。
 */
const processExpanded = computed(() => {
  const manual = processOverrides.get(props.message.id)
  if (manual !== undefined) return manual
  if (props.processCollapsed === true) return false
  return generation.value?.phase === 'running'
})

/** 由 summary 的点击统一控制开合，键盘激活同样生效；手动选择优先于自动开合。 */
function toggleProcess(): void {
  processOverrides.set(props.message.id, !processExpanded.value)
}

/** 折叠态预览：生成中把正在思考的尾部片段放在摘要行，收起时仍能看出在做什么。 */
const liveThinkingPreview = computed(() => {
  const current = liveThinking.value
  return current === null || processExpanded.value ? '' : thinkingPreviewText(current.text)
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
 * 流式思考的正文跟随：换块或过程区块重新展开时重置为跟随，跟随中每次文本更新滚到底部。
 * 折叠期间元素不可见，滚动位置没有参考价值，因此重新展开一律从头跟随。
 */
watch([liveThinking, processExpanded], ([current, expanded], previous) => {
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

/** 由 summary 的点击统一控制开合，键盘激活同样生效。 */
function toggleSkill(key: string): void {
  skillOverrides.set(key, !isSkillExpanded(key))
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
  compactionOverrides.set(key, !isCompactionExpanded(key))
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
  // 父级负责回退与重新发送；回退成功后本条消息离开历史，组件随之卸载，失败时保持编辑态供重试
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
  <article class="chat-message" :class="isUser ? 'chat-message-user' : isCompaction ? 'chat-message-compaction' : 'chat-message-assistant'">
    <header class="chat-meta">
      <span v-if="!isUser && !isCompaction" class="chat-role-mark" aria-hidden="true">π</span>
      <span class="chat-role">{{ roleLabel }}</span>
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
        </div>
      </details>
      <p
        v-else-if="compactionNotice !== null"
        class="status-notice self-start"
        :class="compactionFailed ? 'status-notice-error' : 'status-notice-info'"
      >{{ compactionNotice }}</p>
    </template>

    <!-- AI 响应过程：Thinking 与工具调用合并成一个可折叠区块；生成中展开、结束后收起，最终回答正文始终可见。 -->
    <details
      v-if="processBlocks.length > 0"
      class="chat-process self-start w-full"
      :open="processExpanded"
    >
      <summary @click.prevent="toggleProcess">
        <span class="disclosure"></span>
        <span>过程</span>
        <span class="chat-process-count">{{ processSummary }}</span>
        <span v-if="liveThinkingKey !== null" class="chat-process-hint">
          <span class="status-dots text-desk-accent" aria-hidden="true"><span></span><span></span><span></span></span>
          思考中
        </span>
        <span v-if="liveThinkingPreview !== ''" class="chat-thinking-preview is-live">{{ liveThinkingPreview }}</span>
      </summary>
      <div class="chat-process-body">
        <template v-for="block in processBlocks" :key="block.key">
          <!-- 思考段落直接铺在过程区块里：外层已经负责开合，不再嵌一层折叠。 -->
          <div v-if="block.kind === 'thinking'" class="chat-process-item">
            <p class="chat-process-item-label">Thinking</p>
            <div
              class="chat-process-thinking"
              :ref="element => registerThinkingBody(block.key, element)"
              @scroll.passive="onThinkingBodyScroll"
              @wheel.passive="onThinkingBodyWheel"
              @pointerdown.passive="onThinkingBodyPointerDown"
            >
              <MarkdownContent :text="block.text" />
              <p v-if="block.truncated" class="tool-note">此内容超出展示上限，已截断。</p>
            </div>
          </div>
          <ToolCard v-else-if="block.kind === 'toolcall'" :block="block" />
        </template>
      </div>
    </details>

    <!-- 正文块保持原有顺序与样式：用户气泡、图片、技能卡与 AI 回答都不进过程区块。 -->
    <template v-for="block in textBlocks" :key="block.key">
      <template v-if="block.kind === 'text'">
        <!-- 图片附件仍只来自用户消息的本地附件，不交给 Markdown 解析。 -->
        <img
          v-if="block.image !== null"
          :src="block.image.dataUrl"
          :alt="`附件图片（${block.image.mimeType}）`"
          class="max-h-48 self-end rounded-desk-md border border-desk-line object-contain"
        />
        <!-- 技能调用是被 Pi 展开的机器内容，单独折叠展示；用户追加文本仍走原气泡。 -->
        <details
          v-if="block.skill !== null"
          class="chat-skill self-start w-full"
          :open="isSkillExpanded(block.key)"
        >
          <summary @click.prevent="toggleSkill(block.key)">
            <span class="disclosure"></span>
            <span class="chat-skill-label">技能</span>
            <span class="chat-skill-name">{{ block.skill.name }}</span>
            <span class="chat-skill-hint">技能正文</span>
          </summary>
          <div class="chat-skill-body">
            <MarkdownContent :text="block.skill.content" />
            <p v-if="block.truncated" class="tool-note">此内容超出展示上限，已截断。</p>
          </div>
        </details>
        <!-- 图片块只渲染图片；空文本块（仅图片或仅技能调用的消息）不渲染气泡，避免多出一个空气泡。 -->
        <div
          v-if="block.text !== ''"
          :class="isUser ? 'chat-bubble chat-bubble-user self-end' : 'chat-assistant-content'"
        >
          <p v-if="isUser">{{ block.text }}</p>
          <MarkdownContent v-else :text="block.text" />
          <p v-if="block.truncated" class="chat-truncation-note">此内容超出展示上限，已截断。</p>
        </div>
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
