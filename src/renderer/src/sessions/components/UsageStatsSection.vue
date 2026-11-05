<!-- 设置页的用量统计分节：
     统计已登记项目的所有本地会话 Token 消耗，展示总量、缓存命中率、日度趋势、模型分布、项目分布及高消耗会话 Top 明细。
     支持手动重新扫描；点击 Top 会话可直接跳转至对应项目的该会话并关闭设置页。 -->
<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import type {
  UsageStatsSummary,
  UsageTopSession
} from '../../../../shared/usage-stats-api'
import { getUsageStats } from '../services/usage-stats'
import {
  buildDailyBars,
  calculateSharePercent,
  cacheHitRate,
  formatDateTime,
  formatTokens
} from '../usage-stats-view'
import { formatCost } from '../usage-format'
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

const dailyBars = computed(() => {
  if (!summary.value) return []
  return buildDailyBars(summary.value.daily, 30)
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
          variant="secondary"
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
      <!-- 1. 总量指标卡片 -->
      <section class="settings-section" aria-labelledby="usage-overview-title">
        <div class="settings-section-heading">
          <h2 id="usage-overview-title" class="settings-section-title">总量概览</h2>
          <span class="text-2xs text-desk-muted">
            共扫描 {{ summary.totalSessions }} 个会话 · {{ summary.totalMessages }} 条回复
          </span>
        </div>

        <dl class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="rounded-desk-sm border border-desk-line bg-desk-canvas-sunken px-3 py-2">
            <dt class="text-2xs text-desk-muted">总 Token</dt>
            <dd class="mt-0.5 text-base font-semibold" :title="`${summary.totals.totalTokens} tokens`">
              {{ formatTokens(summary.totals.totalTokens) }}
            </dd>
          </div>

          <div class="rounded-desk-sm border border-desk-line bg-desk-canvas-sunken px-3 py-2">
            <dt class="text-2xs text-desk-muted">输入 / 输出</dt>
            <dd class="mt-0.5 text-sm font-semibold truncate" :title="`输入: ${summary.totals.input} · 输出: ${summary.totals.output}`">
              {{ formatTokens(summary.totals.input) }} / {{ formatTokens(summary.totals.output) }}
            </dd>
          </div>

          <div class="rounded-desk-sm border border-desk-line bg-desk-canvas-sunken px-3 py-2">
            <dt class="text-2xs text-desk-muted">缓存读取 (命中率)</dt>
            <dd class="mt-0.5 text-sm font-semibold" :title="`缓存读: ${summary.totals.cacheRead}`">
              {{ formatTokens(summary.totals.cacheRead) }} ({{ overallCacheHitText }})
            </dd>
          </div>

          <div class="rounded-desk-sm border border-desk-line bg-desk-canvas-sunken px-3 py-2">
            <dt class="text-2xs text-desk-muted">累计费用</dt>
            <dd class="mt-0.5 text-sm font-semibold">
              <span v-if="summary.totalCost !== null">${{ formatCost(summary.totalCost) }}</span>
              <span v-else class="text-xs text-desk-muted font-normal">未提供价格信息</span>
            </dd>
          </div>
        </dl>
      </section>

      <!-- 2. 日度用量趋势 -->
      <section v-if="dailyBars.length > 0" class="settings-section" aria-labelledby="usage-trend-title">
        <div class="settings-section-heading">
          <h2 id="usage-trend-title" class="settings-section-title">用量趋势 (近 30 个有记录日)</h2>
          <span class="text-2xs text-desk-muted">单位：Token 量</span>
        </div>

        <div class="mt-4 rounded-desk-sm border border-desk-line bg-desk-surface p-4">
          <div class="flex h-36 items-end gap-1.5 overflow-x-auto pb-6 pt-2 scroll-area">
            <div
              v-for="bar in dailyBars"
              :key="bar.date"
              class="group relative flex flex-1 min-w-[20px] max-w-[40px] flex-col items-center justify-end h-full cursor-default"
              :title="bar.tooltip"
            >
              <!-- 柱体 -->
              <div
                class="w-full rounded-t bg-desk-accent/70 transition-all hover:bg-desk-accent"
                :style="{ height: `${bar.heightPercent}%` }"
              ></div>

              <!-- 悬浮数值卡片 -->
              <div
                class="pointer-events-none absolute bottom-full mb-1 hidden rounded border border-desk-line bg-desk-surface px-1.5 py-0.5 text-[10px] whitespace-nowrap shadow-sm group-hover:block z-10"
              >
                {{ bar.label }}: {{ formatTokens(bar.totalTokens) }}
              </div>

              <!-- X 轴日期 -->
              <span class="absolute -bottom-5 text-[10px] text-desk-muted whitespace-nowrap">
                {{ bar.label }}
              </span>
            </div>
          </div>
        </div>
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

          <ul v-else class="mt-3 space-y-2.5 max-h-80 overflow-y-auto scroll-area pr-1">
            <li
              v-for="m in summary.models"
              :key="`${m.provider}:${m.modelId}`"
              class="rounded-desk-sm border border-desk-line bg-desk-surface p-2.5 text-xs"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0 flex-1 truncate font-medium">
                  <span class="text-desk-muted text-2xs mr-1">[{{ m.provider }}]</span>
                  <span>{{ m.modelId }}</span>
                </div>
                <div class="text-right text-xs font-semibold whitespace-nowrap">
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

              <div class="mt-1.5 flex items-center justify-between text-2xs text-desk-muted">
                <span>输入: {{ formatTokens(m.input) }} · 输出: {{ formatTokens(m.output) }}</span>
                <span>{{ m.messageCount }} 次回复</span>
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

          <ul v-else class="mt-3 space-y-2.5 max-h-80 overflow-y-auto scroll-area pr-1">
            <li
              v-for="p in summary.projects"
              :key="p.projectPath"
              class="rounded-desk-sm border border-desk-line bg-desk-surface p-2.5 text-xs"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0 flex-1 truncate font-medium" :title="p.projectPath">
                  {{ p.projectName }}
                </div>
                <div class="text-right text-xs font-semibold whitespace-nowrap">
                  {{ formatTokens(p.totalTokens) }}
                  <span class="text-2xs font-normal text-desk-muted ml-1">
                    ({{ calculateSharePercent(p.totalTokens, summary.totals.totalTokens) }})
                  </span>
                </div>
              </div>

              <!-- 进度条 -->
              <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-desk-canvas-sunken">
                <div
                  class="h-full bg-emerald-500 rounded-full"
                  :style="{ width: calculateSharePercent(p.totalTokens, summary.totals.totalTokens) }"
                ></div>
              </div>

              <div class="mt-1.5 flex items-center justify-between text-2xs text-desk-muted">
                <span class="truncate max-w-[200px]" :title="p.projectPath">{{ p.projectPath }}</span>
                <span>{{ p.sessionCount }} 个会话</span>
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
          <li
            v-for="(session, index) in summary.topSessions"
            :key="session.sessionId"
            class="group flex items-center justify-between gap-3 rounded-desk-sm border border-desk-line bg-desk-surface px-3 py-2 text-xs transition-colors hover:border-desk-accent/50 hover:bg-desk-canvas-sunken cursor-pointer"
            @click="handleOpenSession(session)"
          >
            <!-- 序号与标题 -->
            <div class="flex items-center gap-2.5 min-w-0 flex-1">
              <span class="w-5 text-center text-2xs font-mono text-desk-muted">#{{ index + 1 }}</span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="truncate font-medium text-desk-text group-hover:text-desk-accent" :title="session.title">
                    {{ session.title }}
                  </span>
                  <span class="rounded border border-desk-line px-1 py-px text-[10px] text-desk-muted shrink-0">
                    {{ session.projectName }}
                  </span>
                </div>
                <div class="mt-0.5 text-2xs text-desk-muted">
                  更新于 {{ formatDateTime(session.updatedAt) }} · {{ session.messageCount }} 条回复
                </div>
              </div>
            </div>

            <!-- 用量与 Token -->
            <div class="text-right shrink-0">
              <div class="font-semibold font-mono text-xs text-desk-text">
                {{ formatTokens(session.totalTokens) }}
              </div>
              <div class="text-[10px] text-desk-muted">
                入 {{ formatTokens(session.input) }} · 出 {{ formatTokens(session.output) }}
              </div>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
