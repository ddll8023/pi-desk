<!-- 用量与额度浮层：保留本会话统计，按需查询独立的 Codex 账户额度；缺失数据只显示占位，不推算额度或换算金额。 -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import type { OutputRate, SessionUsage } from '../../../../shared/runtime-api'
import type { AuthError, CodexUsageSnapshot } from '../../../../shared/auth-api'
import { getAuthCodexUsage } from '../../providers/services/auth'
import { cacheHitRate, formatCost, formatTokens } from '../usage-format'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  /** 常驻挂载，`open` 控制进入/退出与焦点、快捷键生命周期。 */
  readonly open: boolean
  /** 会话累计统计；主进程尚未取到或形状不符时为 null。 */
  readonly usage: SessionUsage | null
  readonly rate: OutputRate
}>()

const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)
const titleId = useId()
const quota = ref<CodexUsageSnapshot | null>(null)
const quotaLoading = ref(false)
const quotaError = ref<AuthError | null>(null)
let quotaRequest = 0

/** 关闭、重新打开与卸载均换代，迟到的桥接结果不能覆盖另一轮弹窗。 */
async function loadQuota(refresh: boolean): Promise<void> {
  if (!props.open || quotaLoading.value) return
  const request = ++quotaRequest
  quotaLoading.value = true
  quotaError.value = null
  const result = await getAuthCodexUsage(refresh)
  if (request !== quotaRequest || !props.open) return
  quotaLoading.value = false
  if (result.ok) {
    quota.value = result.data
  } else {
    // 失败可能意味着凭据已切换或退出；不继续展示上一账户的额度。
    quota.value = null
    quotaError.value = result.error
  }
}

