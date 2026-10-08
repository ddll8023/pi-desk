<!-- 顶栏：Sidebar 折叠开关、项目切换入口、当前会话与 Runtime 状态，并在详情弹层里提供模型、Thinking、上下文占用等 Agent 控制与关闭 Runtime；不承载消息与 Prompt 提交。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useDesktopStore } from '../stores/desktop'
import { useProjectStore } from '../stores/project'
import { useRuntimeStore } from '../stores/runtime'
import AgentControls from './AgentControls.vue'
import ProjectSwitcher from './ProjectSwitcher.vue'

defineProps<{
  readonly sidebarCollapsed: boolean
  /** 界面偏好尚未读取完成时禁止切换，避免与存储状态互相覆盖。 */
  readonly sidebarToggleDisabled: boolean
}>()

const emit = defineEmits<{
  toggleSidebar: []
}>()

const desktopStore = useDesktopStore()
const projectStore = useProjectStore()
const runtimeStore = useRuntimeStore()
const { connection } = storeToRefs(desktopStore)
const { currentProject } = storeToRefs(projectStore)
const { view: runtimeView } = storeToRefs(runtimeStore)

/** 弹层互斥：同一时刻只展开一个，点外或 Esc 关闭。 */
const openPanel = ref<'project' | 'runtime' | null>(null)
const root = ref<HTMLElement | null>(null)

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

function togglePanel(panel: 'project' | 'runtime'): void {
  openPanel.value = openPanel.value === panel ? null : panel
}

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
          @click="shutdownRuntime"
        >
          关闭 Runtime
        </button>
      </div>
    </div>
  </header>
</template>
