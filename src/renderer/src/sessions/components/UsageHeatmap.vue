<!-- 用量日度热力图：
     把近一年的每日 Token 画成 7 行 × N 列日历格，用同一色相的深浅表达强度。
     只表达分布与量级，精确读数交给格子悬停提示和下方按日明细表，不为每格增加 Tab 停留点。
     未来日期留空占位以保持列对齐；无记录日期用底槽色，与「有记录但很小」区分开。 -->
<script setup lang="ts">
import type { HeatmapModel } from '../usage-stats-view'
import { HEATMAP_LEVEL_COLORS } from '../usage-stats-view'

interface Props {
  readonly model: HeatmapModel
}

const props = defineProps<Props>()

/** 只标三行星期，七行全标会挤在一起且没有更多信息。 */
const WEEKDAY_LABELS = [
  { key: 'mon', label: '一' },
  { key: 'tue', label: '' },
  { key: 'wed', label: '三' },
  { key: 'thu', label: '' },
  { key: 'fri', label: '五' },
  { key: 'sat', label: '' },
  { key: 'sun', label: '日' }
] as const
</script>

<template>
  <div class="overflow-x-auto scroll-area pb-1">
    <div class="inline-flex min-w-full flex-col gap-1.5">
      <!-- 月份标签只在该列列首跨月时出现，与下方格子同列同宽 -->
      <div class="flex gap-1.5" aria-hidden="true">
        <div class="w-6 shrink-0"></div>
        <div class="flex gap-1.5">
          <div
            v-for="week in props.model.weeks"
            :key="`month-${week.key}`"
            class="relative h-4 w-[10px] shrink-0"
          >
            <span v-if="week.monthLabel" class="absolute top-0 left-0 whitespace-nowrap text-2xs text-desk-muted">
              {{ week.monthLabel }}
            </span>
          </div>
        </div>
      </div>

      <div class="flex gap-1.5">
        <div class="flex w-6 shrink-0 flex-col gap-1.5" aria-hidden="true">
          <span
            v-for="day in WEEKDAY_LABELS"
            :key="day.key"
            class="flex h-[10px] items-center text-2xs leading-none text-desk-muted"
          >
            {{ day.label }}
          </span>
        </div>

        <div class="flex gap-1.5" role="img" :aria-label="props.model.ariaLabel">
          <div
            v-for="week in props.model.weeks"
            :key="week.key"
            class="flex shrink-0 flex-col gap-1.5"
          >
            <span
              v-for="cell in week.cells"
              :key="cell.date"
              class="size-[10px] shrink-0 rounded-[2px]"
              :class="cell.future ? 'invisible' : ''"
              :style="{ backgroundColor: HEATMAP_LEVEL_COLORS[cell.level] }"
              :title="cell.title === '' ? undefined : cell.title"
            ></span>
          </div>
        </div>
      </div>

      <!-- 色阶图例：与格子同色，只说明方向，不重复具体读数 -->
      <div class="flex items-center justify-end gap-1.5 text-2xs text-desk-muted" aria-hidden="true">
        <span>少</span>
        <span
          v-for="(color, index) in HEATMAP_LEVEL_COLORS"
          :key="index"
          class="size-[10px] rounded-[2px]"
          :style="{ backgroundColor: color }"
        ></span>
        <span>多</span>
      </div>
    </div>
  </div>
</template>