function windowLabel(seconds: number): string {
  if (seconds % 604800 === 0) return `${seconds / 604800} 周`
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`
  return `${seconds} 秒`
}

/** 展示本地绝对时间，不把未刷新的快照包装成实时倒计时。 */
function resetText(at: number | null): string {
  if (at === null) return '重置时间未知'
  return `${new Date(at).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  })} 重置`
}

const quotaRows = computed(() => (quota.value?.windows ?? []).map((window) => ({
  ...window,
  label: windowLabel(window.seconds),
  reset: resetText(window.resetAt),
  level: window.remainingPercent <= 10 ? 'usage-fill-danger' : window.remainingPercent <= 30 ? 'usage-fill-warn' : ''
})))

const quotaUpdated = computed(() => quota.value === null ? null : new Date(quota.value.fetchedAt)
  .toLocaleTimeString('zh-CN', { hour12: false }))

/** 一条指标：淡色标签 + 实色数值，`title` 是悬停图例。 */
interface UsageMetric {
  readonly tag: string
  readonly value: string
  readonly title: string
}

/** token 分项、缓存命中率与费用；没有统计时返回空数组，由模板显示占位。 */
const metrics = computed<readonly UsageMetric[]>(() => {
  const current = props.usage
  if (current === null) return []
  const hit = cacheHitRate(current)
  return [
    { tag: '↑', value: formatTokens(current.input), title: '输入 tokens' },
    { tag: '↓', value: formatTokens(current.output), title: '输出 tokens' },
    { tag: 'R', value: formatTokens(current.cacheRead), title: '缓存读 tokens' },
    { tag: 'W', value: formatTokens(current.cacheWrite), title: '缓存写 tokens' },
    { tag: '缓存', value: hit === null ? '?' : `${(hit * 100).toFixed(1)}%`, title: '缓存命中率：缓存读 /（输入 + 缓存读 + 缓存写）' },
    { tag: '$', value: formatCost(current.cost), title: '本会话累计费用' }
  ]
})

/** 上下文占用行：文本、进度条宽度与档位色；未知百分比不给条也不给语义色。 */
const contextRow = computed<{ readonly text: string; readonly level: string; readonly width: string } | null>(() => {
  const context = props.usage?.context ?? null
  if (context === null) return null
  const percent = context.percent
  return {
    text: `${percent === null ? '?' : `${percent.toFixed(1)}%`} / ${formatTokens(context.contextWindow)}`,
    level: percent === null ? '' : percent >= 90 ? 'usage-fill-danger' : percent >= 70 ? 'usage-fill-warn' : '',
    width: percent === null ? '0%' : `${Math.min(100, Math.max(0, percent))}%`
  }
})

const averageText = computed(() => (props.rate.average === null ? null : `${props.rate.average.toFixed(1)} t/s`))

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

// 打开时聚焦面板并接管 Escape；关闭时立即移除，避免与其他弹层重复响应同一个按键。
watch(
  () => props.open,
  (open) => {
    if (open) {
      quota.value = null
      quotaError.value = null
      void loadQuota(false)
      window.addEventListener('keydown', onKeydown)
      void nextTick(() => panel.value?.focus())
    } else {
      quotaRequest += 1
      quotaLoading.value = false
      quota.value = null
      quotaError.value = null
      window.removeEventListener('keydown', onKeydown)
    }
  },
  { immediate: true }
)

onUnmounted(() => {
  quotaRequest += 1
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Transition name="dialog-fade">
    <div
      v-if="props.open"
      class="dialog-overlay"
      @click.self="emit('close')"
    >
      <Transition name="dialog-panel-motion" appear>
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
          class="dialog-panel max-w-md"
        >
          <div class="dialog-header">
            <h2 :id="titleId" class="dialog-title">用量与额度</h2>
          </div>
          <div class="dialog-body">
            <section class="space-y-4" aria-label="本会话用量">
              <h3 class="text-xs font-semibold text-desk-ink">本会话</h3>
              <div v-if="metrics.length > 0" class="usage-metrics">
                <span v-for="item in metrics" :key="item.tag" class="usage-metric" :title="item.title">
                  {{ item.tag }}<b>{{ item.value }}</b>
                </span>
              </div>

              <template v-if="contextRow !== null">
                <div class="usage-row">
                  <span class="usage-label">上下文</span>
                  <span class="usage-bar">
                    <span class="usage-fill" :class="contextRow.level" :style="{ width: contextRow.width }"></span>
                  </span>
                  <span class="usage-value">{{ contextRow.text }}</span>
                </div>
              </template>
              <p v-else class="usage-note">
                用量 —（尚未取到会话统计）
              </p>

              <div class="usage-metrics">
                <span
                  v-if="averageText !== null"
                  class="usage-metric usage-metric-rate"
                  title="上一轮模型调用的平均速率：按模型上报的输出 token 与生成时长计算"
                >平均<b>{{ averageText }}</b></span>
                <span v-else class="usage-note">速率 —</span>
              </div>
            </section>

            <section class="space-y-3 border-t border-desk-line pt-4" aria-label="Codex 账户额度" :aria-busy="quotaLoading">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h3 class="text-xs font-semibold text-desk-ink">Codex 账户额度</h3>
                <AppButton variant="compact" :disabled="quotaLoading" @click="loadQuota(true)">
                  {{ quotaLoading ? '读取中…' : '刷新额度' }}
                </AppButton>
              </div>
              <p class="usage-note">已登录 Codex 账户的总额度，不是本会话用量。</p>
              <p v-if="quotaLoading" role="status" class="usage-note">正在读取账户额度…</p>
              <template v-if="quota !== null">
                <p v-if="quotaRows.length === 0" class="usage-note">接口没有返回额度窗口。</p>
                <div v-for="row in quotaRows" :key="row.id" class="space-y-1.5">
                  <div class="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                    <span class="text-xs text-desk-muted">{{ row.label }}</span>
                    <span class="usage-note">{{ row.reset }}</span>
                  </div>
                  <div class="usage-row">
                    <span
                      class="usage-bar"
                      role="meter"
                      :aria-label="`${row.label}剩余额度`"
                      :aria-valuenow="row.remainingPercent"
                      :aria-valuemin="0"
                      :aria-valuemax="100"
                    >
                      <span class="usage-fill" :class="row.level" :style="{ width: `${row.remainingPercent}%` }"></span>
                    </span>
                    <span class="usage-value">剩余 {{ row.remainingPercent.toFixed(1) }}%</span>
                  </div>
                </div>
                <p v-if="quota.unlimited || quota.credits !== null" class="usage-note">
                  可用 credits：{{ quota.unlimited ? '不限量' : quota.credits }}
                </p>
                <p v-if="quota.limitReached" class="text-2xs text-desk-danger">当前窗口额度已用尽</p>
                <p class="usage-note">更新于 {{ quotaUpdated }} · 缓存 60 秒</p>
              </template>
              <div v-else-if="quotaError !== null" role="status" class="space-y-2">
                <p class="usage-note">{{ quotaError.message }}</p>
                <details v-if="quotaError.detail !== null" class="text-2xs text-desk-muted">
                  <summary class="cursor-pointer">技术细节</summary>
                  <pre class="mt-2 whitespace-pre-wrap break-words font-mono">{{ quotaError.detail }}</pre>
                </details>
              </div>
            </section>
          </div>
          <div class="dialog-footer">
            <AppButton @click="emit('close')">
              关闭
            </AppButton>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
