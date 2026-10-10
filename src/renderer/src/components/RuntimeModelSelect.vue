<!-- 当前会话模型选择器：复用分组搜索控件，模型身份以 Runtime 快照为准，不修改全局默认。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import AppButton from './ui/AppButton.vue'
import AppSelect from './ui/AppSelect.vue'

const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const { view, capabilitiesView, modelSwitchView, promptView } = storeToRefs(runtimeStore)
const info = computed(() => view.value.phase === 'ready' ? view.value.snapshot.info : null)
const models = computed(() => capabilitiesView.value.phase === 'ready'
  && capabilitiesView.value.data.runtimeId === (view.value.phase === 'ready' ? view.value.snapshot.runtimeId : null)
  ? capabilitiesView.value.data.models
  : [])

/** 用元组编码复合身份，避免自定义名称含分隔符时误选其他 Provider 的同名模型。 */
function modelKey(provider: string, id: string): string {
  return JSON.stringify([provider, id])
}

const currentKey = computed(() => info.value?.modelProvider && info.value.modelId
  ? modelKey(info.value.modelProvider, info.value.modelId)
  : '')
const currentLabel = computed(() => {
  if (view.value.phase !== 'ready') return 'Pi 未就绪'
  if (!info.value?.modelId) return '未选择模型'
  return info.value.modelProvider ? `${info.value.modelProvider} / ${info.value.modelId}` : info.value.modelId
})
const groups = computed(() => {
  const providers = new Map<string, { value: string; label: string }[]>()
  for (const model of models.value) {
    const options = providers.get(model.provider) ?? []
    options.push({ value: modelKey(model.provider, model.id), label: `${model.provider} / ${model.id}` })
    providers.set(model.provider, options)
  }
  return [...providers].map(([label, options]) => ({ label, options }))
})
const capabilitiesError = computed(() => {
  if (capabilitiesView.value.phase === 'error') return capabilitiesView.value.error.message
  if (capabilitiesView.value.phase === 'ready') return capabilitiesView.value.data.modelsError
  return null
})
const error = computed(() => modelSwitchView.value.phase === 'error'
  ? modelSwitchView.value.error.message
  : capabilitiesError.value)
const disabledReason = computed(() => {
  if (view.value.phase !== 'ready') return '请先打开会话或启动 Pi'
  if (sessionStore.opening || sessionStore.awaitingTrust || sessionStore.awaitingInterrupt) return '正在处理会话切换'
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
  if (capabilitiesView.value.phase === 'loading') return '正在读取模型…'
  if (view.value.phase === 'ready' && capabilitiesError.value === null && models.value.length === 0
    && capabilitiesView.value.phase === 'ready') return '无可用模型，请在设置中配置供应商认证'
  return null
})
const canRetry = computed(() => view.value.phase === 'ready' && capabilitiesError.value !== null
  && modelSwitchView.value.phase !== 'switching')

/** 只提交目录中的真实身份，选中值仍等待官方状态更新。 */
function chooseModel(value: string): void {
  if (disabledReason.value !== null) return
  const model = models.value.find(candidate => modelKey(candidate.provider, candidate.id) === value)
  if (model !== undefined) void runtimeStore.switchModel(model.provider, model.id)
}
</script>

<template>
  <div class="app-runtime-model" :aria-busy="modelSwitchView.phase === 'switching'">
    <div class="runtime-model-control">
      <label for="runtime-model-select" class="runtime-model-label">模型</label>
      <AppSelect
        id="runtime-model-select"
        label="当前会话模型"
        :groups="groups"
        :model-value="currentKey"
        :empty-label="currentLabel"
        :disabled="disabledReason !== null"
        :title="disabledReason ? `${currentLabel}；${disabledReason}` : `当前模型：${currentLabel}；点击切换`"
        :aria-label="`当前模型：${currentLabel}`"
        :aria-describedby="error ? 'runtime-model-error' : progress ? 'runtime-model-progress' : undefined"
        searchable
        search-placeholder="搜索供应商或模型…"
        empty-results-label="没有匹配的模型"
        @update:model-value="chooseModel"
      />
      <AppButton v-if="canRetry" variant="compact" @click="runtimeStore.refreshCapabilities()">重试读取</AppButton>
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

.runtime-model-control :deep(.app-select-trigger) {
  min-width: 0;
  width: 0;
  flex: 1;
  padding: 0.35rem 0.55rem;
  font-size: 0.75rem;
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
