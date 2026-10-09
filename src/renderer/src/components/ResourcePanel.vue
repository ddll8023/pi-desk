<!-- Pi 资源面板：展示当前 Runtime 已加载的 Skills、Prompt Templates、扩展命令、MCP 状态与启动诊断，并提供重启式重载与安全模式启动入口；只读展示 Pi 的资源加载结果，不解析也不修改 Pi 的配置文件。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import type { PiResourceEntry } from '../../../shared/runtime-api'
import { useResourceStore } from '../stores/resource'
import { useSessionStore } from '../stores/session'

const emit = defineEmits<{ close: [] }>()

const resourceStore = useResourceStore()
const sessionStore = useSessionStore()
const {
  resourcesView,
  diagnostics,
  extensionErrors,
  diagnosticsError,
  diagnosticsLoading,
  mcpView,
  safeStart,
  runtimeReady,
  resourcesTruncated
} = storeToRefs(resourceStore)

/** 资源分组只按 `get_commands` 的来源分类展示，不额外推断归属。 */
const groups = computed(() => [
  {
    key: 'skill',
    title: 'Skills',
    hint: '发送 /skill:<名称> 可强制加载某个技能。',
    empty: '当前 Runtime 没有加载任何 Skill。',
    items: resourceStore.skills
  },
  {
    key: 'prompt',
    title: 'Prompt Templates',
    hint: '发送 /<名称> 展开模板，参数追加在其后。',
    empty: '当前 Runtime 没有加载任何 Prompt Template。',
    items: resourceStore.prompts
  },
  {
    key: 'extension',
    title: '扩展命令',
    hint: '由 Extensions 注册的命令，发送 /<名称> 执行。',
    empty: '当前 Runtime 没有注册扩展命令。',
    items: resourceStore.commands
  }
])

/** 调用方式与 Pi 一致：`get_commands` 已把 Skill 规范成 `skill:<名称>`，三类命令都是 `/<名称>`。 */
function invocation(entry: PiResourceEntry): string {
  return `/${entry.name}`
}

function scopeLabel(scope: string | null): string {
  switch (scope) {
    case 'user': return '用户级'
    case 'project': return '项目级'
    case 'temporary': return '本次运行'
    default: return '来源未知'
  }
}

/** 包资源带 baseDir；其他情况只如实说明直接加载或归属未知。 */
function originLabel(entry: PiResourceEntry): string {
  if (entry.origin === 'package') {
    return entry.baseDir === null ? '来自包' : `来自包 ${entry.baseDir}`
  }
  if (entry.origin === 'top-level') return '直接加载'
  return '归属未知'
}

function close(): void {
  emit('close')
}

