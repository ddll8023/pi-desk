<!-- 供应商认证弹窗：集中呈现密钥、验证码、设备授权与认证结果，复用认证 Store 的单一流程。
     OAuth 模式收起只清空未提交输入且不取消流程；API Key 模式取消即退出流程并关闭，保存完成后自动关闭。
     以目标供应商、方式和启动状态隔离旧快照，避免新请求期间显示上一次认证的结果。 -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { AuthMethod } from '../../../../shared/auth-api'
import { useAuthStore } from '../stores/auth'
import { useRuntimeStore } from '../../sessions/stores/runtime'
import { copyText } from '../../ui/clipboard'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly open: boolean
  readonly providerId: string
  readonly providerName: string
  readonly method: AuthMethod
  readonly starting: boolean
  readonly startFailed: boolean
  readonly reloading: boolean
}>()

const emit = defineEmits<{
  close: []
  retry: []
  reload: []
}>()

const authStore = useAuthStore()
const runtimeStore = useRuntimeStore()
const { flow, flowAction, secretInput, selectInput } = storeToRefs(authStore)
const panel = ref<HTMLElement | null>(null)
const titleId = useId()
const descriptionId = useId()
const promptId = useId()
const formId = useId()
const detailCopyLabel = ref('复制技术细节')
let opener: HTMLElement | null = null
let openerFallback: HTMLElement | null = null
let autoCloseTimer: ReturnType<typeof setTimeout> | null = null

const subtitle = computed(() => {
  if (props.method === 'api_key') return '输入密钥并保存后即可使用。'
  return '收起后可以继续认证；未提交的输入不会保留。'
})

const snapshot = computed(() => {
  if (props.starting || props.startFailed) return null
  const current = flow.value
  if (current === null || current.providerId !== props.providerId || current.method !== props.method) return null
  return current
})
const prompt = computed(() => snapshot.value?.prompt ?? null)
const active = computed(() => snapshot.value !== null && authStore.activeFlow?.flowId === snapshot.value.flowId)
const sending = computed(() => props.starting || flowAction.value.phase === 'sending')
const error = computed(() => flowAction.value.phase === 'error' ? flowAction.value.error : null)
const showReload = computed(() => snapshot.value?.phase === 'completed' && runtimeStore.view.phase === 'ready')
const canRetry = computed(() => !sending.value && authStore.activeFlow === null)
const canRespond = computed(() => {
  if (!active.value || prompt.value === null || sending.value || snapshot.value?.phase === 'cancelling') return false
  if (prompt.value.kind === 'select') {
    return prompt.value.options.some((option) => option.id === selectInput.value)
  }
  return secretInput.value !== ''
})
const inputPlaceholder = computed(() => {
  if (prompt.value?.placeholder) return prompt.value.placeholder
  return prompt.value?.kind === 'secret' ? '粘贴密钥' : '输入验证码或回应内容'
})
const phaseLabel = computed(() => {
  if (props.starting) return '正在启动认证…'
  if (props.startFailed) return '认证未能启动'
  switch (snapshot.value?.phase) {
    case 'waiting': return props.method === 'oauth' ? '等待完成账户授权' : '正在准备密钥输入…'
    case 'prompt': return props.method === 'oauth' ? '完成以下认证步骤' : '录入 API Key'
    case 'cancelling': return '正在取消认证…'
    case 'completed': return '认证已完成'
    case 'failed': return '认证失败'
    case 'cancelled': return '认证已取消'
    default: return '当前没有可继续的认证流程'
  }
})

function clearInput(): void {
  if (autoCloseTimer !== null) {
    clearTimeout(autoCloseTimer)
    autoCloseTimer = null
  }
  secretInput.value = ''
  selectInput.value = ''
}

function close(): void {
  clearInput()
  emit('close')
}

async function cancelApiKey(): Promise<void> {
  await authStore.cancel()
  close()
}

