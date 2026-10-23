<!-- Provider 凭据区块：展示一个 Provider 的凭据可用性，并提供录入 API Key、账户登录与删除已保存凭据的入口。
     供应商名称、id 与凭据状态由所在清单行给出，这里只补充行上没有的可用性提示与动作；
     只读 Pi 报告的凭据状态，不回传任何凭据内容；删除不可逆，确认对话框由父级持有。 -->
<script setup lang="ts">
import type { AuthMethod, AuthProviderStatus } from '../../../../shared/auth-api'
import { useAuthStore } from '../stores/auth'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  /** 要展示的 Provider 状态；不含凭据内容。 */
  provider: AuthProviderStatus
  /** Runtime 能力快照里已有模型的 Provider；null 表示能力未就绪，此时不给可用性提示。 */
  runtimeModelProviders: ReadonlySet<string> | null
}>()

const emit = defineEmits<{ (event: 'request-remove'): void }>()

const authStore = useAuthStore()

function methodLabel(provider: AuthProviderStatus, method: AuthMethod): string {
  if (method === 'oauth') return provider.oauthLoginLabel ?? '账户登录'
  return '录入 API Key'
}

/** 模型可用性提示：只说明当前 Runtime 的快照里有没有该 Provider 的模型。 */
function availabilityLabel(): string | null {
  if (props.runtimeModelProviders === null) return null
  if (props.runtimeModelProviders.has(props.provider.providerId)) {
    return `Runtime 里已有 ${props.provider.modelCount} 个可用模型`
  }
  if (!props.provider.configured) return null
  return 'Runtime 里还没有它的可用模型；可能需要重新加载'
}
</script>

<template>
  <div class="provider-credential">
    <p v-if="availabilityLabel() !== null" class="provider-credential__note">
      {{ availabilityLabel() }}
    </p>
    <p v-if="provider.subscription" class="provider-credential__note">
      账户登录由 Provider 订阅支撑。
    </p>

    <div v-if="provider.authTypes.length > 0" class="provider-credential__actions">
      <AppButton
        v-for="method in provider.authTypes"
        :key="`${provider.providerId}-${method}`"
        variant="compact"
        :disabled="authStore.flowAction.phase === 'sending' || authStore.activeFlow !== null"
        @click="authStore.login(provider.providerId, method)"
      >
        {{ method === 'oauth' ? `登录：${methodLabel(provider, method)}` : '录入 API Key' }}
      </AppButton>
      <AppButton
        v-if="provider.storedType !== null"
        variant="quiet-danger"
        class="ml-auto"
        :disabled="authStore.logoutAction.phase === 'sending'"
        @click="emit('request-remove')"
      >
        删除已保存凭据
      </AppButton>
    </div>
    <p v-else class="provider-credential__note">
      这个 Provider 的凭据只能在 Pi 外部配置；这里只展示状态。
    </p>
  </div>
</template>

<style scoped>
.provider-credential {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
}

.provider-credential__note {
  flex: 1 1 18rem;
  margin: 0;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
  line-height: 1.55;
}

.provider-credential__actions {
  display: flex;
  flex: 0 1 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
}

.provider-credential__actions :deep(.control-button-quiet-danger) {
  margin-left: 0.25rem;
}

@media (max-width: 600px) {
  .provider-credential__actions {
    flex-basis: 100%;
  }
}
</style>
