<!-- 设置页的用量统计分节：
     以「会话明细」为唯一数据源，按页面顶部统一时间范围派生全部报表视图（概览、趋势、按日明细、
     模型/项目/团队分布、会话明细），支持从趋势柱、热力图格、分布行与按日明细下钻到该维度的会话列表。
     费用只在供应商上报价格时计入，缺失时按「未提供」占位，不推算金额。
     支持手动重新扫描；分节可见时每 60 秒静默刷新一次（走文件戳缓存，不切断当前视图），页面隐藏后停止。
     点击会话行跳转至对应项目的该会话并关闭设置页；成员会话行不可跳转（它们不在项目会话列表里），只在会话内的团队面板查看。
     热力图固定近一年窗口，不随范围筛选变化。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { UsageStatsSummary } from '../../../../shared/usage-stats-api'
import { getUsageStats } from '../services/usage-stats'
import {
  USAGE_RANGE_OPTIONS,
  USAGE_SEGMENTS,
  buildAxisTicks,
  buildCompositionSegments,
  buildDailyDetailRows,
  buildHeatmap,
  buildModelDistributionRows,
  buildProjectDistributionRows,
  buildTeamDistributionRows,
  buildSessionRows,
  buildTrendBars,
  buildWindowAggregate,
  cacheHitRate,
  formatDateTime,
  formatTokens
} from '../usage-stats-view'
import type {
  HeatmapModel,
  SessionDrill,
  UsageDistributionRow,
  UsageMetric,
  UsageRange,
  UsageSessionRow,
  WindowAggregate
} from '../usage-stats-view'
import { formatCost } from '../usage-format'
import { useSessionStore } from '../stores/session'
import { useSettingsStore } from '../../shell/stores/settings'
import AppButton from '../../ui/AppButton.vue'
import UsageCompositionBar from './UsageCompositionBar.vue'
import UsageDailyTable from './UsageDailyTable.vue'
import UsageDistributionList from './UsageDistributionList.vue'
import UsageHeatmap from './UsageHeatmap.vue'
import UsageSessionList from './UsageSessionList.vue'
import UsageTrendChart from './UsageTrendChart.vue'

const sessionStore = useSessionStore()
const settingsStore = useSettingsStore()

type ViewState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready' }
  | { readonly phase: 'error'; readonly message: string }

const viewState = shallowRef<ViewState>({ phase: 'loading' })
const summary = shallowRef<UsageStatsSummary | null>(null)
const refreshing = ref(false)

/** 页面级时间范围：作用于概览、趋势、明细、分布与会话列表；默认近 30 天。 */
const range = ref<UsageRange>(30)
/** 趋势指标默认 Token；窗口内没有任何计价调用时费用视图不可选。 */
const metric = ref<UsageMetric>('tokens')
/** 下钻上下文；null 时会话明细区显示范围内消耗 Top。 */
const drill = ref<SessionDrill | null>(null)

/** 窗口聚合是全部视图的共同上游，一次计算、多处派生。 */
const aggregate = computed<WindowAggregate | null>(() => {
  if (summary.value === null) return null
  return buildWindowAggregate(summary.value.sessions, range.value, new Date())
})

const costAvailable = computed(() => aggregate.value !== null && aggregate.value.daily.some(day => day.cost !== null))

watch(costAvailable, (available) => {
  if (!available && metric.value === 'cost') metric.value = 'tokens'
})

const rangeLabel = computed(
  () => USAGE_RANGE_OPTIONS.find(option => option.value === range.value)?.label ?? ''
)

/** 趋势指标的展示名，副标题、读数行与单位标签共用同一处说法。 */
const metricLabel = computed(() => {
  if (metric.value === 'cost') return '费用'
  if (metric.value === 'messages') return '回复条数'
  return 'Token 量'
})

/** 读数行右侧的单位，与指标一一对应；回复数不带短格式，直接给条数。 */
const metricUnit = computed(() => {
  if (metric.value === 'cost') return '美元'
  if (metric.value === 'messages') return '条'
  return 'Token'
})

const overviewSubtitle = computed(() => {
  const current = aggregate.value
  if (current === null) return ''
  const costText = current.cost === null
    ? '费用未提供价格'
    : `费用 $${formatCost(current.cost)}`
  return `${rangeLabel.value} · ${costText}`
})

const hasSessions = computed(() => (summary.value?.sessions.length ?? 0) > 0)

/** 概览的四个并列读数：量级、缓存效率与会话规模各自一格，不与构成条重复。 */
interface OverviewMetric {
  readonly key: string
  readonly label: string
  readonly value: string
  /** 原始值的悬停提示；缓存命中率没有可展开的原始值。 */
  readonly title: string | null
}

