<!-- 输入坞模型选择器：未选项目时也读全局模型目录；Pi 未启动时选中即写为 Pi 自身默认模型（settings.json），就绪时选中只切换当前会话、候选项里的「设为默认」才写默认模型，会话切换与默认模型写入互不联动；候选项排除设置中隐藏的模型。 -->
<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useProjectStore } from '../stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import AppButton from './ui/AppButton.vue'
import AppSelect from './ui/AppSelect.vue'

const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const projectStore = useProjectStore()
const {
  view, capabilitiesView, modelSwitchView, promptView,
  modelPreviewView, piDefaultModelView, piDefaultModelLoaded, piDefaultModel,
  availableModels, visibleModels
} = storeToRefs(runtimeStore)
const ready = computed(() => view.value.phase === 'ready')
const canPrepare = computed(() => (
  view.value.phase === 'idle' || view.value.phase === 'closed' || view.value.phase === 'failed'
))
const info = computed(() => view.value.phase === 'ready' ? view.value.snapshot.info : null)
const preview = computed(() => canPrepare.value && modelPreviewView.value.phase === 'ready'
  && modelPreviewView.value.data.projectPath === (projectStore.currentProject?.path ?? null)
  ? modelPreviewView.value.data : null)
const models = availableModels
/** 全部候选都被隐藏；用于区分空态文案。 */
const allModelsHidden = computed(() => models.value.length > 0 && visibleModels.value.length === 0)
const identity = computed(() => {
  if (ready.value) {
    return info.value?.modelProvider && info.value.modelId
      ? { provider: info.value.modelProvider, modelId: info.value.modelId } : null
  }
  // 未就绪时优先展示已设置的 Pi 默认；未设置时退回 Pi 自动选择的结果，仅作展示。
  return canPrepare.value ? piDefaultModel.value ?? preview.value?.defaultModel ?? null : null
})

/** 用元组编码复合身份，避免供应商和模型名称含分隔符时串选。 */
function modelKey(provider: string, id: string): string {
  return JSON.stringify([provider, id])
}

/** 供应商首字母作徽标，缺少身份时不显示。 */
function providerBadge(provider: string): string {
  return ([...provider.trim()][0] ?? '').toLocaleUpperCase()
}

