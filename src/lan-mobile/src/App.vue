<!-- 手机对话外壳：扫码、会话选择与后台新建，输入坞提供斜杠候选及界面命令；不启动桌面 Store，不在重连时重放写操作。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { LAN_REMOTE_MAX_MESSAGE_CHARS } from '../../shared/lan-remote-api'
import { MAX_SESSION_WINDOW } from '../../shared/session-api'
import type { LanCommandEntry } from '../../shared/lan-remote-api'
import { useMobileSession } from './use-mobile-session'
import MobileMessageList from './components/MobileMessageList.vue'
import MobileInteractionPanel from './components/MobileInteractionPanel.vue'

const {
  connection, sync, projects, sessions, selectedProject, selectedSession, projection, status, interaction,
  loadingSessions, remainingSessions, sessionLimit, draft, error, notice, actionBusy, pendingWrite, pairBusy,
  newSessionDraft, canCreateSession, startNewSession, commands, commandsLoading, commandsError, commandsTruncated, loadCommands,
  history, messages, tools, canSend, isRunning, recover, chooseProject, chooseSession, back, loadSessions,
  loadEarlier, loadTurn, loadChunk, setHistoryVisibility, sessionKey, send, stop, respond, retryWrite, acknowledgeUnknown, visitPending
} = useMobileSession()
const input = ref<HTMLTextAreaElement | null>(null)
const heading = ref<HTMLHeadingElement | null>(null)
watch([() => selectedProject.value?.id, () => selectedSession.value?.sessionId, newSessionDraft, () => connection.value === 'unpaired'], () => {
  void nextTick(() => heading.value?.focus({ preventScroll: true }))
})
const viewKey = computed(() => sessionKey())
const currentQuestion = computed(() => interaction.value?.state.dialogs[0] ?? null)
const title = computed(() => newSessionDraft.value ? '新对话' : selectedSession.value ? '对话' : selectedProject.value?.name ?? '你的项目')
const connectionLabel = computed(() => connection.value === 'checking' || pairBusy.value ? '连接中'
  : connection.value === 'unpaired' ? '未连接' : connection.value === 'blocked' ? '需要更新'
    : connection.value === 'offline' ? '连接中断' : sync.value === 'synced' ? '已同步'
      : sync.value === 'retrying' || sync.value === 'connecting' ? '同步中' : sync.value === 'paused' ? '已暂停同步' : '已连接')
const runtimeLabel = computed(() => newSessionDraft.value ? (actionBusy.value ? '正在创建会话并提交首条消息…' : '发送第一条消息后开始新会话')
  : sync.value !== 'synced' ? '连接未同步，电脑上的任务状态待刷新'
  : pendingWrite.value?.request.command.operation === 'compact' || status.value?.info?.isCompacting ? '正在压缩上下文'
    : isRunning.value ? 'Agent 正在运行' : currentQuestion.value ? '等待你的回应' : '可以继续对话')