const overviewMetrics = computed<readonly OverviewMetric[]>(() => {
  const current = aggregate.value
  if (current === null) return []
  const hit = cacheHitRate({
    input: current.totals.input,
    cacheRead: current.totals.cacheRead,
    cacheWrite: current.totals.cacheWrite
  })
  return [
    {
      key: 'tokens',
      label: '总 Token',
      value: formatTokens(current.totals.totalTokens),
      title: `${current.totals.totalTokens} tokens`
    },
    {
      key: 'cache-hit',
      label: '缓存命中率',
      value: hit === null ? '—' : `${(hit * 100).toFixed(1)}%`,
      title: null
    },
    {
      key: 'sessions',
      label: '会话数',
      value: String(current.activeSessions),
      title: `${current.activeSessions} 个会话在范围内有消耗`
    },
    {
      key: 'messages',
      label: '回复数',
      value: String(current.messageCount),
      title: `${current.messageCount} 条回复`
    }
  ]
})

const overallCacheHitText = computed(() => {
  const current = aggregate.value
  if (current === null) return '—'
  const hit = cacheHitRate({
    input: current.totals.input,
    cacheRead: current.totals.cacheRead,
    cacheWrite: current.totals.cacheWrite
  })
  return hit === null ? '—' : `${(hit * 100).toFixed(1)}%`
})

/** 概览的四段构成：宽度与占比都来自四项之和，与趋势图、分布行同序同色。 */
const overviewSegments = computed(() => {
  const totals = aggregate.value?.totals
  if (!totals) return []
  return buildCompositionSegments(totals)
})

const overviewAriaLabel = computed(() => {
  const parts = overviewSegments.value.map(segment => `${segment.label} ${segment.value}（${segment.share}）`)
  return `Token 构成：${parts.join('，')}`
})

/** 近 53 周热力图：固定时间轴视图，不随范围筛选变化；有记录的格子可下钻当日。 */
const heatmap = computed<HeatmapModel | null>(() => {
  if (summary.value === null) return null
  return buildHeatmap(summary.value.sessions, new Date())
})

const trendBars = computed(() => aggregate.value === null ? [] : buildTrendBars(aggregate.value, metric.value))
const trendAxis = computed(() => buildAxisTicks(trendBars.value, metric.value))
const dailyRows = computed(() => aggregate.value === null ? [] : buildDailyDetailRows(aggregate.value))

const modelRows = computed<readonly UsageDistributionRow[]>(() => {
  if (aggregate.value === null) return []
  return buildModelDistributionRows(aggregate.value)
})

const projectRows = computed<readonly UsageDistributionRow[]>(() => {
  if (aggregate.value === null) return []
  return buildProjectDistributionRows(aggregate.value)
})

/** 团队成员会话的合计：没有成员会话时为空，整块不渲染。 */
const teamRows = computed<readonly UsageDistributionRow[]>(() => {
  if (aggregate.value === null) return []
  return buildTeamDistributionRows(aggregate.value)
})

const sessionRows = computed<readonly UsageSessionRow[]>(() => {
  if (summary.value === null || aggregate.value === null) return []
  return buildSessionRows(summary.value.sessions, aggregate.value, drill.value)
})

const updatedText = computed(() => summary.value === null ? '—' : formatDateTime(summary.value.scannedAt))

/** 自动刷新失败不把整页切成错误态，只记一行提示并保留上一次的成功数据。 */
const autoRefreshError = ref<string | null>(null)

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
    autoRefreshError.value = null
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

/** 自动刷新的节拍；走文件戳缓存，未变的会话不会被重扫。 */
const AUTO_REFRESH_MS = 60_000
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null
let silentRefreshing = false

async function refreshSilently(): Promise<void> {
  if (silentRefreshing || refreshing.value) return
  silentRefreshing = true
  try {
    const result = await getUsageStats({ refresh: false })
    if (result.ok) {
      summary.value = result.summary
      autoRefreshError.value = null
    } else {
      autoRefreshError.value = result.error.message
    }
  } catch (error) {
    autoRefreshError.value = error instanceof Error ? error.message : '自动刷新失败。'
  } finally {
    silentRefreshing = false
  }
}

function stopAutoRefresh(): void {
  if (autoRefreshTimer !== null) {
    clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
}

function startAutoRefresh(): void {
  stopAutoRefresh()
  if (document.visibilityState === 'hidden') return
  autoRefreshTimer = setInterval(() => {
    void refreshSilently()
  }, AUTO_REFRESH_MS)
}

/** 页面隐藏时停定时器，回到可见时立即补一次再重新计时，避免后台空跑。 */
function handleVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    stopAutoRefresh()
    return
  }
  void refreshSilently()
  startAutoRefresh()
}

