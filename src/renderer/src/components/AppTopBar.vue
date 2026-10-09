<!-- 顶栏：Sidebar 折叠开关、主题循环切换、项目切换入口、当前会话与 Runtime 状态，并在详情弹层里提供模型、Thinking、上下文占用等 Agent 控制、从历史消息分叉、重置本项目信任决定与关闭 Runtime；另提供 Pi 资源面板与 Provider 认证面板入口；不承载消息与 Prompt 提交。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useDesktopStore } from '../stores/desktop'
import { usePreferencesStore } from '../stores/preferences'
import { useProjectStore } from '../stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import { useTrustStore } from '../stores/trust'
import type { TrustStatus } from '../../../shared/trust-api'
import AgentControls from './AgentControls.vue'
import AuthPanel from './AuthPanel.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import ForkDialog from './ForkDialog.vue'
import ProjectSwitcher from './ProjectSwitcher.vue'
import ResourcePanel from './ResourcePanel.vue'

defineProps<{
  readonly sidebarCollapsed: boolean
  /** 界面偏好尚未读取完成时禁止切换，避免与存储状态互相覆盖。 */
  readonly sidebarToggleDisabled: boolean
}>()

const emit = defineEmits<{
  toggleSidebar: []
}>()

const desktopStore = useDesktopStore()
const preferencesStore = usePreferencesStore()
const projectStore = useProjectStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const trustStore = useTrustStore()
const { connection } = storeToRefs(desktopStore)
const { theme } = storeToRefs(preferencesStore)
const { currentProject } = storeToRefs(projectStore)
const { view: runtimeView } = storeToRefs(runtimeStore)

/** 弹层互斥：同一时刻只展开一个，点外或 Esc 关闭。 */
const openPanel = ref<'project' | 'runtime' | null>(null)
const root = ref<HTMLElement | null>(null)
/** 当前项目的信任状态；详情弹层展开时读取，用于重置入口的展示。 */
const trustStatus = ref<TrustStatus | { error: string } | null>(null)
const hasTrustDecision = computed(() => {
  const status = trustStatus.value
  return status !== null && !('error' in status) && status.decision !== null
})
const trustStatusDetail = computed(() => {
  const status = trustStatus.value
  return status !== null && !('error' in status) ? (status.projectPath ?? '') : ''
})
const confirmingTrustReset = ref(false)
const trustResetBusy = ref(false)
/** 分叉弹层由顶栏声明并渲染到 body：入口在 Runtime 详情弹层里，弹层本身全局展示。 */
const showingFork = ref(false)
/** Pi 资源面板由顶栏声明并渲染到 body：入口是顶栏按钮，弹层本身全局展示。 */
const showingResources = ref(false)
/** Provider 认证面板同样由顶栏声明并渲染到 body：入口是顶栏按钮，与资源面板互斥。 */
const showingAuth = ref(false)

const runtimeInfo = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const runtimeLabel = computed(() => {
  switch (runtimeView.value.phase) {
    case 'idle': return 'Runtime 未启动'
    case 'starting': return '正在启动 Runtime'
    case 'ready': return runtimeInfo.value?.isStreaming === true ? 'Agent 正在运行' : 'Runtime 已就绪'
    case 'stopping': return '正在关闭 Runtime'
    case 'closed': return 'Runtime 已关闭'
    case 'failed': return 'Runtime 异常退出'
  }
})
const runtimeDotClass = computed(() => {
  switch (runtimeView.value.phase) {
    case 'ready': return runtimeInfo.value?.isStreaming === true ? 'bg-desk-accent animate-pulse motion-reduce:animate-none' : 'bg-desk-accent'
    case 'failed': return 'bg-desk-danger'
    case 'starting':
    case 'stopping': return 'bg-desk-muted animate-pulse motion-reduce:animate-none'
    default: return 'bg-desk-line'
  }
})
const runtimeError = computed(() => (
  runtimeView.value.phase === 'failed' ? runtimeView.value.error.message : null
))
const sessionLabel = computed(() => {
  const sessionId = runtimeInfo.value?.sessionId
  if (typeof sessionId === 'string' && sessionId !== '') return `会话 ${sessionId.slice(0, 8)}`
  return currentProject.value === null ? '未选择项目' : '未打开会话'
})
/** 顶栏会话 chip：有会话时只显示 8 位 ID，其余情况显示状态文案。 */
const sessionIdShort = computed(() => {
  const sessionId = runtimeInfo.value?.sessionId
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId.slice(0, 8) : null
})
/** Runtime 状态文字：失败用语义色，就绪用正文色，其余保持次要色。 */
const runtimeTextClass = computed(() => {
  switch (runtimeView.value.phase) {
    case 'failed': return 'text-desk-danger'
    case 'ready': return 'text-desk-ink'
    default: return 'text-desk-muted'
  }
})

