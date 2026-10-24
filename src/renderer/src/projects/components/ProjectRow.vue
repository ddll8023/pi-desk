<!--
  侧栏项目行：一级节点，只负责自身排布与动作转发。

  行由三格组成——展开控件、项目主体（图标 + 名称 + 路径）、尾部（折叠时的活动标记与操作按钮）；
  当前项目用共享背景上的强调竖条表达，竖条的移动动画由外层 LayoutGroup 提供，这里只给出目标元素。
  折叠状态、会话归属与项目切换的判定都在外层或 sidebar-tree.ts，组件不重复推导。
-->
<script setup lang="ts">
import { Motion } from 'motion-v'
import type { Options } from 'motion-v'
import type { SidebarProjectNode } from '../sidebar-tree'
import AppButton from '../../ui/AppButton.vue'
import SessionStatusMark from './SessionStatusMark.vue'

defineProps<{
  /** 节点自带 `current`：当前项目由树构建结果决定，不在行内二次判断。 */
  readonly node: SidebarProjectNode
  /** 项目相关动作进行中：切换、添加或移除时整行不可点。 */
  readonly busy: boolean
  /** 该行的操作浮层是否打开；打开期间保持悬停底色。 */
  readonly menuOpen: boolean
  readonly selectionTransition: NonNullable<Options['transition']>
}>()

const emit = defineEmits<{
  /** 展开折叠只改界面偏好，不切换当前项目。 */
  toggle: []
  setExpanded: [expanded: boolean]
  select: []
  createSession: []
  /** 菜单请求：右键、Shift+F10 与操作按钮共用一条路径，toggle 表示按钮再次点击时收起。 */
  menuRequest: [event: MouseEvent | KeyboardEvent, toggle: boolean]
  rowKeydown: [event: KeyboardEvent]
}>()

/** 路径展示末尾两段，兼容两种目录分隔符；完整路径仍在项目行提示与操作浮层中可读。 */
function shortenPath(path: string): string {
  const separators = [...path.matchAll(/[\\/]/g)]
  const cut = separators.at(-2)
  return cut === undefined ? path : `…${path.slice(cut.index)}`
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault()
  emit('menuRequest', event, false)
}
</script>

<template>
  <div
    class="sidebar-tree-row is-project"
    :class="{ 'is-active': node.current, 'is-menu-open': menuOpen }"
    @contextmenu="onContextMenu"
    @keydown="emit('rowKeydown', $event)"
  >
    <Motion v-if="node.current" as="span" layout-id="project-selection" class="sidebar-project-rail" :initial="false" :transition="selectionTransition" aria-hidden="true" />
    <AppButton
      variant="unstyled" class="sidebar-chevron"
      :aria-expanded="node.expanded" :aria-controls="`sidebar-sessions-${node.project.id}`"
      :aria-label="`${node.expanded ? '折叠' : '展开'}项目 ${node.project.name}`"
      :disabled="busy"
      @click="emit('toggle')"
      @keydown.left.prevent="emit('setExpanded', false)"
      @keydown.right.prevent="emit('setExpanded', true)"
    >
      <svg class="sidebar-icon sidebar-chevron-mark" :class="{ 'is-expanded': node.expanded }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
    </AppButton>
    <AppButton
      variant="unstyled" class="sidebar-tree-item is-project"
      :aria-current="node.current ? 'true' : undefined"
      :title="`${node.project.name}\n${node.project.path}`" :disabled="busy"
      @click="emit('select')"
    >
      <svg class="sidebar-project-mark sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 10h18" /></svg>
      <span class="sidebar-tree-copy">
        <span class="sidebar-project-name">{{ node.project.name }}</span>
        <span class="sidebar-project-path">{{ shortenPath(node.project.path) }}</span>
      </span>
    </AppButton>
    <span class="sidebar-row-tail">
      <!-- 折叠时也要能看到该项目有活动：展开后由会话行自己表达。 -->
      <span v-if="!node.expanded && node.activity !== null" class="sidebar-project-activity">
        <SessionStatusMark :badge="node.activity" :size="12" />
      </span>
      <span class="sidebar-row-actions">
        <AppButton
          variant="unstyled" class="sidebar-row-action"
          :disabled="busy" :aria-label="`在项目 ${node.project.name} 新建会话`"
          @click.stop="emit('createSession')"
        >
          <svg class="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </AppButton>
        <AppButton
          variant="unstyled" class="sidebar-row-action" data-sidebar-menu-trigger
          :disabled="busy" :aria-label="`项目 ${node.project.name} 的更多操作`"
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
