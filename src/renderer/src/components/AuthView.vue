<!-- Provider 认证视图：按凭据来源分组展示 Provider 状态，提供 API Key 录入、官方 OAuth 登录与取消、退出登录与流程进度。
     只复用 Pi 的认证实现与凭据存储：不读取也不回传已有凭据，密钥只在提交时经一次受限通道，不进入聊天、提示词、偏好或日志。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { AuthError, AuthFlowSnapshot, AuthMethod, AuthProviderStatus } from '../../../shared/auth-api'
import { useAuthStore } from '../stores/auth'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import { copyText } from '../clipboard'
import AppButton from './ui/AppButton.vue'
import ConfirmDialog from './ConfirmDialog.vue'

const authStore = useAuthStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const {
  statusView,
  providers,
  configError,
  flow,
  activeFlow,
  flowAction,
  logoutAction,
  filter,
  configuredOnly,
  secretInput,
  selectInput,
  visibleProviders,
  configuredCount
} = storeToRefs(authStore)

/** 待确认的凭据删除目标；确认后才发出 logout 请求。 */
const pendingCredentialRemoval = ref<AuthProviderStatus | null>(null)
/** 最近一次复制成功的区块标识，只用于给出「已复制」反馈。 */
const copiedBlock = ref<string | null>(null)
/** 最近一次复制失败的区块标识；失败必须可见，不能停在「复制」。 */
const failedBlock = ref<string | null>(null)

const runtimeReady = computed(() => runtimeStore.view.phase === 'ready')
const capabilitiesReady = computed(() => runtimeStore.capabilitiesView.phase === 'ready')

/** 当前 Runtime 里已有可用模型的 Provider；只用于提示「是否已被 Pi 用上」，不代表凭据无效。 */
const availableProviders = computed<ReadonlySet<string>>(() => {
  const view = runtimeStore.capabilitiesView
  if (view.phase !== 'ready') return new Set<string>()
  return new Set(view.data.models.map((model) => model.provider))
})

/**
 * Provider 按凭据来源分组。分组只反映 Pi 报告的来源，不推断归属；
 * 未配置的 Provider 单独成组并排在最后，避免 40 多个 Provider 平铺。
 */
const PROVIDER_GROUPS: readonly { readonly key: string; readonly title: string; readonly hint: string }[] = [
  { key: 'stored', title: '已保存凭据', hint: '由 Pi 保存在它的 auth.json 里；删除后需要重新登录。' },
  { key: 'environment', title: '来自环境变量', hint: '由运行环境提供，这里只能查看状态。' },
  { key: 'runtime', title: '本次运行的临时密钥', hint: '只在当前运行时有效，不做持久化。' },
  { key: 'config', title: 'models.json 配置', hint: '在 Pi 的 models.json 中配置，或由其中的密钥命令解析。' },
  { key: 'unknown', title: '已配置（来源未报告）', hint: 'Pi 解析到了凭据，但没有报告来源。' },
  { key: 'none', title: '未配置', hint: '还没有解析到可用凭据。' }
]

const providerGroups = computed(() => {
  const buckets = new Map<string, AuthProviderStatus[]>(PROVIDER_GROUPS.map((group) => [group.key, []]))
  for (const provider of visibleProviders.value) {
    buckets.get(groupKeyOf(provider))?.push(provider)
  }
  return PROVIDER_GROUPS
    .map((group) => ({ ...group, items: buckets.get(group.key) ?? [] }))
    .filter((group) => group.items.length > 0)
})

/** 已配置但来源未报告的 Provider 归到 `unknown`，不猜测它是从哪来的。 */
function groupKeyOf(provider: AuthProviderStatus): string {
  if (!provider.configured) return 'none'
  return provider.source ?? 'unknown'
}

/**
 * 本视图要展示的认证错误：状态读取、登录流程操作与退出登录各自保留错误，
 * 统一在这里按「面向用户的结论 + 可复制的原始信息」两层展示。
 */
const authErrors = computed(() => {
  const entries: { readonly key: string; readonly error: AuthError }[] = []
  if (statusView.value.phase === 'error') entries.push({ key: 'status', error: statusView.value.error })
  if (flowAction.value.phase === 'error') entries.push({ key: 'flow', error: flowAction.value.error })
  if (logoutAction.value.phase === 'error') entries.push({ key: 'logout', error: logoutAction.value.error })
  return entries
})

/** 登录流程刚结束且 Runtime 就绪时，给出重启式重载的一行提示。 */
const showReloadHint = computed(() => flow.value?.phase === 'completed' && runtimeReady.value)

