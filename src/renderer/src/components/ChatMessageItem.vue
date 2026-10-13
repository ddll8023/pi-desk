<!-- 单条消息：按块展示正文、Thinking、技能卡、工具与计时（单条生成耗时与本轮响应耗时）；用户消息下方使用细线图标操作栏，回退与修改后的重新发送由父级执行。 -->
<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, useId } from 'vue'
import { copyText } from '../clipboard'
import type { ChatMessageView, ChatTextBlock } from '../chat-view'
import { formatDuration, useTickingNow } from '../clock'
import MarkdownContent from './MarkdownContent.vue'
import ToolCard from './ToolCard.vue'
import AppButton from './ui/AppButton.vue'

const props = defineProps<{
  readonly message: ChatMessageView
  readonly actionsDisabled?: boolean
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
})

/** 复制与修改预填都取「用户实际输入」：技能消息还原成 Pi 命令形态，投影生成的附件说明不计入。 */
const messageText = computed(() => props.message.blocks
  .filter(block => block.kind === 'text' && block.image === null && !block.notice)
  .map(block => (block.kind === 'text' ? blockUserText(block) : ''))
  .join('\n'))
const hasText = computed(() => messageText.value.trim() !== '')

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

/** 折叠块（Thinking 与技能卡）的手动选择只保留在当前消息组件中；重新进入聊天或切换会话后恢复初始折叠。 */
const thinkingOverrides = reactive(new Map<string, boolean>())

/** 技能卡与 Thinking 同样初始折叠，手动开合只影响当前块。 */
const skillOverrides = reactive(new Map<string, boolean>())

const roleLabel = computed(() => (props.message.role === 'user' ? '你' : 'Assistant'))
const isUser = computed(() => props.message.role === 'user')
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

/** 未手动调整的块一律折叠；流式更新不改变单个块的手动选择。 */
function isThinkingExpanded(key: string): boolean {
  return thinkingOverrides.get(key) ?? false
}

/** 由 summary 的点击统一控制开合，键盘激活同样生效。 */
function toggleThinking(key: string): void {
  thinkingOverrides.set(key, !isThinkingExpanded(key))
}

/** 未手动调整的技能卡一律折叠；流式更新不改变手动选择。 */
function isSkillExpanded(key: string): boolean {
  return skillOverrides.get(key) ?? false
}

/** 由 summary 的点击统一控制开合，键盘激活同样生效。 */
function toggleSkill(key: string): void {
  skillOverrides.set(key, !isSkillExpanded(key))
}

/**
 * 文本块在复制与修改预填里用的用户文本：技能消息还原为 `/skill:<名称> <追加文本>`。
 * 该形态提交后会由 Pi 重新展开技能，因此改写不会静默丢掉技能调用。
 */
function blockUserText(block: ChatTextBlock): string {
  if (block.skill === null) return block.text
  return block.text === '' ? `/skill:${block.skill.name}` : `/skill:${block.skill.name} ${block.text}`
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
  <article class="chat-message" :class="isUser ? 'chat-message-user' : 'chat-message-assistant'">
    <header class="chat-meta">
      <span v-if="!isUser" class="chat-role-mark" aria-hidden="true">π</span>
      <span class="chat-role">{{ roleLabel }}</span>
      <span v-if="message.time || turnText !== null || !isUser" class="chat-time inline-flex flex-wrap items-center gap-x-3 gap-y-1">
        <span v-if="message.time">{{ message.time }}</span>
        <span
          v-if="!isUser"
          class="font-mono"
          title="按客户端事件计时；生成中更新，消息结束、事件配对中断或 Agent 收敛时固定；历史无记录不推算。"
        >{{ generationText }}</span>
        <span
          v-if="turnText !== null"
          class="font-mono"
          title="从提交到本轮结束（含工具执行与等待），按客户端事件计时；历史轮次无记录。"
        >{{ turnText }}</span>
      </span>
    </header>

    <template v-for="block in message.blocks" :key="block.key">
      <template v-if="block.kind === 'text'">
        <!-- 图片附件仍只来自用户消息的本地附件，不交给 Markdown 解析。 -->
        <img
          v-if="block.image !== null"
          :src="block.image.dataUrl"
          :alt="`附件图片（${block.image.mimeType}）`"
          class="max-h-48 self-end rounded-desk-md border border-desk-line object-contain"
        />
        <!-- 技能调用是被 Pi 展开的机器内容，单独折叠展示；用户追加文本仍走原气泡。 -->
        <details v-if="block.skill !== null" class="chat-skill self-start w-full">
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

      <!-- 历史与流式内容均初始折叠；手动开合只影响当前块。 -->
      <details
        v-else-if="block.kind === 'thinking'"
        :open="isThinkingExpanded(block.key)"
        class="chat-thinking self-start w-full"
      >
        <summary @click.prevent="toggleThinking(block.key)">
          <span class="disclosure"></span>
          <span>Thinking</span>
          <span class="chat-thinking-hint">思考过程</span>
        </summary>
        <div class="chat-thinking-body">
          <MarkdownContent :text="block.text" />
          <p v-if="block.truncated" class="tool-note">此内容超出展示上限，已截断。</p>
        </div>
      </details>

      <ToolCard v-else-if="block.kind === 'toolcall'" :block="block" class="self-start w-full" />
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
          <span :id="`${tooltipId}-rewind`" role="tooltip" class="chat-message-action-tooltip">回到这条消息之前</span>
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
          <span :id="`${tooltipId}-edit`" role="tooltip" class="chat-message-action-tooltip">修改消息</span>
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
        <p class="chat-message-edit-hint">提交将回退到该消息之前并用修改后的文本重新发送。原消息中的图片附件无法恢复。</p>
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

.chat-message-action:not(:disabled):hover .chat-message-action-tooltip,
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

.chat-message-action:last-child:not(:disabled):hover .chat-message-action-tooltip,
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
