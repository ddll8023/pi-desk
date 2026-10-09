<!-- Runtime 弹层内的 Agent 控制：模型选择、Thinking level 选择、上下文占用与压缩中状态、手动压缩入口与结果展示；只展示快照与能力结果，不在渲染端预检或推算。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import type { ModelSummary } from '../../../shared/runtime-api'
import AppButton from './ui/AppButton.vue'
import AppSelect from './ui/AppSelect.vue'
import { useRuntimeStore } from '../stores/runtime'

const runtimeStore = useRuntimeStore()
const { view: runtimeView, capabilitiesView, modelAction, thinkingAction, compactAction } = storeToRefs(runtimeStore)

const info = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const capabilities = computed(() => (
  capabilitiesView.value.phase === 'ready' ? capabilitiesView.value.data : null
))
const ready = computed(() => runtimeView.value.phase === 'ready' && info.value !== null)

/** 模型按 provider 分组；组内顺序沿用 Pi 返回顺序，不重新排序。 */
const modelGroups = computed(() => {
  const groups = new Map<string, ModelSummary[]>()
  for (const model of capabilities.value?.models ?? []) {
    const group = groups.get(model.provider)
    if (group === undefined) groups.set(model.provider, [model])
    else group.push(model)
  }
  return [...groups].map(([provider, models]) => ({
    label: provider,
    options: models.map((model) => ({
      value: modelKey(model.provider, model.id),
      label: model.name ?? model.id
    }))
  }))
})

const currentModelKey = computed(() => {
  const current = info.value
  if (current?.modelProvider == null || current.modelId == null) return ''
  return modelKey(current.modelProvider, current.modelId)
})
/** 当前模型不在能力列表里时保留当前文案，避免静默改选到别的模型。 */
const currentModelMissing = computed(() => (
  currentModelKey.value === ''
  || !(capabilities.value?.models ?? []).some(
    (model) => modelKey(model.provider, model.id) === currentModelKey.value
  )
))

/** 只有单一 `off` 说明当前模型不支持推理，此时禁用控件并说明原因。 */
const thinkingLevels = computed(() => capabilities.value?.thinkingLevels ?? [])
const thinkingGroups = computed(() => [{
  options: thinkingLevels.value.map((level) => ({ value: level, label: level }))
}])
const thinkingUnsupported = computed(() => (
  thinkingLevels.value.length === 1 && thinkingLevels.value[0] === 'off'
))

const usageText = computed(() => {
  const usage = capabilities.value?.contextUsage
  if (usage === null || usage === undefined) return null
  const tokens = usage.tokens === null ? '未知' : formatTokens(usage.tokens)
  const window = usage.contextWindow === null ? '未知' : formatTokens(usage.contextWindow)
  const percent = usage.percent === null ? '未知' : `${Math.round(usage.percent)}%`
  return `${tokens} / ${window}（${percent}）`
})
/** 上下文占用有三种未知：无可用窗口、读取失败、压缩后待刷新；这里如实区分。 */
const usageNote = computed(() => {
  const current = capabilitiesView.value
  if (current.phase === 'error') return current.error.message
  if (current.phase !== 'ready') return '正在读取 Agent 能力。'
  if (current.data.contextUsageError !== null) return current.data.contextUsageError
  if (current.data.contextUsage === null) return 'Pi 当前没有可用的上下文窗口。'
  if (current.data.contextUsage.tokens === null) return '压缩刚结束，Pi 尚未给出有效用量。'
  return null
})
const modelNote = computed(() => {
  const current = capabilitiesView.value
  if (current.phase !== 'ready') return null
  if (current.data.modelsError !== null) return current.data.modelsError
  if (current.data.models.length === 0) return 'Pi 没有返回可用模型；请检查模型配置与凭据。'
  return null
})
const thinkingNote = computed(() => {
  const current = capabilitiesView.value
  if (current.phase !== 'ready') return null
  return current.data.thinkingLevelsError
})
const actionError = computed(() => {
  if (modelAction.value.phase === 'error') return modelAction.value.error.message
  if (thinkingAction.value.phase === 'error') return thinkingAction.value.error.message
  return null
})
const busy = computed(() => (
  modelAction.value.phase === 'applying' || thinkingAction.value.phase === 'applying'
))

