<!-- 展示桌面连接与 Runtime 状态；项目目录只在本页输入，不持久化。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useDesktopStore } from './stores/desktop'
import { useRuntimeStore } from './stores/runtime'

const desktopStore = useDesktopStore()
const runtimeStore = useRuntimeStore()
const { connection } = storeToRefs(desktopStore)
const { view: runtimeView } = storeToRefs(runtimeStore)
const projectPath = ref('')
const prompt = ref('')
const connectionLabel = computed(() => {
  switch (connection.value.status) {
    case 'idle': return '尚未连接'
    case 'loading': return '正在连接'
    case 'ready': return '桌面桥接已连接'
    case 'error': return '桌面桥接连接失败'
  }
})
const runtimeLabel = computed(() => {
  switch (runtimeView.value.phase) {
    case 'idle': return 'Runtime 未启动'
    case 'starting': return '正在启动 Runtime'
    case 'ready': return 'Runtime 已就绪'
    case 'stopping': return '正在关闭 Runtime'
    case 'closed': return 'Runtime 已关闭'
    case 'failed': return 'Runtime 异常退出'
  }
})
const runtimeStarting = computed(() => runtimeView.value.phase === 'starting')
const runtimeReady = computed(() => runtimeView.value.phase === 'ready')
const runtimeStopping = computed(() => runtimeView.value.phase === 'stopping')
const runtimeClosed = computed(() => runtimeView.value.phase === 'closed')
const runtimeInfo = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const runtimeError = computed(() => (
  runtimeView.value.phase === 'failed' ? runtimeView.value.error : null
))

function launchRuntime(): void {
  void runtimeStore.launch(projectPath.value)
}

function shutdownRuntime(): void {
  void runtimeStore.shutdown()
}

onMounted(() => {
  void desktopStore.initialize()
  void runtimeStore.initialize()
})

