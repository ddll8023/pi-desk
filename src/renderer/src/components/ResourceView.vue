<!-- Pi 资源视图：一页三区——资源清单、MCP 服务器、默认折叠的排障区。
     资源清单在 Runtime 就绪时来自 Pi 的 `get_commands`；未就绪时用一次性 Pi 进程的磁盘预读（只含 Skill），
     并如实标注来源。MCP 列表的骨架来自 Pi 的 mcp.json（只读浅层读取，不连接服务器、未启动也可读），
     连接状态与工具由官方 CLI 的 `pi mcp list --json` 探测按名叠加；探测会另起一个 Pi 进程重连服务器，
     因此只在用户显式请求时执行。`/mcp` 原始输出、启动诊断与安全模式启动收在排障区。
     本视图不解析、不生成也不修改 Pi 的任何配置文件。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { McpCommandAction, PiResourceEntry } from '../../../shared/runtime-api'
import type { McpServerRow } from '../stores/resource'
import { useProjectStore } from '../stores/project'
import { useResourceStore } from '../stores/resource'
import { useSessionStore } from '../stores/session'
import { copyText } from '../clipboard'
import AppButton from './ui/AppButton.vue'
import ConfirmDialog from './ConfirmDialog.vue'

const resourceStore = useResourceStore()
const sessionStore = useSessionStore()
const projectStore = useProjectStore()
const {
  resourcesView,
  previewSkills,
  diagnostics,
  extensionErrors,
  diagnosticsError,
  diagnosticsLoading,
  mcpView,
  mcpCommandView,
  mcpInspectView,
  mcpConfigView,
  mcpServers,
  safeStart,
  runtimeReady,
  resourcesTruncated
} = storeToRefs(resourceStore)
const { currentProject } = storeToRefs(projectStore)

/** 资源名称与描述的过滤词；只过滤展示，不改变清单来源。 */
const filter = ref('')
/** 展开详情的 MCP 服务器名；一次只展开一个，避免列表被同时撑开。 */
const expandedServer = ref<string | null>(null)
/** 待确认的凭据删除目标；确认后才发出 logout 命令。 */
const pendingCredentialRemoval = ref<string | null>(null)
/** 最近一次复制成功的区块标识，只用于给出「已复制」反馈。 */
const copiedBlock = ref<string | null>(null)
/** 最近一次复制失败的区块标识；失败必须可见，不能停在「复制」。 */
const failedBlock = ref<string | null>(null)

/** 连接动作都要经运行中的 Runtime；服务器名来自配置列举，由主进程再校验后拼进固定命令。 */
const commandReady = computed(() => runtimeReady.value)

/** 资源清单的来源标签：运行中的清单是权威，磁盘预读只用于未启动时。 */
const resourceSourceLabel = computed(() => (runtimeReady.value ? '运行中 Runtime' : '磁盘预读'))
/** 未就绪时展示预读结果；预读只含 Skill，模板与扩展命令仍需启动 Runtime。 */
const previewing = computed(() => !runtimeReady.value && previewSkills.value.length > 0)

/** 资源分组只按 `get_commands` 的来源分类展示，不额外推断归属。 */
const groups = computed(() => [
  {
    key: 'skill',
    title: 'Skills',
    hint: '发送 /skill:<名称> 可强制加载某个技能。',
    empty: '当前清单里没有 Skill。',
    items: resourceStore.skills
  },
  {
    key: 'prompt',
    title: 'Prompt Templates',
    hint: '发送 /<名称> 展开模板，参数追加在其后。',
    empty: runtimeReady.value ? '当前 Runtime 没有加载任何 Prompt Template。' : '模板需要启动 Runtime 后读取。',
    items: resourceStore.prompts
  },
  {
    key: 'extension',
    title: '扩展命令',
    hint: '由 Extensions 注册的命令，发送 /<名称> 执行。',
    empty: runtimeReady.value ? '当前 Runtime 没有注册扩展命令。' : '扩展命令需要启动 Runtime 后读取。',
    items: resourceStore.commands
  }
])