function reload(): void {
  void sessionStore.reloadCurrent()
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-desk-ink/40 p-4" @click.self="close">
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pi 资源"
      class="panel flex max-h-[85vh] w-full max-w-2xl flex-col overflow-y-auto shadow-lg"
    >
      <div class="mb-2 flex items-start justify-between gap-3">
        <h2 class="section-heading">Pi 资源</h2>
        <button type="button" class="control-button" @click="close">关闭</button>
      </div>

      <p class="mb-3 text-xs text-desk-muted">
        Pi 只在 Runtime 启动时读取 Skills、Prompt Templates、MCP 配置与 Extension；RPC 没有重载命令，
        因此改动资源后需要重启 Runtime 才能生效。
      </p>

      <p v-if="!runtimeReady" role="status" class="mb-3 rounded-md border border-desk-line bg-desk-canvas p-3 text-sm text-desk-muted">
        Runtime 未就绪，没有可读取的资源清单与诊断。先用左侧会话列表打开或新建会话；
        上一轮启动失败时可在下方用安全模式启动。
      </p>

      <div v-else class="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="control-button"
          :disabled="resourcesView.phase === 'loading' || diagnosticsLoading"
          @click="resourceStore.refresh()"
        >
          {{ resourcesView.phase === 'loading' || diagnosticsLoading ? '正在读取…' : '重新读取清单与诊断' }}
        </button>
        <button
          type="button"
          class="control-button"
          :disabled="sessionStore.opening"
          @click="reload"
        >
          {{ sessionStore.opening ? '正在重新加载…' : '重新加载资源（重启 Runtime）' }}
        </button>
      </div>

      <p v-if="runtimeReady && resourcesView.phase === 'error'" role="alert" class="mb-3 text-sm text-desk-danger">
        {{ resourcesView.error.message }}
      </p>

      <template v-if="runtimeReady && resourcesView.phase === 'ready'">
        <section v-for="group in groups" :key="group.key" class="mb-4">
          <h3 class="text-sm font-semibold">{{ group.title }}</h3>
          <p class="mb-1 text-xs text-desk-muted">{{ group.hint }}</p>
          <p v-if="group.items.length === 0" class="text-sm text-desk-muted">{{ group.empty }}</p>
          <ul v-else class="space-y-1">
            <li
              v-for="entry in group.items"
              :key="`${group.key}-${entry.name}`"
              class="rounded-md border border-desk-line bg-desk-canvas px-3 py-2"
            >
              <p class="font-mono text-sm">{{ invocation(entry) }}</p>
              <p v-if="entry.description !== null" class="mt-0.5 break-words text-xs">{{ entry.description }}</p>
              <p class="mt-0.5 break-all text-xs text-desk-muted">
                {{ scopeLabel(entry.scope) }} · {{ originLabel(entry) }}
              </p>
              <p v-if="entry.path !== null" class="break-all text-xs text-desk-muted">{{ entry.path }}</p>
            </li>
          </ul>
        </section>

        <p v-if="resourcesTruncated" class="mb-3 text-xs text-desk-muted">
          清单超过展示上限，这里只显示前一部分；完整的资源加载结果以 Pi 侧为准。
        </p>
      </template>

      <section class="mb-4">
        <h3 class="text-sm font-semibold">MCP 状态</h3>
        <p class="mb-1 text-xs text-desk-muted">
          状态文本来自 Pi 的 <span class="font-mono">/mcp</span> 命令；读取会等待已启用服务器连接完成，
          可能较慢，超时只表示结果未知。
        </p>
        <button
          type="button"
          class="control-button mb-2"
          :disabled="!runtimeReady || mcpView.phase === 'requesting'"
          @click="resourceStore.requestMcpStatus()"
        >
          {{ mcpView.phase === 'requesting' ? '正在读取…' : '读取 MCP 状态' }}
        </button>
        <p v-if="mcpView.phase === 'error'" role="alert" class="text-sm text-desk-danger">
          {{ mcpView.error.message }}
        </p>
        <pre
          v-else-if="mcpView.phase === 'ready' && mcpView.messages.length > 0"
          class="empty-output whitespace-pre-wrap break-words text-xs"
        >{{ mcpView.messages.join('\n') }}</pre>
        <p v-else-if="mcpView.phase === 'ready'" class="text-sm text-desk-muted">
          本次请求没有捕获到状态文本；命令可能已由其他 Extension 接管。
        </p>
      </section>

      <section class="mb-4">
        <h3 class="text-sm font-semibold">加载诊断</h3>
        <p class="mb-1 text-xs text-desk-muted">
          Pi 在非交互模式的 stderr 输出尾部，以及本代际收到的 Extension 运行时错误。
          Extension 加载失败会让 Pi 在启动阶段直接退出；Skill 与 Prompt Template 自身的加载警告
          在 RPC 模式下不对外提供，这里也无法显示。
        </p>
        <p v-if="diagnosticsError" role="alert" class="text-sm text-desk-danger">
          {{ diagnosticsError.message }}
        </p>
        <template v-else>
          <p v-if="diagnostics.length === 0 && extensionErrors.length === 0" class="text-sm text-desk-muted">
            没有诊断输出。
          </p>
          <pre
            v-if="diagnostics.length > 0"
            class="empty-output whitespace-pre-wrap break-words text-xs"
          >{{ diagnostics.join('\n') }}</pre>
          <ul v-if="extensionErrors.length > 0" class="mt-1 space-y-1">
            <li
              v-for="(entry, index) in extensionErrors"
              :key="`ext-error-${index}`"
              class="rounded-md border border-desk-line bg-desk-canvas px-3 py-2 text-xs"
            >
              <p class="break-all font-mono">{{ entry.path ?? '来源未知' }} · {{ entry.event ?? '事件未知' }}</p>
              <p class="mt-0.5 break-words text-desk-danger">{{ entry.error }}</p>
            </li>
          </ul>
        </template>
      </section>

      <section class="mb-4">
        <h3 class="text-sm font-semibold">启动失败时的逃生入口</h3>
        <p class="mb-1 text-xs text-desk-muted">
          不加载任何 Extension 启动一次，用于坏扩展让 Runtime 无法启动的情况；同时会禁用内建扩展（包括 MCP，
          因此没有 MCP 工具与 /mcp 命令）。目标取最近一次启动的项目与会话，仅本次生效，不修改任何配置；
          下次启动仍按默认规则加载 Extension。
        </p>
        <button
          type="button"
          class="control-button"
          :disabled="safeStart.phase === 'starting'"
          @click="resourceStore.startSafely()"
        >
          {{ safeStart.phase === 'starting' ? '正在启动…' : '以禁用扩展启动（仅本次）' }}
        </button>
        <p v-if="safeStart.phase === 'error'" role="alert" class="mt-1 text-sm text-desk-danger">
          {{ safeStart.error.message }}
        </p>
        <p v-else-if="safeStart.phase === 'done'" role="status" class="mt-1 text-sm text-desk-muted">
          已请求安全模式启动，Runtime 就绪后这里会重新读取清单。
        </p>
      </section>

      <section class="rounded-md border border-desk-line bg-desk-canvas p-3 text-xs text-desk-muted">
        <h3 class="mb-1 text-sm font-semibold text-desk-ink">边界说明</h3>
        <ul class="list-disc space-y-1 pl-4">
          <li>资源的加载范围由 Pi 自己决定：用户级资源始终加载，项目级资源受 Project Trust 决定控制。</li>
          <li>启用 MCP 后 Pi 会连接你配置的服务器（stdio 服务器会启动外部程序），默认 exposure 的服务器还会让 Pi 自动启用 codemode 工具。</li>
          <li>Desktop 不解析、不生成也不修改 Pi 的 settings.json、mcp.json 与包配置，安装与卸载包请使用 Pi 自己的命令。</li>
          <li>这里的所有内容都是 Pi 返回的文本，按纯文本展示。</li>
        </ul>
      </section>
    </div>
  </div>
</template>
