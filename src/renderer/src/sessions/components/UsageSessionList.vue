<!-- 用量会话明细列表：范围内消耗 Top 与模型/项目/单日/子代理下钻共用的会话列表。
     每行是原生按钮：可聚焦、可键盘触发，点击跳转至对应项目的该会话（由父级关闭设置页）。
     行内数值随视图口径按范围结算，见 usage-stats-view 的 buildSessionRows。 -->
<script setup lang="ts">
import type { UsageSessionRow } from '../usage-stats-view'
import { formatDateTime, formatTokens } from '../usage-stats-view'
import { formatCost } from '../usage-format'

const props = defineProps<{
  readonly rows: readonly UsageSessionRow[]
  readonly emptyText: string
}>()

const emit = defineEmits<{ open: [row: UsageSessionRow] }>()
</script>

<template>
  <p v-if="props.rows.length === 0" class="mt-3 text-xs text-desk-muted">
    {{ props.emptyText }}
  </p>

  <ul v-else class="mt-3 -mx-2 max-h-96 divide-y divide-desk-line overflow-y-auto scroll-area">
    <li v-for="(session, index) in props.rows" :key="session.sessionId">
      <button
        type="button"
        class="group flex w-full cursor-pointer items-center justify-between gap-3 px-2 py-2.5 text-left text-xs transition-colors hover:bg-desk-canvas-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-desk-accent)]"
        @click="emit('open', session)"
      >
        <!-- 序号与标题 -->
        <span class="w-6 shrink-0 text-right font-mono text-2xs tabular-nums text-desk-muted">#{{ index + 1 }}</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="truncate font-medium text-desk-ink group-hover:text-desk-accent" :title="session.title">
              {{ session.title }}
            </span>
            <span class="shrink-0 rounded border border-desk-line px-1 py-px text-2xs text-desk-muted">
              {{ session.projectName }}
            </span>
          </div>
          <div class="mt-0.5 text-2xs text-desk-muted">
            更新于 {{ formatDateTime(session.updatedAt) }} · {{ session.messageCount }} 条回复
          </div>
        </div>

        <!-- 用量与 Token -->
        <div class="shrink-0 text-right">
          <div class="text-xs font-semibold tabular-nums text-desk-ink">
            {{ formatTokens(session.totalTokens) }}
          </div>
          <div class="text-2xs tabular-nums text-desk-muted">
            入 {{ formatTokens(session.input) }} · 出 {{ formatTokens(session.output) }}
            <template v-if="session.cost !== null"> · ${{ formatCost(session.cost) }}</template>
          </div>
        </div>
      </button>
    </li>
  </ul>
</template>
