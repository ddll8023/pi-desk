<!-- 对话页模型展示设置：按单个模型控制顶栏模型切换器的候选项，供应商开关用于批量全选/全不选；只影响桌面显示，不读取也不修改 Pi 配置。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { ModelSummary } from '../../../shared/runtime-api'
import { useRuntimeStore } from '../stores/runtime'
import AppButton from './ui/AppButton.vue'

const runtimeStore = useRuntimeStore()
const { availableModels, hiddenModels, modelDisplayLoaded, modelDisplayView } = storeToRefs(runtimeStore)

const filter = ref('')

interface ProviderEntry {
  readonly provider: string
  readonly models: readonly ModelSummary[]
}

/** 只列出当前确实有模型的 Provider，它们才是切换器里可能出现的候选项。 */
const providerEntries = computed<ProviderEntry[]>(() => {
  const collected = new Map<string, ModelSummary[]>()
  for (const model of availableModels.value) {
    const models = collected.get(model.provider) ?? []
    models.push(model)
    collected.set(model.provider, models)
  }
  return [...collected].map(([provider, models]) => ({ provider, models }))
})

const visibleEntries = computed(() => {
  const query = filter.value.trim().toLocaleLowerCase()
  if (query === '') return providerEntries.value
  return providerEntries.value.filter((entry) => entry.provider.toLocaleLowerCase().includes(query))
})

const loading = computed(() => modelDisplayView.value.phase === 'loading')
const busy = computed(() => modelDisplayView.value.phase === 'saving')
const canToggle = computed(() => modelDisplayLoaded.value && !busy.value && !loading.value)
const error = computed(() => (
  modelDisplayView.value.phase === 'error' ? modelDisplayView.value.error.message : null
))

/** 只统计当前仍有模型的隐藏条目，历史残留不计入展示。 */
const hiddenModelCount = computed(() => hiddenModels.value.filter((hidden) => (
  providerEntries.value.some((entry) => entry.provider === hidden.provider
    && entry.models.some((model) => model.id === hidden.modelId))
)).length)

function isModelHidden(provider: string, modelId: string): boolean {
  return hiddenModels.value.some((hidden) => hidden.provider === provider && hidden.modelId === modelId)
}

function hiddenModelCountOf(entry: ProviderEntry): number {
  return entry.models.filter((model) => isModelHidden(entry.provider, model.id)).length
}

/** 供应商复选框的三态：全部可见为选中，全部隐藏为未选，部分可见为半选。 */
function isProviderFullyVisible(entry: ProviderEntry): boolean {
  return entry.models.every((model) => !isModelHidden(entry.provider, model.id))
}

function isProviderPartiallyVisible(entry: ProviderEntry): boolean {
  const hidden = hiddenModelCountOf(entry)
  return hidden > 0 && hidden < entry.models.length
}

/** 供应商开关 = 批量全选/全不选：部分选中时点击恢复全部显示，全部显示时点击全部取消。 */
function toggleProvider(entry: ProviderEntry): void {
  if (!canToggle.value) return
  const models = entry.models.map((model) => ({ provider: entry.provider, modelId: model.id }))
  runtimeStore.setModelsVisibility(models, !isProviderFullyVisible(entry))
}

/** 单个模型开关；取消全部后仍可单独勾回需要的模型。 */
function toggleModel(provider: string, modelId: string): void {
  if (!canToggle.value) return
  runtimeStore.setModelsVisibility([{ provider, modelId }], isModelHidden(provider, modelId))
}

/** 清空隐藏列表，恢复全部显示。 */
function showAll(): void {
  if (!canToggle.value || hiddenModelCount.value === 0) return
  runtimeStore.showAllModels()
}
</script>

<template>
  <div class="space-y-4">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">对话页模型</h1>
      <p class="mt-1 text-sm text-desk-muted">
        选择哪些模型出现在顶栏的模型切换器里。只影响桌面显示，不改变 Pi 的认证与模型配置。
      </p>
    </header>

    <div class="flex flex-wrap items-center gap-2">
      <input
        v-model="filter"
        type="search"
        placeholder="按 provider 过滤"
        class="text-control sm:max-w-64"
      >
      <span class="chip">隐藏 {{ hiddenModelCount }} 个模型</span>
      <AppButton
        variant="compact"
        class="ml-auto"
        :disabled="!canToggle || hiddenModelCount === 0"
        @click="showAll"
      >
        全部显示
      </AppButton>
    </div>

    <p v-if="error !== null" role="alert" class="status-notice status-notice-error">{{ error }}</p>

    <p v-if="loading" class="hint-text">正在读取展示偏好…</p>

    <template v-else>
      <p v-if="availableModels.length === 0" class="hint-text">
        当前没有可用模型。启动 Runtime 或配置供应商认证后再回来设置。
      </p>
      <p v-else-if="visibleEntries.length === 0" class="hint-text">没有匹配的 Provider。</p>

      <ul v-else class="space-y-1.5">
        <li v-for="entry in visibleEntries" :key="entry.provider" class="list-card">
          <div class="flex items-start gap-3">
            <input
              type="checkbox"
              class="mt-0.5"
              :checked="isProviderFullyVisible(entry)"
              :indeterminate="isProviderPartiallyVisible(entry)"
              :disabled="!canToggle"
              :aria-label="`在对话页显示 ${entry.provider} 的全部模型`"
              @click.prevent="toggleProvider(entry)"
            >
            <details class="min-w-0 flex-1">
              <summary class="cursor-pointer text-sm">
                <span class="font-mono">{{ entry.provider }}</span>
                <span class="ml-2 text-2xs text-desk-muted">
                  {{ entry.models.length }} 个模型<span v-if="hiddenModelCountOf(entry) > 0"> · 已隐藏 {{ hiddenModelCountOf(entry) }}</span>
                </span>
              </summary>
              <ul class="mt-2 space-y-1">
                <li v-for="model in entry.models" :key="model.id">
                  <label class="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      class="mt-0.5"
                      :checked="!isModelHidden(entry.provider, model.id)"
                      :disabled="!canToggle"
                      @click.prevent="toggleModel(entry.provider, model.id)"
                    >
                    <span class="min-w-0">
                      {{ model.name ?? model.id }}
                      <span class="ml-1 font-mono text-2xs text-desk-muted">{{ model.id }}</span>
                    </span>
                  </label>
                </li>
              </ul>
            </details>
          </div>
        </li>
      </ul>
    </template>

    <section class="panel-section">
      <h2 class="panel-section-title">边界说明</h2>
      <ul class="list-disc space-y-1 pl-4 text-xs leading-5 text-desk-muted">
        <li>供应商开关是批量操作：全部显示时点击会取消它下面所有模型，部分选中时点击会恢复全部显示；展开后可以逐个勾选。</li>
        <li>隐藏只作用于顶栏模型切换器的候选项；当前会话模型与已保存的新会话默认模型不受影响，仍会正常显示。</li>
        <li>这里不读取也不修改 Pi 的 settings.json 或 models.json，不影响 Pi 自身的模型选择与认证。</li>
        <li>展示偏好读取失败时不会应用任何过滤，模型保持全部显示。</li>
      </ul>
    </section>
  </div>
</template>
