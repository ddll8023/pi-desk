<!-- 对话大纲：悬停或键盘聚焦时刻度形成弹性波峰，摘要浮层平滑定位并交叉淡化；保留紧凑布局与减少动效支持，只发出跳转意图，不控制正文滚动。
     本轮交付过生成式界面时，刻度右上方点一枚强调色小圆点，预览里多一行个数；圆点不参与刻度的波峰缩放。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AnimatePresence, Motion, MotionConfig, useReducedMotion, useSpring } from 'motion-v'
import type { Options, VariantType } from 'motion-v'
import AppButton from './ui/AppButton.vue'

interface OutlineEntry {
  readonly id: string
  readonly label: string
  /** 本轮交付的界面个数；大于 0 时在刻度旁标一枚强调色圆点。 */
  readonly uiCount: number
}

const props = defineProps<{
  readonly entries: readonly OutlineEntry[]
  readonly activeId: string | null
}>()

const emit = defineEmits<{
  navigate: [messageId: string]
}>()

/** 留出跨越刻度与浮层间隙的时间，不让鼠标移向文字时预览闪退。 */
const HOVER_LEAVE_DELAY_MS = 100
const PREVIEW_EDGE_PX = 8
const MARKER_SPRING = { type: 'spring', stiffness: 360, damping: 25, mass: 0.6 } as const
const PREVIEW_SPRING = { stiffness: 380, damping: 30, mass: 0.65 }

const root = ref<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
const preview = ref<HTMLElement | null>(null)
const hoveredId = ref<string | null>(null)
const focusedId = ref<string | null>(null)
const displayedEntry = ref<OutlineEntry | null>(null)
const prefersReducedMotion = useReducedMotion()
const previewY = useSpring(0, PREVIEW_SPRING)
let leaveTimer: ReturnType<typeof setTimeout> | null = null
let resizeObserver: ResizeObserver | null = null

const previewId = computed(() => hoveredId.value ?? focusedId.value)
const previewEntry = computed(() => props.entries.find(entry => entry.id === previewId.value) ?? null)
const previewVisible = computed(() => previewEntry.value !== null)
const previewIndex = computed(() => props.entries.findIndex(entry => entry.id === previewId.value))

/** 只伸展装饰刻度，不移动按钮或改变行高，避免波峰影响命中区域与浮层定位。 */
const markerEntries = computed(() => props.entries.map((entry, index) => {
  const distance = previewIndex.value < 0 ? Infinity : Math.abs(index - previewIndex.value)
  const active = entry.id === props.activeId
  const waveScale = distance === 0 ? 2.25 : distance === 1 ? 1.55 : distance === 2 ? 1.15 : 1
  return {
    ...entry,
    nearPreview: distance > 0 && distance <= 2,
    animate: {
      scaleX: Math.max(active ? 1.75 : 1, waveScale),
      scaleY: active || distance === 0 ? 1.5 : 1,
      x: distance === 0 ? -1.5 : distance === 1 ? -0.75 : distance === 2 ? -0.25 : 0
    } satisfies VariantType
  }
}))

const markerTransition = computed<NonNullable<Options['transition']>>(() => (
  prefersReducedMotion.value ? { duration: 0 } : MARKER_SPRING
))
const previewInitial = computed<VariantType>(() => ({
  opacity: 0,
  x: prefersReducedMotion.value ? 0 : 6,
  scale: prefersReducedMotion.value ? 1 : 0.97
}))
const previewTransition = computed<NonNullable<Options['transition']>>(() => ({
  default: prefersReducedMotion.value ? { duration: 0 } : { type: 'spring', ...PREVIEW_SPRING },
  opacity: { type: 'tween', duration: prefersReducedMotion.value ? 0 : 0.14, ease: 'easeOut' }
}))
const previewExit = computed<VariantType>(() => ({
  opacity: 0,
  x: prefersReducedMotion.value ? 0 : 4,
  scale: prefersReducedMotion.value ? 1 : 0.985,
  transition: { type: 'tween', duration: prefersReducedMotion.value ? 0 : 0.1, ease: 'easeIn' }
}))
const summaryTransition = computed<NonNullable<Options['transition']>>(() => ({
  type: 'tween', duration: prefersReducedMotion.value ? 0 : 0.12, ease: 'easeOut'
}))

