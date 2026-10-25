<!-- 手机消息阅读区：复用安全 Markdown 和聊天映射，工具详情与历史原文显式展开；滚动只在接近底部时跟随新消息。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { HistoryChunk, ProjectionMessage, ToolExecution } from '../../../shared/runtime-api'
import type { HistoryState } from '../../../renderer/src/sessions/stores/runtime-history'
import { historyChunkKey } from '../../../renderer/src/sessions/stores/runtime-history'
import { createChatViewCache } from '../../../renderer/src/sessions/chat-view'
import type { ChatTurnView } from '../../../renderer/src/sessions/chat-view'
import MarkdownContent from '../../../renderer/src/ui/MarkdownContent.vue'

const props = defineProps<{
  readonly messages: readonly ProjectionMessage[]
  readonly tools: readonly ToolExecution[]
  readonly history: HistoryState
  readonly sessionKey: string
  readonly syncing: boolean
  readonly truncated: boolean
}>()
const emit = defineEmits<{
  earlier: []
  turn: [turnId: string, more: boolean]
  chunk: [turnId: string, chunk: HistoryChunk]
  visibility: [turnId: string, visible: boolean, owner: string]
}>()
const cache = createChatViewCache()
const detailCache = createChatViewCache()
const turns = computed(() => cache.toTurns(props.messages, props.tools))
const openTurns = ref(new Set<string>())
const scroller = ref<HTMLElement | null>(null)
const follow = ref(true)
const phases = { running: '运行中', succeeded: '已完成', failed: '失败', unknown: '未确认结束' } as const
const chunkLabels = { text: '正文', thinking: '思考', arguments: '工具参数', output: '工具结果', summary: '压缩摘要' } as const

function shownMessages(turn: ChatTurnView) {
  const detail = turn.historyId ? props.history.turns[turn.historyId] : undefined
  if (turn.historyId && openTurns.value.has(turn.historyId) && detail?.loaded) {
    // 原文是用户主动打开的分支快照；实时增量仍在后台接收，收起后回到实时内容。
    return detailCache.toMessages(detail.messages, detail.tools)
  }
  return turn.user ? [turn.user, ...turn.responses] : [...turn.responses]
}
function toggle(turnId: string): void {
  const next = new Set(openTurns.value)
  const opening = !next.has(turnId)
  if (opening) { next.add(turnId); follow.value = false } else next.delete(turnId)
  openTurns.value = next
  emit('visibility', turnId, opening, props.sessionKey)
  if (opening) emit('turn', turnId, false)
}
function onScroll(): void {
  const element = scroller.value
  if (element) follow.value = element.scrollHeight - element.scrollTop - element.clientHeight < 96
}
watch(() => [props.messages, props.tools, props.history.pages,
  Object.values(props.history.turns).map(turn => [turn.messages, turn.tools, turn.loading])] as const, async () => {
  const element = scroller.value
  if (!element) return
  const oldHeight = element.scrollHeight
  const oldTop = element.scrollTop
  const first = element.querySelector('[data-turn]')?.getAttribute('data-turn')
  await nextTick()
  if (follow.value) element.scrollTop = element.scrollHeight
  else if (first && first !== element.querySelector('[data-turn]')?.getAttribute('data-turn')) element.scrollTop = oldTop + element.scrollHeight - oldHeight
})
watch(() => props.history, () => { openTurns.value = new Set() })
onMounted(() => { void nextTick(() => { if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight }) })
</script>

