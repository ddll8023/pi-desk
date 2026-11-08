<!-- 设置页的用量统计分节：
     统计已登记项目的所有本地会话 Token 消耗，展示总量与分项构成、可切换范围与指标的堆叠趋势、按日明细表、
     模型分布、项目分布及高消耗会话 Top 明细。
     费用只在供应商上报价格时计入，缺失时按「未提供」占位，不推算金额。
     支持手动重新扫描；点击 Top 会话可直接跳转至对应项目的该会话并关闭设置页。 -->
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
  buildDailyBars,
  buildDailyDetailRows,
  calculateSharePercent,
  cacheHitRate,
  formatDateTime,
  formatTokens
} from '../usage-stats-view'
import type { DailyBarItem, UsageMetric, UsageRange, UsageSegmentKey } from '../usage-stats-view'
import { formatCost, formatCostOrDash } from '../usage-format'
import { useSessionStore } from '../stores/session'
import { useSettingsStore } from '../../shell/stores/settings'
import AppButton from '../../ui/AppButton.vue'

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

/** 概览的四段构成：宽度与占比都来自总量，四段之和即总量。 */
const overviewSegments = computed(() => {
  const totals = summary.value?.totals
  if (!totals || totals.totalTokens <= 0) return []
  return USAGE_SEGMENTS.map((segment) => {
    const value = totals[segment.key]
    return {
      key: segment.key,
      label: segment.label,
      color: segment.color,
      width: `${(value / totals.totalTokens) * 100}%`,
      share: calculateSharePercent(value, totals.totalTokens),
      tokens: formatTokens(value)
    }
  })
})

const overviewDescription = computed(() => (
  overviewSegments.value.map(segment => `${segment.label} ${segment.share}`).join('，')
))

/** 柱体段的配色统一从 USAGE_SEGMENTS 取，模板里不重复硬编码色值。 */
function segmentColor(key: UsageSegmentKey): string {
  return USAGE_SEGMENTS.find(segment => segment.key === key)?.color ?? 'var(--color-desk-chart-1)'
}

