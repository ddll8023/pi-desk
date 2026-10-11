<!-- 顶栏模型选择器：启动前选择并保存桌面新会话默认模型；就绪后只切换当前会话，以 Runtime 状态为准。 -->
<script setup lang="ts">
import { computed } from 'vue'
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
  modelPreviewView, modelPreferenceView, modelPreferenceLoaded, newSessionModel
} = storeToRefs(runtimeStore)
const FOLLOW_PI_DEFAULT = 'pi-default'
const ready = computed(() => view.value.phase === 'ready')
const canPrepare = computed(() => (
  view.value.phase === 'idle' || view.value.phase === 'closed' || view.value.phase === 'failed'
))
const info = computed(() => view.value.phase === 'ready' ? view.value.snapshot.info : null)
const preview = computed(() => canPrepare.value && modelPreviewView.value.phase === 'ready'
  && modelPreviewView.value.data.projectPath === projectStore.currentProject?.path
  ? modelPreviewView.value.data : null)
const models = computed(() => {
  if (view.value.phase === 'ready') {
    return capabilitiesView.value.phase === 'ready'
      && capabilitiesView.value.data.runtimeId === view.value.snapshot.runtimeId
      ? capabilitiesView.value.data.models : []
  }
  return preview.value?.models ?? []
})
const identity = computed(() => {
  if (ready.value) {
    return info.value?.modelProvider && info.value.modelId
      ? { provider: info.value.modelProvider, modelId: info.value.modelId } : null
  }
  return canPrepare.value ? newSessionModel.value ?? preview.value?.defaultModel ?? null : null
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
    if (!modelPreferenceLoaded.value) return ''
    if (newSessionModel.value === null) return FOLLOW_PI_DEFAULT
  }
  return identity.value ? modelKey(identity.value.provider, identity.value.modelId) : ''
})
const currentModel = computed(() => models.value.find(model => (
  model.provider === identity.value?.provider && model.id === identity.value?.modelId
)) ?? null)
const currentLabel = computed(() => {
  if (view.value.phase === 'starting') return 'Pi 启动中'
  if (view.value.phase === 'stopping') return 'Pi 关闭中'
  if (canPrepare.value && !modelPreferenceLoaded.value) return '正在读取模型偏好…'
  return currentModel.value?.name ?? identity.value?.modelId ?? '未选择模型'
})
const currentIdentity = computed(() => identity.value
  ? `${identity.value.provider} / ${identity.value.modelId}` : currentLabel.value)
const groups = computed(() => {
  type Option = { value: string; label: string; badge?: string; description?: string; tag?: string }
  const providers = new Map<string, Option[]>()
  for (const model of models.value) {
    const options = providers.get(model.provider) ?? []
    options.push({
      value: modelKey(model.provider, model.id),
      label: model.name ?? model.id,
      badge: providerBadge(model.provider),
      description: formatContextWindow(model.contextWindow),
      tag: model.imageInput === true ? '图片' : undefined
    })
    providers.set(model.provider, options)
  }
  const modelGroups = [...providers].map(([label, options]) => ({ label, options }))
  if (!canPrepare.value) return modelGroups
  const defaultModel = preview.value?.defaultModel
  const defaultName = models.value.find(model => (
    model.provider === defaultModel?.provider && model.id === defaultModel?.modelId
  ))?.name ?? defaultModel?.modelId
  return [{
    label: '新会话默认',
    options: [{ value: FOLLOW_PI_DEFAULT,
      label: defaultName ? `${defaultName}（Pi 默认）` : '跟随 Pi 默认',
      description: '使用 Pi 自己的默认模型，不修改 Pi 配置' }]
  }, ...modelGroups]
})
const capabilitiesError = computed(() => {
  if (capabilitiesView.value.phase === 'error') return capabilitiesView.value.error.message
  if (capabilitiesView.value.phase === 'ready') return capabilitiesView.value.data.modelsError
  return null
})
const unavailableChoice = computed(() => canPrepare.value && preview.value !== null
  && preview.value.modelsError === null && newSessionModel.value !== null
  && !models.value.some(model => model.provider === newSessionModel.value?.provider && model.id === newSessionModel.value?.modelId)
  ? '保存的模型当前不可用；请重新选择，或跟随 Pi 默认。' : null)