/** 详情弹层展开时读取当前项目的信任状态，决定是否显示重置入口。 */
function togglePanel(panel: 'project' | 'runtime'): void {
  const next = openPanel.value === panel ? null : panel
  openPanel.value = next
  if (next === 'runtime') {
    void trustStore.queryStatus().then((status) => {
      trustStatus.value = status
    })
  }
}

const themeLabel = computed(() => {
  switch (theme.value) {
    case 'system': return '主题：跟随系统'
    case 'light': return '主题：浅色'
    case 'dark': return '主题：深色'
  }
})

function closePanel(): void {
  openPanel.value = null
}

function onPointerDown(event: PointerEvent): void {
  if (openPanel.value === null) return
  const element = root.value
  const target = event.target
  if (element !== null && target instanceof Node && element.contains(target)) return
  closePanel()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closePanel()
}

function shutdownRuntime(): void {
  closePanel()
  void runtimeStore.shutdown()
}

/** 重置当前项目的信任决定；下次启动该项目时重新询问。 */
function resetTrustDecision(): void {
  confirmingTrustReset.value = true
}

/** 打开分叉弹层并读取可分叉消息；入口只在 Runtime 就绪时展示。 */
function openForkDialog(): void {
  closePanel()
  showingFork.value = true
  void sessionStore.loadForkMessages()
}

function closeForkDialog(): void {
  showingFork.value = false
}

/** 资源面板与项目、Runtime 弹层互斥：打开前先收起其他弹层。 */
function openResourcePanel(): void {
  closePanel()
  showingAuth.value = false
  showingResources.value = true
}

function closeResourcePanel(): void {
  showingResources.value = false
}

/** 认证面板同样与项目、Runtime 弹层和资源面板互斥。 */
function openAuthPanel(): void {
  closePanel()
  showingResources.value = false
  showingAuth.value = true
}

function closeAuthPanel(): void {
  showingAuth.value = false
}

async function confirmTrustReset(): Promise<void> {
  if (trustResetBusy.value) return
  trustResetBusy.value = true
  try {
    const failure = await trustStore.resetCurrentProject()
    if (failure !== null) return
    trustStatus.value = await trustStore.queryStatus()
    confirmingTrustReset.value = false
  } finally {
    trustResetBusy.value = false
  }
}

function cancelTrustReset(): void {
  confirmingTrustReset.value = false
}

