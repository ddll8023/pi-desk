<!--
  终端链接操作气泡：在终端点击 HTTP/HTTPS 链接时，在光标位置弹出紧凑菜单，
  支持在工作区内置浏览器标签打开、系统默认浏览器打开或复制链接。

  浮层基于共用 useAnchoredPopup 进行自适应定位、翻转与收边，Teleport 到 body，
  支持按 Esc 或点击外部收起；关闭时清理临时 marker 锚点。
-->
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useAnchoredPopup } from '../../ui/anchored-popup'
import AppButton from '../../ui/AppButton.vue'

const emit = defineEmits<{
  openBrowser: [url: string]
  openDefault: [url: string]
  copyLink: [url: string]
  openChange: [open: boolean]
}>()

const MENU_WIDTH = 260

const targetUrl = ref('')
let anchor: HTMLElement | null = null
let pointAnchor: HTMLElement | null = null

const firstButton = ref<InstanceType<typeof AppButton> | null>(null)

const menu = useAnchoredPopup({
  width: MENU_WIDTH,
  align: 'start',
  onClose: () => {
    anchor = null
    pointAnchor?.remove()
    pointAnchor = null
    emit('openChange', false)
  }
})

const { trigger: menuTrigger, popup: menuPopup, isOpen: menuOpen, position: menuPosition, open: openPopup, close: closePopup } = menu

const menuStyle = computed(() => {
  const position = menuPosition.value
  return {
    left: `${position.left}px`,
    top: `${position.top}px`,
    width: `${position.width}px`,
    maxHeight: `${position.maxHeight}px`
  }
})

function openMenu(element: HTMLElement): void {
  anchor = element
  menuTrigger.value = element
  openPopup()
  emit('openChange', true)
  void nextTick(() => {
    firstButton.value?.$el?.focus()
  })
}

function closeMenu(): void {
  closePopup()
}

/**
 * 在鼠标点击坐标处弹出气泡：生成 1px 临时透明 marker，并自适应视口收边与翻转。
 */
function openAtPoint(x: number, y: number, url: string): void {
  closePopup()
  targetUrl.value = url
  const marker = document.createElement('div')
  marker.style.position = 'fixed'
  marker.style.left = `${x}px`
  marker.style.top = `${y}px`
  marker.style.width = '1px'
  marker.style.height = '1px'
  marker.style.pointerEvents = 'none'
  document.body.appendChild(marker)
  pointAnchor = marker
  openMenu(marker)
}

function onOpenBrowser(): void {
  const url = targetUrl.value
  closeMenu()
  emit('openBrowser', url)
}

function onOpenDefault(): void {
  const url = targetUrl.value
  closeMenu()
  emit('openDefault', url)
}

function onCopyLink(): void {
  const url = targetUrl.value
  closeMenu()
  emit('copyLink', url)
}

defineExpose({
  openAtPoint,
  close: closeMenu
})
</script>

<template>
  <Teleport to="body">
    <Transition name="sidebar-menu">
      <div
        v-if="menuOpen"
        ref="menuPopup"
        class="project-sidebar-menu flex flex-col"
        :style="menuStyle"
        role="dialog"
        aria-label="终端链接操作"
        tabindex="-1"
        @keydown.esc.prevent.stop="closeMenu"
      >
        <div class="sidebar-menu-details">
          <p class="sidebar-menu-title font-mono text-[11px] truncate" :title="targetUrl">
            {{ targetUrl }}
          </p>
        </div>

        <AppButton
          ref="firstButton"
          variant="unstyled"
          class="project-sidebar-menu-item"
          @click="onOpenBrowser"
        >
          在内置浏览器打开
        </AppButton>
        <AppButton
          variant="unstyled"
          class="project-sidebar-menu-item"
          @click="onOpenDefault"
        >
          在默认浏览器打开
        </AppButton>
        <AppButton
          variant="unstyled"
          class="project-sidebar-menu-item"
          @click="onCopyLink"
        >
          复制链接
        </AppButton>
      </div>
    </Transition>
  </Teleport>
</template>