/** 流程卡片的登录方式文案；与具体 Provider 无关，只反映本次流程用的是哪一类认证。 */
const flowMethodLabel = computed(() => (flow.value?.method === 'oauth' ? '账户登录' : 'API Key'))

function methodLabel(provider: AuthProviderStatus, method: AuthMethod): string {
  if (method === 'oauth') return provider.oauthLoginLabel ?? '账户登录'
  return '录入 API Key'
}

/** 状态文案只描述本地凭据解析结果，不声称上游已接受该凭据。 */
function statusLabel(provider: AuthProviderStatus): string {
  if (!provider.configured) {
    return provider.authTypes.length === 0 ? '凭据只能在 Pi 外部提供' : '未配置'
  }
  switch (provider.source) {
    case 'stored':
      return provider.storedType === 'oauth' ? '已保存账户登录' : '已保存 API Key'
    case 'environment':
      return provider.sourceLabel === null ? '来自环境变量' : `来自环境变量 ${provider.sourceLabel}`
    case 'runtime':
      return '来自本次运行的临时密钥'
    case 'config':
      return '来自 models.json 配置'
    default:
      return '已配置'
  }
}

/** 模型可用性提示：只说明当前 Runtime 的快照里有没有该 Provider 的模型。 */
function availabilityLabel(provider: AuthProviderStatus): string | null {
  if (!capabilitiesReady.value) return null
  if (availableProviders.value.has(provider.providerId)) return `Runtime 有 ${provider.modelCount} 个模型可用`
  if (!provider.configured) return null
  return 'Runtime 里还没有它的可用模型；可能需要重新加载'
}

function promptPlaceholder(snapshot: AuthFlowSnapshot): string {
  const placeholder = snapshot.prompt?.placeholder ?? null
  if (placeholder !== null && placeholder !== '') return placeholder
  return snapshot.prompt?.kind === 'secret' ? '粘贴密钥后提交' : '输入后提交'
}

