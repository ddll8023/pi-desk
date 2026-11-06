<!-- 待办清单面板：显示当前轮的待办清单，挂在输入坞上方。
     数据来自宿主活动投影（本轮 `todo_write` 结果的 details）；新一轮开始或模型提交空清单时
     宿主给出 null，整块不渲染，不留上一轮的旧清单。本组件只做展示，不计算完成度、不改写清单。
     标题行就是折叠开关：默认展开，收起后只留完成进度，折叠状态不持久化。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SessionTodoItem, SessionTodoList } from '../../../../shared/runtime-api'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{ readonly todos: SessionTodoList | null }>()

const expanded = ref(true)
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
    <AppButton
      variant="unstyled"
      class="prompt-todo-head"
      :aria-expanded="expanded"
      aria-controls="prompt-todo-list"
      :title="expanded ? '折叠待办清单，只留完成进度' : '展开待办清单'"
      @click="expanded = !expanded"
    >
      <span id="prompt-todo-title" class="prompt-todo-title">{{ title }}</span>
      <span class="prompt-todo-chevron" aria-hidden="true">{{ expanded ? '⌃' : '⌄' }}</span>
    </AppButton>
    <ul v-show="expanded" id="prompt-todo-list" class="prompt-todo-list scroll-area" role="list">
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