const error = computed(() => {
  if (ready.value) {
    return modelSwitchView.value.phase === 'error' ? modelSwitchView.value.error.message : capabilitiesError.value
  }
  if (!canPrepare.value) return null
  if (modelPreferenceView.value.phase === 'error') return modelPreferenceView.value.error.message
  if (modelPreviewView.value.phase === 'error') return modelPreviewView.value.error.message
  return preview.value?.modelsError
    ?? (newSessionModel.value === null ? preview.value?.defaultModelError : null)
    ?? unavailableChoice.value
})
const sessionChanging = computed(() => sessionStore.opening || sessionStore.awaitingTrust || sessionStore.awaitingInterrupt)
const disabledReason = computed(() => {
  if (projectStore.currentProject === null) return '请先选择项目'
  if (sessionChanging.value) return '正在处理会话切换'
  if (!ready.value) {
    if (!canPrepare.value) return 'Pi 正在启动或关闭'
    if (modelPreferenceView.value.phase === 'saving') return '正在保存新会话默认模型…'
    if (!modelPreferenceLoaded.value) return modelPreferenceView.value.phase === 'error'
      ? '模型偏好读取失败，请重试' : '正在读取模型偏好…'
    if (modelPreferenceView.value.phase === 'loading') return '正在读取模型偏好…'
    if (modelPreviewView.value.phase === 'loading' || modelPreviewView.value.phase === 'idle') return '正在读取可用模型…'
    // 读取失败时仍允许清除已保存的失效选择，回到跟随 Pi 默认。
    return null
  }
  if (modelSwitchView.value.phase === 'switching') return '正在切换模型…'
  if (info.value?.isStreaming === true) return 'Agent 运行中，本轮结束后才能切换模型'
  if (promptView.value.phase === 'sending') return 'Prompt 正在提交'
  if (capabilitiesView.value.phase === 'loading' || capabilitiesView.value.phase === 'idle') return '正在读取可用模型…'
  if (capabilitiesError.value !== null) return '模型列表读取失败'
  if (models.value.length === 0) return '无可用模型，请在设置中配置供应商认证'
  return null
})
const progress = computed(() => {
  if (modelSwitchView.value.phase === 'switching') return '正在切换模型…'
  if (canPrepare.value) {
    if (modelPreferenceView.value.phase === 'saving') return '正在保存新会话默认模型…'
    if (modelPreferenceView.value.phase === 'loading') return '正在读取模型偏好…'
    if (modelPreviewView.value.phase === 'loading') return '正在读取模型…'
    if (preview.value !== null && models.value.length === 0) return '无可用模型，请在设置中配置供应商认证'
    return null
  }
  if (ready.value && capabilitiesView.value.phase === 'loading') return '正在读取模型…'
  if (ready.value && capabilitiesError.value === null && models.value.length === 0
    && capabilitiesView.value.phase === 'ready') return '无可用模型，请在设置中配置供应商认证'
  return null
})
const canRetry = computed(() => ready.value && capabilitiesError.value !== null
  && modelSwitchView.value.phase !== 'switching')
const refreshDisabled = computed(() => sessionChanging.value
  || modelPreviewView.value.phase === 'loading'
  || modelPreferenceView.value.phase === 'loading' || modelPreferenceView.value.phase === 'saving')
const busy = computed(() => modelSwitchView.value.phase === 'switching'
  || (canPrepare.value && (modelPreviewView.value.phase === 'loading'
    || modelPreferenceView.value.phase === 'loading' || modelPreferenceView.value.phase === 'saving')))

/** 启动前保存默认选择，就绪后提交会话切换；两者都不乐观伪造当前模型。 */
function chooseModel(value: string): void {
  if (disabledReason.value !== null) return
  if (canPrepare.value && value === FOLLOW_PI_DEFAULT) {
    void runtimeStore.chooseNewSessionModel(null)
    return
  }
  const model = models.value.find(candidate => modelKey(candidate.provider, candidate.id) === value)
  if (model === undefined) return
  if (canPrepare.value) void runtimeStore.chooseNewSessionModel({ provider: model.provider, modelId: model.id })
  else void runtimeStore.switchModel(model.provider, model.id)
}

/** 手动刷新绕过预读缓存，并重新读取模型偏好以解除读写失败状态。 */
function refreshModels(): void {
  if (sessionChanging.value || refreshDisabled.value) return
  if (canPrepare.value) {
    void Promise.all([runtimeStore.refreshModelPreview(true), runtimeStore.loadModelPreference(true)])
  } else if (canRetry.value) void runtimeStore.refreshCapabilities()
}
</script>

<template>
  <div class="app-runtime-model" :aria-busy="busy">
    <div class="runtime-model-control">
      <label for="runtime-model-select" class="runtime-model-label">模型</label>
      <AppSelect
        id="runtime-model-select"
        :label="ready ? '当前会话模型' : '新会话默认模型'"
        :groups="groups"
        :model-value="currentKey"
        :empty-label="currentLabel"
        :selected-meta="identity?.provider"
        :selected-badge="identity ? providerBadge(identity.provider) : undefined"
        :disabled="disabledReason !== null"
        :title="disabledReason ? `${currentIdentity}；${disabledReason}` : `${ready ? '当前会话模型' : '桌面新会话默认模型'}：${currentIdentity}；点击选择`"
        :aria-label="`${ready ? '当前会话模型' : '新会话默认模型'}：${currentIdentity}`"
        :aria-describedby="error ? 'runtime-model-error' : progress ? 'runtime-model-progress' : undefined"
        searchable
        search-placeholder="搜索供应商或模型…"
        empty-results-label="没有匹配的模型"
        @update:model-value="chooseModel"
      />
      <AppButton v-if="canPrepare || canRetry" variant="compact" :disabled="refreshDisabled" @click="refreshModels">
        {{ canPrepare ? '刷新' : '重试读取' }}
      </AppButton>
    </div>
    <p v-if="error" id="runtime-model-error" class="runtime-model-error" role="alert" :title="error">{{ error }}</p>
    <p v-else-if="progress" id="runtime-model-progress" class="runtime-model-progress" role="status">{{ progress }}</p>
  </div>
</template>

<style scoped>
.runtime-model-control {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.4rem;
}
.runtime-model-label {
  flex: none;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}
/* 顶栏胶囊保持原有布局，选择状态与进程状态分开呈现。 */
.runtime-model-control :deep(.app-select-trigger) {
  min-width: 0;
  width: 0;
  flex: 1;
  border-color: transparent;
  border-radius: 999px;
  background: transparent;
  padding: 0.3rem 0.7rem;
  font-size: 0.75rem;
}
.runtime-model-control :deep(.app-select-trigger:not(:disabled):hover) {
  background: var(--color-desk-surface-subtle);
}
.runtime-model-control :deep(.app-select-trigger:disabled) {
  background: transparent;
}
.runtime-model-error,
.runtime-model-progress {
  margin: 0.25rem 0 0;
  font-size: 0.6875rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.runtime-model-error {
  color: var(--color-desk-danger);
}
.runtime-model-progress {
  color: var(--color-desk-muted);
}
</style>
