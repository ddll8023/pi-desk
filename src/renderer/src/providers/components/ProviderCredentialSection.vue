<!-- 供应商凭据摘要与入口：展示可用性提示与认证入口，认证输入和过程反馈交给页面级认证弹窗。
     已有流程提供继续入口；这里不直接启动认证，不持有密钥，删除仍由父级确认。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { AuthMethod, AuthProviderStatus } from '../../../../shared/auth-api'
import { useAuthStore } from '../stores/auth'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly provider: AuthProviderStatus
  readonly runtimeModelProviders: ReadonlySet<string> | null
}>()

const emit = defineEmits<{
  login: [method: AuthMethod]
  resume: []
  'request-remove': []
}>()
const authStore = useAuthStore()
const hasCurrentFlow = computed(() => authStore.activeFlow?.providerId === props.provider.providerId)

/** 只描述当前 Runtime 模型目录，不把已知模型数当作可用模型数。 */
const availabilityLabel = computed(() => {
  if (props.runtimeModelProviders === null) return null
  if (props.runtimeModelProviders.has(props.provider.providerId)) return '当前会话的模型目录已包含这个供应商。'
  return props.provider.configured ? '当前会话尚未加载这个供应商的模型，配置后需重新加载。' : null
})

function actionLabel(method: AuthMethod): string {
  if (method === 'oauth') return `登录：${props.provider.oauthLoginLabel ?? '账户登录'}`
  return '录入 API Key'
}
</script>

<template>
  <div class="provider-credential">
    <div v-if="availabilityLabel !== null || provider.subscription" class="provider-credential__notes">
      <p v-if="availabilityLabel !== null">{{ availabilityLabel }}</p>
      <p v-if="provider.subscription">账户登录由 Provider 订阅支撑。</p>
    </div>
    <div v-if="provider.authTypes.length > 0 || hasCurrentFlow" class="provider-credential__actions">
      <AppButton v-if="hasCurrentFlow" variant="compact" @click="emit('resume')">继续认证</AppButton>
      <template v-else>
        <AppButton
          v-for="method in provider.authTypes"
          :key="`${provider.providerId}-${method}`"
          variant="compact"
          class="provider-credential__login-button"
          :disabled="authStore.flowAction.phase === 'sending' || authStore.activeFlow !== null"
          @click="emit('login', method)"
        >{{ actionLabel(method) }}</AppButton>
      </template>
      <div v-if="provider.storedType !== null" class="provider-credential__removal">
        <AppButton variant="quiet-danger" :disabled="authStore.logoutAction.phase === 'sending'" @click="emit('request-remove')">
          删除已保存凭据
        </AppButton>
      </div>
    </div>
    <p v-else class="provider-credential__external">这个 Provider 的凭据只能在 Pi 外部配置；这里只展示状态。</p>
  </div>
</template>

<style scoped>
.provider-credential {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 1rem;
}

.provider-credential__notes {
  min-width: 0;
  flex: 1 1 18rem;
}

.provider-credential__notes p,
.provider-credential__external {
  margin: 0;
  color: var(--color-desk-muted);
  font-size: 0.75rem;
  line-height: 1.6;
}

.provider-credential__actions {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.provider-credential__login-button,
.provider-credential__refresh-button {
  max-width: 100%;
  height: auto;
  min-height: 2rem;
  white-space: normal;
  overflow-wrap: anywhere;
}

.provider-credential__removal {
  border-left: 1px solid var(--color-desk-line);
  padding-left: 0.5rem;
}
</style>
