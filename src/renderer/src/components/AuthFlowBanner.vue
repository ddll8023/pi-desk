<!-- 登录流程条：固定在模型页顶部，滚到任何位置都能看到流程进度与「重新加载 Runtime」入口。
     流程进行中时承载 Pi 的提示输入（含设备码与授权地址）；流程刚结束时只留一行结论与重载动作。
     流程状态来自 auth store，本组件不持有流程生命周期。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import type { AuthFlowSnapshot } from '../../../shared/auth-api'
import { useAuthStore } from '../stores/auth'
import { useRuntimeStore } from '../stores/runtime'
import AppButton from './ui/AppButton.vue'

defineProps<{
  /** Runtime 是否正在重新加载；用于禁用重载入口。 */
  readonly reloading: boolean
}>()

const emit = defineEmits<{ reload: [] }>()

const authStore = useAuthStore()
const runtimeStore = useRuntimeStore()
const { flow, activeFlow, flowAction, secretInput, selectInput } = storeToRefs(authStore)

/** 登录流程刚结束且 Runtime 就绪时，给出重启式重载的一行提示。 */
const showReloadHint = computed(() => flow.value?.phase === 'completed' && runtimeStore.view.phase === 'ready')

/** 流程卡片的登录方式文案；与具体 Provider 无关，只反映本次流程用的是哪一类认证。 */
const flowMethodLabel = computed(() => (flow.value?.method === 'oauth' ? '账户登录' : 'API Key'))

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
</script>

<template>
  <!-- 流程进行中：固定在清单上方，展开另一行不会让它从视野里消失。 -->
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

  <!-- 流程结束后只留一行结论，不把清单整体下推。 -->
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
      :disabled="reloading"
      @click="emit('reload')"
    >
      {{ reloading ? '正在重新加载…' : '重新加载 Runtime（保留会话）' }}
    </AppButton>
  </div>
</template>