function cancelHide(): void {
  if (leaveTimer === null) return
  clearTimeout(leaveTimer)
  leaveTimer = null
}

function showEntry(messageId: string): void {
  cancelHide()
  hoveredId.value = messageId
}

/** 延迟只用于鼠标离开；键盘聚焦仍独立保留预览。 */
function scheduleHide(): void {
  cancelHide()
  leaveTimer = setTimeout(() => {
    leaveTimer = null
    hoveredId.value = null
  }, HOVER_LEAVE_DELAY_MS)
}

/** 鼠标点击后的普通焦点不锁住预览；键盘焦点与悬停享有相同反馈。 */
function onEntryFocus(event: FocusEvent, messageId: string): void {
  if (event.currentTarget instanceof HTMLElement && event.currentTarget.matches(':focus-visible')) {
    focusedId.value = messageId
  }
}

function onEntryBlur(messageId: string): void {
  if (focusedId.value === messageId) focusedId.value = null
}

/** 只在当前大纲内找刻度，不依赖跨会话唯一的 DOM ID。 */
function findMarker(messageId: string): HTMLElement | null {
  return list.value?.querySelector<HTMLElement>(`[data-outline-id="${CSS.escape(messageId)}"]`) ?? null
}

/** 浮层相对整个大纲定位，滚动列表只裁剪刻度；首尾预览限制在消息区可用高度内。 */
function positionPreview(snap = false): void {
  const host = root.value
  const scrollList = list.value
  const entry = previewEntry.value
  if (host === null || scrollList === null || entry === null) return
  const marker = findMarker(entry.id)
  if (marker === null) return

  const markerRect = marker.getBoundingClientRect()
  const listRect = scrollList.getBoundingClientRect()
  if (markerRect.bottom <= listRect.top || markerRect.top >= listRect.bottom) {
    hoveredId.value = null
    focusedId.value = null
    return
  }

  const hostRect = host.getBoundingClientRect()
  const halfHeight = Math.min(hostRect.height / 2, (preview.value?.offsetHeight || 52) / 2 + PREVIEW_EDGE_PX)
  const center = markerRect.top - hostRect.top + markerRect.height / 2
  const top = Math.max(halfHeight, Math.min(hostRect.height - halfHeight, center))
  if (snap || prefersReducedMotion.value) previewY.jump(top)
  else previewY.set(top)
}

/** 正文滚动时把当前刻度留在列表可视范围；用户正在操作大纲时不抢它的滚动位置。 */
function revealActiveMarker(): void {
  const scrollList = list.value
  if (scrollList === null || props.activeId === null) return
  if (root.value?.matches(':hover') || root.value?.contains(document.activeElement)) return
  const marker = findMarker(props.activeId)
  if (marker === null) return

  const listRect = scrollList.getBoundingClientRect()
  const markerRect = marker.getBoundingClientRect()
  if (markerRect.top < listRect.top + PREVIEW_EDGE_PX) {
    scrollList.scrollTop += markerRect.top - listRect.top - PREVIEW_EDGE_PX
  } else if (markerRect.bottom > listRect.bottom - PREVIEW_EDGE_PX) {
    scrollList.scrollTop += markerRect.bottom - listRect.bottom + PREVIEW_EDGE_PX
  }
}

function dismissPreview(): void {
  cancelHide()
  hoveredId.value = null
  focusedId.value = null
}

/** 首次显示先落到目标刻度，避免从顶端飞入；连续切换则保留弹簧当前位置与速度。 */
watch(previewEntry, (entry, previousEntry) => {
  if (entry === null) return
  displayedEntry.value = entry
  const snap = previousEntry === null
  positionPreview(snap)
  void nextTick(() => positionPreview(snap))
}, { flush: 'post' })

watch(() => props.entries, () => {
  if (hoveredId.value !== null && !props.entries.some(entry => entry.id === hoveredId.value)) hoveredId.value = null
  if (focusedId.value !== null && !props.entries.some(entry => entry.id === focusedId.value)) focusedId.value = null
  revealActiveMarker()
  void nextTick(positionPreview)
}, { flush: 'post' })

watch(() => props.activeId, revealActiveMarker, { flush: 'post' })

