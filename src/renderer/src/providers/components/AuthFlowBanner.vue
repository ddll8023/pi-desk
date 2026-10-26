<!-- 认证流程摘要：页面只保留一行状态与继续入口，输入和授权明细由认证弹窗承载。
     摘要不持有凭据输入，也不改变 Store 中的认证生命周期；完成后仍提供会话重载入口。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useRuntimeStore } from '../../sessions/stores/runtime'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly providerName: string
  readonly starting: boolean
  readonly startFailed: boolean
  readonly reloading: boolean
}>()

const emit = defineEmits<{ resume: []; reload: [] }>()
const authStore = useAuthStore()
const runtimeStore = useRuntimeStore()

const phaseLabel = computed(() => {
  if (props.starting) return '正在启动认证…'
  if (props.startFailed) return '认证未能启动'
  switch (authStore.flow?.phase) {
    case 'waiting': return '认证进行中'
    case 'prompt': return '等待输入'
    case 'cancelling': return '正在取消认证…'
    case 'completed': return '认证已完成，运行中的会话需重新加载'
    case 'failed': return '认证失败'
    case 'cancelled': return '认证已取消'
    default: return '查看认证信息'
  }
})
const showReload = computed(() => !props.starting && !props.startFailed
  && authStore.flow?.phase === 'completed' && runtimeStore.view.phase === 'ready')
const isError = computed(() => props.startFailed || (!props.starting && authStore.flow?.phase === 'failed'))
</script>

<template>
  <div class="auth-flow" :class="{ 'is-error': isError }">
    <p role="status" class="auth-flow__summary">
      <strong>{{ providerName }}</strong>
      <span>{{ phaseLabel }}</span>
    </p>
    <div class="auth-flow__actions">
      <AppButton variant="ghost" :disabled="starting" @click="emit('resume')">
        {{ authStore.activeFlow !== null ? '继续认证' : '查看详情' }}
      </AppButton>
      <AppButton v-if="showReload" variant="compact" :disabled="reloading" @click="emit('reload')">
        {{ reloading ? '正在重新加载…' : '重新加载会话' }}
      </AppButton>
    </div>
  </div>
</template>

<style scoped>
.auth-flow {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.375rem 1rem;
  border-bottom: 1px solid var(--color-desk-line);
  padding: 0.5rem 0;
  font-size: 0.75rem;
}

.auth-flow__summary {
  display: flex;
  min-width: 0;
  flex: 1 1 16rem;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 0.625rem;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--color-desk-muted);
}

.auth-flow__summary strong {
  color: var(--color-desk-ink);
  font-weight: 600;
}

.auth-flow.is-error .auth-flow__summary {
  color: var(--color-desk-danger);
}

.auth-flow__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
</style>
