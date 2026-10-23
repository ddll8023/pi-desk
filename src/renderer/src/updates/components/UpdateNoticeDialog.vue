<!-- 启动时发现可更新的只读提示：列出有更新的扩展，可以跳到设置页看详情或直接关闭。
     只报告版本差异，不在这里执行安装或更新；Pi agent 随应用发布更新，不作为用户待办，因此不在这里提示。 -->
<script setup lang="ts">
import { nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { ExtensionUpdateInfo } from '../../../../shared/updates-api'
import { useUpdatesStore } from '../stores/updates'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  /** 弹层由父级常驻挂载，`open` 控制进入/退出与焦点、快捷键生命周期。 */
  readonly open: boolean
}>()

const emit = defineEmits<{
  details: []
  dismiss: []
}>()

const updatesStore = useUpdatesStore()
const { outdatedExtensions } = storeToRefs(updatesStore)
const panel = ref<HTMLElement | null>(null)
const titleId = useId()

/** 扩展的版本差异文本；git 源比的是提交短哈希，与 npm 的版本号分开表述。 */
function changeText(entry: ExtensionUpdateInfo): string {
  const installed = entry.installedVersion ?? '未知'
  const latest = entry.latestVersion ?? '未知'
  return entry.type === 'git'
    ? `已装提交 ${installed} → 远端 ${latest}`
    : `已装 ${installed} → 最新 ${latest}`
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('dismiss')
}

// 打开时聚焦对话框并接管 Escape；关闭时立即移除，避免同一页面多个实例重复响应。
watch(
  () => props.open,
  (open) => {
    if (open) {
      window.addEventListener('keydown', onKeydown)
      void nextTick(() => {
        // 焦点落在对话框本身，键盘用户按 Tab 先到次要按钮，不用 Enter 直接跳到设置页。
        panel.value?.focus()
      })
    } else {
      window.removeEventListener('keydown', onKeydown)
    }
  },
  { immediate: true }
)

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Transition name="dialog-fade">
    <div
      v-if="props.open"
      class="dialog-overlay"
      @click.self="emit('dismiss')"
    >
      <Transition name="dialog-panel-motion" appear>
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
          class="dialog-panel max-w-lg"
        >
          <div class="dialog-header">
            <h2 :id="titleId" class="dialog-title">发现可更新的内容</h2>
          </div>
          <div class="dialog-body">
            <p class="text-sm">检查到以下扩展落后于远端；这里只报告版本，更新需要按下面的说明自行执行。</p>
            <ul class="mt-2 space-y-1.5">
              <li
                v-for="entry in outdatedExtensions"
                :key="`${entry.scope}-${entry.source}`"
                class="list-card"
              >
                <p class="break-all font-mono text-xs font-medium">{{ entry.source }}</p>
                <p class="mt-0.5 font-mono text-2xs text-desk-muted">{{ changeText(entry) }}</p>
              </li>
            </ul>
            <p class="mt-2 text-2xs text-desk-muted">
              扩展用 <span class="font-mono">pi update --extensions</span> 更新；设置页可以复制该命令。
            </p>
          </div>
          <div class="dialog-footer">
            <AppButton @click="emit('dismiss')">稍后</AppButton>
            <AppButton variant="primary" @click="emit('details')">查看详情</AppButton>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
