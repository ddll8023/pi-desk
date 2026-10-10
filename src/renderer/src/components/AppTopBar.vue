<!-- 顶栏：侧栏折叠开关与当前会话选择入口。 -->
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

const runtimeInfo = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const sessionLabel = computed(() => {
  const sessionId = runtimeInfo.value?.sessionId
  if (typeof sessionId === 'string' && sessionId !== '') return `会话 ${sessionId.slice(0, 8)}`
  return currentProject.value === null ? '未选择项目' : '未打开会话'
})
const sessionIdShort = computed(() => {
  const sessionId = runtimeInfo.value?.sessionId
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId.slice(0, 8) : null
})
</script>

<template>
  <header class="relative z-30 flex h-12 shrink-0 items-center gap-2 border-b border-desk-line bg-desk-surface px-3">
    <AppButton
      variant="compact"
      :aria-expanded="!sidebarCollapsed"
      :disabled="sidebarToggleDisabled"
      @click="emit('toggleSidebar')"
    >
      {{ sidebarCollapsed ? '显示侧栏' : '隐藏侧栏' }}
    </AppButton>

    <div class="flex min-w-0 flex-1 items-center justify-center">
      <AppButton
        variant="unstyled"
        class="chip max-w-72 cursor-pointer truncate"
        :title="`${sessionLabel}；点击选择其他会话`"
        aria-haspopup="dialog"
        @click="sessionStore.openSessionPicker()"
      >
        <template v-if="sessionIdShort !== null">
          <span>会话</span>
          <span class="font-mono text-desk-ink">{{ sessionIdShort }}</span>
        </template>
        <template v-else>{{ sessionLabel }}</template>
      </AppButton>
    </div>
  </header>
</template>