/** 未就绪时把预读到的 Skill 直接当成 Skill 组的内容，只读展示。 */
const displayGroups = computed(() => {
  const group = groups.value.map((item) => (
    item.key === 'skill' && previewing.value ? { ...item, items: previewSkills.value } : item
  ))
  const keyword = filter.value.trim().toLowerCase()
  if (keyword === '') return group
  return group.map((item) => ({
    ...item,
    items: item.items.filter((entry) => (
      entry.name.toLowerCase().includes(keyword)
      || (entry.description ?? '').toLowerCase().includes(keyword)
    ))
  }))
})

/** 默认展开第一个有内容的分组：首屏先给出三组各自的数量，需要时再展开。 */
const openGroupKey = computed(() => displayGroups.value.find((group) => group.items.length > 0)?.key ?? null)
const resourceCount = computed(() => displayGroups.value.reduce((total, group) => total + group.items.length, 0))
const filtered = computed(() => filter.value.trim() !== '')

const inspectedServers = computed(() => (
  mcpInspectView.value.phase === 'ready' ? mcpInspectView.value.data.servers : null
))
/** 探测过的服务器名集合，用于说明列表里哪些行还没有连接状态。 */
const probedCount = computed(() => inspectedServers.value?.length ?? 0)
const configListing = computed(() => (
  mcpConfigView.value.phase === 'ready' ? mcpConfigView.value.data : null
))
/** 项目级条目在未信任项目下不会被 Pi 读取，必须显式说明，不能让用户以为它在生效。 */
const projectRowsInactive = computed(() => (
  configListing.value !== null
  && !configListing.value.projectConfigTrusted
  && configListing.value.servers.some((server) => server.scope === 'project')
))
/** 排障区计数只统计真的出问题的条数，正常时不加噪声。 */
const diagnosticCount = computed(() => diagnostics.value.length + extensionErrors.value.length)

/** 官方 CLI 的状态取值到中文标签；未知取值原样展示，不猜测含义。 */
const SERVER_STATE_LABELS: Readonly<Record<string, string>> = {
  connected: '已连接',
  connecting: '连接中',
  'needs-auth': '需要登录',
  failed: '连接失败',
  disconnected: '已断开',
  closed: '已关闭',
  disabled: '未启用'
}

/** exposure 取值到中文标签；未知取值原样展示。 */
const EXPOSURE_LABELS: Readonly<Record<string, string>> = {
  direct: '直接可用',
  codemode: 'codemode',
  deferred: '按需检索',
  hidden: '不暴露'
}

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

/** 最近一次连接动作的展示信息；没有动作时为 null。模板只用这个对象，不直接读联合类型的成员。 */
const commandBanner = computed(() => {
  const view = mcpCommandView.value
  if (view.phase === 'idle') return null
  return {
    title: commandLabel(view.action, view.serverName),
    running: view.phase === 'running',
    error: view.phase === 'error' ? view.error.message : null,
    messages: view.phase === 'ready' ? view.data.messages : [],
    disposition: view.phase === 'ready' ? view.data.disposition : null
  }
})

function stateLabel(state: string): string {
  return SERVER_STATE_LABELS[state] ?? state
}

/** 状态点的语义分类；颜色只是辅助，状态标签始终同时出现。 */
function stateTone(state: string): string {
  switch (state) {
    case 'connected': return 'status-dot-ok'
    case 'failed': return 'status-dot-error'
    case 'connecting':
    case 'needs-auth':
    case 'disconnected': return 'status-dot-warn'
    default: return 'status-dot-idle'
  }
}

/** 行的状态标签：没有探测报告时如实说「未探测」，不冒充已断开。 */
function rowStateLabel(row: McpServerRow): string {
  return row.report === null ? '未探测' : stateLabel(row.report.state)
}

function rowStateTone(row: McpServerRow): string {
  return row.report === null ? 'status-dot-idle' : stateTone(row.report.state)
}

function exposureLabel(exposure: string): string {
  return EXPOSURE_LABELS[exposure] ?? exposure
}

/** 暴露方式只在有探测报告时存在。 */
function exposureOf(row: McpServerRow): string | null {
  return row.report === null ? null : exposureLabel(row.report.exposure)
}

function serverScopeLabel(row: McpServerRow): string {
  if (row.scope === 'project') return '项目级'
  if (row.scope === 'global') return '用户级'
  return '范围未知'
}