onMounted(() => {
  window.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <header
    ref="root"
    class="relative z-30 flex h-12 shrink-0 items-center gap-2 border-b border-desk-line bg-desk-surface px-3"
  >
    <button
      type="button"
      class="control-button-sm"
      :aria-expanded="!sidebarCollapsed"
      :disabled="sidebarToggleDisabled"
      @click="emit('toggleSidebar')"
    >
      {{ sidebarCollapsed ? '显示会话' : '隐藏会话' }}
    </button>

    <button
      type="button"
      class="control-button-sm"
      :disabled="!preferencesStore.ready"
      @click="preferencesStore.cycleTheme()"
    >
      {{ themeLabel }}
    </button>

    <div class="relative">
      <button
        type="button"
        class="control-button-sm max-w-56 truncate"
        aria-haspopup="dialog"
        :aria-expanded="openPanel === 'project'"
        @click="togglePanel('project')"
      >
        {{ currentProject?.name ?? '选择项目' }}
      </button>
      <div
        v-if="openPanel === 'project'"
        class="dialog-popover left-0 top-full mt-2"
        role="dialog"
        aria-label="项目切换"
      >
        <div class="scroll-area min-h-0 flex-1 overflow-y-auto p-4">
          <ProjectSwitcher @close="closePanel" />
        </div>
      </div>
    </div>

    <div class="flex min-w-0 flex-1 items-center justify-center">
      <span class="chip truncate" :title="sessionLabel">
        <template v-if="sessionIdShort !== null">
          <span>会话</span>
          <span class="font-mono text-desk-ink">{{ sessionIdShort }}</span>
        </template>
        <template v-else>{{ sessionLabel }}</template>
      </span>
    </div>

    <div class="relative">
      <button
        type="button"
        class="control-button-sm"
        aria-haspopup="dialog"
        :aria-expanded="openPanel === 'runtime'"
        @click="togglePanel('runtime')"
      >
        <span class="status-dot" :class="runtimeDotClass"></span>
        <span :class="runtimeTextClass">{{ runtimeLabel }}</span>
      </button>
      <div
        v-if="openPanel === 'runtime'"
        class="dialog-popover right-0 top-full mt-2 w-96"
        role="dialog"
        aria-label="Runtime 状态"
      >
        <div class="scroll-area min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <div class="flex items-center gap-2">
            <span class="status-dot" :class="runtimeDotClass"></span>
            <span class="dialog-title">{{ runtimeLabel }}</span>
          </div>

          <div v-if="runtimeError" role="alert" class="status-notice status-notice-error">
            {{ runtimeError }}
            <span class="mt-1 block text-desk-muted">异常退出后不会自动重启或重放请求。</span>
          </div>

          <AgentControls v-if="runtimeInfo" />

          <dl v-if="runtimeInfo" class="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <div class="min-w-0">
              <dt class="text-desk-muted">Session</dt>
              <dd class="break-all font-mono">{{ runtimeInfo.sessionId ?? '未提供' }}</dd>
            </div>
            <div>
              <dt class="text-desk-muted">消息数</dt>
              <dd class="font-mono">{{ runtimeInfo.messageCount }}</dd>
            </div>
          </dl>
          <p v-else class="text-xs text-desk-muted">{{ runtimeLabel }}。</p>

          <div v-if="connection.status === 'ready'" class="space-y-2">
            <p class="section-label">应用信息</p>
            <dl class="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
              <div>
                <dt class="text-desk-muted">应用版本</dt>
                <dd class="font-mono">{{ connection.info.appVersion }}</dd>
              </div>
              <div>
                <dt class="text-desk-muted">Electron</dt>
                <dd class="font-mono">{{ connection.info.electronVersion }}</dd>
              </div>
              <div>
                <dt class="text-desk-muted">平台</dt>
                <dd class="font-mono">{{ connection.info.platform }}</dd>
              </div>
              <div>
                <dt class="text-desk-muted">架构</dt>
                <dd class="font-mono">{{ connection.info.arch }}</dd>
              </div>
            </dl>
          </div>
          <p
            v-else-if="connection.status === 'error'"
            role="alert"
            class="status-notice status-notice-error"
          >
            {{ connection.error.message }}
          </p>

          <div class="space-y-2 border-t border-desk-line pt-3">
            <button
              type="button"
              class="control-button w-full"
              :disabled="runtimeView.phase !== 'ready'"
              @click="openForkDialog"
            >
              从历史消息分叉
            </button>

            <button
              type="button"
              class="control-button w-full"
              :disabled="runtimeView.phase !== 'ready'"
              @click="shutdownRuntime"
            >
              关闭 Runtime
            </button>

            <button
              v-if="hasTrustDecision"
              type="button"
              class="control-button-danger w-full"
              @click="resetTrustDecision"
            >
              重置本项目信任决定
            </button>
          </div>
        </div>
      </div>
    </div>

    <button
      type="button"
      class="control-button-sm"
      @click="openResourcePanel"
    >
      Pi 资源
    </button>

    <button
      type="button"
      class="control-button-sm"
      @click="openAuthPanel"
    >
      Provider 认证
    </button>

    <!-- 模态弹层经 Teleport 渲染到 body：遮罩不嵌套在顶栏 z-30 的堆叠上下文里，避免整窗重绘被放大。 -->
    <Teleport to="body">
      <ConfirmDialog
        v-if="confirmingTrustReset"
        title="重置本项目信任决定？"
        description="重置后下次打开或新建该项目的会话时，会重新询问是否信任项目资源；本次正在运行的 Runtime 不受影响。"
        :detail="trustStatusDetail"
        confirm-label="重置决定"
        @confirm="confirmTrustReset"
        @cancel="cancelTrustReset"
      />
    </Teleport>

    <Teleport to="body">
      <ForkDialog v-if="showingFork" @close="closeForkDialog" />
    </Teleport>

    <Teleport to="body">
      <ResourcePanel v-if="showingResources" @close="closeResourcePanel" />
    </Teleport>

    <Teleport to="body">
      <AuthPanel v-if="showingAuth" @close="closeAuthPanel" />
    </Teleport>
  </header>
</template>