/** 摘要交叉淡化结束后行数可能改变，继续用真实高度约束首尾浮层。 */
watch(preview, (element, previousElement) => {
  if (previousElement !== null) resizeObserver?.unobserve(previousElement)
  if (element !== null) resizeObserver?.observe(element)
}, { flush: 'post' })

watch(prefersReducedMotion, () => positionPreview(true))

onMounted(() => {
  revealActiveMarker()
  resizeObserver = new ResizeObserver(() => {
    revealActiveMarker()
    positionPreview()
  })
  if (root.value !== null) resizeObserver.observe(root.value)
})

onBeforeUnmount(() => {
  cancelHide()
  resizeObserver?.disconnect()
  previewY.destroy()
})
</script>

<template>
  <nav ref="root" class="chat-outline" aria-label="对话大纲" @keydown.esc="dismissPreview">
    <MotionConfig reduced-motion="user">
      <ol ref="list" class="chat-outline-list" @scroll.passive="positionPreview()">
        <li v-for="(entry, index) in markerEntries" :key="entry.id" class="chat-outline-item">
          <AppButton
            variant="unstyled"
            class="chat-outline-trigger"
            :class="{
              'is-active': entry.id === activeId,
              'is-previewing': entry.id === previewId,
              'is-near-preview': entry.nearPreview,
              'has-ui': entry.uiCount > 0
            }"
            :data-outline-id="entry.id"
            :aria-label="`第 ${index + 1} 条用户输入：${entry.label}${entry.uiCount > 0 ? `，含 ${entry.uiCount} 个界面` : ''}`"
            :aria-current="entry.id === activeId ? 'location' : undefined"
            @mouseenter="showEntry(entry.id)"
            @mouseleave="scheduleHide"
            @focus="onEntryFocus($event, entry.id)"
            @blur="onEntryBlur(entry.id)"
            @click="emit('navigate', entry.id)"
          >
            <Motion
              as="span"
              class="chat-outline-mark"
              :initial="false"
              :animate="entry.animate"
              :transition="markerTransition"
              aria-hidden="true"
            />
          </AppButton>
        </li>
      </ol>

      <Motion
        v-if="displayedEntry !== null"
        class="chat-outline-preview-anchor"
        :initial="false"
        :style="{ y: previewY }"
      >
        <div
          ref="preview"
          class="chat-outline-preview"
          :class="{ 'is-visible': previewVisible }"
          :aria-hidden="!previewVisible"
          :inert="!previewVisible"
          @mouseenter="displayedEntry && showEntry(displayedEntry.id)"
          @mouseleave="scheduleHide"
        >
          <AnimatePresence mode="sync">
            <Motion
              v-if="previewVisible"
              key="outline-preview"
              class="chat-outline-preview-surface"
              :initial="previewInitial"
              :animate="{ opacity: 1, x: 0, scale: 1 }"
              :exit="previewExit"
              :transition="previewTransition"
            >
              <AppButton
                variant="unstyled"
                class="chat-outline-preview-button"
                :tabindex="-1"
                :aria-label="`跳转到用户输入：${displayedEntry.label}${displayedEntry.uiCount > 0 ? `，含 ${displayedEntry.uiCount} 个生成式界面` : ''}`"
                @click="displayedEntry && emit('navigate', displayedEntry.id)"
              >
                <AnimatePresence
                  as="span"
                  mode="sync"
                  class="chat-outline-preview-content"
                  :initial="false"
                  aria-hidden="true"
                >
                  <Motion
                    as="span"
                    :key="displayedEntry.id"
                    class="chat-outline-preview-text"
                    :initial="{ opacity: 0 }"
                    :animate="{ opacity: 1 }"
                    :exit="{ opacity: 0 }"
                    :transition="summaryTransition"
                  >
                    {{ displayedEntry.label }}
                  </Motion>
                </AnimatePresence>
                <!-- 本轮交付了界面时补一行：刻度上的圆点只能说明“有”，个数与含义靠这行说清；
                     读屏已由按钮的 aria-label 完整转达，因此这行不重复进无障碍树。 -->
                <span v-if="displayedEntry.uiCount > 0" class="chat-outline-preview-meta" aria-hidden="true">
                  含 {{ displayedEntry.uiCount }} 个生成式界面
                </span>
              </AppButton>
            </Motion>
          </AnimatePresence>
        </div>
      </Motion>
    </MotionConfig>
  </nav>
</template>
