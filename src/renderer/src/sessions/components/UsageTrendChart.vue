<!-- 用量趋势图：把窗口内自然日序列画成堆叠柱，读数行固定在卡片顶部、不跟随光标
     （柱区是横向滚动容器，跟随光标的浮层必被裁切）。
     刻度列与网格线共用同一个 bottom-5（即列内日期行的高度），柱区不加竖向 padding，基线与刻度只有这一处来源。
     有值日的柱可点击，点击进入当日会话明细；键盘用户经按日明细表的日期按钮进入同一入口。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DailyBarItem, UsageAxisTick, UsageMetric } from '../usage-stats-view'
import { usageSegmentColor } from '../usage-stats-view'
import { formatCost, formatTokens } from '../usage-format'

const props = defineProps<{
  /** 窗口内自然日柱体序列（升序，缺失日为零）。 */
  readonly bars: readonly DailyBarItem[]
  readonly ticks: readonly UsageAxisTick[]
  /** 读数行右侧的单位标签，与指标一一对应。 */
  readonly unitLabel: string
  readonly metric: UsageMetric
}>()

const emit = defineEmits<{ select: [date: string] }>()

/**
 * 柱宽与间距按天数分档：天数越多柱越窄、间距越小，全部范围下仍能看清单根柱。
 * 「全部」的天数不固定，未命中的档位落到与 90 天相同的默认值。
 * 类名写成完整字面量，Tailwind 才能在构建时扫到。
 */
const BAR_SIZING: Record<number, { readonly gap: string; readonly width: string }> = {
  7: { gap: 'gap-2.5', width: 'min-w-[32px] max-w-[56px]' },
  14: { gap: 'gap-1.5', width: 'min-w-[14px] max-w-[28px]' },
  30: { gap: 'gap-1.5', width: 'min-w-[10px] max-w-[24px]' },
  90: { gap: 'gap-1', width: 'min-w-[6px] max-w-[14px]' }
}

const BAR_DEFAULT = { gap: 'gap-1', width: 'min-w-[6px] max-w-[14px]' } as const

const barSizing = computed(() => BAR_SIZING[props.bars.length] ?? BAR_DEFAULT)

/**
 * 读数行：悬停某天时显示那天，离开后回到当前范围的峰值那天。
 * 点击有值柱向外发 select，由父级决定下钻目标。
 */
const hoveredDate = ref<string | null>(null)

const readoutBar = computed(() => {
  const bars = props.bars
  if (bars.length === 0) return null
  const hovered = hoveredDate.value === null
    ? null
    : bars.find(bar => bar.date === hoveredDate.value) ?? null
  if (hovered !== null) return hovered
  return bars.reduce((peak, bar) => (bar.metricValue > peak.metricValue ? bar : peak))
})

const readoutDate = computed(() => readoutBar.value?.label ?? '')

/** 单位由读数行右侧的静态标签给出，这里只放数值，不在两处重复单位。 */
const readoutValue = computed(() => {
  const bar = readoutBar.value
  if (bar === null) return ''
  if (props.metric === 'cost') return bar.cost === null ? '无价格' : `$${formatCost(bar.cost)}`
  if (props.metric === 'messages') return String(bar.metricValue)
  return formatTokens(bar.metricValue)
})

function handleBarClick(bar: DailyBarItem): void {
  if (bar.hasValue) emit('select', bar.date)
}
</script>

<template>
  <div class="rounded-desk-sm border border-desk-line bg-desk-surface p-4">
    <div class="flex items-baseline justify-between gap-3 pb-3">
      <div class="flex items-baseline gap-2">
        <span class="text-2xs tabular-nums text-desk-muted">{{ readoutDate }}</span>
        <span class="text-xs font-semibold tabular-nums">{{ readoutValue }}</span>
      </div>
      <span class="text-2xs text-desk-muted">单位 {{ unitLabel }}</span>
    </div>

    <div class="relative h-44">
      <div class="pointer-events-none absolute top-0 bottom-5 left-0 w-12" aria-hidden="true">
        <span
          v-for="tick in props.ticks"
          :key="tick.ratio"
          class="absolute right-0 translate-y-1/2 text-2xs whitespace-nowrap tabular-nums text-desk-muted"
          :style="{ bottom: `${tick.ratio * 100}%` }"
        >
          {{ tick.label }}
        </span>
      </div>

      <!-- 网格线只画在柱区内（左侧跳过刻度列）：峰顶、半高与基线，给柱高一个可读的参照。 -->
      <div class="pointer-events-none absolute top-0 right-0 bottom-5 left-14" aria-hidden="true">
        <div class="absolute inset-x-0 top-0 border-t border-desk-line"></div>
        <div class="absolute inset-x-0 top-1/2 border-t border-dashed border-desk-line"></div>
        <div class="absolute inset-x-0 bottom-0 border-t border-desk-line"></div>
      </div>

      <div
        class="ml-14 flex h-full items-end overflow-x-auto scroll-area"
        :class="barSizing.gap"
        role="group"
        aria-label="每日用量趋势"
        @mouseleave="hoveredDate = null"
      >
        <div
          v-for="bar in props.bars"
          :key="bar.date"
          class="group relative flex h-full flex-1 flex-col items-center justify-end"
          :class="[barSizing.width, bar.hasValue ? 'cursor-pointer' : '']"
          role="img"
          :aria-label="bar.hasValue ? `${bar.ariaLabel}（点击查看当日会话）` : bar.ariaLabel"
          @mouseenter="hoveredDate = bar.date"
          @click="handleBarClick(bar)"
        >
          <!-- 绘图格：柱高百分比基于这一格，下面的日期行不参与高度分配 -->
          <div class="relative flex w-full grow flex-col justify-end">
            <!-- 悬停列高亮：垫在柱体后面的整列淡底，不改变柱体本身的颜色 -->
            <div
              class="pointer-events-none absolute inset-0 rounded-sm bg-desk-canvas-sunken opacity-0 transition-opacity group-hover:opacity-100"
              aria-hidden="true"
            ></div>

            <!-- 柱体：Token 指标按四个分项堆叠，费用指标整体一色；
                 段间 1px 卡片底色隔开，非零段保底 1px 高度，避免小分项在柱上消失。 -->
            <div class="relative w-full" :style="{ height: `${bar.heightPercent}%` }">
              <div
                v-if="!bar.stacked"
                class="h-full w-full rounded-t-sm"
                :style="{ backgroundColor: 'var(--color-desk-usage-1)' }"
              ></div>
              <div v-else class="flex h-full w-full flex-col-reverse overflow-hidden rounded-t-sm">
                <div
                  v-for="(segment, index) in bar.segments"
                  :key="segment.key"
                  :style="{
                    height: `${segment.percent}%`,
                    minHeight: '1px',
                    backgroundColor: usageSegmentColor(segment.key),
                    boxShadow: index > 0 ? 'inset 0 1px 0 0 var(--color-desk-surface)' : 'none'
                  }"
                ></div>
              </div>
            </div>

            <!-- 无值日只画一根 2px 基线条：保留日期位置，不让柱列出现无法解释的空洞 -->
            <div
              v-if="!bar.hasValue"
              class="relative h-0.5 w-full rounded-sm bg-desk-canvas-sunken"
            ></div>
          </div>

          <!-- 日期行：每列都占同一高度，稀疏标签用空行占位，柱高才能在列之间对齐 -->
          <span class="flex h-5 shrink-0 items-center text-2xs whitespace-nowrap tabular-nums text-desk-muted">
            {{ bar.showLabel ? bar.label : '' }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
