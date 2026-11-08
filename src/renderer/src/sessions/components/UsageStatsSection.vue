<!-- 设置页的用量统计分节：
     统计已登记项目的所有本地会话 Token 消耗，展示总量与分项构成、可切换范围与指标的堆叠趋势、按日明细表、
     模型分布、项目分布及高消耗会话 Top 明细。
     费用只在供应商上报价格时计入，缺失时按「未提供」占位，不推算金额。
     支持手动重新扫描；点击 Top 会话可直接跳转至对应项目的该会话并关闭设置页。
     展示口径：量级用两个主读数承载，构成关系交给构成条与图例；趋势图带三档刻度与网格线，
     柱宽与间距按天数分档；分布行内的条与趋势图同序同色，只表达构成、不重复绝对值。 -->
<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import type {
  UsageStatsSummary,
  UsageTopSession
} from '../../../../shared/usage-stats-api'
import { getUsageStats } from '../services/usage-stats'
import {
  USAGE_RANGE_OPTIONS,
  USAGE_SEGMENTS,
  buildAxisTicks,
  buildCompositionSegments,
  buildDailyBars,
  buildDailyDetailRows,
  calculateSharePercent,
  cacheHitRate,
  formatDateTime,
  formatTokens
} from '../usage-stats-view'
import type {
  CompositionSegment,
  UsageMetric,
  UsageRange,
  UsageSegmentKey
} from '../usage-stats-view'
import { formatCost, formatCostOrDash } from '../usage-format'
import { useSessionStore } from '../stores/session'
import { useSettingsStore } from '../../shell/stores/settings'
import AppButton from '../../ui/AppButton.vue'
import UsageCompositionBar from './UsageCompositionBar.vue'

const sessionStore = useSessionStore()
const settingsStore = useSettingsStore()

type ViewState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready' }
  | { readonly phase: 'error'; readonly message: string }

const viewState = shallowRef<ViewState>({ phase: 'loading' })
const summary = shallowRef<UsageStatsSummary | null>(null)
const refreshing = ref(false)

/** 趋势默认近 30 天；范围按有记录日期取末尾 N 天，不按自然日补零。 */
const range = ref<UsageRange>(30)
/** 指标默认 Token；没有任何计价消息时费用视图不可选。 */
const metric = ref<UsageMetric>('tokens')

const costAvailable = computed(() => (summary.value?.costMessages ?? 0) > 0)

watch(costAvailable, (available) => {
  if (!available) metric.value = 'tokens'
})

const rangeLabel = computed(
  () => USAGE_RANGE_OPTIONS.find(option => option.value === range.value)?.label ?? ''
)

const dailyBars = computed(() => {
  if (!summary.value) return []
  return buildDailyBars(summary.value.daily, { range: range.value, metric: metric.value })
})

const dailyDetailRows = computed(() => {
  if (!summary.value) return []
  return buildDailyDetailRows(summary.value.daily, range.value)
})

/** 概览的四段构成：宽度与占比都来自四项之和，与趋势图、分布行同序同色。 */
const overviewSegments = computed(() => {
  const totals = summary.value?.totals
  if (!totals) return []
  return buildCompositionSegments(totals)
})

const overviewAriaLabel = computed(() => {
  const parts = overviewSegments.value.map(segment => `${segment.label} ${segment.value}（${segment.share}）`)
  return `Token 构成：${parts.join('，')}`
})

/** 趋势图三档刻度：峰值、半峰值与 0，单位随所选指标。 */
const trendAxis = computed(() => buildAxisTicks(dailyBars.value, metric.value))

/**
 * 柱宽与间距按范围分档：天数越多柱越窄、间距越小，全部范围下仍能看清单根柱。
 * 类名写成完整字面量，Tailwind 才能在构建时扫到。
 */
const BAR_SIZING = {
  7: { gap: 'gap-2.5', width: 'min-w-[32px] max-w-[56px]' },
  30: { gap: 'gap-1.5', width: 'min-w-[10px] max-w-[24px]' },
  90: { gap: 'gap-1', width: 'min-w-[6px] max-w-[14px]' },
  all: { gap: 'gap-1', width: 'min-w-[6px] max-w-[14px]' }
} satisfies Record<UsageRange, { readonly gap: string; readonly width: string }>

const barSizing = computed(() => BAR_SIZING[range.value])

