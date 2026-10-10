<!-- 中央工作区顶栏：呈现当前项目、会话摘要与 Runtime 状态，并按窗口模式切换侧栏。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useProjectStore } from '../stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import AppButton from './ui/AppButton.vue'

defineProps<{
  readonly sidebarCollapsed: boolean
  /** 界面偏好尚未读取完成时禁止切换，避免与存储状态互相覆盖。 */
  readonly sidebarToggleDisabled: boolean
}>()

const emit = defineEmits<{
  toggleSidebar: []
}>()

const projectStore = useProjectStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const { currentProject } = storeToRefs(projectStore)
const { view: runtimeView } = storeToRefs(runtimeStore)
const { sessions } = storeToRefs(sessionStore)

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
  if (runtime.phase === 'ready' && runtime.snapshot.info.isStreaming) {
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
  <header class="app-topbar">
    <AppButton
      variant="compact"
      class="app-sidebar-toggle"
      :aria-expanded="!sidebarCollapsed"
      :aria-label="sidebarCollapsed ? '展开导航栏' : '收起导航栏'"
      :disabled="sidebarToggleDisabled"
      @click="emit('toggleSidebar')"
    >
      <span aria-hidden="true">{{ sidebarCollapsed ? '☰' : '‹' }}</span>
      <span>{{ sidebarCollapsed ? '导航' : '收起' }}</span>
    </AppButton>

    <div class="app-topbar-context">
      <AppButton
        variant="unstyled"
        class="app-topbar-session"
        :title="`${sessionTitleText}；点击选择其他会话`"
        :disabled="currentProject === null"
        aria-haspopup="dialog"
        @click="sessionStore.openSessionPicker()"
      >
        {{ sessionTitle }}
      </AppButton>
      <span class="app-topbar-project" :title="projectPath">{{ projectPath }}</span>
    </div>

    <span class="app-runtime-status" :class="`is-${runtimeStatus.kind}`" role="status">
      <span class="app-runtime-status-dot" aria-hidden="true"></span>
      {{ runtimeStatus.label }}
    </span>
  </header>
</template>