async function respond(): Promise<void> {
  if (canRespond.value) await authStore.respond()
}

async function copyDetail(): Promise<void> {
  const detail = error.value?.detail
  if (detail === null || detail === undefined) return
  detailCopyLabel.value = await copyText(detail) ? '已复制' : '复制失败'
}

function focusableElements(): HTMLElement[] {
  const root = panel.value
  if (root === null) return []
  return [...root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])'
  )].filter((element) => !element.matches(':disabled') && element.getClientRects().length > 0)
}

function focusPrompt(): void {
  const root = panel.value
  if (root === null) return
  const input = root.querySelector<HTMLInputElement>('input:enabled')
  if (input !== null) input.focus()
  else root.focus()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const items = focusableElements()
  const first = items[0]
  const last = items[items.length - 1]
  if (first === undefined || last === undefined) {
    event.preventDefault()
    panel.value?.focus()
    return
  }
  const current = document.activeElement
  if (!panel.value?.contains(current)) {
    event.preventDefault()
    if (event.shiftKey) last.focus()
    else first.focus()
  } else if (event.shiftKey && (current === first || current === panel.value)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (current === last || current === panel.value)) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.open, (open) => {
  if (open) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // 认证启动后入口按钮会变成「继续认证」，原按钮卸载时回到稳定的供应商行触发器。
    const trigger = opener?.closest('[data-provider-detail]')?.previousElementSibling
    openerFallback = trigger instanceof HTMLElement ? trigger : null
    detailCopyLabel.value = '复制技术细节'
    window.addEventListener('keydown', onKeydown, true)
    void nextTick(focusPrompt)
  } else {
    clearInput()
    window.removeEventListener('keydown', onKeydown, true)
    if (opener?.isConnected) opener.focus()
    else if (openerFallback?.isConnected) openerFallback.focus()
    opener = null
    openerFallback = null
  }
}, { immediate: true })

watch(() => prompt.value?.promptId, () => {
  if (props.open) void nextTick(focusPrompt)
})

watch(sending, (busy) => {
  if (!busy && props.open) {
    void nextTick(() => {
      if (!panel.value?.contains(document.activeElement)) focusPrompt()
    })
  }
})

watch(() => error.value?.detail, () => {
  detailCopyLabel.value = '复制技术细节'
})

watch(() => snapshot.value?.phase, (phase) => {
  if (props.open && props.method === 'api_key' && phase === 'completed') {
    if (autoCloseTimer !== null) clearTimeout(autoCloseTimer)
    autoCloseTimer = setTimeout(() => {
      if (props.open && snapshot.value?.phase === 'completed') {
        close()
      }
    }, 600)
  }
})

