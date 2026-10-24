<!--
  侧栏会话行：二级节点，也承载“尚未绑定会话的运行实例”这一特殊行。

  布局固定为四格——状态槽、标题（含状态 chip 与分叉字形）、相对时间、悬停操作。
  状态从行尾移到行首并改成形状区分：执行中是旋转环，需要留意是实心点加光晕，
  时间因此始终留在同一个位置，用户扫视时不会因为某行“时间变成文字”而读错。
  当前会话的底色由外层 LayoutGroup 的共享背景承担，这里只渲染目标元素，避免两层底色叠加。
  行只接收已算好的展示字段，不接触会话摘要或运行状态，因此未绑定实例也能用同一套排布。
-->
<script setup lang="ts">
import { Motion } from 'motion-v'
import type { Options } from 'motion-v'
import type { SessionRunBadge } from '../../sessions/stores/session-runs'
import AppButton from '../../ui/AppButton.vue'
import SessionStatusMark from './SessionStatusMark.vue'

defineProps<{
  readonly title: string
  /** 行尾元信息，始终是相对时间或“进行中”这类时间替代文案。 */
  readonly meta: string
  readonly badge: SessionRunBadge | null
  /** 需要留意时的状态短标签；为空表示该行只留状态标记。 */
  readonly chip: string | null
  readonly forkedFrom: string | null
  /** 该行是否就是当前项目的当前会话；未绑定的运行实例永远不是当前会话。 */
  readonly current: boolean
  /** 共享选中背景的 layout-id：每个项目一组，跨项目切换时不做位移动画。 */
  readonly selectionLayoutId: string
  readonly selectionTransition: NonNullable<Options['transition']>
  /** 会话打开或删除进行中。 */
  readonly busy: boolean
  readonly menuOpen: boolean
  /** 是否提供更多操作入口：没有文件条目的会话只保留阻塞态的释放动作。 */
  readonly hasMenu: boolean
}>()

const emit = defineEmits<{
  open: []
  menuRequest: [event: MouseEvent | KeyboardEvent, toggle: boolean]
  rowKeydown: [event: KeyboardEvent]
}>()

function onContextMenu(event: MouseEvent): void {
  event.preventDefault()
  emit('menuRequest', event, false)
}
</script>

<template>
  <div
    class="sidebar-tree-row is-session"
    :class="{ 'is-active': current, 'is-menu-open': menuOpen }"
    @contextmenu="onContextMenu"
    @keydown="emit('rowKeydown', $event)"
  >
    <Motion v-if="current" as="span" :layout-id="selectionLayoutId" class="sidebar-selection" :initial="false" :transition="selectionTransition" aria-hidden="true" />
    <!-- 状态槽在最左：即使标题很长被截断，状态也总在同一列可读。 -->
    <span class="sidebar-session-status">
      <SessionStatusMark v-if="badge !== null" :badge="badge" />
    </span>
    <AppButton
      variant="unstyled" class="sidebar-tree-item is-session"
      :aria-current="current ? 'true' : undefined"
      :title="title" :disabled="busy"
      @click="emit('open')"
    >
      <span class="sidebar-session-title">{{ title }}</span>
      <!-- 需要留意时才出 chip；已就绪与已回收保持安静，只留状态标记。 -->
      <span v-if="chip !== null && badge !== null" class="sidebar-session-chip" :class="`is-${badge}`">{{ chip }}</span>
      <!-- 分叉来源只用字形占位，完整来源与时间一样留在操作浮层里。 -->
      <span v-if="forkedFrom !== null" class="sidebar-session-fork" :title="`分叉自 ${forkedFrom}`" aria-hidden="true">⑂</span>
    </AppButton>
    <span class="sidebar-row-tail">
      <span class="sidebar-session-meta">{{ meta }}</span>
      <span v-if="hasMenu" class="sidebar-row-actions">
        <AppButton
          variant="unstyled" class="sidebar-row-action" data-sidebar-menu-trigger
          :disabled="busy" :aria-label="`会话 ${title} 的更多操作`"
          aria-haspopup="dialog" :aria-expanded="menuOpen"
          :aria-controls="menuOpen ? 'sidebar-actions' : undefined"
          @click.stop="emit('menuRequest', $event, true)"
        >
          <svg class="sidebar-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
        </AppButton>
      </span>
    </span>
  </div>
</template>
