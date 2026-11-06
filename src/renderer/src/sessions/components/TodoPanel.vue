<!-- 待办清单面板：显示标准模式最近一次提交的清单，挂在输入坞上方。
     数据来自宿主活动投影（分支上最近一次 todo_write 结果的 details），本组件只做展示，
     不计算完成度、不改写清单；没有清单时整块不渲染，不用空状态占位。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { SessionTodoItem, SessionTodoList } from '../../../../shared/runtime-api'

const props = defineProps<{ readonly todos: SessionTodoList | null }>()

const items = computed<readonly SessionTodoItem[]>(() => props.todos?.items ?? [])
const doneCount = computed(() => items.value.filter(item => item.status === 'completed').length)
const title = computed(() => `待办 ${doneCount.value}/${items.value.length}`)

/** 状态用字符加文字表达，不只用颜色：读屏与色觉差异场景下同样可辨。 */
function statusMark(status: SessionTodoItem['status']): string {
  if (status === 'completed') return '✓'
  return status === 'in_progress' ? '▸' : '·'
}

function statusLabel(status: SessionTodoItem['status']): string {
  if (status === 'completed') return '已完成'
  return status === 'in_progress' ? '进行中' : '待处理'
}
</script>

<template>
  <section v-if="items.length > 0" class="prompt-todo" aria-labelledby="prompt-todo-title">
    <p id="prompt-todo-title" class="prompt-todo-title">{{ title }}</p>
    <ul class="prompt-todo-list scroll-area" role="list">
      <li
        v-for="(item, index) in items"
        :key="`${index}-${item.text}`"
        class="prompt-todo-item"
        :class="`is-${item.status}`"
      >
        <span class="prompt-todo-mark" aria-hidden="true">{{ statusMark(item.status) }}</span>
        <span class="min-w-0">{{ item.text }}</span>
        <span class="sr-only">{{ statusLabel(item.status) }}</span>
      </li>
    </ul>
  </section>
</template>
