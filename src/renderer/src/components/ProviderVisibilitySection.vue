<!-- 供应商模型可见性区块：按单个模型控制它是否出现在顶栏模型切换器里。
     只写桌面端的展示偏好，不读取也不修改 Pi 的模型与认证配置。 -->
<script setup lang="ts">
import type { ModelSummary } from '../../../shared/runtime-api'
import { useRuntimeStore } from '../stores/runtime'

const props = defineProps<{
  /** 这些模型所属的 Provider。 */
  provider: string
  /** 该 Provider 在当前模型目录下的模型。 */
  models: readonly ModelSummary[]
  /** 已被隐藏的模型 id；隐藏中的模型在界面上为未勾选。 */
  hiddenModelIds: ReadonlySet<string>
  /** 偏好尚未就绪或正在写入时禁用勾选。 */
  disabled: boolean
}>()

const runtimeStore = useRuntimeStore()

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
  <ul class="mt-2 space-y-1">
    <li v-for="model in models" :key="model.id">
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
</template>