/** 分布行的同一套字段，模型与项目两个分节据此保持同一种排布。 */
interface DistributionRow {
  readonly key: string
  readonly name: string
  /** 模型行的供应商标记；项目行为 null。 */
  readonly badge: string | null
  /** 名称下方的次级标识：模型的输入/输出分项，项目的路径。 */
  readonly detail: string
  /** 路径这类可能被截断的次级标识的悬停全文；不需要时为 null。 */
  readonly detailTitle: string | null
  readonly totalTokens: string
  readonly share: string
  readonly meta: string
  readonly segments: readonly CompositionSegment[]
}

const modelRows = computed<readonly DistributionRow[]>(() => {
  const total = summary.value?.totals.totalTokens ?? 0
  return (summary.value?.models ?? []).map(model => ({
    key: `${model.provider}:${model.modelId}`,
    name: model.modelId,
    badge: model.provider,
    detail: `输入 ${formatTokens(model.input)} · 输出 ${formatTokens(model.output)}`,
    detailTitle: null,
    totalTokens: formatTokens(model.totalTokens),
    share: calculateSharePercent(model.totalTokens, total),
    meta: model.cost === null
      ? `${model.messageCount} 次回复`
      : `$${formatCost(model.cost)} · ${model.messageCount} 次回复`,
    segments: buildCompositionSegments(model)
  }))
})

const projectRows = computed<readonly DistributionRow[]>(() => {
  const total = summary.value?.totals.totalTokens ?? 0
  return (summary.value?.projects ?? []).map(project => ({
    key: project.projectPath,
    name: project.projectName,
    badge: null,
    detail: project.projectPath,
    detailTitle: project.projectPath,
    totalTokens: formatTokens(project.totalTokens),
    share: calculateSharePercent(project.totalTokens, total),
    meta: project.cost === null
      ? `${project.sessionCount} 个会话`
      : `$${formatCost(project.cost)} · ${project.sessionCount} 个会话`,
    segments: buildCompositionSegments(project)
  }))
})

/** 柱体段的配色统一从 USAGE_SEGMENTS 取，模板里不重复硬编码色值。 */
function segmentColor(key: UsageSegmentKey): string {
  return USAGE_SEGMENTS.find(segment => segment.key === key)?.color ?? 'var(--color-desk-usage-1)'
}

/**
 * 读数行：悬停某天时显示那天，离开后回到当前范围的峰值那天。
 * 读数固定在图表卡片顶部而不跟随光标：柱区是横向滚动容器，跟随光标的浮层必被裁切。
 */
const hoveredDate = ref<string | null>(null)

const readoutBar = computed(() => {
  const bars = dailyBars.value
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
  if (metric.value === 'cost') return bar.cost === null ? '无价格' : `$${formatCost(bar.cost)}`
  return formatTokens(bar.totalTokens)
})

const overallCacheHitRate = computed(() => {
  if (!summary.value) return null
  const totals = summary.value.totals
  return cacheHitRate({
    input: totals.input,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite
  })
})

const overallCacheHitText = computed(() => {
  const rate = overallCacheHitRate.value
  if (rate === null) return '—'
  return `${(rate * 100).toFixed(1)}%`
})

async function loadData(forceRefresh = false): Promise<void> {
  if (forceRefresh) {
    refreshing.value = true
  } else {
    viewState.value = { phase: 'loading' }
  }

  try {
    const result = await getUsageStats({ refresh: forceRefresh })
    if (!result.ok) {
      viewState.value = { phase: 'error', message: result.error.message }
      return
    }
    summary.value = result.summary
    viewState.value = { phase: 'ready' }
  } catch (error) {
    viewState.value = {
      phase: 'error',
      message: error instanceof Error ? error.message : '加载用量统计失败。'
    }
  } finally {
    refreshing.value = false
  }
}

async function handleOpenSession(item: UsageTopSession): Promise<void> {
  settingsStore.closeSettings()
  await sessionStore.open(item.sessionId, false, item.projectPath)
}

onMounted(() => {
  void loadData(false)
})
</script>

