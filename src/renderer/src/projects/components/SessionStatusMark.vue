<!--
  侧栏会话与项目行的运行状态标记。

  形状而非色相承担主要区分：执行中是一枚旋转环，需要留意是实心点加光晕，空闲是中性小点。
  同一形状族（实心点）内部仍靠颜色令牌区分语义，颜色因此是第二通道而不是唯一通道。
  标记本身 aria-hidden，状态文案由调用方的标题 chip 或 aria-label 提供，读屏不依赖形状。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { SESSION_RUN_LABELS, sessionRunTone } from '../sidebar-tree'
import type { SessionRunBadge } from '../../sessions/stores/session-runs'

const props = withDefaults(defineProps<{
  readonly badge: SessionRunBadge
  /** 标记外径；会话行为 14，项目行折叠提示沿用同一尺寸以免换形时跳动。 */
  readonly size?: number
}>(), {
  size: 14
})

const tone = computed(() => sessionRunTone(props.badge))
/** 旋转环要留出描边与呼吸弧的空间，实心点的核心只占外径的一半，两者视觉重量才相当。 */
const coreSize = computed(() => Math.round(props.size * 0.55))
</script>

<template>
  <span
    class="sidebar-status-mark"
    :class="`is-${tone}`"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :data-badge="badge"
    :title="SESSION_RUN_LABELS[badge]"
    aria-hidden="true"
  >
    <!-- 执行中：静止时也读得出“正在进行”，动效关闭后停在呼吸弧的初始位置。 -->
    <svg v-if="tone === 'busy'" class="sidebar-status-ring" viewBox="0 0 24 24" :width="size" :height="size" fill="none">
      <g class="sidebar-status-ring-motion">
        <circle class="sidebar-status-ring-track" cx="12" cy="12" r="9.5" />
        <circle class="sidebar-status-ring-arc" cx="12" cy="12" r="9.5" />
      </g>
    </svg>
    <span v-else class="sidebar-status-core" :style="{ width: `${coreSize}px`, height: `${coreSize}px` }" />
  </span>
</template>
