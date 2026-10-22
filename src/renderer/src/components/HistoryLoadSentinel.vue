<!-- 历史加载触发点：进入可见区域后按游标自动读取；正常时不占操作区，失败时才提供就地重试。 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppButton from '../ui/AppButton.vue'

const props = withDefaults(defineProps<{
  readonly cursor: string
  readonly enabled: boolean
  readonly loading?: boolean
  readonly error?: string | null | undefined
  /** 多个占位共用一页请求时，仅由轮末的触发点呈现一次失败。 */
  readonly quietError?: boolean
}>(), { loading: false, error: null, quietError: false })
const emit = defineEmits<{ load: [] }>()
const target = ref<HTMLElement | null>(null)
let visible = false
let requested: string | null = null
let observer: IntersectionObserver | null = null
let frame: number | null = null

/** 同一游标只发起一次，等待父级加载结束或游标前进；失败不会自动重试。 */
function schedule(force = false): void {
  if (frame !== null) cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    frame = null
    if (!visible || !props.enabled || props.loading || (!force && props.error) || requested === props.cursor) return
    requested = props.cursor
    emit('load')
  })
}
function retry(): void {
  requested = null
  schedule(true)
}
watch(() => [props.cursor, props.enabled, props.loading, props.error] as const, (next, previous) => {
  if (next[0] !== previous[0] || (!previous[1] && next[1]) || (previous[2] && !next[2])) requested = null
  schedule()
}, { flush: 'post' })
onMounted(() => {
  observer = new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting)
    if (visible) schedule()
  }, { rootMargin: '120px' })
  if (target.value) observer.observe(target.value)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  if (frame !== null) cancelAnimationFrame(frame)
})
</script>

<template>
  <div ref="target" class="min-h-px w-full" :aria-busy="loading">
    <div v-if="error && !quietError" role="alert" class="flex flex-wrap items-center gap-2 py-1 text-xs text-desk-danger">
      <span :title="error">内容加载失败</span>
      <AppButton variant="compact" :disabled="loading || !enabled" :title="error" @click="retry">重试</AppButton>
    </div>
  </div>
</template>
