<!-- 原版 Lancer SVG 运行边框的 Vue 挂载层：只随真实运行显示，页面隐藏或离屏时暂停，减少动态效果由原版样式处理。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import '../../ui/lancer-light-ui/running-border.css'

const props = withDefaults(defineProps<{
  readonly active: boolean
  readonly radius?: number
}>(), { radius: 8 })
const host = ref<HTMLElement | null>(null)
const inView = ref(false)
const hidden = ref(true)
let observer: IntersectionObserver | null = null
const paused = computed(() => hidden.value || !inView.value)
function syncVisibility(): void { hidden.value = document.hidden }
onMounted(() => {
  syncVisibility()
  document.addEventListener('visibilitychange', syncVisibility)
  observer = new IntersectionObserver(entries => { inView.value = entries.some(entry => entry.isIntersecting) })
  if (host.value !== null) observer.observe(host.value)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  document.removeEventListener('visibilitychange', syncVisibility)
})
</script>

<template>
  <span ref="host" class="task-running-layer" :class="{ 'light-motion-paused': paused }" aria-hidden="true">
    <svg v-if="props.active" class="light-running-border">
      <rect x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" :rx="radius" pathLength="100" />
    </svg>
  </span>
</template>

<style scoped>
.task-running-layer { position: absolute; inset: 0; display: block; border-radius: inherit; pointer-events: none; --light-color: var(--color-desk-accent); }
</style>