onUnmounted(() => {
  runtimeStore.dispose()
})
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8 sm:px-10">
    <header class="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div>
        <p class="mb-1 font-mono text-xs tracking-wide text-desk-muted">Pi Desktop</p>
        <h1 class="text-3xl font-semibold tracking-tight">Runtime</h1>
      </div>
      <span class="rounded-md border border-desk-line bg-desk-surface px-3 py-2 text-sm">
        {{ runtimeLabel }}
      </span>
    </header>

    <p id="runtime-notice" class="mb-6 border-l-2 border-desk-accent pl-3 text-sm text-desk-muted">
      当前只有桌面页面、只读应用信息接口与 Runtime 启停。不会发送 Prompt、不读取消息、不持久化项目。
    </p>

    <section
      class="panel mb-6"
      aria-labelledby="desktop-heading"
      :aria-busy="connection.status === 'loading'"
    >
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="desktop-heading" class="section-heading">桌面连接</h2>
        <p role="status" class="text-sm text-desk-accent">{{ connectionLabel }}</p>
      </div>
      <dl v-if="connection.status === 'ready'" class="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt class="mb-1 text-desk-muted">应用版本</dt>
          <dd class="font-mono">{{ connection.info.appVersion }}</dd>
        </div>
        <div>
          <dt class="mb-1 text-desk-muted">Electron</dt>
          <dd class="font-mono">{{ connection.info.electronVersion }}</dd>
        </div>
        <div>
          <dt class="mb-1 text-desk-muted">平台</dt>
          <dd class="font-mono">{{ connection.info.platform }}</dd>
        </div>
        <div>
          <dt class="mb-1 text-desk-muted">架构</dt>
          <dd class="font-mono">{{ connection.info.arch }}</dd>
        </div>
      </dl>
      <div v-else-if="connection.status === 'error'" class="flex flex-wrap items-center gap-3">
        <p role="alert" class="text-sm">{{ connection.error.message }}</p>
        <button type="button" class="control-button" @click="desktopStore.initialize()">
          重试连接
        </button>
      </div>
      <p v-else class="text-sm text-desk-muted">正在获取此桌面应用的版本与平台信息。</p>
    </section>

    <section class="panel mb-6" aria-labelledby="runtime-heading" :aria-busy="runtimeStarting">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="runtime-heading" class="section-heading">Runtime</h2>
        <p role="status" class="text-sm text-desk-accent">{{ runtimeLabel }}</p>
      </div>
      <dl v-if="runtimeInfo" class="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt class="mb-1 text-desk-muted">模型</dt>
          <dd class="font-mono">{{ runtimeInfo.model ?? '未提供' }}</dd>
        </div>
        <div>
          <dt class="mb-1 text-desk-muted">Thinking</dt>
          <dd class="font-mono">{{ runtimeInfo.thinkingLevel ?? '未设置' }}</dd>
        </div>
        <div>
          <dt class="mb-1 text-desk-muted">Session</dt>
          <dd class="font-mono">{{ runtimeInfo.sessionId ?? '未提供' }}</dd>
        </div>
        <div>
          <dt class="mb-1 text-desk-muted">消息数</dt>
          <dd class="font-mono">{{ runtimeInfo.messageCount }}</dd>
        </div>
      </dl>
      <p v-else-if="runtimeError" role="alert" class="text-sm">
        {{ runtimeError.message }}
        <span class="mt-1 block text-desk-muted">Runtime 异常退出后不会自动重启或重放请求。</span>
      </p>
      <p v-else-if="runtimeStopping" class="text-sm text-desk-muted">正在关闭 Pi 并等待进程退出。</p>
      <p v-else-if="runtimeClosed" class="text-sm text-desk-muted">Runtime 已正常关闭，可以重新启动。</p>
      <p v-else-if="runtimeStarting" class="text-sm text-desk-muted">正在启动 Pi 并等待 get_state 响应。</p>
      <p v-else class="text-sm text-desk-muted">填写项目目录后启动 Runtime；发送 Prompt 在后续阶段接入。</p>
    </section>

    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
      <div class="space-y-6">
        <section class="panel" aria-labelledby="project-heading">
          <h2 id="project-heading" class="section-heading mb-4">项目</h2>
          <label for="project-path" class="mb-2 block text-sm font-medium">项目目录</label>
          <input
            id="project-path"
            v-model="projectPath"
            type="text"
            class="text-control font-mono"
            placeholder="输入项目的绝对路径"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="runtime-notice project-note"
          />
          <p id="project-note" class="mt-2 text-xs text-desk-muted">作为 Pi 的工作目录，主进程会校验是否为绝对目录；不持久化。</p>
          <div class="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              class="control-button"
              :disabled="runtimeStarting || runtimeReady || runtimeStopping || projectPath.trim() === ''"
              @click="launchRuntime"
            >
              启动 Runtime
            </button>
            <button
              type="button"
              class="control-button"
              :disabled="!runtimeReady"
              @click="shutdownRuntime"
            >
              关闭 Runtime
            </button>
          </div>
        </section>

        <section class="panel" aria-labelledby="prompt-heading">
          <h2 id="prompt-heading" class="section-heading mb-4">Prompt</h2>
          <label for="prompt-input" class="mb-2 block text-sm font-medium">输入内容</label>
          <textarea
            id="prompt-input"
            v-model="prompt"
            rows="6"
            class="text-control resize-y"
            placeholder="发送 Prompt 在后续阶段接入。"
            aria-describedby="runtime-notice"
          ></textarea>
          <div class="mt-4 flex flex-wrap gap-2">
            <button type="button" class="control-button" disabled aria-describedby="runtime-notice">发送</button>
            <button type="button" class="control-button" disabled aria-describedby="runtime-notice">Stop</button>
          </div>
        </section>
      </div>

      <div class="space-y-6">
        <section class="panel" aria-labelledby="output-heading">
          <h2 id="output-heading" class="section-heading mb-4">输出</h2>
          <div class="empty-output mb-4">
            <h3 class="mb-2 text-sm font-medium">文本</h3>
            <p class="text-sm text-desk-muted">尚无消息。</p>
          </div>
          <div class="empty-output">
            <h3 class="mb-2 text-sm font-medium">Thinking</h3>
            <p class="text-sm text-desk-muted">尚无 Thinking 内容。</p>
          </div>
        </section>

        <section class="panel" aria-labelledby="tools-heading">
          <h2 id="tools-heading" class="section-heading mb-3">工具</h2>
          <p class="text-sm text-desk-muted">尚无工具执行记录。</p>
        </section>

        <section class="panel" aria-labelledby="diagnostics-heading">
          <h2 id="diagnostics-heading" class="section-heading mb-3">诊断</h2>
          <p class="text-sm text-desk-muted">尚无 Runtime 诊断输出。</p>
        </section>
      </div>
    </div>
  </main>
</template>