/** 压缩入口只在就绪且非压缩中时可用；压缩中提交会被 Pi 拒绝，界面同样禁用。 */
const compactAvailable = computed(() => (
  ready.value && info.value?.isCompacting !== true && compactAction.value.phase !== 'compacting'
))
const compactResult = computed(() => (
  compactAction.value.phase === 'done' ? compactAction.value.result : null
))
const compactError = computed(() => (
  compactAction.value.phase === 'error' ? compactAction.value.error.message : null
))

function compact(): void {
  void runtimeStore.compact()
}

/** provider 与 id 用 NUL 连接，避免两者中出现分隔符时产生歧义。 */
function modelKey(provider: string, id: string): string {
  return `${provider}\u0000${id}`
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

function onSelectModel(value: string): void {
  const separator = value.indexOf('\u0000')
  if (separator < 0) return
  const provider = value.slice(0, separator)
  const modelId = value.slice(separator + 1)
  if (provider === '' || modelId === '') return
  void runtimeStore.setModel(provider, modelId)
}

function onSelectThinking(level: string): void {
  if (level === '') return
  void runtimeStore.setThinkingLevel(level)
}
</script>

<template>
  <div class="space-y-3 text-xs">
    <div>
      <label class="field-label" for="agent-model">模型</label>
      <AppSelect
        id="agent-model"
        label="模型"
        class="mt-1"
        :groups="modelGroups"
        :model-value="currentModelKey"
        :empty-label="currentModelMissing ? (info?.model ?? '未提供') : '选择模型'"
        :disabled="!ready || busy || (capabilities?.models.length ?? 0) === 0"
        searchable
        search-placeholder="搜索模型或 Provider"
        empty-results-label="没有匹配的模型"
        @update:model-value="onSelectModel"
      />
      <p v-if="modelNote" class="mt-1 text-desk-muted">{{ modelNote }}</p>
    </div>

    <div>
      <label class="field-label" for="agent-thinking">Thinking</label>
      <AppSelect
        id="agent-thinking"
        label="Thinking"
        class="mt-1"
        :groups="thinkingGroups"
        :model-value="info?.thinkingLevel ?? ''"
        :empty-label="info?.thinkingLevel ?? '未设置'"
        :disabled="!ready || busy || thinkingUnsupported || thinkingLevels.length === 0"
        @update:model-value="onSelectThinking"
      />
      <p v-if="thinkingUnsupported" class="mt-1 text-desk-muted">当前模型不支持 Thinking。</p>
      <p v-else-if="thinkingNote" class="mt-1 text-desk-muted">{{ thinkingNote }}</p>
    </div>

    <div>
      <p class="field-label">上下文占用</p>
      <p v-if="usageText" class="mt-1 font-mono">{{ usageText }}</p>
      <p v-if="usageNote" class="mt-1 text-desk-muted">{{ usageNote }}</p>
    </div>

    <p v-if="info?.isCompacting" role="status" class="status-notice status-notice-warn">
      Pi 正在压缩上下文；此时提交会被 Pi 拒绝，请等当前轮结束。
    </p>

    <div class="space-y-2">
      <AppButton
        :disabled="!compactAvailable"
        @click="compact"
      >
        {{ compactAction.phase === 'compacting' ? '正在压缩…' : '压缩上下文' }}
      </AppButton>
      <p v-if="compactResult" class="status-notice">
        压缩完成：{{ compactResult.tokensBefore === null ? '未知' : formatTokens(compactResult.tokensBefore) }}
        → {{ compactResult.estimatedTokensAfter === null ? '未知' : formatTokens(compactResult.estimatedTokensAfter) }} tokens。
      </p>
      <p v-if="compactError" role="alert" class="status-notice status-notice-error">{{ compactError }}</p>
    </div>

    <p v-if="busy" role="status" class="status-notice">正在应用设置…</p>
    <p v-if="actionError" role="alert" class="status-notice status-notice-error">{{ actionError }}</p>
  </div>
</template>