/** 上下文窗口缩写；缺失或过小不显示。 */
function formatContextWindow(value: number | null): string | undefined {
  if (value === null || value < 1000) return undefined
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M 上下文`
  return `${Math.round(value / 1000)}K 上下文`
}

const currentKey = computed(() => {
  if (canPrepare.value) {
    // 读取中或读取失败时不匹配任何选项，让触发键直接显示进度或错误文案。
    if (modelPreviewView.value.phase === 'loading'
      || (error.value !== null && error.value !== unavailableChoice.value)) return ''
    if (!piDefaultModelLoaded.value) return ''
  }
  return identity.value ? modelKey(identity.value.provider, identity.value.modelId) : ''
})
const currentModel = computed(() => models.value.find(model => (
  model.provider === identity.value?.provider && model.id === identity.value?.modelId
)) ?? null)
const currentLabel = computed(() => {
  if (view.value.phase === 'starting') return 'Pi 启动中'
  if (view.value.phase === 'stopping') return 'Pi 关闭中'
  if (error.value !== null) {
    // 已保存选择只是不可用时不改写触发键文案，仍展示当前选择，错误由 title 与读屏提示传达。
    if (error.value !== unavailableChoice.value) {
      return view.value.phase === 'ready' && modelSwitchView.value.phase === 'error'
        ? '模型切换失败' : '模型读取失败'
    }
  }
  if (canPrepare.value && !piDefaultModelLoaded.value) return '正在读取默认模型…'
  if (canPrepare.value && modelPreviewView.value.phase === 'loading') return '正在读取模型…'
  return currentModel.value?.name ?? identity.value?.modelId ?? '未选择模型'
})
const currentIdentity = computed(() => identity.value
  ? `${identity.value.provider} / ${identity.value.modelId}` : currentLabel.value)
/** 就绪时也能写 Pi 默认模型（只影响以后新建的会话）；默认模型没读到或正在保存时不给这个动作。 */
const canSetDefault = computed(() => ready.value && piDefaultModelLoaded.value
  && piDefaultModelView.value.phase !== 'saving')
const groups = computed(() => {
  type Option = {
    value: string
    label: string
    badge?: string | undefined
    description?: string | undefined
    tag?: string | undefined
    action?: { label: string; shortcut?: string | undefined } | undefined
  }
  const providers = new Map<string, Option[]>()
  const piDefault = piDefaultModel.value
  for (const model of visibleModels.value) {
    const options = providers.get(model.provider) ?? []
    // 标出当前 Pi 默认：Runtime 就绪时勾选的是当前会话模型，第二行仍能区分出默认项。
    const isDefault = piDefault !== null
      && piDefault.provider === model.provider && piDefault.modelId === model.id
    const context = formatContextWindow(model.contextWindow)
    options.push({
      value: modelKey(model.provider, model.id),
      label: model.name ?? model.id,
      badge: providerBadge(model.provider),
      description: isDefault
        ? (context === undefined ? 'Pi 默认' : `${context} · Pi 默认`)
        : context,
      tag: model.imageInput === true ? '图片' : undefined,
      // 就绪时改默认模型只能走这条次级动作；已经是默认的项不再重复给出入口。
      action: canSetDefault.value && !isDefault
        ? { label: '设为默认', shortcut: 'Alt+Enter' } : undefined
    })
    providers.set(model.provider, options)
  }
  return [...providers].map(([label, options]) => ({ label, options }))
})
const capabilitiesError = computed(() => {
  if (capabilitiesView.value.phase === 'error') return capabilitiesView.value.error.message
  if (capabilitiesView.value.phase === 'ready') return capabilitiesView.value.data.modelsError
  return null
})
const unavailableChoice = computed(() => canPrepare.value && preview.value !== null
  && preview.value.modelsError === null && piDefaultModel.value !== null
  && !models.value.some(model => (
    model.provider === piDefaultModel.value?.provider && model.id === piDefaultModel.value?.modelId
  ))
  ? '设置的 Pi 默认模型当前不可用；请重新选择。' : null)
const error = computed(() => {
  if (ready.value) {
    if (modelSwitchView.value.phase === 'error') return modelSwitchView.value.error.message
    // 模型列表读不出来时优先报它；Pi 默认模型保存失败放在其后，避免被能力错误盖掉。
    if (capabilitiesError.value !== null) return capabilitiesError.value
    if (piDefaultModelView.value.phase === 'error') return piDefaultModelView.value.error.message
    return null
  }
  if (!canPrepare.value) return null
  if (piDefaultModelView.value.phase === 'error') return piDefaultModelView.value.error.message
  if (modelPreviewView.value.phase === 'error') return modelPreviewView.value.error.message
  return preview.value?.modelsError
    ?? (piDefaultModel.value === null ? preview.value?.defaultModelError : null)
    ?? unavailableChoice.value
})
const sessionChanging = computed(() => sessionStore.opening || sessionStore.awaitingTrust || sessionStore.awaitingInterrupt)
const disabledReason = computed(() => {
  if (sessionChanging.value) return '正在处理会话切换'
  if (!ready.value) {
    if (!canPrepare.value) return 'Pi 正在启动或关闭'
    if (piDefaultModelView.value.phase === 'saving') return '正在保存 Pi 默认模型…'
    if (!piDefaultModelLoaded.value) return piDefaultModelView.value.phase === 'error'
      ? '默认模型读取失败，请重试' : '正在读取默认模型…'
    if (piDefaultModelView.value.phase === 'loading') return '正在读取默认模型…'
    if (modelPreviewView.value.phase === 'loading' || modelPreviewView.value.phase === 'idle') return '正在读取可用模型…'
    // 读取失败时仍允许重新选择，覆盖已保存的失效选择。
    return null
  }
  if (modelSwitchView.value.phase === 'switching') return '正在切换模型…'
  if (info.value?.isStreaming === true) return 'Agent 运行中，本轮结束后才能切换模型'
  if (promptView.value.phase === 'sending') return 'Prompt 正在提交'
  if (capabilitiesView.value.phase === 'loading' || capabilitiesView.value.phase === 'idle') return '正在读取可用模型…'
  if (capabilitiesError.value !== null) return '模型列表读取失败'
  if (visibleModels.value.length === 0) {
    return allModelsHidden.value ? '所有模型已在设置中隐藏' : '无可用模型，请在设置中配置供应商认证'
  }
  return null
})
const progress = computed(() => {
  if (modelSwitchView.value.phase === 'switching') return '正在切换模型…'
  if (piDefaultModelView.value.phase === 'saving') return '正在保存 Pi 默认模型…'
  if (canPrepare.value) {
    if (piDefaultModelView.value.phase === 'loading') return '正在读取默认模型…'
    if (modelPreviewView.value.phase === 'loading') return '正在读取模型…'
    if (preview.value !== null && visibleModels.value.length === 0) {
      return allModelsHidden.value ? '所有模型已在设置中隐藏' : '无可用模型，请在设置中配置供应商认证'
    }
    return null
  }
  if (ready.value && capabilitiesView.value.phase === 'loading') return '正在读取模型…'
  if (ready.value && capabilitiesError.value === null && visibleModels.value.length === 0
    && capabilitiesView.value.phase === 'ready') {
    return allModelsHidden.value ? '所有模型已在设置中隐藏' : '无可用模型，请在设置中配置供应商认证'
  }
  return null
})
const canRetry = computed(() => ready.value && capabilitiesError.value !== null
  && modelSwitchView.value.phase !== 'switching')
const refreshDisabled = computed(() => sessionChanging.value
  || modelPreviewView.value.phase === 'loading'
  || piDefaultModelView.value.phase === 'loading' || piDefaultModelView.value.phase === 'saving')
const busy = computed(() => modelSwitchView.value.phase === 'switching'
  || piDefaultModelView.value.phase === 'loading' || piDefaultModelView.value.phase === 'saving'
  || (canPrepare.value && modelPreviewView.value.phase === 'loading'))

/**
 * 选中即生效，但三种场景互不联动：
 * Pi 就绪时只切换当前会话的模型（SDK 的会话切换默认不持久化全局默认），
 * 未启动时写为 Pi 自身默认模型（settings.json），只影响以后新建的会话；
 * 就绪时改默认模型走候选项的「设为默认」（见 chooseDefaultModel），不动当前会话。
 * 三条路径都不乐观伪造结果。
 */
async function chooseModel(value: string): Promise<void> {
  if (disabledReason.value !== null) return
  const model = models.value.find(candidate => modelKey(candidate.provider, candidate.id) === value)
  if (model === undefined) return
  if (ready.value) {
    void runtimeStore.switchModel(model.provider, model.id)
    showNotice('success', `已切换当前会话模型：${model.name ?? model.id}`)
    return
  }
  const result = await runtimeStore.setPiDefaultModel({ provider: model.provider, modelId: model.id })
  if (result.ok) showNotice('success', `已设为 Pi 默认模型：${model.name ?? model.id}`)
  else showNotice('error', result.message)
}

/**
 * 候选项里的「设为默认」：只写 Pi 默认模型（settings.json），不切换当前会话；
 * 影响的是以后新建的会话，因此提示里点明当前会话不变。
 */
async function chooseDefaultModel(value: string): Promise<void> {
  const model = models.value.find(candidate => modelKey(candidate.provider, candidate.id) === value)
  if (model === undefined || !canSetDefault.value) return
  const result = await runtimeStore.setPiDefaultModel({ provider: model.provider, modelId: model.id })
  if (result.ok) showNotice('success', `已设为 Pi 默认模型：${model.name ?? model.id}（当前会话不变）`)
  else showNotice('error', result.message)
}

/** 设置默认的可见反馈：成功短暂提示，失败显示原因；不占布局，靠浮层呈现。 */
const notice = ref<{ readonly kind: 'success' | 'error'; readonly text: string } | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | null = null

/** 取消上一条提示的计时并重新计时；成功与失败停留时长不同。 */
function showNotice(kind: 'success' | 'error', text: string): void {
  if (noticeTimer !== null) clearTimeout(noticeTimer)
  notice.value = { kind, text }
  noticeTimer = setTimeout(() => {
    notice.value = null
    noticeTimer = null
  }, kind === 'success' ? 2500 : 6000)
}

onUnmounted(() => {
  if (noticeTimer !== null) clearTimeout(noticeTimer)
})

/** 手动刷新绕过预读缓存，并重新读取 Pi 默认模型以解除读写失败状态。 */
function refreshModels(): void {
  if (sessionChanging.value || refreshDisabled.value) return
  if (canPrepare.value) {
    void Promise.all([runtimeStore.refreshModelPreview(true), runtimeStore.loadPiDefaultModel(true)])
  } else if (canRetry.value) void runtimeStore.refreshCapabilities()
}
</script>

<template>
  <div class="app-runtime-model" :class="{ 'is-error': error !== null }" :aria-busy="busy">
    <div class="runtime-model-control">
      <AppSelect
        id="runtime-model-select"
        :label="ready ? '当前会话模型' : 'Pi 默认模型'"
        :groups="groups"
        :model-value="currentKey"
        :empty-label="currentLabel"
        :selected-meta="currentKey ? identity?.provider : undefined"
        :selected-badge="currentKey && identity ? providerBadge(identity.provider) : undefined"
        :disabled="disabledReason !== null"
        :title="error ? `${currentIdentity}；${error}` : disabledReason ? `${currentIdentity}；${disabledReason}` : `${ready ? '当前会话模型' : 'Pi 默认模型'}：${currentIdentity}；点击选择${ready ? '，只切换当前会话，改默认模型在候选项里' : '，选中即设为 Pi 默认模型'}`"
        :aria-label="`${ready ? '当前会话模型' : 'Pi 默认模型'}：${currentIdentity}`"
        :aria-describedby="error ? 'runtime-model-error' : progress ? 'runtime-model-progress' : undefined"
        searchable
        search-placeholder="搜索供应商或模型…"
        empty-results-label="没有匹配的模型"
        @update:model-value="chooseModel"
        @option-action="chooseDefaultModel"
      />
      <!-- 只在未就绪与读取失败时出现的重试入口；图标按钮，不再占一行文字。 -->
      <AppButton
        v-if="canPrepare || canRetry"
        variant="icon"
        class="runtime-model-refresh"
        :disabled="refreshDisabled"
        :aria-label="canPrepare ? '刷新模型列表' : '重试读取模型列表'"
        :title="canPrepare ? '刷新模型列表' : '重试读取模型列表'"
        @click="refreshModels"
      >
        <span aria-hidden="true">↻</span>
      </AppButton>
    </div>
    <!-- 进度与错误并入触发键文案与 title；此处仅保留读屏用的隐藏区域，输入坞高度保持恒定。 -->
    <p
      v-if="error || progress"
      :id="error ? 'runtime-model-error' : 'runtime-model-progress'"
      class="sr-only"
      :role="error ? 'alert' : 'status'"
    >{{ error ?? progress }}</p>
    <!-- 设置默认的可见反馈：绝对定位在胶囊上方，不改变输入坞布局。 -->
    <p
      v-if="notice"
      class="runtime-model-notice"
      :class="`is-${notice.kind}`"
      :role="notice.kind === 'error' ? 'alert' : 'status'"
    >{{ notice.text }}</p>
  </div>
</template>

<style scoped>
/* 常驻在输入坞动作组里：宽度随模型名自适应，上限防止长名撑开工具条。 */
.app-runtime-model {
  position: relative;
  min-width: 0;
  max-width: 16rem;
  flex: none;
}
.runtime-model-control {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.25rem;
}
/* 输入坞里的紧凑胶囊：无边框、圆角，不占背景色，只靠悬停反馈。 */
.runtime-model-control :deep(.app-select-trigger) {
  min-width: 0;
  border-color: transparent;
  border-radius: 999px;
  background: transparent;
  padding: 0.3rem 0.6rem;
  font-size: 0.75rem;
}
.runtime-model-control :deep(.app-select-trigger:not(:disabled):hover) {
  background: var(--color-desk-surface-subtle);
}
.runtime-model-control :deep(.app-select-trigger:disabled) {
  background: transparent;
}
/* 读取进度与错误并入触发键文案，不设独立状态行，输入坞高度保持恒定。 */
.app-runtime-model.is-error :deep(.app-select-name) {
  color: var(--color-desk-danger);
}
/* 设置默认的反馈浮层贴在胶囊上方，不占布局、不改变输入坞高度；向右展开会越出窗口，因此靠右对齐向左生长。 */
.runtime-model-notice {
  position: absolute;
  z-index: 30;
  bottom: 100%;
  right: 0;
  max-width: 20rem;
  margin-bottom: 0.35rem;
  border: 1px solid var(--color-desk-line);
  border-radius: 8px;
  background: var(--color-desk-surface);
  box-shadow: var(--shadow-desk-pop);
  padding: 0.35rem 0.6rem;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
  line-height: 1.4;
}
.runtime-model-notice.is-error {
  border-color: var(--color-desk-danger);
  color: var(--color-desk-danger);
}
</style>
