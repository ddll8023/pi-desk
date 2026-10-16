<!-- 供应商模型可见性区块：按单个模型控制它是否出现在输入坞模型选择器里。
     只写桌面端的展示偏好，不读取也不修改 Pi 的模型与认证配置；
     开关是乐观更新——界面先变，落盘失败由 store 回滚，因此勾选期间不禁用。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ModelSummary } from '../../../shared/runtime-api'
import { useRuntimeStore } from '../stores/runtime'

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
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <input
        v-model="query"
        type="search"
        placeholder="按模型 id 或显示名过滤"
        class="text-control sm:max-w-64"
      >
      <span class="chip">已隐藏 {{ hiddenCount }} / {{ models.length }}</span>
    </div>
    <p v-if="filteredModels.length === 0" class="hint-text">
      没有匹配的模型；清空过滤可以看到这个供应商的全部模型。
    </p>
    <ul v-else class="space-y-1">
      <li v-for="model in filteredModels" :key="model.id">
        <label class="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            class="mt-0.5"
            :checked="!hiddenModelIds.has(model.id)"
            :disabled="disabled"
            @click.prevent="toggle(model)"
          >
          <span class="min-w-0">
            {{ model.name ?? model.id }}
            <span class="ml-1 font-mono text-2xs text-desk-muted">{{ model.id }}</span>
          </span>
        </label>
      </li>
    </ul>
  </div>
</template>
