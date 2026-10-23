<!-- 供应商模型可见性区块：按单个模型控制它是否出现在输入坞模型选择器里。
     只写桌面端的展示偏好，不读取也不修改 Pi 的模型与认证配置；
     开关是乐观更新——界面先变，落盘失败由 store 回滚，因此勾选期间不禁用。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ModelSummary } from '../../../../shared/runtime-api'
import { useRuntimeStore } from '../../sessions/stores/runtime'

const props = defineProps<{
  /** 这些模型所属的 Provider。 */
  readonly provider: string
  /** 该 Provider 在当前模型目录下的模型。 */
  readonly models: readonly ModelSummary[]
  /** 已被隐藏的模型 id；隐藏中的模型在界面上为未勾选。 */
  readonly hiddenModelIds: ReadonlySet<string>
  /** 偏好尚未加载时禁用勾选；写入失败不禁用，用户再点一次即为重试。 */
  readonly disabled: boolean
}>()

const runtimeStore = useRuntimeStore()

/** 过滤词；只作用于展示集合，不改变勾选结果。 */
const query = ref('')

/** 单个供应商可能有上百个模型，按 id 与显示名过滤。 */
const filteredModels = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  if (keyword === '') return props.models
  return props.models.filter((model) => (
    model.id.toLocaleLowerCase().includes(keyword)
    || (model.name ?? '').toLocaleLowerCase().includes(keyword)
  ))
})

/** 当前目录里被隐藏的模型数；历史残留的偏好 id 不计入。 */
const hiddenCount = computed(() => props.models.filter((model) => props.hiddenModelIds.has(model.id)).length)

/** 单个模型开关：隐藏中的模型改为显示，其余改为隐藏。 */
function toggle(model: ModelSummary): void {
  if (props.disabled) return
  runtimeStore.setModelsVisibility(
    [{ provider: props.provider, modelId: model.id }],
    props.hiddenModelIds.has(model.id)
  )
}
</script>

<template>
  <div class="provider-visibility">
    <div class="provider-visibility__toolbar">
      <input
        v-model="query"
        type="search"
        placeholder="按模型 id 或显示名过滤"
        class="text-control provider-visibility__search"
      >
      <span class="provider-visibility__count">已隐藏 <strong>{{ hiddenCount }}</strong> / {{ models.length }}</span>
    </div>
    <p v-if="filteredModels.length === 0" class="provider-visibility__empty">
      没有匹配的模型；清空过滤可以看到这个供应商的全部模型。
    </p>
    <ul v-else class="provider-visibility__list">
      <li v-for="model in filteredModels" :key="model.id">
        <label class="provider-visibility__row">
          <input
            type="checkbox"
            class="provider-visibility__checkbox"
            :checked="!hiddenModelIds.has(model.id)"
            :disabled="disabled"
            @change="toggle(model)"
          >
          <span class="provider-visibility__model">
            <span class="provider-visibility__name">{{ model.name ?? model.id }}</span>
            <span class="provider-visibility__id">{{ model.id }}</span>
          </span>
        </label>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.provider-visibility {
  display: grid;
  gap: 0.625rem;
}

.provider-visibility__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.625rem 0.875rem;
}

.provider-visibility__search {
  width: min(100%, 22rem);
}

.provider-visibility__count {
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}

.provider-visibility__count strong {
  color: var(--color-desk-ink);
  font-weight: 650;
}

.provider-visibility__empty {
  margin: 0;
  color: var(--color-desk-muted);
  font-size: 0.75rem;
  line-height: 1.55;
}

.provider-visibility__list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
  padding: 0;
  list-style: none;
}

.provider-visibility__row {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 0.625rem;
  border-top: 1px solid var(--color-desk-line);
  padding: 0.625rem 0.5rem;
  cursor: pointer;
}

.provider-visibility__row:hover {
  background: var(--color-desk-surface-subtle);
}

.provider-visibility__checkbox {
  flex: none;
  margin-top: 0.1875rem;
  accent-color: var(--color-desk-accent);
}

.provider-visibility__checkbox:focus-visible {
  outline: 2px solid var(--color-desk-accent);
  outline-offset: 2px;
}

.provider-visibility__model {
  display: grid;
  min-width: 0;
  gap: 0.125rem;
}

.provider-visibility__name {
  overflow-wrap: anywhere;
  font-size: 0.75rem;
  line-height: 1.45;
}

.provider-visibility__id {
  overflow-wrap: anywhere;
  color: var(--color-desk-muted);
  font-family: var(--font-mono);
  font-size: 0.625rem;
  line-height: 1.45;
}

@media (max-width: 700px) {
  .provider-visibility__list {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
