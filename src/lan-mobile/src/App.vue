<!-- 手机对话外壳：通过 HTTPS 网页扫码配对后逐级进入项目与会话；不启动桌面 Store，不在重连时重放写操作。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { LAN_REMOTE_MAX_MESSAGE_CHARS } from '../../shared/lan-remote-api'
import { MAX_SESSION_WINDOW } from '../../shared/session-api'
import { useMobileSession } from './use-mobile-session'
import MobileMessageList from './components/MobileMessageList.vue'
import MobileInteractionPanel from './components/MobileInteractionPanel.vue'

const {
  connection, sync, projects, sessions, selectedProject, selectedSession, projection, status, interaction,
  loadingSessions, remainingSessions, sessionLimit, draft, error, notice, actionBusy, pendingWrite, pairBusy, pairCode, deviceName,
  history, messages, tools, canSend, isRunning, pair, recover, chooseProject, chooseSession, back, loadSessions,
  loadEarlier, loadTurn, loadChunk, setHistoryVisibility, sessionKey, send, stop, respond, retryWrite, acknowledgeUnknown, visitPending
} = useMobileSession()
const input = ref<HTMLTextAreaElement | null>(null)
const heading = ref<HTMLHeadingElement | null>(null)
watch([() => selectedProject.value?.id, () => selectedSession.value?.sessionId, () => connection.value === 'unpaired'], () => {
  void nextTick(() => heading.value?.focus({ preventScroll: true }))
})
const viewKey = computed(() => sessionKey())
const currentQuestion = computed(() => interaction.value?.state.dialogs[0] ?? null)
const title = computed(() => selectedSession.value ? '对话' : selectedProject.value?.name ?? '你的项目')
const connectionLabel = computed(() => connection.value === 'checking' ? '连接中'
  : connection.value === 'unpaired' ? '尚未配对' : connection.value === 'blocked' ? '需要更新'
    : connection.value === 'offline' ? '连接中断' : sync.value === 'synced' ? '已同步'
      : sync.value === 'retrying' || sync.value === 'connecting' ? '同步中' : sync.value === 'paused' ? '已暂停同步' : '已连接')
const runtimeLabel = computed(() => sync.value !== 'synced' ? '连接未同步，电脑上的任务状态待刷新'
  : isRunning.value ? 'Agent 正在运行' : currentQuestion.value ? '等待你的回应' : '可以继续对话')
