<!--
  右侧面板的页签条：文件树与源代码管理共用同一列，同一时刻只显示一个。

  页签只表达「看哪一个视图」，不承担任何数据读取：选中状态由界面偏好持有（重启后保持），
  切换只派发一次意图，读取与缓存分别由两个视图自己管理。改动数只作为提示，为 0 时不显示。
-->
<script setup lang="ts">
import type { RightPanelTab } from '../../../shared/preferences-api'

const props = defineProps<{
  readonly active: RightPanelTab
  /** 未提交的改动条目数；只用于页签上的角标。 */
  readonly changes: number
}>()

const emit = defineEmits<{
  select: [tab: RightPanelTab]
}>()

/** 页签定义：顺序即展示顺序，图标与文案成对给出。 */
const TABS: readonly { readonly key: RightPanelTab; readonly label: string }[] = [
  { key: 'files', label: '文件' },
  { key: 'source-control', label: '源代码管理' }
]
</script>

<template>
  <div class="right-panel-tabs" role="tablist" aria-label="右侧面板视图">
    <button
      v-for="tab in TABS"
      :key="tab.key"
      type="button"
      role="tab"
      class="right-panel-tab"
      :class="{ 'is-active': props.active === tab.key }"
      :aria-selected="props.active === tab.key"
      @click="emit('select', tab.key)"
    >
      <span class="right-panel-tab-label">{{ tab.label }}</span>
      <span
        v-if="tab.key === 'source-control' && props.changes > 0"
        class="right-panel-tab-count"
        :aria-label="`${props.changes} 个改动`"
      >{{ props.changes > 99 ? '99+' : props.changes }}</span>
    </button>
  </div>
</template>