onUnmounted(() => {
  clearInput()
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="open" class="dialog-overlay" @click.self="close">
        <Transition name="dialog-panel-motion" appear>
          <section
            ref="panel"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="titleId"
            :aria-describedby="descriptionId"
            tabindex="-1"
            class="dialog-panel auth-dialog"
          >
            <header class="dialog-header">
              <div class="auth-dialog__heading">
                <h2 :id="titleId" class="dialog-title">{{ providerName || providerId }} · {{ method === 'oauth' ? '账户登录' : 'API Key' }}</h2>
                <p :id="descriptionId" class="dialog-subtitle">{{ subtitle }}</p>
              </div>
              <AppButton variant="icon" aria-label="收起认证弹窗" @click="close">×</AppButton>
            </header>

            <div class="dialog-body scroll-area auth-dialog__body">
              <p role="status" class="auth-dialog__phase" :class="{ 'is-error': startFailed || snapshot?.phase === 'failed' }">{{ phaseLabel }}</p>
              <p v-if="snapshot?.message" class="auth-dialog__message">{{ snapshot.message }}</p>
              <p v-if="snapshot?.phase === 'completed'" class="hint-text">
                凭据已交由 Pi 保存；运行中的会话需要重新加载后才会使用新凭据。
              </p>
              <p v-else-if="active && prompt === null && method === 'oauth'" class="hint-text">
                请在系统浏览器中完成授权；也可以收起此窗口，稍后继续。
              </p>

              <div v-if="error !== null" role="alert" class="status-notice status-notice-error">
                <p>{{ error.message }}</p>
                <details v-if="error.detail !== null" class="auth-dialog__technical">
                  <summary>技术细节</summary>
                  <AppButton variant="ghost" @click="copyDetail">{{ detailCopyLabel }}</AppButton>
                  <pre>{{ error.detail }}</pre>
                </details>
              </div>

              <dl v-if="active && snapshot?.deviceCode" class="auth-dialog__device">
                <div>
                  <dt>设备码</dt>
                  <dd class="auth-dialog__code">{{ snapshot.deviceCode.userCode }}</dd>
                </div>
                <div>
                  <dt>验证地址</dt>
                  <dd>{{ snapshot.deviceCode.verificationUri }}</dd>
                </div>
              </dl>

              <div v-if="active && snapshot?.hasOpenableUrl" class="space-y-1">
                <AppButton :disabled="sending || snapshot.phase === 'cancelling'" @click="authStore.openUrl()">
                  {{ snapshot.browserOpened ? '再次打开授权页' : '在浏览器中打开授权页' }}
                </AppButton>
                <p v-if="snapshot.browserOpened" class="hint-text">授权页已交给系统浏览器打开。</p>
              </div>

              <form v-if="active && prompt !== null" :id="formId" class="auth-dialog__form" @submit.prevent="respond">
                <fieldset v-if="prompt.kind === 'select'" :disabled="sending || snapshot?.phase === 'cancelling'" class="auth-dialog__options">
                  <legend>{{ prompt.message }}</legend>
                  <label v-for="option in prompt.options" :key="option.id" class="auth-dialog__option">
                    <input v-model="selectInput" type="radio" :value="option.id" :name="`${formId}-choice`">
                    <span>
                      {{ option.label }}
                      <span v-if="option.description !== null" class="auth-dialog__option-description">{{ option.description }}</span>
                    </span>
                  </label>
                </fieldset>
                <template v-else>
                  <label :for="promptId" class="field-label">{{ prompt.message }}</label>
                  <input
                    :id="promptId"
                    v-model="secretInput"
                    :type="prompt.kind === 'secret' ? 'password' : 'text'"
                    :placeholder="inputPlaceholder"
                    :disabled="sending || snapshot?.phase === 'cancelling'"
                    autocomplete="off"
                    spellcheck="false"
                    class="text-control"
                  >
                </template>
              </form>

              <details v-if="snapshot !== null && snapshot.messages.length > 0" class="auth-dialog__messages">
                <summary>认证过程信息</summary>
                <ul>
                  <li v-for="(message, index) in snapshot.messages" :key="`${snapshot.flowId}-${index}`">{{ message }}</li>
                </ul>
              </details>
            </div>

            <footer class="dialog-footer auth-dialog__footer">
              <template v-if="method === 'api_key'">
                <AppButton
                  v-if="active"
                  :disabled="sending || snapshot?.phase === 'cancelling'"
                  @click="cancelApiKey"
                >取消</AppButton>
                <AppButton v-else @click="close">关闭</AppButton>
                <AppButton v-if="active && prompt !== null" type="submit" :form="formId" variant="primary" :disabled="!canRespond">
                  {{ sending ? '正在提交…' : '保存密钥' }}
                </AppButton>
                <AppButton v-else-if="showReload" variant="primary" :disabled="reloading" @click="emit('reload')">
                  {{ reloading ? '正在重新加载…' : '重新加载会话' }}
                </AppButton>
                <AppButton v-else-if="!active && !starting && snapshot?.phase !== 'completed'" variant="primary" :disabled="!canRetry" @click="emit('retry')">
                  重新认证
                </AppButton>
              </template>
              <template v-else>
                <AppButton
                  v-if="active"
                  variant="quiet-danger"
                  class="auth-dialog__cancel"
                  :disabled="sending || snapshot?.phase === 'cancelling'"
                  @click="authStore.cancel()"
                >取消认证</AppButton>
                <AppButton @click="close">{{ active || starting ? '收起' : '关闭' }}</AppButton>
                <AppButton v-if="active && prompt !== null" type="submit" :form="formId" variant="primary" :disabled="!canRespond">
                  {{ sending ? '正在提交…' : '继续认证' }}
                </AppButton>
                <AppButton v-else-if="showReload" variant="primary" :disabled="reloading" @click="emit('reload')">
                  {{ reloading ? '正在重新加载…' : '重新加载会话' }}
                </AppButton>
                <AppButton v-else-if="!active && !starting && snapshot?.phase !== 'completed'" variant="primary" :disabled="!canRetry" @click="emit('retry')">
                  重新认证
                </AppButton>
              </template>
            </footer>
          </section>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.auth-dialog {
  max-width: 32rem;
}

.auth-dialog__heading {
  min-width: 0;
  overflow-wrap: anywhere;
}

.auth-dialog__body {
  overflow-wrap: anywhere;
}

.auth-dialog__phase {
  margin: 0;
  color: var(--color-desk-ink);
  font-size: 0.875rem;
  font-weight: 600;
}

.auth-dialog__phase.is-error {
  color: var(--color-desk-danger);
}

.auth-dialog__message {
  font-size: 0.8125rem;
  white-space: pre-wrap;
}

.auth-dialog__form {
  display: grid;
  gap: 0.5rem;
}

.auth-dialog__options {
  display: grid;
  min-width: 0;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  border: 0;
}

.auth-dialog__options legend {
  margin-bottom: 0.625rem;
  font-size: 0.8125rem;
}

.auth-dialog__option {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  padding: 0.625rem 0.75rem;
  font-size: 0.8125rem;
  cursor: pointer;
}

.auth-dialog__option:has(input:checked) {
  border-color: var(--color-desk-accent);
  background: var(--color-desk-accent-soft);
}

.auth-dialog__option input {
  margin-top: 0.25rem;
  accent-color: var(--color-desk-accent);
}

.auth-dialog__option-description {
  display: block;
  margin-top: 0.125rem;
  color: var(--color-desk-muted);
  font-size: 0.75rem;
}

.auth-dialog__device {
  display: grid;
  gap: 0.75rem;
  font-size: 0.8125rem;
}

.auth-dialog__device dt {
  margin-bottom: 0.25rem;
  color: var(--color-desk-muted);
  font-size: 0.75rem;
}

.auth-dialog__device dd {
  margin: 0;
  font-family: var(--font-mono);
}

.auth-dialog__code {
  font-size: 1.125rem;
  font-weight: 600;
  letter-spacing: 0.05em;
}

.auth-dialog__technical,
.auth-dialog__messages {
  color: var(--color-desk-muted);
  font-size: 0.75rem;
}

.auth-dialog__technical summary,
.auth-dialog__messages summary {
  width: fit-content;
}

.auth-dialog__technical pre,
.auth-dialog__messages ul {
  margin: 0.5rem 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.auth-dialog__technical pre {
  font-size: 0.6875rem;
}

.auth-dialog__messages ul {
  display: grid;
  gap: 0.375rem;
  list-style: none;
  padding: 0;
}

.auth-dialog__cancel {
  margin-right: auto;
}

.auth-dialog__footer {
  flex-wrap: wrap;
}

@media (max-width: 560px) {
  .auth-dialog :deep(.control-button),
  .auth-dialog :deep(.control-button-primary) {
    max-width: 100%;
    height: auto;
    white-space: normal;
  }
}
</style>
