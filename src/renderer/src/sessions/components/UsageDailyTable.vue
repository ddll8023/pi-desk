<!-- 按日用量明细表：窗口内自然日的精确读数，最新日期在前。
     趋势图的键盘与精确读数入口：有记录的日期是按钮，点击进入当日会话明细；
     无记录日为纯文本，补零行让「范围里哪些天没在用」一眼可读。 -->
<script setup lang="ts">
import type { DailyDetailRow } from '../usage-stats-view'
import { formatCostOrDash, formatTokens } from '../usage-format'

const props = defineProps<{
  readonly rows: readonly DailyDetailRow[]
  /** 费用列只在窗口内存在计价调用时出现。 */
  readonly costAvailable: boolean
}>()

const emit = defineEmits<{ selectDay: [date: string] }>()
</script>

<template>
  <div class="max-h-80 overflow-auto scroll-area">
    <table class="w-full min-w-[34rem] border-collapse text-xs">
      <caption class="sr-only">按日用量明细</caption>
      <thead>
        <tr class="text-2xs text-desk-muted">
          <th scope="col" class="py-1.5 pr-2 text-left font-medium">日期</th>
          <th scope="col" class="px-2 py-1.5 text-right font-medium">总量</th>
          <th scope="col" class="px-2 py-1.5 text-right font-medium">输入</th>
          <th scope="col" class="px-2 py-1.5 text-right font-medium">输出</th>
          <th scope="col" class="px-2 py-1.5 text-right font-medium">缓存读</th>
          <th scope="col" class="px-2 py-1.5 text-right font-medium">缓存写</th>
          <th scope="col" class="px-2 py-1.5 text-right font-medium">回复</th>
          <th v-if="props.costAvailable" scope="col" class="py-1.5 pl-2 text-right font-medium">费用</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in props.rows" :key="row.date" class="border-t border-desk-line">
          <th scope="row" class="py-1.5 pr-2 text-left font-normal tabular-nums">
            <button
              v-if="row.active"
              type="button"
              class="cursor-pointer rounded-xs transition-colors hover:text-desk-accent focus-visible:outline-2 focus-visible:outline-[var(--color-desk-accent)]"
              :aria-label="`查看 ${row.date} 的会话明细`"
              @click="emit('selectDay', row.date)"
            >
              {{ row.date }}
            </button>
            <span v-else>{{ row.date }}</span>
          </th>
          <td class="px-2 py-1.5 text-right font-medium tabular-nums">{{ formatTokens(row.totalTokens) }}</td>
          <td class="px-2 py-1.5 text-right tabular-nums text-desk-muted">{{ formatTokens(row.input) }}</td>
          <td class="px-2 py-1.5 text-right tabular-nums text-desk-muted">{{ formatTokens(row.output) }}</td>
          <td class="px-2 py-1.5 text-right tabular-nums text-desk-muted">{{ formatTokens(row.cacheRead) }}</td>
          <td class="px-2 py-1.5 text-right tabular-nums text-desk-muted">{{ formatTokens(row.cacheWrite) }}</td>
          <td class="px-2 py-1.5 text-right tabular-nums text-desk-muted">{{ row.messageCount }}</td>
          <td v-if="props.costAvailable" class="py-1.5 pl-2 text-right tabular-nums text-desk-muted">
            {{ formatCostOrDash(row.cost) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
