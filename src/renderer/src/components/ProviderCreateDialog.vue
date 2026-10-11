<!-- 新建自定义供应商的弹窗：只提供遮罩、面板与 Escape 关闭。
     表单、校验与保存由 ProviderDefinitionSection 负责，本组件不另加标题栏与底部按钮。 -->
<script setup lang="ts">
import { onUnmounted, watch } from 'vue'
import ProviderDefinitionSection from './ProviderDefinitionSection.vue'

const props = defineProps<{
  /** 弹层由父级常驻挂载，`open` 控制进入/退出与 Escape 生命周期。 */
  readonly open: boolean
  /** 新建条目的初始供应商 ID；从某个供应商的详情进入时带上它的 ID。 */
  readonly presetProviderId: string
  /** models.json 里已存在的供应商 ID；用于拦下重名。 */
  readonly existingProviderIds: readonly string[]
}>()

const emit = defineEmits<{
  (event: 'saved', providerId: string): void
  (event: 'cancel'): void
}>()

/** 新建条目的初始内容；表单与原始 JSON 都以它为起点。 */
const INITIAL_RAW_TEXT = JSON.stringify({ api: 'openai-completions', models: [{ id: '' }] }, null, 2)

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('cancel')
}

// 打开时接管 Escape，关闭时立即移除，避免同一页面多个实例重复响应。
watch(
  () => props.open,
  (open) => {
    if (open) window.addEventListener('keydown', onKeydown)
    else window.removeEventListener('keydown', onKeydown)
  },
  { immediate: true }
)

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div
        v-if="open"
        class="dialog-overlay"
        @click.self="emit('cancel')"
      >
        <Transition name="dialog-panel-motion" appear>
          <div class="dialog-panel max-w-2xl">
            <div class="dialog-body">
              <ProviderDefinitionSection
                :key="presetProviderId"
                mode="create"
                :provider-id="presetProviderId"
                :initial-raw-text="INITIAL_RAW_TEXT"
                :existing-provider-ids="existingProviderIds"
                @saved="emit('saved', $event)"
                @cancel="emit('cancel')"
              />
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
