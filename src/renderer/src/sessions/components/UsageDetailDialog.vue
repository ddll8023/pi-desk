<!-- 本会话用量明细浮层：token 分项、费用、缓存命中率、上下文占用与平均输出速率；数据缺失只显示占位，不做推算或换算。 -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import type { OutputRate, SessionUsage } from '../../../../shared/runtime-api'
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
      window.addEventListener('keydown', onKeydown)
      void nextTick(() => panel.value?.focus())
    } else {
      window.removeEventListener('keydown', onKeydown)
    }
  },
  { immediate: true }
)

onUnmounted(() => {
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
            <h2 :id="titleId" class="dialog-title">本会话用量</h2>
          </div>
          <div class="dialog-body">
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