function resizeInput(): void {
  const element = input.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, 160)}px`
}
watch(draft, () => { void nextTick(resizeInput) })

type MobileSuggestion = LanCommandEntry | { readonly kind: 'local'; readonly name: string; readonly description: string }
const localCommands: readonly MobileSuggestion[] = [
  { kind: 'local', name: 'new', description: '进入新对话，保留原会话和电脑上的任务' },
  { kind: 'local', name: 'compact', description: '压缩当前会话上下文，可追加摘要说明' }
]
const commandKinds = { local: '界面命令', skill: '技能', prompt: '模板', extension: '扩展命令' }
const commandOrder: readonly MobileSuggestion['kind'][] = ['local', 'skill', 'prompt', 'extension']
const slashQuery = computed(() => draft.value.startsWith('/') && !/\s/.test(draft.value) ? draft.value.slice(1).toLowerCase() : null)
const commandsDismissed = ref(false)
const commandIndex = ref(0)
const commandMenu = ref<HTMLElement | null>(null)

/** 与桌面一致地优先名称匹配，再匹配非连续字符和描述；skill: 查询不混入其他类型。 */
function commandRank(entry: MobileSuggestion, query: string): number | null {
  const skillOnly = query.startsWith('skill:')
  if (skillOnly && entry.kind !== 'skill') return null
  const needle = skillOnly ? query.slice('skill:'.length) : query
  if (needle === '') return 0
  const name = entry.name.toLowerCase()
  const names = entry.kind === 'skill' && name.startsWith('skill:') ? [name.slice('skill:'.length), name] : [name]
  if (names.some(value => value === needle)) return 0
  if (names.some(value => value.startsWith(needle))) return 1
  if (names.some(value => value.includes(needle))) return 2
  for (const value of names) {
    let position = 0
    let matched = true
    for (const character of needle) {
      const found = value.indexOf(character, position)
      if (found < 0) { matched = false; break }
      position = found + character.length
    }
    if (matched) return 3
  }
  return entry.description?.toLowerCase().includes(needle) ? 4 : null
}
const commandSuggestions = computed<readonly MobileSuggestion[]>(() => {
  const query = slashQuery.value
  if (query === null) return []
  const resources = connection.value === 'connected' && (newSessionDraft.value || sync.value === 'synced') ? commands.value : []
  const entries = [...localCommands, ...resources.filter(entry => entry.name !== 'new' && entry.name !== 'compact')]
  return commandOrder.flatMap(kind => entries.filter(entry => entry.kind === kind).flatMap(entry => {
    const rank = commandRank(entry, query)
    return rank === null ? [] : [{ entry, rank }]
  }).sort((left, right) => left.rank - right.rank).slice(0, 8).map(item => item.entry))
})
const showCommandMenu = computed(() => slashQuery.value !== null && !commandsDismissed.value && !actionBusy.value
  && (newSessionDraft.value || selectedSession.value !== null))
watch(slashQuery, () => { commandsDismissed.value = false; commandIndex.value = 0 })
watch(commandSuggestions, () => { commandIndex.value = 0 })
watch([slashQuery, viewKey, sync, connection, () => status.value?.runtimeId], () => {
  if (slashQuery.value !== null) void loadCommands()
})

/** 接受候选只填充命令，不直接执行；保留尾随空格供追加参数。 */
function acceptCommand(entry: MobileSuggestion | undefined): void {
  if (!entry) return
  const name = entry.kind === 'skill' && !entry.name.startsWith('skill:') ? `skill:${entry.name}` : entry.name
  draft.value = `/${name} `; commandsDismissed.value = true
  void nextTick(() => { input.value?.focus(); input.value?.setSelectionRange(draft.value.length, draft.value.length); resizeInput() })
}
function onPromptKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  if (showCommandMenu.value) {
    if (event.key === 'Escape') { event.preventDefault(); commandsDismissed.value = true; return }
    if (commandSuggestions.value.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const count = commandSuggestions.value.length
      commandIndex.value = (commandIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
      void nextTick(() => commandMenu.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
      return
    }
    if (event.key === 'Tab' && commandSuggestions.value.length > 0) {
      event.preventDefault(); acceptCommand(commandSuggestions.value[commandIndex.value]); return
    }
  }
  // 手机回车仍用于换行，外接键盘的 Ctrl+Enter 才提交。
  if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); void send() }
}
function fitViewport(): void {
  document.documentElement.style.setProperty('--mobile-height', `${window.visualViewport?.height ?? window.innerHeight}px`)
}
onMounted(() => {
  fitViewport(); window.visualViewport?.addEventListener('resize', fitViewport); window.addEventListener('resize', fitViewport)
})
onBeforeUnmount(() => {
  window.visualViewport?.removeEventListener('resize', fitViewport); window.removeEventListener('resize', fitViewport)
  document.documentElement.style.removeProperty('--mobile-height')
})
</script>

<template>
  <div class="mobile-app">
    <header class="mobile-topbar">
      <button v-if="selectedProject && connection !== 'unpaired'" type="button" class="mobile-back" :disabled="actionBusy" :aria-label="selectedSession || newSessionDraft ? '返回会话列表' : '返回项目列表'" @click="back"><span aria-hidden="true">‹</span>{{ selectedSession || newSessionDraft ? '会话' : '项目' }}</button>
      <div class="mobile-heading"><p class="mobile-eyebrow">PI DESK <span v-if="selectedSession || newSessionDraft">/ {{ selectedProject?.name }}</span></p><h1 ref="heading" tabindex="-1">{{ connection === 'unpaired' ? '连接电脑' : title }}</h1></div>
      <span class="mobile-connection" role="status">{{ connectionLabel }}</span>
    </header>
    <div v-if="error" class="mobile-banner scroll-area is-error" role="alert"><p>{{ error }}</p><button v-if="connection !== 'unpaired' && connection !== 'blocked'" type="button" class="mobile-link-button" :disabled="actionBusy" @click="recover">重新连接</button></div>
    <div v-if="notice" class="mobile-banner scroll-area" role="status">{{ notice }}</div>
    <div v-if="pendingWrite && !actionBusy" class="mobile-banner scroll-area is-warning">
      <p><strong>{{ pendingWrite.label }}结果未知。</strong>{{ pendingWrite.session ? '先查看原会话' : '先查看原项目的会话列表' }}；重试只查询或重试原身份，不创建另一条操作。</p>
      <div class="mobile-actions"><button type="button" class="control-button" @click="retryWrite">重试原请求</button><button type="button" class="control-button" @click="visitPending">{{ pendingWrite.session ? '查看原会话' : '查看原项目' }}</button></div>
      <details><summary class="mobile-link-button">我已核对电脑上的实际结果</summary><p>解除保护不会重新发送上一条操作。</p><button type="button" class="control-button" @click="acknowledgeUnknown">已核对结果，解除保护</button></details>
    </div>

    <main v-if="connection === 'checking' || pairBusy" class="mobile-page mobile-connect-page" aria-busy="true">
      <section class="mobile-connect-panel" role="status">
        <h2>正在连接电脑…</h2>
        <p class="mobile-muted">连接后自动进入项目页面，无需其他操作。</p>
      </section>
    </main>
    <main v-else-if="connection === 'unpaired'" class="mobile-page scroll-area mobile-connect-page">
      <section class="mobile-connect-panel">
        <h2>扫描电脑上的二维码</h2>
        <p class="mobile-muted">在电脑「设置 → 手机访问」中开启访问，手机与电脑连接同一 Wi-Fi 后扫码即可进入。</p>
      </section>
    </main>
    <main v-else-if="connection === 'blocked'" class="mobile-page scroll-area"><h2>需要更新连接页面</h2><p class="mobile-muted">请刷新手机页面；若桌面版本不匹配，请先更新桌面应用。</p><button type="button" class="control-button" @click="recover">重新检查连接</button></main>
    <main v-else-if="!selectedSession && !newSessionDraft" class="mobile-page scroll-area" :aria-busy="loadingSessions">
      <template v-if="!selectedProject">
        <p class="mobile-section-intro">选择要继续的项目。</p>
        <p class="mobile-muted">电脑需保持开机，Pi Desk 与手机访问入口需保持开启。</p>
        <button v-for="project in projects" :key="project.id" type="button" class="mobile-list-row" :disabled="actionBusy" @click="chooseProject(project)"><span><strong>{{ project.name }}</strong><small>查看会话</small></span><span aria-hidden="true">›</span></button>
        <div v-if="!projects.length" class="mobile-empty"><p>{{ connection === 'connected' ? '电脑上还没有项目。' : '等待连接电脑后读取项目。' }}</p><p v-if="connection === 'connected'" class="mobile-muted">先在电脑添加项目，再刷新此页面。</p></div>
        <button type="button" class="control-button" :disabled="actionBusy" @click="recover">刷新项目</button>
      </template>
      <template v-else>
        <div class="mobile-list-heading"><p class="mobile-section-intro">选择会话，或开始新的对话</p><button type="button" class="mobile-link-button" :disabled="loadingSessions || actionBusy" @click="loadSessions(false)">刷新</button></div>
        <button type="button" class="control-button-primary mb-4 w-full" :disabled="!canCreateSession" @click="startNewSession">新建会话</button>
        <button v-for="session in sessions" :key="session.sessionId" type="button" class="mobile-list-row" :disabled="actionBusy" @click="chooseSession(session)"><span><strong>{{ session.preview || '未命名会话' }}</strong><small>{{ new Date(session.updatedAt).toLocaleString() }}</small></span><span aria-hidden="true">›</span></button>
        <p v-if="!sessions.length" class="mobile-empty">{{ loadingSessions ? '正在读取会话…' : '该项目还没有会话，点击“新建会话”开始对话。' }}</p>
        <button v-if="remainingSessions > 0 && sessionLimit < MAX_SESSION_WINDOW" type="button" class="control-button" :disabled="loadingSessions" @click="loadSessions(true)">加载更多会话</button>
      </template>
    </main>
    <template v-else>
      <main v-if="newSessionDraft" class="mobile-page scroll-area" :aria-busy="actionBusy">
        <div class="mobile-empty"><h2>新对话</h2><p>在下方输入第一条消息开始对话。会话在电脑后台执行，不切换电脑上正在查看的对话。</p></div>
      </main>
      <MobileMessageList v-else :key="viewKey" :messages="messages" :tools="tools" :history="history" :session-key="viewKey" :syncing="sync !== 'synced'" :truncated="projection?.truncated ?? false" @earlier="loadEarlier" @turn="loadTurn" @chunk="loadChunk" @visibility="setHistoryVisibility" />
      <MobileInteractionPanel v-if="currentQuestion" :key="`${viewKey}-${status?.runId}-${status?.runtimeId}-${currentQuestion.id}`" :dialog="currentQuestion" :busy="actionBusy" :blocked="sync !== 'synced' || pendingWrite !== null" @respond="respond" />
      <footer class="mobile-composer-area">
        <div v-if="showCommandMenu" ref="commandMenu" class="mobile-command-menu scroll-area">
          <div class="mobile-command-heading"><span>命令</span><button type="button" class="mobile-link-button" :disabled="commandsLoading || connection !== 'connected'" @click="loadCommands(true)">刷新候选</button></div>
          <p v-if="commandsLoading" class="mobile-command-note" role="status">正在读取命令候选…</p>
          <p v-if="commandsError" class="mobile-command-note mobile-error" role="alert">{{ commandsError }}</p>
          <p v-if="newSessionDraft" class="mobile-command-note">新对话先预读技能；模板和扩展命令在会话建立后提供。</p>
          <p v-if="commandsTruncated" class="mobile-command-note">部分资源未列出，可输入完整命令。</p>
          <div id="mobile-command-list" role="listbox" aria-label="命令候选">
            <button v-for="(entry, index) in commandSuggestions" :id="`mobile-command-${index}`" :key="`${entry.kind}:${entry.name}`" type="button" role="option" :aria-selected="index === commandIndex" class="mobile-command-option" @mousedown.prevent @click="acceptCommand(entry)">
              <span><strong>/{{ entry.name }}</strong><small v-if="entry.description">{{ entry.description }}</small></span><span class="mobile-command-kind">{{ commandKinds[entry.kind] }}</span>
            </button>
          </div>
          <p v-if="!commandsLoading && commandSuggestions.length === 0" class="mobile-command-note">没有匹配的命令。</p>
        </div>
        <p class="mobile-runtime-status" role="status">
          <span class="mobile-runtime-label">{{ runtimeLabel }}</span>
          <span v-if="status?.info?.modelId" class="mobile-runtime-model"> · {{ status.info.modelId }}</span>
        </p>
        <form class="mobile-composer" @submit.prevent="send">
          <label for="mobile-prompt" class="mobile-sr-only">发送到当前会话的消息</label>
          <textarea id="mobile-prompt" ref="input" v-model="draft" class="mobile-composer-input scroll-area" rows="2" :maxlength="LAN_REMOTE_MAX_MESSAGE_CHARS" :placeholder="newSessionDraft ? '输入第一条消息…' : '继续这段对话…'" :disabled="actionBusy" aria-autocomplete="list" :aria-expanded="showCommandMenu" :aria-controls="showCommandMenu ? 'mobile-command-list' : undefined" :aria-activedescendant="showCommandMenu && commandSuggestions.length ? `mobile-command-${commandIndex}` : undefined" @input="resizeInput" @keydown="onPromptKeydown" />
          <div class="mobile-composer-actions">
            <span class="mobile-muted mobile-composer-count">{{ draft.length }}/{{ LAN_REMOTE_MAX_MESSAGE_CHARS }}</span>
            <div class="mobile-actions mobile-composer-buttons">
              <button v-if="isRunning" type="button" class="control-button mobile-composer-stop" :disabled="actionBusy || pendingWrite !== null || sync !== 'synced'" @click="stop">停止生成</button>
              <button type="submit" class="control-button-primary mobile-composer-send" :disabled="!canSend">{{ actionBusy ? '提交中…' : '发送' }}</button>
            </div>
          </div>
        </form>
      </footer>
    </template>
  </div>
</template>
