<!-- 生成式界面的挂载门：界面进入视口附近才挂载真实组件，远离视口时退化为一行占位。
     为什么不用 content-visibility：它只跳过绘制，DOM 与组件实例仍然存在，达不到减少同时挂载量的目的。
     为什么要自己补偿滚动：对话区滚动容器设了 overflow-anchor:none，浏览器不会替高度变化补偿，
     占位换成真实界面的高度差必须自己补，否则界面在可视区上方首次挂载时，正在读的内容会整体下移。
     参数取值按 documentId 存在模块内存里（见 param-state.ts），卸载不清空，重新挂载沿用当前取值；
     同一份取值另存本机旁路文件（param-persistence.ts），重启后仍在。
     根节点带 documentId 与 revision 两个 data 属性：被取代的旧版折叠行靠它们定位新版落点，
     未挂载时占位也在，因此不参与布局、也不影响挂载判定。 -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { GenuiPayload } from '../../../../shared/genui-api'

const props = withDefaults(defineProps<{
  readonly payload: GenuiPayload
  /** 视口外多远就提前挂载；留出余量，滚到位置之前已经渲染完成。 */
  readonly margin?: number
}>(), { margin: 800 })

/** 占位撑高的上限：记住的高度来自上一版界面，过大时宁可让高度差交给补偿逻辑处理。 */
const MAX_PLACEHOLDER_HEIGHT_PX = 720

/** 记住高度的条目上限；超出按写入序淘汰，避免长会话里无限累积。 */
const MAX_HEIGHT_ENTRIES = 200

/**
 * 每份界面最后一次实测高度，键为 `documentId`：占位先按它撑开，重新挂载时高度差更小。
 * 只作近似值使用，不参与布局计算，因此文档改版后沿用旧高度也不会算错。
 */
const rememberedHeights = new Map<string, number>()

function rememberHeight(id: string, height: number): void {
  if (!Number.isFinite(height) || height <= 0) return
  rememberedHeights.delete(id)
  rememberedHeights.set(id, height)
  if (rememberedHeights.size > MAX_HEIGHT_ENTRIES) {
    const oldest = rememberedHeights.keys().next()
    if (oldest.done !== true) rememberedHeights.delete(oldest.value)
  }
}

/** 占位撑高取值：记住的高度换成 CSS 长度，超过上限时封顶。 */
function heightOf(id: string): string | undefined {
  const height = rememberedHeights.get(id)
  return height === undefined ? undefined : `${Math.round(Math.min(height, MAX_PLACEHOLDER_HEIGHT_PX))}px`
}

const root = ref<HTMLElement | null>(null)
const mounted = ref(false)
let observer: IntersectionObserver | null = null
let restoreFrame: number | null = null

/** 占位撑高：取上次卸载时记下的高度；用 ref 而不是 computed，因为高度表是普通 Map、不可追踪。 */
const placeholderMinHeight = ref<string | undefined>(heightOf(props.payload.documentId))

/** 最近的纵向滚动容器：对话区滚动容器；找不到时按视口处理（返回 null）。 */
function scrollParent(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement
  while (node !== null) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node
    node = node.parentElement
  }
  return null
}

/** 卸载与挂载共用的几何快照：挂载门自身的当前高度，以及它是否已在可视区上方。 */
function geometry(): { host: HTMLElement; height: number; aboveViewport: boolean } | null {
  const element = root.value
  if (element === null) return null
  const host = scrollParent(element)
  if (host === null) return null
  const rect = element.getBoundingClientRect()
  return { host, height: rect.height, aboveViewport: rect.top < host.getBoundingClientRect().top }
}

/**
 * 按高度差补滚动：界面在可视区上方时，它长高或变矮会把正在读的内容推开或拽回，必须抵消。
 * 下方的高度变化不移动用户已看的内容，因此不处理；这也避开了与观察器互相触发的循环。
 */
function compensate(before: { host: HTMLElement; height: number; aboveViewport: boolean }): void {
  if (!before.aboveViewport) return
  void nextTick(() => {
    if (restoreFrame !== null) cancelAnimationFrame(restoreFrame)
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = null
      const node = root.value
      if (node === null || !node.isConnected) return
      const delta = node.getBoundingClientRect().height - before.height
      if (delta !== 0) before.host.scrollTop += delta
    })
  })
}

/** 卸载：先记下实测高度，占位按它撑开，下次挂载的高度差更小。 */
function collapse(): void {
  if (!mounted.value) return
  const before = geometry()
  if (before !== null) rememberHeight(props.payload.documentId, before.height)
  mounted.value = false
  // 占位按实测高度撑开，下次挂载的高度差更小，滚动补偿也就更不明显。
  placeholderMinHeight.value = heightOf(props.payload.documentId)
  if (before !== null) compensate(before)
}

/**
 * 挂载：先记下挂载前的几何，再让真实组件顶上来。
 * 长高与变矮都要补偿：界面在可视区上方时，它的高度变化会把正在读的内容整体推开或拽回。
 */
function expand(): void {
  if (mounted.value) return
  const before = geometry()
  mounted.value = true
  if (before !== null) compensate(before)
}

onMounted(() => {
  const element = root.value
  if (element === null) return
  observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) expand()
    else collapse()
  }, { rootMargin: `${props.margin}px` })
  // 首次同步判定：新交付的界面通常就在视口里，等观察器回调会先闪一帧占位。
  const rect = element.getBoundingClientRect()
  if (rect.bottom > -props.margin && rect.top < window.innerHeight + props.margin) expand()
  observer.observe(element)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (restoreFrame !== null) cancelAnimationFrame(restoreFrame)
  restoreFrame = null
})
</script>

<template>
  <div ref="root" class="genui-mount" :data-genui-document-id="payload.documentId" :data-genui-revision="payload.revision">
    <slot v-if="mounted" />
    <!-- 占位保留标题与替代文本：未挂载时仍能看到这份界面是什么、说了什么。 -->
    <div v-else class="genui-mount-placeholder" :style="{ minHeight: placeholderMinHeight }">
      <div class="genui-mount-head">
        <span class="genui-mount-label">生成式界面</span>
        <span class="genui-mount-title" :title="payload.document.title">{{ payload.document.title }}</span>
        <span class="genui-mount-hint">滚动到此处后加载</span>
      </div>
      <p class="genui-mount-fallback">{{ payload.document.fallback }}</p>
    </div>
  </div>
</template>
