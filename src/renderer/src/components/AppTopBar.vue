<!-- 顶栏：Sidebar 折叠开关、主题循环切换、项目切换入口、当前会话与 Runtime 状态，并在详情弹层里提供模型、Thinking、上下文占用等 Agent 控制、从历史消息分叉、重置本项目信任决定与关闭 Runtime；另提供 Pi 资源面板入口；不承载消息与 Prompt 提交。 -->
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
/** 分叉弹层挂在顶栏组件内：入口在 Runtime 详情弹层里，弹层本身全局展示。 */
const showingFork = ref(false)
/** Pi 资源面板挂在顶栏组件内：入口是顶栏按钮，弹层本身全局展示。 */
const showingResources = ref(false)

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
  showingResources.value = true
}

function closeResourcePanel(): void {
  showingResources.value = false
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
    class="relative z-30 flex items-center gap-3 border-b border-desk-line bg-desk-surface px-3 py-2"
  >
    <button
      type="button"
      class="icon-button"
      :aria-expanded="!sidebarCollapsed"
      :disabled="sidebarToggleDisabled"
      @click="emit('toggleSidebar')"
    >
      {{ sidebarCollapsed ? '显示会话' : '隐藏会话' }}
    </button>

    <button
      type="button"
      class="icon-button"
      :disabled="!preferencesStore.ready"
      @click="preferencesStore.cycleTheme()"
    >
      {{ themeLabel }}
    </button>

    <div class="relative">
      <button
        type="button"
        class="control-button max-w-64 truncate"
        aria-haspopup="dialog"
        :aria-expanded="openPanel === 'project'"
        @click="togglePanel('project')"
      >
        {{ currentProject?.name ?? '选择项目' }}
      </button>
      <div
        v-if="openPanel === 'project'"
        class="panel absolute left-0 top-full mt-2 w-80 shadow-lg"
        role="dialog"
        aria-label="项目切换"
      >
        <ProjectSwitcher @close="closePanel" />
      </div>
    </div>

    <p class="min-w-0 flex-1 truncate text-center text-xs font-mono text-desk-muted">{{ sessionLabel }}</p>

    <div class="relative">
      <button
        type="button"
        class="icon-button"
        aria-haspopup="dialog"
        :aria-expanded="openPanel === 'runtime'"
        @click="togglePanel('runtime')"
      >
        <span class="status-dot" :class="runtimeDotClass"></span>
        {{ runtimeLabel }}
      </button>
      <div
        v-if="openPanel === 'runtime'"
        class="panel absolute right-0 top-full mt-2 w-80 shadow-lg"
        role="dialog"
        aria-label="Runtime 状态"
      >
        <h2 class="section-heading mb-2">Runtime</h2>
        <p v-if="runtimeError" role="alert" class="mb-3 text-sm text-desk-danger">
          {{ runtimeError }}
          <span class="mt-1 block text-xs text-desk-muted">异常退出后不会自动重启或重放请求。</span>
        </p>
        <AgentControls v-if="runtimeInfo" />
        <dl v-if="runtimeInfo" class="mt-3 grid grid-cols-2 gap-3 text-xs">
          <div>
            <dt class="text-desk-muted">Session</dt>
            <dd class="break-words font-mono">{{ runtimeInfo.sessionId ?? '未提供' }}</dd>
          </div>
          <div>
            <dt class="text-desk-muted">消息数</dt>
            <dd class="font-mono">{{ runtimeInfo.messageCount }}</dd>
          </div>
        </dl>
        <p v-else class="text-sm text-desk-muted">{{ runtimeLabel }}。</p>

        <dl v-if="connection.status === 'ready'" class="mt-4 grid grid-cols-2 gap-3 text-xs">
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
        <p v-else-if="connection.status === 'error'" role="alert" class="mt-4 text-xs text-desk-danger">
          {{ connection.error.message }}
        </p>

        <button
          type="button"
          class="control-button mt-4"
          :disabled="runtimeView.phase !== 'ready'"
          @click="openForkDialog"
        >
          从历史消息分叉
        </button>

        <button
          type="button"
          class="control-button mt-2"
          :disabled="runtimeView.phase !== 'ready'"
          @click="shutdownRuntime"
        >
          关闭 Runtime
        </button>

        <button
          v-if="hasTrustDecision"
          type="button"
          class="control-button mt-2"
          @click="resetTrustDecision"
        >
          重置本项目信任决定
        </button>
      </div>
    </div>

    <button
      type="button"
      class="icon-button"
      @click="openResourcePanel"
    >
      Pi 资源
    </button>

    <ConfirmDialog
      v-if="confirmingTrustReset"
      title="重置本项目信任决定？"
      description="重置后下次打开或新建该项目的会话时，会重新询问是否信任项目资源；本次正在运行的 Runtime 不受影响。"
      :detail="trustStatusDetail"
      confirm-label="重置决定"
      @confirm="confirmTrustReset"
      @cancel="cancelTrustReset"
    />

    <ForkDialog v-if="showingFork" @close="closeForkDialog" />

    <ResourcePanel v-if="showingResources" @close="closeResourcePanel" />
  </header>
</template>