function resizeInput(): void {
  const element = input.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, 160)}px`
}
watch(draft, () => { void nextTick(resizeInput) })
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
      <button v-if="selectedProject && connection !== 'unpaired'" type="button" class="mobile-back" :disabled="actionBusy" :aria-label="selectedSession ? '返回会话列表' : '返回项目列表'" @click="back"><span aria-hidden="true">‹</span>{{ selectedSession ? '会话' : '项目' }}</button>
      <div class="mobile-heading"><p class="mobile-eyebrow">PI DESK <span v-if="selectedSession">/ {{ selectedProject?.name }}</span></p><h1 ref="heading" tabindex="-1">{{ connection === 'unpaired' ? '连接电脑' : title }}</h1></div>
      <span class="mobile-connection" role="status">{{ connectionLabel }}</span>
    </header>
    <div v-if="error" class="mobile-banner scroll-area is-error" role="alert"><p>{{ error }}</p><button v-if="connection !== 'unpaired' && connection !== 'blocked'" type="button" class="mobile-link-button" :disabled="actionBusy" @click="recover">重新连接</button></div>
    <div v-if="notice" class="mobile-banner scroll-area" role="status">{{ notice }}</div>
    <div v-if="pendingWrite && !actionBusy" class="mobile-banner scroll-area is-warning">
      <p><strong>{{ pendingWrite.label }}结果未知。</strong>先查看原会话；重试只查询或重试原身份，不创建另一条操作。</p>
      <div class="mobile-actions"><button type="button" class="control-button" @click="retryWrite">重试原请求</button><button type="button" class="control-button" @click="visitPending">查看原会话</button></div>
      <details><summary class="mobile-link-button">我已核对电脑上的实际结果</summary><p>解除保护不会重新发送上一条操作。</p><button type="button" class="control-button" @click="acknowledgeUnknown">已核对结果，解除保护</button></details>
    </div>

    <main v-if="connection === 'unpaired'" class="mobile-page scroll-area">
      <section class="mobile-pair-panel">
        <p class="mobile-eyebrow">连接你的电脑 · 任务在电脑上执行</p>
        <h2>让对话留在手边</h2>
        <p class="mobile-muted">在电脑「设置 → 手机访问」中配置可信 HTTPS 入口，选择允许访问的项目并生成配对二维码，用手机扫码后确认连接。不要跳过浏览器的证书警告。</p>
        <form class="mobile-pair-form" :aria-busy="pairBusy" @submit.prevent="pair">
          <label for="mobile-device-name" class="field-label">设备名称</label>
          <input id="mobile-device-name" v-model="deviceName" class="text-control" maxlength="80" autocomplete="off" :disabled="pairBusy" />
          <label for="mobile-pair-code" class="field-label">一次性配对码</label>
          <input id="mobile-pair-code" v-model="pairCode" class="text-control" autocomplete="off" autocapitalize="off" spellcheck="false" :disabled="pairBusy" placeholder="扫码后自动填入，也可从配对链接复制 code 后的值" />
          <p class="mobile-muted">配对链接包含一次性凭证，请勿转发给他人。页面不会读取或保存电脑的模型密钥。</p>
          <button type="submit" class="control-button-primary" :disabled="pairBusy || !deviceName.trim() || !/^[A-Za-z0-9_-]{43}$/.test(pairCode.trim())">{{ pairBusy ? '正在配对…' : '连接这台电脑' }}</button>
          <button type="button" class="mobile-link-button" :disabled="pairBusy" @click="recover">此浏览器已配对，直接连接</button>
        </form>
      </section>
    </main>
    <main v-else-if="connection === 'blocked'" class="mobile-page scroll-area"><h2>需要更新连接页面</h2><p class="mobile-muted">请刷新手机页面；若桌面版本不匹配，请先更新桌面应用。</p><button type="button" class="control-button" @click="recover">重新检查连接</button></main>
    <main v-else-if="!selectedSession" class="mobile-page scroll-area" :aria-busy="loadingSessions || connection === 'checking'">
      <template v-if="!selectedProject">
        <p class="mobile-section-intro">选择一个电脑上已授权的项目。</p>
        <p class="mobile-muted">电脑需保持开机，Pi Desk 与手机访问入口需保持开启。</p>
        <button v-for="project in projects" :key="project.id" type="button" class="mobile-list-row" :disabled="actionBusy" @click="chooseProject(project)"><span><strong>{{ project.name }}</strong><small>查看会话</small></span><span aria-hidden="true">›</span></button>
        <div v-if="!projects.length" class="mobile-empty"><p>{{ connection === 'checking' ? '正在连接电脑…' : '当前设备没有可访问的项目。' }}</p><p class="mobile-muted">可在电脑的「手机访问」设置中调整项目授权。</p></div>
        <button type="button" class="control-button" :disabled="actionBusy || connection === 'checking'" @click="recover">刷新项目</button>
      </template>
      <template v-else>
        <div class="mobile-list-heading"><p class="mobile-section-intro">选择要继续的会话</p><button type="button" class="mobile-link-button" :disabled="loadingSessions" @click="loadSessions(false)">刷新</button></div>
        <button v-for="session in sessions" :key="session.sessionId" type="button" class="mobile-list-row" :disabled="actionBusy" @click="chooseSession(session)"><span><strong>{{ session.preview || '未命名会话' }}</strong><small>{{ new Date(session.updatedAt).toLocaleString() }}</small></span><span aria-hidden="true">›</span></button>
        <p v-if="!sessions.length" class="mobile-empty">{{ loadingSessions ? '正在读取会话…' : '该项目暂无可继续的会话，请先在电脑开始一次对话。' }}</p>
        <button v-if="remainingSessions > 0 && sessionLimit < MAX_SESSION_WINDOW" type="button" class="control-button" :disabled="loadingSessions" @click="loadSessions(true)">加载更多会话</button>
      </template>
    </main>
    <template v-else>
      <MobileMessageList :key="viewKey" :messages="messages" :tools="tools" :history="history" :session-key="viewKey" :syncing="sync !== 'synced'" :truncated="projection?.truncated ?? false" @earlier="loadEarlier" @turn="loadTurn" @chunk="loadChunk" @visibility="setHistoryVisibility" />
      <MobileInteractionPanel v-if="currentQuestion" :key="`${viewKey}-${status?.runId}-${status?.runtimeId}-${currentQuestion.id}`" :dialog="currentQuestion" :busy="actionBusy" :blocked="sync !== 'synced' || pendingWrite !== null" @respond="respond" />
      <footer class="mobile-composer-area">
        <p class="mobile-runtime-status" role="status">{{ runtimeLabel }}<span v-if="status?.info?.modelId"> · {{ status.info.modelId }}</span></p>
        <form class="mobile-composer" @submit.prevent="send">
          <label for="mobile-prompt" class="mobile-sr-only">发送到当前会话的消息</label>
          <textarea id="mobile-prompt" ref="input" v-model="draft" class="scroll-area" rows="2" :maxlength="LAN_REMOTE_MAX_MESSAGE_CHARS" placeholder="继续这段对话…" :disabled="actionBusy" @input="resizeInput" @keydown.ctrl.enter.prevent="send" />
          <div class="mobile-composer-actions"><span class="mobile-muted">{{ draft.length }}/{{ LAN_REMOTE_MAX_MESSAGE_CHARS }}</span><div class="mobile-actions"><button v-if="isRunning" type="button" class="control-button" :disabled="actionBusy || pendingWrite !== null || sync !== 'synced'" @click="stop">停止生成</button><button type="submit" class="control-button-primary" :disabled="!canSend">{{ actionBusy ? '提交中…' : '发送' }}</button></div></div>
        </form>
      </footer>
    </template>
  </div>
</template>
