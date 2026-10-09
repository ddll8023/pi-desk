<!-- 认证面板：展示 Provider 与认证状态，提供 API Key 录入、官方 OAuth 登录与取消、退出登录与流程进度展示；只复用 Pi 的认证实现与凭据存储，不读取也不回传已有凭据，密钥不进入聊天、提示词与日志。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import type { AuthFlowSnapshot, AuthMethod, AuthProviderStatus } from '../../../shared/auth-api'
import { useAuthStore } from '../stores/auth'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'

const emit = defineEmits<{ close: [] }>()

const authStore = useAuthStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const {
  statusView,
  configError,
  flow,
  activeFlow,
  flowAction,
  logoutAction,
  filter,
  secretInput,
  selectInput,
  visibleProviders,
  configuredCount
} = storeToRefs(authStore)

const runtimeReady = computed(() => runtimeStore.view.phase === 'ready')
const capabilitiesReady = computed(() => runtimeStore.capabilitiesView.phase === 'ready')
/** 当前 Runtime 里已有可用模型的 Provider；只用于提示「是否已被 Pi 用上」，不代表凭据无效。 */
const availableProviders = computed<ReadonlySet<string>>(() => {
  const view = runtimeStore.capabilitiesView
  if (view.phase !== 'ready') return new Set<string>()
  return new Set(view.data.models.map((model) => model.provider))
})

/** 刚保存过凭据时给出重启式重载入口：Pi 只在进程启动时构建可用模型快照。 */
const showReloadHint = computed(() => flow.value?.phase === 'completed' && runtimeReady.value)

function methodLabel(provider: AuthProviderStatus, method: AuthMethod): string {
  if (method === 'oauth') return provider.oauthLoginLabel ?? '账户登录'
  return 'API Key'
}