<template>
  <div class="settings-section-stack">
    <!-- 顶栏标题与控制 -->
    <div class="settings-section-header flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">用量统计</h1>
        <p class="mt-1 text-sm text-desk-muted">
          统计当前桌面已登记项目的所有本地会话 Token 与上下文用量（进行中的会话在结束落盘后计入）。
        </p>
      </div>
      <div>
        <AppButton
          variant="ghost"
          size="sm"
          type="button"
          :disabled="viewState.phase === 'loading' || refreshing"
          @click="loadData(true)"
        >
          {{ refreshing ? '正在扫描…' : '刷新统计' }}
        </AppButton>
      </div>
    </div>

    <!-- 加载中 -->
    <p v-if="viewState.phase === 'loading'" class="mt-4 text-xs text-desk-muted" role="status">
      正在读取并索引会话用量…
    </p>

    <!-- 错误状态 -->
    <div v-else-if="viewState.phase === 'error'" class="mt-4 text-xs text-desk-danger" role="alert">
      {{ viewState.message }}
    </div>

    <!-- 正常就绪状态 -->
    <template v-else-if="summary !== null">
      <!-- 1. 总量与分项构成 -->
      <section class="settings-section" aria-labelledby="usage-overview-title">
        <div class="settings-section-heading">
          <div>
            <h2 id="usage-overview-title" class="settings-section-title">总量概览</h2>
            <p class="mt-1 text-2xs tabular-nums text-desk-muted">
              共扫描 {{ summary.totalSessions }} 个会话 · {{ summary.totalMessages }} 条回复 · 已计价 {{ summary.costMessages }} 条
            </p>
          </div>
        </div>

        <!-- 两个主读数承载量级：总 Token 与累计费用同级放大，四个分项交给下方的构成条与图例。 -->
        <dl class="mt-4 flex flex-wrap items-end gap-x-10 gap-y-4">
          <div>
            <dt class="text-2xs text-desk-muted">总 Token</dt>
            <dd
              class="mt-1 font-semibold text-2xl leading-none tabular-nums"
              :title="`${summary.totals.totalTokens} tokens`"
            >
              {{ formatTokens(summary.totals.totalTokens) }}
            </dd>
          </div>
          <div>
            <dt class="text-2xs text-desk-muted">累计费用</dt>
            <dd class="mt-1 leading-none">
              <span v-if="summary.totalCost !== null" class="font-semibold text-2xl tabular-nums">
                ${{ formatCost(summary.totalCost) }}
              </span>
              <span v-else class="text-sm font-medium text-desk-muted">未提供价格</span>
            </dd>
          </div>
        </dl>

        <!-- 构成条 + 图例：四段同序同色，图例给出数值与占比，缓存读取额外带命中率。 -->
        <div v-if="overviewSegments.length > 0" class="mt-5">
          <UsageCompositionBar :segments="overviewSegments" size="md" :label="overviewAriaLabel" />
          <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <div v-for="segment in overviewSegments" :key="segment.key">
              <dt class="flex items-center gap-1.5 text-2xs text-desk-muted">
                <span
                  class="size-2 shrink-0 rounded-sm"
                  :style="{ backgroundColor: segment.color }"
                  aria-hidden="true"
                ></span>
                {{ segment.label }}
              </dt>
              <dd class="mt-0.5 text-xs font-medium tabular-nums" :title="`${segment.label} ${segment.raw} tokens`">
                {{ segment.value }}
                <span class="ml-1 font-normal text-2xs text-desk-muted">{{ segment.share }}</span>
                <span v-if="segment.key === 'cacheRead'" class="ml-1 font-normal text-2xs text-desk-muted">
                  命中 {{ overallCacheHitText }}
                </span>
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <!-- 2. 日度用量趋势 + 按日明细 -->
      <section v-if="dailyBars.length > 0" class="settings-section" aria-labelledby="usage-trend-title">
        <div class="settings-section-heading">
          <div>
            <h2 id="usage-trend-title" class="settings-section-title">用量趋势</h2>
            <p class="mt-1 text-2xs text-desk-muted">
              按有记录日期取{{ rangeLabel }}；柱高为当日{{ metric === 'cost' ? '费用' : 'Token 量' }}。
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <div class="segment" role="group" aria-label="统计范围">
              <AppButton
                v-for="option in USAGE_RANGE_OPTIONS"
                :key="option.value"
                variant="unstyled"
                class="segment-option"
                :class="range === option.value ? 'is-selected' : ''"
                :aria-pressed="range === option.value"
                @click="range = option.value"
              >
                {{ option.label }}
              </AppButton>
            </div>
            <div class="segment" role="group" aria-label="趋势指标">
              <AppButton
                variant="unstyled"
                class="segment-option"
                :class="metric === 'tokens' ? 'is-selected' : ''"
                :aria-pressed="metric === 'tokens'"
                @click="metric = 'tokens'"
              >
                Token
              </AppButton>
              <AppButton
                variant="unstyled"
                class="segment-option"
                :class="metric === 'cost' ? 'is-selected' : ''"
                :aria-pressed="metric === 'cost'"
                :disabled="!costAvailable"
                :title="costAvailable ? '按供应商上报的费用查看' : '模型未上报价格，无法按费用查看'"
                @click="metric = 'cost'"
              >
                费用
              </AppButton>
            </div>
          </div>
        </div>

        <!-- 图例：Token 指标下四种分项与柱体段同色；费用指标没有分项，只说明口径。 -->
        <div class="mt-3 flex flex-wrap items-center gap-3 text-2xs text-desk-muted">
          <template v-if="metric === 'tokens'">
            <span v-for="segment in USAGE_SEGMENTS" :key="segment.key" class="inline-flex items-center gap-1.5">
              <span class="size-2 rounded-sm" :style="{ backgroundColor: segment.color }" aria-hidden="true"></span>
              {{ segment.label }}
            </span>
          </template>
          <span v-else>费用只统计供应商上报价格的调用，未提供价格的日期不画柱</span>
        </div>

        <!-- 图表：读数行固定在卡片顶部，不跟随光标；刻度列与网格线共用同一个 bottom-5
             （即列内日期行的高度），柱区不加竖向 padding，基线与刻度只有这一处来源。 -->
        <div class="mt-3 rounded-desk-sm border border-desk-line bg-desk-surface p-4">
          <div class="flex items-baseline justify-between gap-3 pb-3">
            <div class="flex items-baseline gap-2">
              <span class="text-2xs tabular-nums text-desk-muted">{{ readoutDate }}</span>
              <span class="text-xs font-semibold tabular-nums">{{ readoutValue }}</span>
            </div>
            <span class="text-2xs text-desk-muted">单位 {{ metric === 'cost' ? '美元' : 'Token' }}</span>
          </div>

          <div class="relative h-44">
            <div class="pointer-events-none absolute top-0 bottom-5 left-0 w-12" aria-hidden="true">
              <span
                v-for="tick in trendAxis"
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
                v-for="bar in dailyBars"
                :key="bar.date"
                class="group relative flex h-full flex-1 flex-col items-center justify-end"
                :class="barSizing.width"
                role="img"
                :aria-label="bar.ariaLabel"
                @mouseenter="hoveredDate = bar.date"
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
                      v-if="metric === 'cost'"
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
                          backgroundColor: segmentColor(segment.key),
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

        <!-- 明细表：精确读数与键盘浏览的入口，默认折叠，最新日期在前。 -->
        <details class="mt-3 border-t border-desk-line pt-3">
          <summary class="cursor-pointer text-2xs font-medium text-desk-muted">
            按日明细（{{ rangeLabel }}，最新在前）
          </summary>
          <div class="mt-2 max-h-80 overflow-auto scroll-area">
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
                  <th v-if="costAvailable" scope="col" class="py-1.5 pl-2 text-right font-medium">费用</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in dailyDetailRows" :key="row.date" class="border-t border-desk-line">
                  <th scope="row" class="py-1.5 pr-2 text-left font-normal tabular-nums">{{ row.date }}</th>
                  <td class="px-2 py-1.5 text-right font-medium tabular-nums">{{ formatTokens(row.totalTokens) }}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-desk-muted">{{ formatTokens(row.input) }}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-desk-muted">{{ formatTokens(row.output) }}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-desk-muted">{{ formatTokens(row.cacheRead) }}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-desk-muted">{{ formatTokens(row.cacheWrite) }}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-desk-muted">{{ row.messageCount }}</td>
                  <td v-if="costAvailable" class="py-1.5 pl-2 text-right tabular-nums text-desk-muted">
                    {{ formatCostOrDash(row.cost) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <!-- 3. 模型与项目分布 (双列并排) -->
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <!-- 模型分布 -->
        <section class="settings-section" aria-labelledby="usage-models-title">
          <div class="settings-section-heading">
            <h2 id="usage-models-title" class="settings-section-title">模型用量分布</h2>
            <span class="text-2xs text-desk-muted">{{ summary.models.length }} 个模型</span>
          </div>

          <div v-if="summary.models.length === 0" class="mt-3 text-xs text-desk-muted">
            无模型用量记录。
          </div>

          <!-- 列表项不再套一层卡片：外层分节已是卡片，行与行之间用分隔线区分。
               左右各外扩 8px 交给滚动条槽位，行内 padding 再把内容拉回分节的内容边。 -->
          <ul v-else class="mt-3 -mx-2 max-h-80 overflow-y-auto scroll-area">
            <li
              v-for="row in modelRows"
              :key="row.key"
              class="border-t border-desk-line px-2 py-2.5 text-xs transition-colors first:border-t-0 hover:bg-desk-canvas-sunken"
            >
              <div class="flex items-baseline justify-between gap-3">
                <div class="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span v-if="row.badge !== null" class="shrink-0 text-2xs text-desk-muted">[{{ row.badge }}]</span>
                  <span class="min-w-0 truncate font-medium">{{ row.name }}</span>
                </div>
                <div class="shrink-0 text-right text-xs font-semibold whitespace-nowrap tabular-nums">
                  {{ row.totalTokens }}
                  <span class="ml-1 font-normal text-2xs text-desk-muted">{{ row.share }}</span>
                </div>
              </div>

              <!-- 构成条：与趋势图同序同色的四段，行内只表达构成，绝对值已在上方数字里。
                   外面包一层普通块：条宽只取决于这个块，不依赖行内的 flex 上下文。 -->
              <div class="mt-2">
                <UsageCompositionBar
                  :segments="row.segments"
                  size="sm"
                  :label="`${row.name} 的 Token 构成`"
                />
              </div>

              <div class="mt-1.5 flex items-center justify-between gap-2 text-2xs tabular-nums text-desk-muted">
                <span class="min-w-0 truncate">{{ row.detail }}</span>
                <span class="shrink-0">{{ row.meta }}</span>
              </div>
            </li>
          </ul>
        </section>

        <!-- 项目分布 -->
        <section class="settings-section" aria-labelledby="usage-projects-title">
          <div class="settings-section-heading">
            <h2 id="usage-projects-title" class="settings-section-title">项目用量分布</h2>
            <span class="text-2xs text-desk-muted">{{ summary.projects.length }} 个项目</span>
          </div>

          <div v-if="summary.projects.length === 0" class="mt-3 text-xs text-desk-muted">
            无项目用量记录。
          </div>

          <ul v-else class="mt-3 -mx-2 max-h-80 overflow-y-auto scroll-area">
            <li
              v-for="row in projectRows"
              :key="row.key"
              class="border-t border-desk-line px-2 py-2.5 text-xs transition-colors first:border-t-0 hover:bg-desk-canvas-sunken"
            >
              <div class="flex items-baseline justify-between gap-3">
                <div class="min-w-0 flex-1 truncate font-medium" :title="row.detailTitle">{{ row.name }}</div>
                <div class="shrink-0 text-right text-xs font-semibold whitespace-nowrap tabular-nums">
                  {{ row.totalTokens }}
                  <span class="ml-1 font-normal text-2xs text-desk-muted">{{ row.share }}</span>
                </div>
              </div>

              <!-- 构成条：与模型分布、趋势图保持同一套分项与颜色，项目占比不是成功语义。 -->
              <div class="mt-2">
                <UsageCompositionBar
                  :segments="row.segments"
                  size="sm"
                  :label="`${row.name} 的 Token 构成`"
                />
              </div>

              <div class="mt-1.5 flex items-center justify-between gap-2 text-2xs text-desk-muted">
                <span class="min-w-0 flex-1 truncate tabular-nums" :title="row.detailTitle">{{ row.detail }}</span>
                <span class="shrink-0 tabular-nums">{{ row.meta }}</span>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <!-- 4. 高消耗会话 Top 明细 -->
      <section class="settings-section" aria-labelledby="usage-top-sessions-title">
        <div class="settings-section-heading">
          <h2 id="usage-top-sessions-title" class="settings-section-title">高消耗会话 Top 排行</h2>
          <span class="text-2xs text-desk-muted">点击可快速打开该会话</span>
        </div>

        <div v-if="summary.topSessions.length === 0" class="mt-3 text-xs text-desk-muted">
          暂无会话明细。
        </div>

        <ul v-else class="mt-3 -mx-2 max-h-96 divide-y divide-desk-line overflow-y-auto scroll-area">
          <li v-for="(session, index) in summary.topSessions" :key="session.sessionId">
            <!-- 整行是原生按钮：可聚焦、可键盘触发；行与行用分隔线区分，不再逐行套一层卡片。 -->
            <button
              type="button"
              class="group flex w-full cursor-pointer items-center justify-between gap-3 px-2 py-2.5 text-left text-xs transition-colors hover:bg-desk-canvas-sunken"
              @click="handleOpenSession(session)"
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
      </section>
    </template>
  </div>
</template>