/** 最近一次连接动作的标题；动作与服务器名都来自本次请求，不重新推断。 */
function commandLabel(action: McpCommandAction, serverName: string): string {
  switch (action) {
    case 'login': return `登录 ${serverName}`
    case 'logout': return `删除 ${serverName} 的已保存凭据`
    case 'reconnect': return `重连 ${serverName}`
  }
}

function toggleServer(name: string): void {
  expandedServer.value = expandedServer.value === name ? null : name
}

/** 重启式重载：复用既有的中断确认链，让 Pi 重新读取资源与模型快照。 */
function reload(): void {
  void sessionStore.reloadCurrent()
}

/** 复制到剪贴板；成功与失败都就地反馈，不改变页面其他状态。 */
async function copy(key: string, text: string): Promise<void> {
  const copied = await copyText(text)
  copiedBlock.value = copied ? key : null
  failedBlock.value = copied ? null : key
}

function copyLabel(key: string): string {
  if (copiedBlock.value === key) return '已复制'
  return failedBlock.value === key ? '复制失败' : '复制'
}

/** 凭据删除不可逆：先经确认对话框，确认后才把命令交给主进程。 */
function confirmCredentialRemoval(): void {
  const serverName = pendingCredentialRemoval.value
  pendingCredentialRemoval.value = null
  if (serverName === null) return
  void resourceStore.runMcpServerCommand('logout', serverName)
}

function runServerCommand(action: McpCommandAction, serverName: string): void {
  void resourceStore.runMcpServerCommand(action, serverName)
}

/** 暴露方式、工具与错误都只在有探测报告时存在；模板使用这些取值函数，避免直接穿透可空字段。 */
function toolsOf(row: McpServerRow): readonly string[] {
  return row.report?.tools ?? []
}

function rowError(row: McpServerRow): string | null {
  return row.report?.error ?? null
}

/** 资源与模板计数；Pi 未报告时为 null，不用 0 冒充。 */
function resourceSummary(row: McpServerRow): string | null {
  const resources = row.report?.resources
  if (resources === null || resources === undefined) return null
  return `${resources} / ${row.report?.resourceTemplates ?? 0}`
}

function toolExposureLabel(row: McpServerRow): string | null {
  const exposure = row.report?.toolExposure
  if (exposure === null || exposure === undefined) return null
  return Object.entries(exposure).map(([name, mode]) => `${name}=${mode}`).join('、')
}

/** 项目级配置的启用状态只在受信任时才有意义，未生效时单独说明。 */
function enabledLabel(row: McpServerRow): string {
  if (!row.enabled) return '未启用'
  if (row.scope === 'project' && !configListing.value?.projectConfigTrusted) return '未启用（未信任项目）'
  return '已启用'
}
</script>