/** 状态文案只描述本地凭据解析结果，不声称上游已接受该凭据。 */
function statusLabel(provider: AuthProviderStatus): string {
  if (!provider.configured) {
    return provider.authTypes.length === 0
      ? '未配置：凭据需要在 Pi 外部提供（环境变量或 models.json）'
      : '未配置'
  }
  switch (provider.source) {
    case 'stored':
      return `已保存凭据（${provider.storedType === 'oauth' ? '账户登录' : 'API Key'}）`
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
  if (availableProviders.value.has(provider.providerId)) return `当前 Runtime 有 ${provider.modelCount} 个模型可用`
  if (!provider.configured) return null
  return '当前 Runtime 没有它的可用模型（可能需要重新加载 Runtime）'
}

function promptPlaceholder(snapshot: AuthFlowSnapshot): string {
  const placeholder = snapshot.prompt?.placeholder ?? null
  if (placeholder !== null && placeholder !== '') return placeholder
  return snapshot.prompt?.kind === 'secret' ? '粘贴密钥后提交' : '输入后提交'
}

/** 流程卡片的登录方式文案；与具体 Provider 无关，只反映本次流程用的是哪一类认证。 */
const flowMethodLabel = computed(() => (flow.value?.method === 'oauth' ? '账户登录' : 'API Key'))

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

function close(): void {
  emit('close')
}

/** 重新加载 Runtime：复用既有重启式重载与中断确认链，让 Pi 重新读取凭据与模型目录。 */
function reloadRuntime(): void {
  void sessionStore.reloadCurrent()
}

onMounted(() => {
  void authStore.initialize()
})

onUnmounted(() => {
  authStore.dispose()
})
</script>

<template>
  <div class="dialog-overlay" @click.self="close">
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Provider 与认证"
      class="dialog-panel max-w-2xl"
    >
      <div class="dialog-header">
        <div class="min-w-0">
          <h2 class="dialog-title">Provider 与认证</h2>
          <p class="mt-1 text-xs text-desk-muted">
            凭据由 Pi 自己的认证实现保存到它的 auth.json；这里只调用同一实现，不建立第二套凭据文件。
            状态只表示本地是否解析到凭据，不代表上游已接受它。密钥只在提交时经过一次受限通道，
            不进入聊天、提示词、桌面偏好或常规日志，主进程也不会回传任何已有凭据。
          </p>
        </div>
        <button type="button" class="control-button-sm" @click="close">关闭</button>
      </div>

      <div class="scroll-area dialog-body">
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="control-button"
            :disabled="statusView.phase === 'loading'"
            @click="authStore.refresh()"
          >
            {{ statusView.phase === 'loading' ? '正在读取…' : '重新读取认证状态' }}
          </button>
          <span v-if="statusView.phase === 'ready'" class="chip">
            已配置 {{ configuredCount }} / {{ authStore.providers.length }} 个 Provider
          </span>
        </div>

        <p v-if="statusView.phase === 'error'" role="alert" class="status-notice status-notice-error">
          {{ statusView.error.message }}
        </p>

        <p v-if="configError !== null" role="alert" class="status-notice status-notice-error">
          Pi 报告的本地认证或模型状态问题：{{ configError }}
        </p>

        <div v-if="showReloadHint" role="status" class="status-notice">
          凭据已交由 Pi 保存。新配置的 Provider 只有在 Runtime 重新启动后才会出现在可用模型与模型选择里；
          重新加载会重启 Runtime 并保留当前会话。
          <button
            type="button"
            class="control-button mt-2"
            :disabled="sessionStore.opening"
            @click="reloadRuntime"
          >
            {{ sessionStore.opening ? '正在重新加载…' : '重新加载 Runtime（保留会话）' }}
          </button>
        </div>

        <!-- 登录流程：进度、设备码、等待输入与取消都在这里；密钥输入为掩码且提交后立即清空。 -->
        <section
          v-if="flow !== null"
          class="space-y-2 rounded-desk-sm border border-desk-line bg-desk-canvas p-3"
        >
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="section-heading">{{ flow.providerId }}</h3>
            <span class="chip">{{ flowMethodLabel }} · {{ phaseLabel(flow) }}</span>
          </div>

          <p v-if="flow.prompt === null && activeFlow !== null" class="text-xs text-desk-muted">
            流程正在进行；如果浏览器已经打开授权页，请在浏览器中完成登录。这里的进度来自 Pi。
          </p>

          <p v-if="flow.message !== null" class="text-xs text-desk-muted">{{ flow.message }}</p>

          <div v-if="flow.deviceCode !== null" class="space-y-0.5 text-xs">
            <p>设备码：<span class="font-mono">{{ flow.deviceCode.userCode }}</span></p>
            <p class="break-all">
              验证地址：<span class="font-mono">{{ flow.deviceCode.verificationUri }}</span>
            </p>
          </div>

          <ul v-if="flow.messages.length > 0" class="space-y-0.5">
            <li
              v-for="(message, index) in flow.messages"
              :key="`flow-message-${index}`"
              class="whitespace-pre-wrap break-words text-xs text-desk-muted"
            >{{ message }}</li>
          </ul>

          <div v-if="activeFlow !== null && flow.hasOpenableUrl">
            <button
              type="button"
              class="control-button"
              :disabled="flowAction.phase === 'sending'"
              @click="authStore.openUrl()"
            >
              {{ flow.browserOpened ? '再次在系统浏览器中打开' : '在系统浏览器中打开授权页' }}
            </button>
            <p v-if="flow.browserOpened" class="mt-1 text-xs text-desk-muted">授权页已交给系统浏览器打开。</p>
          </div>

          <form
            v-if="activeFlow !== null && flow !== null && flow.prompt !== null"
            class="space-y-2"
            @submit.prevent="authStore.respond()"
          >
            <p class="text-xs">{{ flow.prompt.message }}</p>

            <div v-if="flow.prompt.kind === 'select'" class="space-y-0.5">
              <label
                v-for="option in flow.prompt.options"
                :key="option.id"
                class="list-item flex items-start gap-2 border-desk-line text-xs"
              >
                <input v-model="selectInput" type="radio" :value="option.id" name="auth-select">
                <span>
                  {{ option.label }}
                  <span v-if="option.description !== null" class="block text-2xs text-desk-muted">{{ option.description }}</span>
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
              <button
                type="submit"
                class="control-button-primary"
                :disabled="flowAction.phase === 'sending'"
              >
                {{ flowAction.phase === 'sending' ? '正在提交…' : '提交' }}
              </button>
              <button
                type="button"
                class="control-button"
                :disabled="flowAction.phase === 'sending'"
                @click="authStore.cancel()"
              >
                取消登录
              </button>
            </div>
          </form>

          <div v-else-if="activeFlow !== null">
            <button
              type="button"
              class="control-button"
              :disabled="flowAction.phase === 'sending'"
              @click="authStore.cancel()"
            >
              取消登录
            </button>
          </div>

          <p v-if="flowAction.phase === 'error'" role="alert" class="status-notice status-notice-error">
            {{ flowAction.error.message }}
          </p>
        </section>

        <section v-if="statusView.phase === 'ready'" class="space-y-2">
          <h3 class="section-heading">Provider</h3>
          <input
            v-model="filter"
            type="search"
            placeholder="按名称或 provider 过滤"
            class="text-control"
          >

          <p v-if="visibleProviders.length === 0" class="text-xs text-desk-muted">
            没有匹配的 Provider。
          </p>
          <ul v-else class="space-y-0.5">
            <li
              v-for="provider in visibleProviders"
              :key="provider.providerId"
              class="list-item border-desk-line"
            >
              <div class="flex flex-wrap items-baseline justify-between gap-2">
                <p class="text-xs font-semibold">
                  {{ provider.name }}
                  <span class="ml-1 font-mono text-2xs text-desk-muted">{{ provider.providerId }}</span>
                </p>
                <p class="text-2xs text-desk-muted">{{ provider.modelCount }} 个已知模型</p>
              </div>
              <p class="mt-0.5 text-2xs" :class="provider.configured ? 'text-desk-ink' : 'text-desk-muted'">
                {{ statusLabel(provider) }}
                <span v-if="provider.subscription" class="ml-1">（订阅账户）</span>
              </p>
              <p v-if="availabilityLabel(provider) !== null" class="text-2xs text-desk-muted">
                {{ availabilityLabel(provider) }}
              </p>
              <div v-if="provider.authTypes.length > 0" class="mt-1.5 flex flex-wrap items-center gap-2">
                <button
                  v-for="method in provider.authTypes"
                  :key="`${provider.providerId}-${method}`"
                  type="button"
                  class="control-button-sm"
                  :disabled="flowAction.phase === 'sending' || activeFlow !== null"
                  @click="authStore.login(provider.providerId, method)"
                >
                  {{ method === 'oauth' ? `登录：${methodLabel(provider, method)}` : '录入 API Key' }}
                </button>
                <button
                  v-if="provider.storedType !== null"
                  type="button"
                  class="control-button-sm border-desk-danger text-desk-danger"
                  :disabled="logoutAction.phase === 'sending'"
                  @click="authStore.logout(provider.providerId)"
                >
                  删除已保存凭据
                </button>
              </div>
              <p v-else class="mt-1 text-2xs text-desk-muted">
                这个 Provider 的凭据只能在 Pi 外部配置；这里只展示状态。
              </p>
            </li>
          </ul>

          <p v-if="logoutAction.phase === 'error'" role="alert" class="status-notice status-notice-error">
            {{ logoutAction.error.message }}
          </p>
        </section>

        <section class="status-notice space-y-1">
          <h3 class="text-xs font-semibold text-desk-ink">边界说明</h3>
          <ul class="list-disc space-y-1 pl-4">
            <li>OAuth 由 Pi 的官方实现完成：回调地址与状态校验都在它自己进程内，Desktop 只把授权页交给系统浏览器。</li>
            <li>退出登录只删除 Pi 保存的凭据，不影响环境变量与 models.json 里配置的凭据或密钥命令。</li>
            <li>已保存的凭据不会回传到页面；页面只能看到「是否已配置」与来源。</li>
            <li>凭据变化后运行中的 Runtime 仍使用启动时的可用模型快照，需要重新加载才能看到新 Provider 的模型。</li>
          </ul>
        </section>
      </div>
    </div>
  </div>
</template>
