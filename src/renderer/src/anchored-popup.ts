/**
 * 锚定浮层：把「按触发元素量算浮层位置」这套逻辑收在一处，供选择器与操作菜单复用。
 *
 * 只负责展开状态与几何，不管内容、键盘与焦点，也不渲染元素：浮层由调用方经 Teleport 渲染到
 * body，避免被侧栏、弹层等滚动容器的 overflow 裁掉。位置策略是先按触发元素的矩形算尺寸，
 * 下方空间不足且上方更宽裕时向上翻转，再贴住视窗边缘收边；展开期间监听视窗缩放与滚动
 * （捕获阶段，滚动容器内的滚动同样命中）重算，点击浮层与触发元素之外的位置收起。
 */
import { onUnmounted, ref } from 'vue'

/** 浮层落点与尺寸；四个值由调用方直接写进浮层的内联样式。 */
export interface AnchoredPopupPosition {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly maxHeight: number
}

export interface AnchoredPopupOptions {
  /** 浮层与视窗边缘保留的最小间距。 */
  readonly edge?: number
  /** 触发元素与浮层之间的间隙。 */
  readonly gap?: number
  /** 下方可用高度低于该值、且上方更宽裕时向上翻转。 */
  readonly flipThreshold?: number
  /** 浮层最小可用高度；空间更小时不再压缩，交给浮层内部滚动。 */
  readonly minHeight?: number
  /** 浮层高度上限。 */
  readonly maxHeightCap?: number
  /** 浮层宽度；不传时与触发元素等宽。 */
  readonly width?: number
  /** 横向对齐：`start` 与触发元素左对齐，`end` 与触发元素右对齐。 */
  readonly align?: 'start' | 'end'
  /** 收起时的回调（含点击外部收起），用于让调用方清掉自己的「当前项」。 */
  readonly onClose?: () => void
}

const DEFAULT_EDGE = 8
const DEFAULT_GAP = 4
const DEFAULT_FLIP_THRESHOLD = 200
const DEFAULT_MIN_HEIGHT = 96
const DEFAULT_MAX_HEIGHT_CAP = 360

/**
 * `trigger` 由调用方在打开前赋值；`popup` 只用于判断点击是否落在浮层内；
 * `isOpen` 是展开状态，`open()` 是展开动作，`close()` 返回本次是否真的从展开态收起。
 */
export function useAnchoredPopup(options: AnchoredPopupOptions = {}) {
  const edge = options.edge ?? DEFAULT_EDGE
  const gap = options.gap ?? DEFAULT_GAP
  const flipThreshold = options.flipThreshold ?? DEFAULT_FLIP_THRESHOLD
  const minHeight = options.minHeight ?? DEFAULT_MIN_HEIGHT
  const maxHeightCap = options.maxHeightCap ?? DEFAULT_MAX_HEIGHT_CAP

  const trigger = ref<HTMLElement | null>(null)
  const popup = ref<HTMLElement | null>(null)
  const isOpen = ref(false)
  const position = ref<AnchoredPopupPosition>({ left: 0, top: 0, width: 0, maxHeight: maxHeightCap })

  /** 按触发元素当前的位置重算落点；触发元素缺失时保持上一次结果。 */
  function update(): void {
    const element = trigger.value
    if (element === null) return

    const rect = element.getBoundingClientRect()
    const width = Math.min(options.width ?? rect.width, window.innerWidth - edge * 2)
    const availableBelow = window.innerHeight - rect.bottom - gap - edge
    const availableAbove = rect.top - gap - edge
    const placeAbove = availableBelow < flipThreshold && availableAbove > availableBelow
    const available = placeAbove ? availableAbove : availableBelow
    const maxHeight = Math.max(minHeight, Math.min(maxHeightCap, available))
    const alignedLeft = options.align === 'end' ? rect.right - width : rect.left
    const left = Math.max(edge, Math.min(alignedLeft, window.innerWidth - width - edge))
    const proposedTop = placeAbove ? rect.top - gap - maxHeight : rect.bottom + gap
    const top = Math.max(edge, Math.min(proposedTop, window.innerHeight - maxHeight - edge))

    position.value = { left, top, width, maxHeight }
  }

  function onWindowPointerDown(event: PointerEvent): void {
    const target = event.target
    if (!(target instanceof Node)) return
    if (trigger.value?.contains(target) || popup.value?.contains(target)) return
    close()
  }

  function onViewportChange(): void {
    if (isOpen.value) update()
  }

  /** 展开：先量出位置再挂监听，首帧不会落在默认坐标上。 */
  function open(): void {
    if (isOpen.value) return
    isOpen.value = true
    update()
    window.addEventListener('pointerdown', onWindowPointerDown)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
  }

  /** 收起并解绑；返回本次是否真的从展开态收起，供调用方决定要不要把焦点还给触发元素。 */
  function close(): boolean {
    if (!isOpen.value) return false
    isOpen.value = false
    window.removeEventListener('pointerdown', onWindowPointerDown)
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('scroll', onViewportChange, true)
    options.onClose?.()
    return true
  }

  function toggle(): void {
    if (isOpen.value) close()
    else open()
  }

  onUnmounted(() => {
    close()
  })

  return { trigger, popup, isOpen, position, open, close, toggle, update }
}
