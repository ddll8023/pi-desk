<!-- 展示桌面连接、Runtime 状态、消息投影与工具执行，并提交 Prompt、中止当前操作；输入内容只在本页使用，不持久化。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { ProjectionBlockKind, ToolExecutionPhase } from '../../shared/runtime-api'
import { useDesktopStore } from './stores/desktop'
import { useRuntimeStore } from './stores/runtime'

/** 工具状态只做文案映射，不推断工具是否真的成功结束。 */
const TOOL_PHASE_LABELS: Readonly<Record<ToolExecutionPhase, string>> = {
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  unknown: '未确认结束'
}

const desktopStore = useDesktopStore()
const runtimeStore = useRuntimeStore()
const { connection } = storeToRefs(desktopStore)
const {
  view: runtimeView,
  promptView,
  abortView,
  messages,
  tools,
  projectionSync,
  projectionTruncated,
  droppedMessages,
  droppedTools
} = storeToRefs(runtimeStore)
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
const promptSending = computed(() => promptView.value.phase === 'sending')
const promptError = computed(() => (
  promptView.value.phase === 'error' ? promptView.value.error : null
))
const promptResult = computed(() => {
  const current = promptView.value
  if (current.phase === 'sending') return '正在提交 Prompt，等待 Pi 回应。'
  if (current.phase !== 'accepted') return null
  if (current.disposition === 'started') return 'Pi 已接受并开始执行，本轮内容会显示在输出区域。'
  if (current.disposition === 'queued') return 'Pi 已将本次输入排队。'
  return '本次输入已被处理，未发起新的 Agent run。'
})
const projectionSyncing = computed(() => projectionSync.value !== 'synced')
const runtimeStreaming = computed(() => runtimeInfo.value?.isStreaming === true)
const abortPending = computed(() => abortView.value.phase === 'requesting' && runtimeStreaming.value)
const abortError = computed(() => (abortView.value.phase === 'error' ? abortView.value.error : null))
const textBlocks = computed(() => collectBlocks('text'))
const thinkingBlocks = computed(() => collectBlocks('thinking'))
/** 工具面板只展示投影已给字段，不推断耗时或成功与否。 */
const toolExecutions = computed(() => tools.value.map((tool) => ({
  key: tool.toolCallId,
  name: tool.toolName === '' ? '未知工具' : tool.toolName,
  phaseLabel: TOOL_PHASE_LABELS[tool.phase],
  isError: tool.phase === 'failed',
  argsText: tool.argsText,
  argsTruncated: tool.argsTruncated,
  text: tool.text,
  textLabel: tool.textKind === 'partial' ? '部分输出' : '结果',
  textTruncated: tool.textTruncated,
  nonTextBlocks: tool.nonTextBlocks
})))
const messageError = computed(() => {
  const failed = messages.value.find((message) => (
    message.errorMessage !== null || message.stopReason === 'error' || message.stopReason === 'aborted'
  ))
  if (failed === undefined) return null
  return failed.errorMessage ?? `Agent 响应以 ${failed.stopReason} 结束。`
})

/** 按内容块收集展示项；工具调用块与空块不在本阶段展示。 */
function collectBlocks(
  kind: ProjectionBlockKind
): { key: string; role: string; text: string; truncated: boolean }[] {
  const collected: { key: string; role: string; text: string; truncated: boolean }[] = []
  for (const message of messages.value) {
    for (const block of message.blocks) {
      if (block.kind !== kind || block.text === '') continue
      collected.push({
        key: `${message.id}-${block.contentIndex}`,
        role: message.role === 'user' ? '你' : 'Assistant',
        text: block.text,
        truncated: block.truncated
      })
    }
  }
  return collected
}

function launchRuntime(): void {
  void runtimeStore.launch(projectPath.value)
}

function shutdownRuntime(): void {
  void runtimeStore.shutdown()
}

function submitPrompt(): void {
  void runtimeStore.send(prompt.value)
}