<template>
  <div class="space-y-4">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">Pi 资源</h1>
      <p class="mt-1 text-sm text-desk-muted">
        资源与 MCP 配置只在 Pi 启动时读取；改动配置后需要重启 Runtime 才会生效。
      </p>
    </header>

    <!-- 资源：清单来源与 MCP 一样只有一个当前生效的口径，未启动时才降级为磁盘预读。 -->
    <section class="panel-section" aria-labelledby="resource-list-title">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="resource-list-title" class="panel-section-title">资源</h2>
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="chip">{{ resourceSourceLabel }}</span>
          <span class="chip">{{ resourceCount }} 项</span>
        </div>
      </div>
      <p class="hint-text">
        <template v-if="runtimeReady">
          清单来自运行中 Runtime 的 <span class="font-mono">get_commands</span>，与 Pi 当前实际加载的一致。
        </template>
        <template v-else>
          磁盘预读只含 Skill，且不含扩展在运行时注册的项；模板与扩展命令需要启动 Runtime 后读取。
        </template>
      </p>

      <div class="flex flex-wrap items-center gap-2">
        <AppButton
          :disabled="!runtimeReady || resourcesView.phase === 'loading'"
          @click="resourceStore.refresh()"
        >
          {{ resourcesView.phase === 'loading' ? '正在读取…' : '重新读取' }}
        </AppButton>
        <AppButton
          :disabled="sessionStore.opening"
          @click="reload"
        >
          {{ sessionStore.opening ? '正在重新加载…' : '重启 Runtime 以重新加载' }}
        </AppButton>
        <input
          v-if="resourceCount > 0 || filtered"
          v-model="filter"
          type="search"
          placeholder="过滤名称或描述"
          autocomplete="off"
          spellcheck="false"
          class="text-control max-w-72"
        >
      </div>

      <p v-if="!runtimeReady && !previewing" role="status" class="status-notice">
        没有可显示的清单：磁盘预读也没有读到 Skill。先在左侧会话列表打开或新建会话，
        上一轮启动失败时可在下方「排障」里用安全模式启动。
      </p>

      <p
        v-if="runtimeReady && resourcesView.phase === 'error'"
        role="alert"
        class="status-notice status-notice-error"
      >
        {{ resourcesView.error.message }}
      </p>

      <template v-if="runtimeReady ? resourcesView.phase === 'ready' : previewing">
        <details
          v-for="group in displayGroups"
          :key="group.key"
          class="fold-group"
          :open="group.key === openGroupKey"
        >
          <summary>
            <span class="disclosure"></span>
            <span>{{ group.title }}</span>
            <span class="chip">{{ group.items.length }}</span>
          </summary>
          <div class="fold-group-body">
            <p class="hint-text">{{ group.hint }}</p>
            <p v-if="group.items.length === 0" class="hint-text">
              {{ filtered ? '没有匹配的条目。' : group.empty }}
            </p>
            <ul v-else class="space-y-1.5">
              <li
                v-for="entry in group.items"
                :key="`${group.key}-${entry.name}`"
                class="list-card"
              >
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <p class="font-mono text-xs text-desk-ink">{{ invocation(entry) }}</p>
                  <AppButton
                    variant="unstyled"
                    class="copy-button"
                    @click="copy(`${group.key}-${entry.name}`, invocation(entry))"
                  >
                    {{ copyLabel(`${group.key}-${entry.name}`) }}
                  </AppButton>
                </div>
                <p v-if="entry.description !== null" class="mt-0.5 break-words text-2xs">
                  {{ entry.description }}
                </p>
                <p class="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-desk-muted">
                  <span class="chip">{{ scopeLabel(entry.scope) }}</span>
                  <span>{{ originLabel(entry) }}</span>
                </p>
                <p v-if="entry.path !== null" class="mt-0.5 break-all font-mono text-2xs text-desk-muted">
                  {{ entry.path }}
                </p>
              </li>
            </ul>
          </div>
        </details>

        <p v-if="runtimeReady && resourcesTruncated" class="status-notice">
          清单超过展示上限，这里只显示前一部分；完整的资源加载结果以 Pi 侧为准。
        </p>
      </template>
    </section>

    <!-- MCP：列表骨架来自配置文件，连接状态来自探测；两者职责分开，不再并列两套口径。 -->
    <section class="panel-section" aria-labelledby="mcp-list-title">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="mcp-list-title" class="panel-section-title">MCP 服务器</h2>
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="chip">{{ mcpServers.length }} 个</span>
          <span v-if="probedCount > 0" class="chip">已探测 {{ probedCount }} 个</span>
        </div>
      </div>

      <p class="hint-text">
        列表读取自 Pi 的 <span class="font-mono">mcp.json</span>（只读，不修改）：全局
        <span class="break-all font-mono">{{ configListing?.globalConfigPath ?? '未读取' }}</span><template
          v-if="configListing !== null && configListing.projectConfigPath !== null"
        >，项目 <span class="break-all font-mono">{{ configListing.projectConfigPath }}</span></template>。
        连接状态由探测补充，未探测的行只表示「配置里有」，不代表连接结果。
      </p>

      <div class="flex flex-wrap items-center gap-2">
        <AppButton
          :disabled="currentProject === null || mcpInspectView.phase === 'inspecting'"
          @click="resourceStore.inspectServers()"
        >
          {{ mcpInspectView.phase === 'inspecting' ? '正在探测…' : '探测连接状态' }}
        </AppButton>
        <AppButton
          v-if="mcpInspectView.phase === 'inspecting'"
          @click="resourceStore.cancelInspection()"
        >
          取消探测
        </AppButton>
        <span class="hint-text">
          探测会另起一个 Pi 进程并重新连接每个已启用服务器，stdio 服务器会被再启动一次。
        </span>
      </div>
      <p v-if="currentProject === null" class="hint-text">先在左侧选择一个项目，再探测 MCP 服务器。</p>
      <p v-if="mcpInspectView.phase === 'inspecting'" class="hint-text">
        正在逐个连接，可能较慢；可以随时取消，取消只终止这次探测。stdio 服务器会在 stdin 关闭后自行退出；
        不读 stdin 的服务器在取消或超时后可能继续存在。
      </p>

      <p
        v-if="mcpConfigView.phase === 'error'"
        role="alert"
        class="status-notice status-notice-error"
      >
        {{ mcpConfigView.error.message }}
      </p>

      <div v-if="configListing !== null && configListing.errors.length > 0" class="technical-detail">
        <span class="text-2xs text-desk-muted">被跳过的配置条目</span>
        <pre class="technical-detail-text">{{ configListing.errors.join('\n') }}</pre>
      </div>

      <p v-if="projectRowsInactive" role="status" class="status-notice status-notice-warn">
        项目级配置在未信任项目下不会被 Pi 读取；这些条目现在不生效，完成信任决定后才会加载。
      </p>

      <p
        v-if="mcpInspectView.phase === 'error'"
        role="alert"
        class="status-notice status-notice-error"
      >
        {{ mcpInspectView.error.message }}
      </p>

      <template v-if="mcpInspectView.phase === 'ready'">
        <p v-if="mcpInspectView.data.note !== null" role="status" class="status-notice status-notice-warn">
          部分配置未参与本次探测，Pi 的说明：{{ mcpInspectView.data.note }}
        </p>

        <div v-if="mcpInspectView.data.configErrors.length > 0" class="technical-detail">
          <span class="text-2xs text-desk-muted">Pi 跳过或拒绝的配置条目</span>
          <pre class="technical-detail-text">{{ mcpInspectView.data.configErrors.join('\n') }}</pre>
        </div>
      </template>

      <p v-if="mcpServers.length === 0 && mcpConfigView.phase !== 'loading'" class="hint-text">
        两处 <span class="font-mono">mcp.json</span> 都没有配置服务器。添加或删除服务器请用 Pi 自己的命令
        （例如 <span class="font-mono">pi mcp add</span>），这里不修改 Pi 的配置。
      </p>

      <ul v-else class="space-y-1.5">
        <li
          v-for="row in mcpServers"
          :key="row.name"
          class="list-card"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
              <span class="status-dot" :class="rowStateTone(row)"></span>
              <span>{{ row.name }}</span>
              <span class="text-2xs font-normal text-desk-muted">{{ rowStateLabel(row) }}</span>
            </p>
            <span v-if="row.report !== null" class="chip">{{ toolsOf(row).length }} 个工具</span>
          </div>

          <p class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-desk-muted">
            <span class="chip">{{ serverScopeLabel(row) }}</span>
            <span class="chip">{{ enabledLabel(row) }}</span>
            <span v-if="row.override !== null" class="chip">项目覆盖</span>
            <span v-if="row.transport !== null" class="min-w-0 truncate font-mono">{{ row.transport }}</span>
          </p>

          <p
            v-if="rowError(row) !== null && expandedServer !== row.name"
            class="mt-1 break-words text-xs text-desk-danger"
          >
            {{ rowError(row) }}
          </p>

          <div class="mt-2 flex flex-wrap items-center gap-2">
            <AppButton
              variant="compact"
              :disabled="!commandReady || mcpCommandView.phase === 'running'"
              @click="runServerCommand('reconnect', row.name)"
            >
              重连
            </AppButton>
            <AppButton
              variant="unstyled"
              class="copy-button"
              @click="toggleServer(row.name)"
            >
              {{ expandedServer === row.name ? '收起详情' : '详情' }}
            </AppButton>
          </div>

          <div v-if="expandedServer === row.name" class="mt-2 space-y-2 border-t border-desk-line pt-2">
            <dl class="grid gap-x-3 gap-y-1 text-2xs sm:grid-cols-[auto_1fr]">
              <dt class="text-desk-muted">配置文件</dt>
              <dd class="break-all font-mono">{{ row.source === '' ? '未报告' : row.source }}</dd>
              <dt class="text-desk-muted">项目覆盖</dt>
              <dd class="break-all font-mono">{{ row.override ?? '无' }}</dd>
              <dt class="text-desk-muted">启动方式</dt>
              <dd class="break-all font-mono">{{ row.transport ?? '配置里没有 command 或 url' }}</dd>
              <dt v-if="exposureOf(row) !== null" class="text-desk-muted">暴露方式</dt>
              <dd v-if="exposureOf(row) !== null">{{ exposureOf(row) }}</dd>
              <dt v-if="resourceSummary(row) !== null" class="text-desk-muted">资源 / 模板</dt>
              <dd v-if="resourceSummary(row) !== null">{{ resourceSummary(row) }}</dd>
            </dl>

            <div v-if="rowError(row) !== null" class="technical-detail">
              <span class="text-2xs text-desk-muted">连接错误</span>
              <pre class="technical-detail-text">{{ rowError(row) }}</pre>
            </div>

            <div v-if="toolsOf(row).length > 0">
              <p class="text-2xs text-desk-muted">工具</p>
              <p class="mt-1 flex flex-wrap gap-1">
                <span
                  v-for="tool in toolsOf(row)"
                  :key="tool"
                  class="chip font-mono"
                >{{ tool }}</span>
              </p>
              <p v-if="toolExposureLabel(row) !== null" class="mt-1 text-2xs text-desk-muted">
                逐工具 exposure：<span class="font-mono">{{ toolExposureLabel(row) }}</span>
              </p>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <AppButton
                variant="compact"
                :disabled="!commandReady || mcpCommandView.phase === 'running'"
                @click="runServerCommand('login', row.name)"
              >
                登录（OAuth）
              </AppButton>
              <AppButton
                variant="quiet-danger"
                :disabled="!commandReady || mcpCommandView.phase === 'running'"
                @click="pendingCredentialRemoval = row.name"
              >
                删除已保存凭据
              </AppButton>
            </div>
            <p class="hint-text">
              登录与删除凭据只对使用 OAuth 的 HTTP 服务器有意义；这些动作要经运行中的 Runtime，
              服务器名由这里选定，不会手动拼进命令。
            </p>
          </div>
        </li>
      </ul>

      <!-- 连接动作的进度与捕获文本：登录需要用户在浏览器里完成授权，可能等待较久。 -->
      <div v-if="commandBanner !== null" class="technical-detail">
        <span class="text-2xs text-desk-muted">{{ commandBanner.title }}</span>
        <p v-if="commandBanner.running" class="mt-1 text-xs">
          等待 Pi 结束该命令；登录期间的浏览器地址与输入请求会出现在通知区与 Extension 对话框里。
        </p>
        <p
          v-else-if="commandBanner.error !== null"
          role="alert"
          class="mt-1 text-xs text-desk-danger"
        >
          {{ commandBanner.error }}
        </p>
        <template v-else>
          <pre
            v-if="commandBanner.messages.length > 0"
            class="technical-detail-text"
          >{{ commandBanner.messages.join('\n') }}</pre>
          <p v-else class="mt-1 text-xs text-desk-muted">
            命令已被 Pi 处理（{{ commandBanner.disposition }}）；本次没有捕获到额外文本，
            可重新探测确认结果。
          </p>
        </template>
      </div>

      <!-- 运行中 Runtime 的 `/mcp` 是另一套连接，只在需要对照时读取，不再作为并列的区块。 -->
      <details class="fold-group">
        <summary>
          <span class="disclosure"></span>
          <span>运行中 Runtime 的原始输出</span>
          <span class="chip font-mono">/mcp</span>
        </summary>
        <div class="fold-group-body">
          <p class="hint-text">
            这是 Pi 的 <span class="font-mono">/mcp</span> 原始输出，反映当前 Runtime 自己加载的连接，
            与上面的探测是两套独立连接，结果可能不同。读取要等已启用服务器连接完成，可能较慢，
            超时只表示结果未知。
          </p>
          <AppButton
            :disabled="!runtimeReady || mcpView.phase === 'requesting'"
            @click="resourceStore.requestMcpStatus()"
          >
            {{ mcpView.phase === 'requesting' ? '正在读取…' : '读取状态' }}
          </AppButton>
          <p v-if="!runtimeReady" class="hint-text">Runtime 未就绪；先打开或新建会话。</p>
          <p v-if="mcpView.phase === 'error'" role="alert" class="status-notice status-notice-error">
            {{ mcpView.error.message }}
          </p>
          <template v-else-if="mcpView.phase === 'ready'">
            <div v-if="mcpView.messages.length > 0" class="technical-detail">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="text-2xs text-desk-muted">Pi 的原始输出</span>
                <AppButton
                  variant="unstyled"
                  class="copy-button"
                  @click="copy('mcp-status', mcpView.messages.join('\n'))"
                >
                  {{ copyLabel('mcp-status') }}
                </AppButton>
              </div>
              <pre class="technical-detail-text">{{ mcpView.messages.join('\n') }}</pre>
            </div>
            <p v-else class="hint-text">
              本次请求没有捕获到状态文本；命令可能已由其他 Extension 接管。
            </p>
          </template>
        </div>
      </details>
    </section>

    <!-- 排障：默认折叠，只在真的需要时展开；正常使用时这一区不占视觉权重。 -->
    <details class="fold-group">
      <summary>
        <span class="disclosure"></span>
        <span>排障</span>
        <span v-if="diagnosticCount > 0" class="chip">{{ diagnosticCount }}</span>
      </summary>
      <div class="fold-group-body">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="panel-section-title">启动诊断</h3>
          <AppButton
            variant="compact"
            :disabled="!runtimeReady || diagnosticsLoading"
            @click="resourceStore.refresh()"
          >
            {{ diagnosticsLoading ? '正在读取…' : '重新读取' }}
          </AppButton>
        </div>
        <p class="hint-text">
          Pi 非交互模式的 stderr 尾部；Skill 与 Prompt Template 自身的加载警告在 RPC 模式下不对外提供。
        </p>
        <p v-if="diagnosticsError !== null" role="alert" class="status-notice status-notice-error">
          {{ diagnosticsError.message }}
        </p>
        <p v-else-if="diagnostics.length === 0" class="hint-text">没有诊断输出。</p>
        <div v-else class="technical-detail">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-2xs text-desk-muted">Pi 的原始输出</span>
            <AppButton
              variant="unstyled"
              class="copy-button"
              @click="copy('stderr', diagnostics.join('\n'))"
            >
              {{ copyLabel('stderr') }}
            </AppButton>
          </div>
          <pre class="technical-detail-text">{{ diagnostics.join('\n') }}</pre>
        </div>

        <h3 class="panel-section-title">Extension 运行时错误</h3>
        <p class="hint-text">本代际收到的 Extension 运行时错误，只保留最近的若干条。</p>
        <p v-if="extensionErrors.length === 0" class="hint-text">没有 Extension 运行时错误。</p>
        <ul v-else class="space-y-1.5">
          <li
            v-for="(entry, index) in extensionErrors"
            :key="`ext-error-${index}`"
            class="list-card"
          >
            <p class="break-all font-mono text-2xs">
              {{ entry.path ?? '来源未知' }} · {{ entry.event ?? '事件未知' }}
            </p>
            <p class="mt-0.5 break-words text-xs text-desk-danger">{{ entry.error }}</p>
          </li>
        </ul>

        <h3 class="panel-section-title">启动失败时的逃生入口</h3>
        <p class="hint-text">
          不加载任何 Extension 启动一次，用于坏扩展让 Runtime 无法启动的情况；
          同时会禁用内建扩展（包括 MCP，因此没有 MCP 工具与 <span class="font-mono">/mcp</span> 命令）。
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
          已请求安全模式启动；Runtime 就绪后这里会重新读取清单与诊断。
        </p>
      </div>
    </details>

    <Teleport to="body">
      <ConfirmDialog
        :open="pendingCredentialRemoval !== null"
        title="删除已保存的凭据？"
        description="只删除 Pi 为这个 MCP 服务器保存的 OAuth 凭据，不改动 mcp.json、环境变量或其他服务器的凭据。删除后需要重新登录才能使用该服务器。"
        :detail="pendingCredentialRemoval ?? ''"
        confirm-label="删除凭据"
        @confirm="confirmCredentialRemoval"
        @cancel="pendingCredentialRemoval = null"
      />
    </Teleport>
  </div>
</template>