function phaseLabel(snapshot: AuthFlowSnapshot | null): string {
  if (snapshot === null) return ''
  switch (snapshot.phase) {
    case 'waiting': return '进行中'
    case 'prompt': return '等待输入'
    case 'cancelling': return '正在取消'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
  }
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

/** 删除凭据不可逆：先经确认对话框，确认后才把请求交给主进程。 */
function confirmCredentialRemoval(): void {
  const provider = pendingCredentialRemoval.value
  pendingCredentialRemoval.value = null
  if (provider === null) return
  void authStore.logout(provider.providerId)
}

/** 重新加载 Runtime：复用既有重启式重载与中断确认链，让 Pi 重新读取凭据与模型目录。 */
function reloadRuntime(): void {
  void sessionStore.reloadCurrent()
}

// 认证状态与流程订阅只在视图挂载期间存在；离开子页即释放。
onMounted(() => {
  void authStore.initialize()
})

onUnmounted(() => {
  authStore.dispose()
})
</script>

<template>
  <div class="space-y-4">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">Provider 认证</h1>
      <p class="mt-1 text-sm text-desk-muted">
        凭据由 Pi 自己保存到它的 auth.json；这里只显示本地是否解析到凭据与它的来源。
      </p>
    </header>

    <div class="flex flex-wrap items-center gap-2">
      <AppButton
        :disabled="statusView.phase === 'loading'"
        @click="authStore.refresh()"
      >
        {{ statusView.phase === 'loading' ? '正在读取…' : '重新读取状态' }}
      </AppButton>
      <span v-if="statusView.phase === 'ready'" class="chip">
        已配置 {{ configuredCount }} / {{ authStore.providers.length }}
      </span>
      <div class="segment ml-auto" role="group" aria-label="Provider 过滤范围">
        <AppButton
          variant="unstyled"
          class="segment-option"
          :class="configuredOnly ? '' : 'is-selected'"
          :aria-pressed="!configuredOnly"
          @click="configuredOnly = false"
        >
          全部
        </AppButton>
        <AppButton
          variant="unstyled"
          class="segment-option"
          :class="configuredOnly ? 'is-selected' : ''"
          :aria-pressed="configuredOnly"
          @click="configuredOnly = true"
        >
          只看已配置
        </AppButton>
      </div>
    </div>

    <!-- 错误分层：结论在上一层，原始文本与辅助进程诊断收在可复制的细节里。 -->
    <div
      v-for="entry in authErrors"
      :key="`auth-error-${entry.key}`"
      role="alert"
      class="status-notice status-notice-error"
    >
      <p>{{ entry.error.message }}</p>
      <details v-if="entry.error.detail !== null">
        <summary class="mt-1 text-2xs">技术细节</summary>
        <div class="technical-detail">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-2xs text-desk-muted">原始信息</span>
            <AppButton
              variant="unstyled"
              class="copy-button"
              @click="copy(`error-${entry.key}`, entry.error.detail ?? '')"
            >
              {{ copyLabel(`error-${entry.key}`) }}
            </AppButton>
          </div>
          <pre class="technical-detail-text">{{ entry.error.detail }}</pre>
        </div>
      </details>
    </div>

    <p v-if="configError !== null" role="alert" class="status-notice status-notice-error">
      Pi 报告的本地认证或模型状态问题：{{ configError }}
    </p>

    <!-- 登录流程：进度、设备码、等待输入与取消都在这里；密钥输入为掩码且提交后立即清空。 -->
    <section v-if="activeFlow !== null && flow !== null" class="panel-section">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="panel-section-title">{{ flow.providerId }}</h2>
        <span class="chip">{{ flowMethodLabel }} · {{ phaseLabel(flow) }}</span>
      </div>

      <p v-if="flow.prompt === null" class="hint-text">
        流程正在进行；如果浏览器已经打开授权页，请在浏览器中完成登录。这里的进度来自 Pi。
      </p>

      <p v-if="flow.message !== null" class="hint-text">{{ flow.message }}</p>

      <dl v-if="flow.deviceCode !== null" class="space-y-0.5 text-xs">
        <div class="flex flex-wrap items-baseline gap-1.5">
          <dt class="text-desk-muted">设备码</dt>
          <dd class="font-mono">{{ flow.deviceCode.userCode }}</dd>
        </div>
        <div class="flex flex-wrap items-baseline gap-1.5">
          <dt class="text-desk-muted">验证地址</dt>
          <dd class="break-all font-mono">{{ flow.deviceCode.verificationUri }}</dd>
        </div>
      </dl>

      <ul v-if="flow.messages.length > 0" class="space-y-0.5">
        <li
          v-for="(message, index) in flow.messages"
          :key="`flow-message-${index}`"
          class="whitespace-pre-wrap break-words text-xs text-desk-muted"
        >{{ message }}</li>
      </ul>

      <div v-if="flow.hasOpenableUrl" class="space-y-1">
        <AppButton
          :disabled="flowAction.phase === 'sending'"
          @click="authStore.openUrl()"
        >
          {{ flow.browserOpened ? '再次在系统浏览器中打开' : '在系统浏览器中打开授权页' }}
        </AppButton>
        <p v-if="flow.browserOpened" class="hint-text">授权页已交给系统浏览器打开。</p>
      </div>

      <form
        v-if="flow.prompt !== null"
        class="space-y-2"
        @submit.prevent="authStore.respond()"
      >
        <p class="text-xs">{{ flow.prompt.message }}</p>

        <div v-if="flow.prompt.kind === 'select'" class="space-y-1.5">
          <label
            v-for="option in flow.prompt.options"
            :key="option.id"
            class="list-card flex items-start gap-2 text-xs"
          >
            <input v-model="selectInput" type="radio" :value="option.id" name="auth-select">
            <span>
              {{ option.label }}
              <span
                v-if="option.description !== null"
                class="block text-2xs text-desk-muted"
              >{{ option.description }}</span>
            </span>
          </label>
        </div>

        <input
          v-else
          v-model="secretInput"
          :type="flow.prompt.kind === 'secret' ? 'password' : 'text'"
          :placeholder="promptPlaceholder(flow)"
          autocomplete="off"
          spellcheck="false"
          class="text-control"
        >

        <div class="flex flex-wrap items-center gap-2">
          <AppButton type="submit" variant="primary" :disabled="flowAction.phase === 'sending'">
            {{ flowAction.phase === 'sending' ? '正在提交…' : '提交' }}
          </AppButton>
          <AppButton :disabled="flowAction.phase === 'sending'" @click="authStore.cancel()">
            取消登录
          </AppButton>
        </div>
      </form>

      <div v-else>
        <AppButton :disabled="flowAction.phase === 'sending'" @click="authStore.cancel()">
          取消登录
        </AppButton>
      </div>
    </section>

    <!-- 流程结束后只留一行结论，不把列表整体下推。 -->
    <div v-else-if="flow !== null" role="status" class="status-notice">
      <p>
        {{ flow.providerId }} · {{ flowMethodLabel }} {{ phaseLabel(flow) }}<span v-if="flow.message !== null">：{{ flow.message }}</span>
      </p>
      <p v-if="showReloadHint" class="mt-1">
        凭据已交由 Pi 保存。新配置的 Provider 只有在 Runtime 重新启动后才会出现在可用模型里。
      </p>
      <AppButton
        v-if="showReloadHint"
        variant="compact"
        class="mt-2"
        :disabled="sessionStore.opening"
        @click="reloadRuntime"
      >
        {{ sessionStore.opening ? '正在重新加载…' : '重新加载 Runtime（保留会话）' }}
      </AppButton>
    </div>

    <section v-if="statusView.phase === 'ready'" class="panel-section">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="panel-section-title">Provider</h2>
        <input
          v-model="filter"
          type="search"
          placeholder="按名称或 provider 过滤"
          class="text-control sm:max-w-64"
        >
      </div>

      <p v-if="visibleProviders.length === 0" class="hint-text">
        {{ providers.length === 0 ? 'Pi 没有报告任何 Provider。' : '没有匹配的 Provider。' }}
      </p>

      <section
        v-for="group in providerGroups"
        :key="group.key"
        class="space-y-1.5"
      >
        <div class="flex flex-wrap items-baseline gap-2">
          <h3 class="text-xs font-semibold">{{ group.title }}</h3>
          <span class="chip">{{ group.items.length }}</span>
        </div>
        <p class="hint-text">{{ group.hint }}</p>

        <ul class="space-y-1.5">
          <li
            v-for="provider in group.items"
            :key="provider.providerId"
            class="list-card"
          >
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <p class="text-sm font-medium">
                {{ provider.name }}
                <span class="ml-1 font-mono text-2xs text-desk-muted">{{ provider.providerId }}</span>
              </p>
              <p class="text-2xs text-desk-muted">
                {{ statusLabel(provider) }}<span v-if="provider.subscription">（订阅账户）</span>
              </p>
            </div>

            <p
              v-if="availabilityLabel(provider) !== null"
              class="mt-0.5 text-2xs text-desk-muted"
            >
              {{ provider.modelCount }} 个已知模型 · {{ availabilityLabel(provider) }}
            </p>
            <p v-else class="mt-0.5 text-2xs text-desk-muted">{{ provider.modelCount }} 个已知模型</p>

            <div v-if="provider.authTypes.length > 0" class="mt-2 flex flex-wrap items-center gap-2">
              <AppButton
                v-for="method in provider.authTypes"
                :key="`${provider.providerId}-${method}`"
                variant="compact"
                :disabled="flowAction.phase === 'sending' || activeFlow !== null"
                @click="authStore.login(provider.providerId, method)"
              >
                {{ method === 'oauth' ? `登录：${methodLabel(provider, method)}` : '录入 API Key' }}
              </AppButton>
              <AppButton
                v-if="provider.storedType !== null"
                variant="quiet-danger"
                class="ml-auto"
                :disabled="logoutAction.phase === 'sending'"
                @click="pendingCredentialRemoval = provider"
              >
                删除已保存凭据
              </AppButton>
            </div>
            <p v-else class="mt-1 text-2xs text-desk-muted">
              这个 Provider 的凭据只能在 Pi 外部配置；这里只展示状态。
            </p>
          </li>
        </ul>
      </section>
    </section>

    <section class="panel-section">
      <h2 class="panel-section-title">边界说明</h2>
      <ul class="list-disc space-y-1 pl-4 text-xs leading-5 text-desk-muted">
        <li>提交的密钥只经一次受限通道交给 Pi，不进入聊天、提示词、偏好或日志；已保存的凭据不会回传到页面。</li>
        <li>OAuth 由 Pi 的官方实现完成：回调地址与状态校验都在它自己的进程内，Desktop 只把授权页交给系统浏览器。</li>
        <li>退出登录只删除 Pi 保存的凭据，不影响环境变量与 models.json 里配置的凭据或密钥命令。</li>
        <li>凭据变化后运行中的 Runtime 仍使用启动时的可用模型快照，需要重新加载才能看到新 Provider 的模型。</li>
      </ul>
    </section>

    <Teleport to="body">
      <ConfirmDialog
        :open="pendingCredentialRemoval !== null"
        title="删除已保存的凭据？"
        description="只删除 Pi 为这个 Provider 保存在 auth.json 里的凭据，不影响环境变量与 models.json 里配置的凭据或密钥命令，也不会在 Provider 侧撤销该凭据。"
        :detail="pendingCredentialRemoval === null ? '' : `${pendingCredentialRemoval.name}（${pendingCredentialRemoval.providerId}）`"
        confirm-label="删除凭据"
        @confirm="confirmCredentialRemoval"
        @cancel="pendingCredentialRemoval = null"
      />
    </Teleport>
  </div>
</template>
