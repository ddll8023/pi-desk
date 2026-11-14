<!-- 用量分布列表：模型、项目与子代理行共用的读数列表。
     每行是原生按钮：读数、构成条与下钻目标都来自 usage-stats-view 预先算好的行数据；
     行内构成条与趋势图同序同色，只表达构成、不重复绝对值。点击整行进入该维度的会话明细。 -->
<script setup lang="ts">
import type { SessionDrill, UsageDistributionRow } from '../usage-stats-view'
import UsageCompositionBar from './UsageCompositionBar.vue'

const props = defineProps<{
  readonly rows: readonly UsageDistributionRow[]
  readonly emptyText: string
}>()

const emit = defineEmits<{ select: [drill: SessionDrill] }>()
</script>

<template>
  <p v-if="props.rows.length === 0" class="mt-3 text-xs text-desk-muted">
    {{ props.emptyText }}
  </p>

  <!-- 列表项不再套一层卡片：外层分节已是卡片，行与行之间用分隔线区分。
       左右各外扩 8px 交给滚动条槽位，行内 padding 再把内容拉回分节的内容边。 -->
  <ul v-else class="mt-3 -mx-2 max-h-80 overflow-y-auto scroll-area">
    <li v-for="row in props.rows" :key="row.key">
      <button
        type="button"
        class="block w-full cursor-pointer border-t border-desk-line px-2 py-2.5 text-left text-xs transition-colors first:border-t-0 hover:bg-desk-canvas-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-desk-accent)]"
        @click="emit('select', row.drill)"
      >
        <div class="flex items-baseline justify-between gap-3">
          <div class="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span v-if="row.badge !== null" class="shrink-0 text-2xs text-desk-muted">[{{ row.badge }}]</span>
            <span class="min-w-0 truncate font-medium" :title="row.detailTitle ?? undefined">{{ row.name }}</span>
          </div>
          <div class="shrink-0 text-right text-xs font-semibold whitespace-nowrap tabular-nums">
            {{ row.totalTokens }}
            <span class="ml-1 font-normal text-2xs text-desk-muted">{{ row.share }}</span>
          </div>
        </div>

        <!-- 构成条：与趋势图同序同色的四段，行内只表达构成，绝对值已在上方数字里。
             外面包一层普通块：条宽只取决于这个块，不依赖行内的 flex 上下文。 -->
        <div v-if="row.segments.length > 0" class="mt-2">
          <UsageCompositionBar
            :segments="row.segments"
            size="sm"
            :label="`${row.name} 的 Token 构成`"
          />
        </div>

        <div class="mt-1.5 flex items-center justify-between gap-2 text-2xs tabular-nums text-desk-muted">
          <span class="min-w-0 flex-1 truncate" :title="row.detailTitle ?? undefined">{{ row.detail }}</span>
          <span class="shrink-0">{{ row.meta }}</span>
        </div>
      </button>
    </li>
  </ul>
</template>