function stopOperation(): void {
  void runtimeStore.stopOperation()
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
      当前可以启停 Runtime、提交 Prompt，查看本轮文本、Thinking 与工具执行，并停止当前操作。消息只在本页展示、不持久化，Runtime 诊断仍在后续任务接入。
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
      <p v-else class="text-sm text-desk-muted">填写项目目录后启动 Runtime，再提交 Prompt。</p>
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
            placeholder="输入要发送给 Pi 的内容"
            aria-describedby="runtime-notice prompt-status"
          ></textarea>
          <p v-if="promptError" id="prompt-status" role="alert" class="mt-2 text-xs">
            {{ promptError.message }}
          </p>
          <p v-else id="prompt-status" class="mt-2 text-xs text-desk-muted">
            {{ promptResult ?? '提交结果会显示在这里。' }}
          </p>
          <div class="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              class="control-button"
              :disabled="!runtimeReady || prompt.trim() === '' || promptSending || projectionSyncing || runtimeStreaming"
              aria-describedby="prompt-status"
              @click="submitPrompt"
            >
              发送
            </button>
            <button
              type="button"
              class="control-button"
              :disabled="!runtimeReady || !runtimeStreaming || abortPending"
              aria-describedby="stop-status"
              @click="stopOperation"
            >
              Stop
            </button>
          </div>
          <p v-if="abortError" id="stop-status" role="alert" class="mt-2 text-xs">
            {{ abortError.message }}
          </p>
          <p v-else-if="abortPending" id="stop-status" role="status" class="mt-2 text-xs text-desk-muted">
            正在停止当前操作，等待本轮结束。
          </p>
          <p v-else id="stop-status" class="mt-2 text-xs text-desk-muted">
            {{ runtimeStreaming ? 'Agent 正在运行；停止后仍保留 Runtime。' : 'Stop 在 Agent 运行期间可用。' }}
          </p>
        </section>
      </div>

      <div class="space-y-6">
        <section class="panel" aria-labelledby="output-heading">
          <h2 id="output-heading" class="section-heading mb-4">输出</h2>
          <p v-if="projectionSyncing" role="status" class="mb-3 text-sm text-desk-muted">
            正在与主进程同步消息，暂不显示增量内容。
          </p>
          <p v-else-if="projectionTruncated" role="status" class="mb-3 text-sm text-desk-muted">
            投影已截断：省略较早消息 {{ droppedMessages }} 条，超长内容已标记截断。
          </p>
          <p v-if="messageError" role="alert" class="mb-3 text-sm">{{ messageError }}</p>
          <div class="empty-output mb-4">
            <h3 class="mb-2 text-sm font-medium">文本</h3>
            <p v-if="textBlocks.length === 0" class="text-sm text-desk-muted">尚无消息。</p>
            <div v-else class="space-y-3">
              <div v-for="block in textBlocks" :key="block.key">
                <p class="mb-1 text-xs text-desk-muted">{{ block.role }}</p>
                <p class="whitespace-pre-wrap break-words text-sm">{{ block.text }}</p>
                <p v-if="block.truncated" class="mt-1 text-xs text-desk-muted">此内容超出展示上限，已截断。</p>
              </div>
            </div>
          </div>
          <div class="empty-output">
            <h3 class="mb-2 text-sm font-medium">Thinking</h3>
            <p v-if="thinkingBlocks.length === 0" class="text-sm text-desk-muted">尚无 Thinking 内容。</p>
            <div v-else class="space-y-3">
              <div v-for="block in thinkingBlocks" :key="block.key">
                <p class="mb-1 text-xs text-desk-muted">{{ block.role }}</p>
                <p class="whitespace-pre-wrap break-words text-sm">{{ block.text }}</p>
                <p v-if="block.truncated" class="mt-1 text-xs text-desk-muted">此内容超出展示上限，已截断。</p>
              </div>
            </div>
          </div>
        </section>

        <section class="panel" aria-labelledby="tools-heading">
          <h2 id="tools-heading" class="section-heading mb-3">工具</h2>
          <p v-if="droppedTools > 0" role="status" class="mb-3 text-sm text-desk-muted">
            省略较早工具记录 {{ droppedTools }} 条。
          </p>
          <p v-if="toolExecutions.length === 0" class="text-sm text-desk-muted">尚无工具执行记录。</p>
          <div v-else class="space-y-3">
            <article
              v-for="tool in toolExecutions"
              :key="tool.key"
              class="rounded border border-desk-line bg-desk-surface p-3"
            >
              <div class="mb-1 flex flex-wrap items-center justify-between gap-2">
                <p class="font-mono text-sm">{{ tool.name }}</p>
                <p class="text-xs" :class="tool.isError ? 'text-desk-accent' : 'text-desk-muted'">
                  {{ tool.phaseLabel }}
                </p>
              </div>
              <p v-if="tool.argsText !== null" class="mb-2 break-words font-mono text-xs text-desk-muted">
                参数：{{ tool.argsText }}<span v-if="tool.argsTruncated">（已截断）</span>
              </p>
              <template v-if="tool.text !== ''">
                <p class="mb-1 text-xs text-desk-muted">{{ tool.textLabel }}</p>
                <p class="whitespace-pre-wrap break-words text-sm">{{ tool.text }}</p>
                <p v-if="tool.textTruncated" class="mt-1 text-xs text-desk-muted">此输出超出展示上限，已截断。</p>
              </template>
              <p v-else class="text-xs text-desk-muted">无文本输出。</p>
              <p v-if="tool.nonTextBlocks > 0" class="mt-1 text-xs text-desk-muted">
                含 {{ tool.nonTextBlocks }} 个非文本内容块，不在本页渲染。
              </p>
            </article>
          </div>
        </section>

        <section class="panel" aria-labelledby="diagnostics-heading">
          <h2 id="diagnostics-heading" class="section-heading mb-3">诊断</h2>
          <p class="text-sm text-desk-muted">尚无 Runtime 诊断输出。</p>
        </section>
      </div>
    </div>
  </main>
</template>
