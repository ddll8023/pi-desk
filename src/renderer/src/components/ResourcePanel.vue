<!-- Pi 资源面板：展示当前 Runtime 已加载的 Skills、Prompt Templates、扩展命令、MCP 状态与启动诊断，提供 MCP 服务器登录/退出请求，以及重启式重载与安全模式启动入口；资源清单只来自 Pi 的 `get_commands`，MCP 登录/退出只发固定命令，不解析也不修改 Pi 的配置文件。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import type { PiResourceEntry } from '../../../shared/runtime-api'
import { useResourceStore } from '../stores/resource'
import { useSessionStore } from '../stores/session'
import AppButton from './ui/AppButton.vue'

const emit = defineEmits<{ close: [] }>()

/** 弹层由父级常驻挂载，`open` 控制遮罩与面板的进入/退出；挂载期不读任何资源。 */
const props = defineProps<{
  readonly open: boolean
}>()

const resourceStore = useResourceStore()
const sessionStore = useSessionStore()
const {
  resourcesView,
  diagnostics,
  extensionErrors,
  diagnosticsError,
  diagnosticsLoading,
  mcpView,
  mcpCommandView,
  mcpServerName,
  mcpServerNameValid,
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
  <Transition name="dialog-fade">
    <div v-if="props.open" class="dialog-overlay" @click.self="close">
      <Transition name="dialog-panel-motion" appear>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Pi 资源"
          class="dialog-panel max-w-2xl"
        >
      <div class="dialog-header">
        <div class="min-w-0">
          <h2 class="dialog-title">Pi 资源</h2>
          <p class="dialog-subtitle">
            Pi 只在 Runtime 启动时读取资源与 MCP 配置；改动后需重启 Runtime 生效。
          </p>
        </div>
        <AppButton variant="unstyled" class="dialog-close-button" aria-label="关闭" @click="close" />
      </div>

      <div class="scroll-area dialog-body">
        <p v-if="!runtimeReady" role="status" class="status-notice">
          Runtime 未就绪，没有可读取的资源清单与诊断。先用左侧会话列表打开或新建会话；
          上一轮启动失败时可在下方用安全模式启动。
        </p>

        <div v-else class="flex flex-wrap items-center gap-2">
          <AppButton
            :disabled="resourcesView.phase === 'loading' || diagnosticsLoading"
            @click="resourceStore.refresh()"
          >
            {{ resourcesView.phase === 'loading' || diagnosticsLoading ? '正在读取…' : '重新读取清单与诊断' }}
          </AppButton>
          <AppButton
            :disabled="sessionStore.opening"
            @click="reload"
          >
            {{ sessionStore.opening ? '正在重新加载…' : '重新加载资源（重启 Runtime）' }}
          </AppButton>
        </div>

        <p v-if="runtimeReady && resourcesView.phase === 'error'" role="alert" class="status-notice status-notice-error">
          {{ resourcesView.error.message }}
        </p>

        <template v-if="runtimeReady && resourcesView.phase === 'ready'">
          <section v-for="group in groups" :key="group.key" class="panel-section">
            <h3 class="panel-section-title">{{ group.title }}</h3>
            <p class="hint-text">{{ group.hint }}</p>
            <p v-if="group.items.length === 0" class="hint-text">{{ group.empty }}</p>
            <ul v-else class="space-y-1.5">
              <li
                v-for="entry in group.items"
                :key="`${group.key}-${entry.name}`"
                class="list-card"
              >
                <p class="font-mono text-xs text-desk-ink">{{ invocation(entry) }}</p>
                <p v-if="entry.description !== null" class="mt-0.5 break-words text-2xs">
                  {{ entry.description }}
                </p>
                <p class="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-desk-muted">
                  <span class="chip">{{ scopeLabel(entry) }}</span>
                  <span>{{ originLabel(entry) }}</span>
                </p>
                <p v-if="entry.path !== null" class="mt-0.5 break-all font-mono text-2xs text-desk-muted">
                  {{ entry.path }}
                </p>
              </li>
            </ul>
          </section>

          <p v-if="resourcesTruncated" class="status-notice">
            清单超过展示上限，这里只显示前一部分；完整的资源加载结果以 Pi 侧为准。
          </p>
        </template>

        <section class="panel-section">
          <h3 class="panel-section-title">MCP 状态</h3>
          <p class="hint-text">
            状态文本来自 Pi 的 <span class="font-mono">/mcp</span> 命令；读取需等待已启用服务器连接完成，
            可能较慢，超时只表示结果未知。
          </p>
          <AppButton
            :disabled="!runtimeReady || mcpView.phase === 'requesting'"
            @click="resourceStore.requestMcpStatus()"
          >
            {{ mcpView.phase === 'requesting' ? '正在读取…' : '读取 MCP 状态' }}
          </AppButton>
          <p v-if="mcpView.phase === 'error'" role="alert" class="status-notice status-notice-error">
            {{ mcpView.error.message }}
          </p>
          <pre
            v-else-if="mcpView.phase === 'ready' && mcpView.messages.length > 0"
            class="tool-output"
          >{{ mcpView.messages.join('\n') }}</pre>
          <p v-else-if="mcpView.phase === 'ready'" class="hint-text">
            本次请求没有捕获到状态文本；命令可能已由其他 Extension 接管。
          </p>
        </section>

        <section class="panel-section">
          <h3 class="panel-section-title">MCP 服务器登录 / 退出</h3>
          <p class="hint-text">
            只对使用 OAuth 的 HTTP 服务器有意义；服务器名只能包含字母、数字、点、下划线与连字符。
          </p>
          <p class="hint-text">
            浏览器由 Pi 自己打开；回调无法回到本机时，Pi 会通过 Extension 对话框索要 redirect URL。
          </p>
          <input
            v-model="mcpServerName"
            type="text"
            placeholder="服务器名，例如 radius"
            autocomplete="off"
            spellcheck="false"
            class="text-control"
          >
          <div class="flex flex-wrap items-center gap-2">
            <AppButton
              :disabled="!runtimeReady || !mcpServerNameValid || mcpCommandView.phase === 'running'"
              @click="resourceStore.runMcpServerCommand('login')"
            >
              {{ mcpCommandView.phase === 'running' && mcpCommandView.action === 'login' ? '登录进行中…' : '登录此服务器' }}
            </AppButton>
            <AppButton
              :disabled="!runtimeReady || !mcpServerNameValid || mcpCommandView.phase === 'running'"
              @click="resourceStore.runMcpServerCommand('logout')"
            >
              {{ mcpCommandView.phase === 'running' && mcpCommandView.action === 'logout' ? '正在退出…' : '删除已保存凭据' }}
            </AppButton>
          </div>

          <p
            v-if="mcpCommandView.phase === 'running' && mcpCommandView.action === 'login'"
            role="status"
            class="status-notice status-notice-info"
          >
            登录需要你在浏览器里完成授权，这里会一直等到 Pi 结束该命令；期间的进度与输入请求
            会出现在通知区与 Extension 对话框里。
          </p>
          <p v-if="mcpCommandView.phase === 'error'" role="alert" class="status-notice status-notice-error">
            {{ mcpCommandView.error.message }}
          </p>
          <pre
            v-else-if="mcpCommandView.phase === 'ready' && mcpCommandView.data.messages.length > 0"
            class="tool-output"
          >{{ mcpCommandView.data.messages.join('\n') }}</pre>
          <p
            v-else-if="mcpCommandView.phase === 'ready'"
            class="status-notice"
          >
            命令已被 Pi 处理（{{ mcpCommandView.data.disposition }}）；本次没有捕获到额外文本，
            请重新读取 MCP 状态确认结果。
          </p>
        </section>

        <section class="panel-section">
          <h3 class="panel-section-title">加载诊断</h3>
          <p class="hint-text">
            Pi 非交互模式的 stderr 尾部，以及本代际收到的 Extension 运行时错误；
            Skill 与 Prompt Template 自身的加载警告在 RPC 模式下不对外提供。
          </p>
          <p v-if="diagnosticsError" role="alert" class="status-notice status-notice-error">
            {{ diagnosticsError.message }}
          </p>
          <template v-else>
            <p v-if="diagnostics.length === 0 && extensionErrors.length === 0" class="hint-text">
              没有诊断输出。
            </p>
            <pre
              v-if="diagnostics.length > 0"
              class="tool-output"
            >{{ diagnostics.join('\n') }}</pre>
            <ul v-if="extensionErrors.length > 0" class="space-y-1.5">
              <li
                v-for="(entry, index) in extensionErrors"
                :key="`ext-error-${index}`"
                class="list-card"
              >
                <p class="break-all font-mono text-2xs">{{ entry.path ?? '来源未知' }} · {{ entry.event ?? '事件未知' }}</p>
                <p class="mt-0.5 break-words text-xs text-desk-danger">{{ entry.error }}</p>
              </li>
            </ul>
          </template>
        </section>

        <section class="panel-section">
          <h3 class="panel-section-title">启动失败时的逃生入口</h3>
          <p class="hint-text">
            不加载任何 Extension 启动一次，用于坏扩展让 Runtime 无法启动的情况；
            同时会禁用内建扩展（包括 MCP，因此没有 MCP 工具与 /mcp 命令）。
            目标取最近一次启动的项目与会话，仅本次生效，不修改任何配置。
          </p>
          <AppButton
            :disabled="safeStart.phase === 'starting'"
            @click="resourceStore.startSafely()"
          >
            {{ safeStart.phase === 'starting' ? '正在启动…' : '以禁用扩展启动（仅本次）' }}
          </AppButton>
          <p v-if="safeStart.phase === 'error'" role="alert" class="status-notice status-notice-error">
            {{ safeStart.error.message }}
          </p>
          <p v-else-if="safeStart.phase === 'done'" role="status" class="status-notice">
            已请求安全模式启动，Runtime 就绪后这里会重新读取清单。
          </p>
        </section>

        <section class="panel-section">
          <h3 class="panel-section-title">边界说明</h3>
          <ul class="list-disc space-y-1 pl-4 text-xs leading-5 text-desk-muted">
            <li>资源的加载范围由 Pi 决定：用户级资源始终加载，项目级资源受 Project Trust 决定控制。</li>
            <li>启用 MCP 后 Pi 会连接你配置的服务器（stdio 服务器会启动外部程序），默认 exposure 的服务器还会启用 codemode 工具。</li>
            <li>Desktop 不解析、不生成也不修改 Pi 的 settings.json、mcp.json 与包配置，安装与卸载包请用 Pi 自己的命令。</li>
            <li>这里的所有内容都是 Pi 返回的文本，按纯文本展示。</li>
          </ul>
        </section>
      </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