<template>
  <main ref="scroller" class="mobile-messages scroll-area" aria-label="对话消息" @scroll.passive="onScroll">
    <div class="mobile-message-column">
      <div v-if="history.before !== null" class="mobile-history-action">
        <button type="button" class="control-button" :disabled="history.loading || syncing" @click="emit('earlier')">{{ history.loading ? '正在读取历史…' : '加载更早的对话' }}</button>
      </div>
      <p v-if="history.error" role="alert" class="mobile-error">{{ history.error }}</p>
      <p v-if="!turns.length" class="mobile-empty">{{ syncing ? '正在读取会话…' : '这个会话暂无消息。' }}</p>
      <article v-for="turn in turns" :key="turn.key" :data-turn="turn.key" class="mobile-turn">
        <div v-for="message in shownMessages(turn)" :key="message.id" class="mobile-message" :class="`is-${message.role}`">
          <p class="mobile-message-label">{{ message.role === 'user' ? '你' : message.role === 'compaction' ? '上下文压缩' : 'Pi' }}</p>
          <template v-if="message.compaction"><p class="mobile-muted">{{ message.compaction.summary }}</p></template>
          <template v-for="block in message.blocks" :key="block.key">
            <template v-if="block.kind === 'text'">
              <img v-if="block.image" :src="block.image.dataUrl" alt="对话中的图片附件" class="mobile-message-image" loading="lazy" />
              <details v-if="block.skill" class="mobile-detail"><summary>技能 · {{ block.skill.name }}</summary><pre class="scroll-area">{{ block.skill.content }}</pre></details>
              <MarkdownContent v-if="block.text" :text="block.text" />
              <p v-if="block.truncated" class="mobile-muted">此段正文已截断，可展开这一轮原文。</p>
            </template>
            <details v-else-if="block.kind === 'thinking'" class="mobile-detail"><summary>思考过程</summary><MarkdownContent :text="block.text" /><p v-if="block.truncated" class="mobile-muted">思考正文已截断。</p></details>
            <details v-else class="mobile-detail mobile-tool">
              <summary><span class="mobile-tool-name">{{ block.toolName }}</span><span class="mobile-muted">{{ block.execution ? phases[block.execution.phase] : '等待执行记录' }}</span></summary>
              <template v-if="block.execution">
                <div v-if="block.execution.argsText"><p class="mobile-detail-label">参数</p><pre class="scroll-area">{{ block.execution.argsText }}</pre></div>
                <div v-if="block.execution.diff?.lines.length"><p class="mobile-detail-label">变更 · {{ block.execution.diff.source === 'args' ? '根据参数推断' : '执行结果' }}</p><pre class="scroll-area">{{ block.execution.diff.lines.map(line => `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '} ${line.text}`).join('\n') }}</pre></div>
                <div v-if="block.execution.text"><p class="mobile-detail-label">结果</p><pre class="scroll-area">{{ block.execution.text }}</pre></div>
                <p v-if="block.execution.argsTruncated || block.execution.textTruncated" class="mobile-muted">内容已截断，可从这一轮原文继续读取。</p>
                <p v-if="block.ui" class="mobile-muted">此工具交付了生成式界面，请在桌面查看与操作。</p>
              </template>
            </details>
          </template>
          <p v-if="message.failure" role="status" class="mobile-error">{{ message.failure }}</p>
        </div>
        <div v-if="turn.historyId" class="mobile-turn-history">
          <button type="button" class="mobile-link-button" :aria-expanded="openTurns.has(turn.historyId)" @click="toggle(turn.historyId)">{{ openTurns.has(turn.historyId) ? '收起这一轮原文' : '查看这一轮原文' }}</button>
          <div v-if="openTurns.has(turn.historyId)">
            <p v-if="history.turns[turn.historyId]?.loading" role="status" class="mobile-muted">正在读取原文…</p>
            <p v-if="history.turns[turn.historyId]?.error" role="alert" class="mobile-error">{{ history.turns[turn.historyId]?.error }}<button type="button" class="mobile-link-button" @click="emit('turn', turn.historyId, false)">重试</button></p>
            <p v-if="turn.user?.turn != null && history.turns[turn.historyId]?.loaded" class="mobile-muted">正在查看这一轮的原文快照；收起后回到实时内容。</p>
            <button v-if="history.turns[turn.historyId]?.next" type="button" class="control-button" :disabled="history.turns[turn.historyId]?.loading" @click="emit('turn', turn.historyId, true)">继续加载这一轮</button>
            <div v-for="chunk in history.turns[turn.historyId]?.chunks ?? []" :key="historyChunkKey(chunk)" class="mobile-chunk-action">
              <button type="button" class="mobile-link-button" :disabled="history.turns[turn.historyId]?.loading" @click="emit('chunk', turn.historyId, chunk)">继续读取{{ chunkLabels[chunk.field] }}</button>
              <p v-if="history.turns[turn.historyId]?.chunkStates[historyChunkKey(chunk)]?.error" role="alert" class="mobile-error">{{ history.turns[turn.historyId]?.chunkStates[historyChunkKey(chunk)]?.error }}</p>
            </div>
          </div>
        </div>
      </article>
      <p v-if="truncated" class="mobile-muted mobile-history-action">当前展示经过裁剪；可加载更早对话或展开原文，完整记录保留在电脑。</p>
    </div>
    <button v-if="!follow" type="button" class="mobile-follow control-button" @click="follow = true; scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' })">回到最新消息</button>
  </main>
</template>