function handleDrill(selection: SessionDrill): void {
  drill.value = selection
}

/** 趋势柱、热力图格与按日明细的日期点击统一进入当日会话明细。 */
function handleDayDrill(date: string): void {
  drill.value = { kind: 'day', date, label: date }
}

function clearDrill(): void {
  drill.value = null
}

async function handleOpenSession(row: UsageSessionRow): Promise<void> {
  // 成员会话不在项目会话列表里：跳转只会关掉设置页而打不开任何会话。
  if (row.scope === 'team-member') return
  settingsStore.closeSettings()
  await sessionStore.open(row.sessionId, false, row.projectPath)
}

onMounted(() => {
  void loadData(false)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  startAutoRefresh()
})

onUnmounted(() => {
  stopAutoRefresh()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
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
      <div class="flex items-center gap-3">
        <span v-if="viewState.phase === 'ready'" class="text-2xs tabular-nums text-desk-muted">
          更新于 {{ updatedText }}
        </span>
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
    <template v-else-if="summary !== null && aggregate !== null">
      <!-- 无任何会话记录：单一空态，不渲染空读数的各个分节 -->
      <section v-if="!hasSessions" class="settings-section" aria-labelledby="usage-empty-title">
        <h2 id="usage-empty-title" class="settings-section-title">暂无用量记录</h2>
        <p class="mt-2 text-xs text-desk-muted">
          还没有可统计的会话用量。会话在结束落盘后计入统计。
        </p>
      </section>

      <template v-else>
        <!-- 页面级范围筛选：统一作用于概览、趋势、明细、分布与会话列表 -->
        <div class="flex flex-wrap items-center gap-2 px-1">
          <span class="text-2xs text-desk-muted">范围</span>
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
        </div>

        <!-- 1. 总量与分项构成 -->
        <section class="settings-section" aria-labelledby="usage-overview-title">
          <div class="settings-section-heading">
            <div>
              <h2 id="usage-overview-title" class="settings-section-title">总量概览</h2>
              <p class="mt-1 text-2xs tabular-nums text-desk-muted">
                {{ overviewSubtitle }}
              </p>
              <p v-if="autoRefreshError !== null" class="mt-1 text-2xs text-desk-warning" role="status">
                自动刷新失败：{{ autoRefreshError }}
              </p>
            </div>
          </div>

          <!-- 四个并列读数承载量级与规模，费用交给趋势指标与下方说明；四个分项交给构成条与图例。 -->
          <dl class="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <div v-for="item in overviewMetrics" :key="item.key">
              <dt class="text-2xs text-desk-muted">{{ item.label }}</dt>
              <dd
                class="mt-1 font-semibold text-xl leading-none tabular-nums"
                :title="item.title ?? undefined"
              >
                {{ item.value }}
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

        <!-- 2. 日度用量趋势 + 常驻按日明细 -->
        <section class="settings-section" aria-labelledby="usage-trend-title">
          <div class="settings-section-heading">
            <div>
              <h2 id="usage-trend-title" class="settings-section-title">用量趋势</h2>
              <p class="mt-1 text-2xs text-desk-muted">
                {{ rangeLabel }}按自然日结算，无消耗的日子不画柱；柱高为当日{{ metricLabel }}。
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
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
                  :class="metric === 'messages' ? 'is-selected' : ''"
                  :aria-pressed="metric === 'messages'"
                  @click="metric = 'messages'"
                >
                  回复数
                </AppButton>
                <AppButton
                  variant="unstyled"
                  class="segment-option"
                  :class="metric === 'cost' ? 'is-selected' : ''"
                  :aria-pressed="metric === 'cost'"
                  :disabled="!costAvailable"
                  :title="costAvailable ? '按供应商上报的费用查看' : '所选范围内模型未上报价格，无法按费用查看'"
                  @click="metric = 'cost'"
                >
                  费用
                </AppButton>
              </div>
            </div>
          </div>

          <!-- 图例：Token 指标下四种分项与柱体段同色；其余指标没有分项，只说明口径。 -->
          <div class="mt-3 flex flex-wrap items-center gap-3 text-2xs text-desk-muted">
            <template v-if="metric === 'tokens'">
              <span v-for="segment in USAGE_SEGMENTS" :key="segment.key" class="inline-flex items-center gap-1.5">
                <span class="size-2 rounded-sm" :style="{ backgroundColor: segment.color }" aria-hidden="true"></span>
                {{ segment.label }}
              </span>
            </template>
            <span v-else-if="metric === 'messages'">柱高为当日回复条数</span>
            <span v-else>费用只统计供应商上报价格的调用，未提供价格的日期不画柱</span>
          </div>

          <div class="mt-3">
            <UsageTrendChart
              :bars="trendBars"
              :ticks="trendAxis"
              :unit-label="metricUnit"
              :metric="metric"
              @select="handleDayDrill"
            />
          </div>

          <!-- 常驻按日明细：精确读数与键盘浏览入口，最新日期在前；日期可点进当日会话明细。 -->
          <div class="mt-3 border-t border-desk-line pt-3">
            <p class="text-2xs font-medium text-desk-muted">按日明细（{{ rangeLabel }}，最新在前）</p>
            <div class="mt-2">
              <UsageDailyTable :rows="dailyRows" :cost-available="costAvailable" @select-day="handleDayDrill" />
            </div>
          </div>
        </section>

        <!-- 3. 模型与项目分布 (双列并排) -->
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <!-- 模型分布 -->
          <section class="settings-section" aria-labelledby="usage-models-title">
            <div class="settings-section-heading">
              <h2 id="usage-models-title" class="settings-section-title">模型用量分布</h2>
              <span class="text-2xs text-desk-muted">{{ modelRows.length }} 项 · 点击行查看会话</span>
            </div>

            <UsageDistributionList
              :rows="modelRows"
              empty-text="所选范围内无模型用量记录。"
              @select="handleDrill"
            />
          </section>

          <!-- 项目分布 -->
          <section class="settings-section" aria-labelledby="usage-projects-title">
            <div class="settings-section-heading">
              <h2 id="usage-projects-title" class="settings-section-title">项目用量分布</h2>
              <span class="text-2xs text-desk-muted">{{ projectRows.length }} 项 · 点击行查看会话</span>
            </div>

            <UsageDistributionList
              :rows="projectRows"
              empty-text="所选范围内无项目用量记录。"
              @select="handleDrill"
            />
          </section>

          <!-- 团队用量分布：只含团队成员会话，按根会话归组；没有团队记录时整块不出现 -->
          <section v-if="teamRows.length > 0" class="settings-section" aria-labelledby="usage-teams-title">
            <div class="settings-section-heading">
              <h2 id="usage-teams-title" class="settings-section-title">团队用量分布</h2>
            </div>
            <p class="mt-1 text-2xs text-desk-muted">
              团队成员是完整会话，开销独立计时；这里按团队（根会话）归组，团长自己的请求仍计在“项目用量分布”里。
            </p>
            <UsageDistributionList
              :rows="teamRows"
              empty-text="所选范围内无团队成员会话记录。"
              @select="handleDrill"
            />
          </section>
        </div>

        <!-- 4. 会话明细：无下钻为范围内消耗 Top，点击分布行/趋势柱/热力图格后按维度过滤 -->
        <section class="settings-section" aria-labelledby="usage-sessions-title">
          <div class="settings-section-heading">
            <div class="flex flex-wrap items-center gap-2">
              <h2 id="usage-sessions-title" class="settings-section-title">
                {{ drill === null ? '高消耗会话' : '会话明细' }}
              </h2>
              <span
                v-if="drill !== null"
                class="inline-flex items-center rounded-full border border-desk-line px-2 py-0.5 text-2xs text-desk-muted"
              >
                {{ drill.label }} · {{ rangeLabel }}
              </span>
            </div>
            <div class="flex items-center gap-3">
              <span class="text-2xs text-desk-muted">点击可快速打开该会话</span>
              <AppButton v-if="drill !== null" variant="ghost" size="sm" type="button" @click="clearDrill">
                清除筛选
              </AppButton>
            </div>
          </div>

          <UsageSessionList
            :rows="sessionRows"
            :empty-text="drill === null
              ? `${rangeLabel}内暂无会话明细。`
              : `${drill.label}在${rangeLabel}内没有会话明细。`"
            @open="handleOpenSession"
          />
        </section>

        <!-- 5. 近一年日度活跃度：固定窗口，不随范围筛选变化 -->
        <section v-if="heatmap !== null" class="settings-section" aria-labelledby="usage-heatmap-title">
          <div class="settings-section-heading">
            <div>
              <h2 id="usage-heatmap-title" class="settings-section-title">全年活跃度</h2>
              <p class="mt-1 text-2xs tabular-nums text-desk-muted">
                固定近一年窗口 · {{ heatmap.activeDays }} 天有记录 · 合计 {{ formatTokens(heatmap.totalTokens) }} tokens · 点击格子查看当日会话
              </p>
            </div>
          </div>
          <UsageHeatmap :model="heatmap" @select="handleDayDrill" />
        </section>
      </template>
    </template>
  </div>
</template>
