<!-- 全宽顶部栏：自绘窗口标题栏，呈现侧栏开关、应用名、当前会话与项目、Runtime 状态与右侧面板开关；macOS 预留原生红绿灯位。模型选择已下沉到输入坞。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useDesktopStore } from '../stores/desktop'
import { useProjectStore } from '../stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import AppButton from './ui/AppButton.vue'

defineProps<{
  readonly sidebarCollapsed: boolean
  readonly rightPanelOpen: boolean
  /** 界面偏好尚未读取完成时禁止切换，避免与存储状态互相覆盖；两个开关共用。 */
  readonly sidebarToggleDisabled: boolean
}>()

const emit = defineEmits<{
  toggleSidebar: []
  toggleRightPanel: []
}>()

const desktopStore = useDesktopStore()
const projectStore = useProjectStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const { connection } = storeToRefs(desktopStore)
const { currentProject } = storeToRefs(projectStore)
const { view: runtimeView } = storeToRefs(runtimeStore)
const { sessions } = storeToRefs(sessionStore)

/** macOS 用 hiddenInset 保留原生红绿灯，顶部栏左侧要让出它们占的宽度；其他平台不需要。 */
const reservesTrafficLights = computed(() => (
  connection.value.status === 'ready' && connection.value.info.platform === 'darwin'
))

const runtimeInfo = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const sessionId = computed(() => runtimeInfo.value?.sessionId ?? null)
const currentSession = computed(() => (
  sessionId.value === null
    ? null
    : sessions.value.find((session) => session.sessionId === sessionId.value) ?? null
))
const sessionTitle = computed(() => {
  if (currentSession.value?.preview) return currentSession.value.preview
  if (sessionId.value !== null) return `会话 ${sessionId.value.slice(0, 8)}`
  return currentProject.value === null ? '未选择项目' : '新会话'
})
const runtimeStatus = computed(() => {
  const runtime = runtimeView.value
  if (runtime.phase === 'starting') return { label: 'Pi 启动中', kind: 'pending' }
  if (runtime.phase === 'stopping') return { label: 'Pi 关闭中', kind: 'pending' }
  if (runtime.phase === 'failed') return { label: 'Pi 异常', kind: 'error' }
  if (runtime.phase === 'ready' && runtime.snapshot.info?.isStreaming === true) {
    return { label: 'Agent 运行中', kind: 'active' }
  }
  if (runtime.phase === 'ready') return { label: 'Pi 就绪', kind: 'ready' }
  return { label: 'Pi 未启动', kind: 'idle' }
})
const projectPath = computed(() => currentProject.value?.path ?? '尚未选择项目')
const sessionTitleText = computed(() => (
  sessionId.value === null ? sessionTitle.value : `${sessionTitle.value} · ${sessionId.value}`
))
</script>

<template>
  <header class="app-titlebar">
    <!-- 红绿灯占位：只作布局留白，不接收指针事件，也不进入无障碍树。 -->
    <span v-if="reservesTrafficLights" class="app-titlebar-traffic-pad" aria-hidden="true"></span>

    <AppButton
      variant="icon"
      class="app-titlebar-toggle"
      :aria-expanded="!sidebarCollapsed"
      :aria-label="sidebarCollapsed ? '展开导航栏' : '收起导航栏'"
      :title="sidebarCollapsed ? '展开导航栏' : '收起导航栏'"
      :disabled="sidebarToggleDisabled"
      @click="emit('toggleSidebar')"
    >
      <!-- 导航栏图标：外框加左列，展开时左列填实；与右侧面板开关同一套画法，左右对称。 -->
      <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect v-if="!sidebarCollapsed" x="4" y="6" width="4.4" height="12" rx="1" fill="currentColor" stroke="none" />
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M9 4v16" />
      </svg>
    </AppButton>

    <span class="app-titlebar-app-name">Pi Desktop</span>

    <div class="app-titlebar-context">
      <AppButton
        variant="unstyled"
        class="app-titlebar-session"
        :title="`${sessionTitleText}；点击选择其他会话`"
        :disabled="currentProject === null"
        aria-haspopup="dialog"
        @click="sessionStore.openSessionPicker()"
      >
        {{ sessionTitle }}
      </AppButton>
      <span class="app-titlebar-project" :title="projectPath">{{ projectPath }}</span>
    </div>

    <!-- 窗口拖动区：只占控件之间的空白，控件群周围不再顺带可拖动，避免误拖与误双击最大化。 -->
    <span class="app-titlebar-drag" aria-hidden="true"></span>

    <span v-if="runtimeStatus.kind !== 'idle'" class="app-runtime-status" :class="`is-${runtimeStatus.kind}`" role="status">
      <span class="app-runtime-status-dot" aria-hidden="true"></span>
      {{ runtimeStatus.label }}
    </span>

    <AppButton
      variant="icon"
      class="app-titlebar-toggle"
      :aria-expanded="rightPanelOpen"
      :aria-label="rightPanelOpen ? '收起右侧面板' : '展开右侧面板'"
      :title="rightPanelOpen ? '收起右侧面板' : '展开右侧面板'"
      :disabled="sidebarToggleDisabled"
      @click="emit('toggleRightPanel')"
    >
      <!-- 右侧面板图标：外框加右列，展开时右列填实；与左侧导航栏图标同一套画法，一眼看出管的是哪一侧。 -->
      <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect v-if="rightPanelOpen" x="15.6" y="6" width="4.4" height="12" rx="1" fill="currentColor" stroke="none" />
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M15 4v16" />
      </svg>
    </AppButton>
  </header>
</template>
