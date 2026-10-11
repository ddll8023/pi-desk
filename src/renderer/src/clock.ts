/**
 * 共享刻度：只在存在需要实时数字的组件时按固定节拍更新"当前时刻"。
 *
 * 服务于运行中工具与 AI 消息的耗时显示，不作为权威时间源；耗时差值仍以主进程给出的
 * `startedAt`/`endedAt` 为准，本模块仅让运行中的数字继续走动。没有订阅者时
 * 定时器被清除，避免每个工具卡片或消息各起一个定时器而持续重渲染。
 * 耗时格式化共用于消息与工具，秒数四舍五入后统一进位。
 */
import { computed, onScopeDispose, ref, watchEffect } from 'vue'
import type { ComputedRef } from 'vue'

/** 刻度间隔；越短越平滑，越长越省重渲染。 */
const TICK_INTERVAL_MS = 500

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
let subscribers = 0

function startTimer(): void {
  if (timer !== null) return
  now.value = Date.now()
  timer = setInterval(() => {
    now.value = Date.now()
  }, TICK_INTERVAL_MS)
}

function stopTimer(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

/** 只表达客户端事件间隔的量级，不代表模型或工具的服务端精确耗时。 */
export function formatDuration(milliseconds: number): string {
  const rounded = Math.max(0, Math.round(milliseconds))
  if (rounded < 1000) return `${rounded} 毫秒`
  const tenths = Math.round(rounded / 100)
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} 秒`
  const seconds = Math.round(rounded / 1000)
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

/**
 * `active` 为真时保持刻度，为假或组件销毁时自动退订；返回值每次刻度都会更新。
 * 组件必须在 setup 作用域内调用，退订依赖该作用域的销毁钩子。
 */
export function useTickingNow(active: () => boolean): ComputedRef<number> {
  let subscribed = false

  const subscribe = (): void => {
    if (subscribed) return
    subscribed = true
    subscribers += 1
    startTimer()
  }

  const unsubscribe = (): void => {
    if (!subscribed) return
    subscribed = false
    subscribers -= 1
    if (subscribers === 0) stopTimer()
  }

  watchEffect(() => {
    if (active()) subscribe()
    else unsubscribe()
  })
  onScopeDispose(unsubscribe)

  return computed(() => now.value)
}