/** 悬停读数只显示当前指标的单个数值，完整分项放在 title 与明细表中。 */
function barReadout(bar: DailyBarItem): string {
  const value = metric.value === 'cost'
    ? (bar.cost === null ? '无价格' : `$${formatCost(bar.cost)}`)
    : `${formatTokens(bar.totalTokens)} Token`
  return `${bar.label}：${value}`
}

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
          <h2 id="usage-overview-title" class="settings-section-title">总量概览</h2>
          <span class="text-2xs tabular-nums text-desk-muted">
            共扫描 {{ summary.totalSessions }} 个会话 · {{ summary.totalMessages }} 条回复 · 已计价 {{ summary.costMessages }} 条
          </span>
        </div>

        <!-- 六个指标同级：字号与等宽数字统一，层次由标签与位置表达，不单独放大其中一格。 -->
        <dl class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div class="rounded-desk-sm border border-desk-line bg-desk-canvas-sunken px-3 py-2">
            <dt class="text-2xs text-desk-muted">总 Token</dt>
            <dd class="mt-0.5 text-sm font-semibold tabular-nums" :title="`${summary.totals.totalTokens} tokens`">
              {{ formatTokens(summary.totals.totalTokens) }}
            </dd>
          </div>

          <div class="rounded-desk-sm border border-desk-line bg-desk-canvas-sunken px-3 py-2">
            <dt class="text-2xs text-desk-muted">输入</dt>
            <dd class="mt-0.5 text-sm font-semibold tabular-nums" :title="`输入: ${summary.totals.input}`">
              {{ formatTokens(summary.totals.input) }}
              <span class="ml-1 text-2xs font-normal text-desk-muted">
                {{ calculateSharePercent(summary.totals.input, summary.totals.totalTokens) }}
              </span>
            </dd>
          </div>

          <div class="rounded-desk-sm border border-desk-line bg-desk-canvas-sunken px-3 py-2">
            <dt class="text-2xs text-desk-muted">输出</dt>
            <dd class="mt-0.5 text-sm font-semibold tabular-nums" :title="`输出: ${summary.totals.output}`">
              {{ formatTokens(summary.totals.output) }}
              <span class="ml-1 text-2xs font-normal text-desk-muted">
                {{ calculateSharePercent(summary.totals.output, summary.totals.totalTokens) }}
              </span>
            </dd>
          </div>

          <div class="rounded-desk-sm border border-desk-line bg-desk-canvas-sunken px-3 py-2">
            <dt class="text-2xs text-desk-muted">缓存读取</dt>
            <dd class="mt-0.5 text-sm font-semibold tabular-nums" :title="`缓存读: ${summary.totals.cacheRead}`">
              {{ formatTokens(summary.totals.cacheRead) }}
              <span class="ml-1 text-2xs font-normal text-desk-muted">
                命中 {{ overallCacheHitText }}
              </span>
            </dd>
          </div>

          <div class="rounded-desk-sm border border-desk-line bg-desk-canvas-sunken px-3 py-2">
            <dt class="text-2xs text-desk-muted">缓存写入</dt>
            <dd class="mt-0.5 text-sm font-semibold tabular-nums" :title="`缓存写: ${summary.totals.cacheWrite}`">
              {{ formatTokens(summary.totals.cacheWrite) }}
              <span class="ml-1 text-2xs font-normal text-desk-muted">
                {{ calculateSharePercent(summary.totals.cacheWrite, summary.totals.totalTokens) }}
              </span>
            </dd>
          </div>

          <div class="rounded-desk-sm border border-desk-line bg-desk-canvas-sunken px-3 py-2">
            <dt class="text-2xs text-desk-muted">累计费用</dt>
            <dd class="mt-0.5 text-sm font-semibold tabular-nums">
              <span v-if="summary.totalCost !== null">${{ formatCost(summary.totalCost) }}</span>
              <span v-else class="text-xs font-normal text-desk-muted">未提供价格</span>
            </dd>
          </div>
        </dl>

        <!-- 构成条：四段与上方分项同序同色，宽度即占比，零值时整条不渲染。 -->
        <div
          v-if="overviewSegments.length > 0"
          class="mt-3 flex h-1.5 overflow-hidden rounded-full bg-desk-canvas-sunken"
          role="img"
          :aria-label="`Token 构成：${overviewDescription}`"
        >
          <div
            v-for="segment in overviewSegments"
            :key="segment.key"
            :style="{ width: segment.width, backgroundColor: segment.color }"
            :title="`${segment.label}：${segment.tokens}（${segment.share}）`"
          ></div>
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
        <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-2xs text-desk-muted">
          <div v-if="metric === 'tokens'" class="flex flex-wrap items-center gap-3">
            <span v-for="segment in USAGE_SEGMENTS" :key="segment.key" class="inline-flex items-center gap-1.5">
              <span class="size-2 rounded-sm" :style="{ backgroundColor: segment.color }" aria-hidden="true"></span>
              {{ segment.label }}
            </span>
          </div>
          <span v-else>费用只统计供应商上报价格的调用，未提供价格的日期不画柱</span>
          <span>单位：{{ metric === 'cost' ? '美元' : 'Token' }}</span>
        </div>

        <!-- 柱区顶部留出读数卡片的高度：横向滚动容器会把 overflow-y 算成 auto，不预留就会被裁掉。 -->
        <div class="mt-3 rounded-desk-sm border border-desk-line bg-desk-surface p-4">
          <div
            class="flex h-36 items-end gap-1.5 overflow-x-auto pb-6 pt-7 scroll-area"
            role="group"
            aria-label="每日用量趋势"
          >
            <div
              v-for="bar in dailyBars"
              :key="bar.date"
              class="group relative flex h-full flex-1 min-w-[18px] flex-col items-center justify-end"
              :class="range === 7 ? 'max-w-none' : 'max-w-[40px]'"
              :title="bar.tooltip"
              role="img"
              :aria-label="bar.ariaLabel"
            >
              <!-- 柱体：Token 指标按四个分项堆叠，费用指标整体一色 -->
              <div class="w-full" :style="{ height: `${bar.heightPercent}%` }">
                <div
                  v-if="metric === 'cost'"
                  class="h-full w-full rounded-t"
                  :style="{ backgroundColor: 'var(--color-desk-chart-1)' }"
                ></div>
                <div v-else class="flex h-full w-full flex-col-reverse overflow-hidden rounded-t">
                  <div
                    v-for="segment in bar.segments"
                    :key="segment.key"
                    :style="{ height: `${segment.percent}%`, backgroundColor: segmentColor(segment.key) }"
                  ></div>
                </div>
              </div>

              <!-- 悬浮读数：单行短值；完整分项在 title 与按日明细表里 -->
              <div
                class="pointer-events-none absolute bottom-full mb-1 hidden rounded border border-desk-line bg-desk-surface px-2 py-1 text-2xs whitespace-nowrap tabular-nums shadow-sm group-hover:block z-10"
              >
                {{ barReadout(bar) }}
              </div>

              <!-- X 轴日期：只标注稀疏标记的柱，避免相邻标签重叠 -->
              <span
                v-if="bar.showLabel"
                class="absolute -bottom-5 text-2xs tabular-nums text-desk-muted whitespace-nowrap"
              >
                {{ bar.label }}
              </span>
            </div>
          </div>
        </div>

        <!-- 明细表：精确读数与键盘浏览的入口，默认折叠，最新日期在前。 -->
        <details class="mt-3 border-t border-desk-line pt-3">
          <summary class="cursor-pointer text-2xs font-medium text-desk-muted">
            按日明细（{{ rangeLabel }}，最新在前）
          </summary>
          <div class="mt-2 overflow-x-auto scroll-area">
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
              v-for="m in summary.models"
              :key="`${m.provider}:${m.modelId}`"
              class="rounded-desk-sm border-t border-desk-line px-2 py-2.5 text-xs transition-colors first:border-t-0 hover:bg-desk-canvas-sunken"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0 flex-1 truncate font-medium">
                  <span class="text-desk-muted text-2xs mr-1">[{{ m.provider }}]</span>
                  <span>{{ m.modelId }}</span>
                </div>
                <div class="text-right text-xs font-semibold tabular-nums whitespace-nowrap">
                  {{ formatTokens(m.totalTokens) }}
                  <span class="text-2xs font-normal text-desk-muted ml-1">
                    ({{ calculateSharePercent(m.totalTokens, summary.totals.totalTokens) }})
                  </span>
                </div>
              </div>

              <!-- 进度条 -->
              <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-desk-canvas-sunken">
                <div
                  class="h-full bg-desk-accent rounded-full"
                  :style="{ width: calculateSharePercent(m.totalTokens, summary.totals.totalTokens) }"
                ></div>
              </div>

              <div class="mt-1.5 flex items-center justify-between gap-2 text-2xs tabular-nums text-desk-muted">
                <span>输入: {{ formatTokens(m.input) }} · 输出: {{ formatTokens(m.output) }}</span>
                <span class="shrink-0">
                  <template v-if="m.cost !== null">费用 ${{ formatCost(m.cost) }} · </template>
                  {{ m.messageCount }} 次回复
                </span>
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
              v-for="p in summary.projects"
              :key="p.projectPath"
              class="rounded-desk-sm border-t border-desk-line px-2 py-2.5 text-xs transition-colors first:border-t-0 hover:bg-desk-canvas-sunken"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0 flex-1 truncate font-medium" :title="p.projectPath">
                  {{ p.projectName }}
                </div>
                <div class="text-right text-xs font-semibold tabular-nums whitespace-nowrap">
                  {{ formatTokens(p.totalTokens) }}
                  <span class="text-2xs font-normal text-desk-muted ml-1">
                    ({{ calculateSharePercent(p.totalTokens, summary.totals.totalTokens) }})
                  </span>
                </div>
              </div>

              <!-- 进度条：与模型分布保持同一主色，项目占比不是成功语义。 -->
              <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-desk-canvas-sunken">
                <div
                  class="h-full bg-desk-accent rounded-full"
                  :style="{ width: calculateSharePercent(p.totalTokens, summary.totals.totalTokens) }"
                ></div>
              </div>

              <div class="mt-1.5 flex items-center justify-between gap-2 text-2xs text-desk-muted">
                <span class="min-w-0 flex-1 truncate tabular-nums" :title="p.projectPath">{{ p.projectPath }}</span>
                <span class="shrink-0 tabular-nums">
                  <template v-if="p.cost !== null">费用 ${{ formatCost(p.cost) }} · </template>
                  {{ p.sessionCount }} 个会话
                </span>
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

        <ul v-else class="mt-3 space-y-1.5 max-h-96 overflow-y-auto scroll-area pr-1">
          <li v-for="(session, index) in summary.topSessions" :key="session.sessionId">
            <!-- 整行是原生按钮：可聚焦、可键盘触发，同时保持单行卡片的视觉。 -->
            <button
              type="button"
              class="group flex w-full items-center justify-between gap-3 rounded-desk-sm border border-desk-line bg-desk-surface px-3 py-2 text-left text-xs transition-colors hover:border-desk-accent/50 hover:bg-desk-canvas-sunken cursor-pointer"
              @click="handleOpenSession(session)"
            >
              <!-- 序号与标题 -->
              <div class="flex min-w-0 flex-1 items-center gap-2.5">
                <span class="w-5 shrink-0 text-center font-mono text-2xs tabular-nums text-desk-muted">#{{ index + 1 }}</span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate font-medium text-desk-text group-hover:text-desk-accent" :title="session.title">
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
              </div>

              <!-- 用量与 Token -->
              <div class="shrink-0 text-right">
                <div class="text-xs font-semibold tabular-nums text-desk-text">
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
