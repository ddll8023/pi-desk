<!--
  内置浏览器工具栏：导航、地址输入、截图标注、元素选择／取消、开发者工具与系统浏览器入口。

  地址栏输入由父级状态管理；回车触发导航，Esc 还原当前已加载网址，空白新建时自动聚焦。
-->
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly tabKey: string
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly loading: boolean
  readonly url: string
  readonly inputUrl: string
  readonly active: boolean
  readonly hasAnnotation: boolean
  readonly pickingElement: boolean
}>()

const emit = defineEmits<{
  back: []
  forward: []
  reload: []
  stop: []
  navigate: [url: string]
  openDevTools: []
  openExternal: []
  inputChange: [value: string]
  annotate: []
  pickElement: []
}>()

const inputRef = ref<HTMLInputElement | null>(null)

/** 用户按回车提交导航请求。 */
function onSubmit(): void {
  emit('navigate', props.inputUrl)
}

/** 用户按 Esc 取消当前编辑，还原为当前实际地址。 */
function onCancel(): void {
  emit('inputChange', props.url === 'about:blank' ? '' : props.url)
}

function onInput(event: Event): void {
  const target = event.target as HTMLInputElement
  emit('inputChange', target.value)
}

/** 聚焦地址输入框；可在新建空白页或切回标签时调用。 */
function focusInput(): void {
  inputRef.value?.focus()
  inputRef.value?.select()
}

/** 监听活动状态：切到活动标签且当前为空白页时，自动聚焦输入框。 */
watch(() => [props.active, props.url], async ([active, url]) => {
  if (active && (!url || url === 'about:blank')) {
    await nextTick()
    focusInput()
  }
}, { immediate: true })

defineExpose({
  focusInput
})
</script>

<template>
  <div class="browser-toolbar flex items-center gap-1.5 px-3 py-2 border-b border-[var(--color-desk-border)] bg-[var(--color-desk-surface)]">
    <!-- 后退按钮 -->
    <AppButton
      variant="unstyled"
      class="browser-toolbar-btn p-1.5 rounded-md text-[var(--color-desk-ink-muted)] hover:text-[var(--color-desk-ink)] hover:bg-[var(--color-desk-panel)] disabled:opacity-30 disabled:pointer-events-none transition-colors"
      :disabled="!props.canGoBack"
      aria-label="后退"
      title="后退"
      @click="emit('back')"
    >
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m15 18-6-6 6-6" />
      </svg>
    </AppButton>

    <!-- 前进按钮 -->
    <AppButton
      variant="unstyled"
      class="browser-toolbar-btn p-1.5 rounded-md text-[var(--color-desk-ink-muted)] hover:text-[var(--color-desk-ink)] hover:bg-[var(--color-desk-panel)] disabled:opacity-30 disabled:pointer-events-none transition-colors"
      :disabled="!props.canGoForward"
      aria-label="前进"
      title="前进"
      @click="emit('forward')"
    >
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </AppButton>

    <!-- 刷新 / 停止按钮 -->
    <AppButton
      variant="unstyled"
      class="browser-toolbar-btn p-1.5 rounded-md text-[var(--color-desk-ink-muted)] hover:text-[var(--color-desk-ink)] hover:bg-[var(--color-desk-panel)] transition-colors"
      :aria-label="props.loading ? '停止加载' : '刷新'"
      :title="props.loading ? '停止加载' : '刷新'"
      @click="props.loading ? emit('stop') : emit('reload')"
    >
      <!-- 加载中显示 ✕ -->
      <svg v-if="props.loading" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
      <!-- 空闲态显示 ↻ -->
      <svg v-else class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
        <path d="M16 16h5v5" />
      </svg>
    </AppButton>

    <!-- 地址栏输入框 -->
    <div class="flex-1 flex items-center min-w-0 bg-[var(--color-desk-panel)] border border-[var(--color-desk-border)] rounded-md px-2.5 py-1 focus-within:border-[var(--color-desk-accent)] transition-colors">
      <svg class="w-3.5 h-3.5 text-[var(--color-desk-ink-muted)] mr-1.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
        <path d="M2 12h20" />
      </svg>
      <input
        ref="inputRef"
        type="text"
        class="flex-1 min-w-0 bg-transparent text-xs text-[var(--color-desk-ink)] placeholder-[var(--color-desk-ink-muted)] outline-none"
        placeholder="输入网址（如 localhost:5173）并按回车访问…"
        :value="props.inputUrl"
        @input="onInput"
        @keydown.enter.prevent="onSubmit"
        @keydown.esc.prevent="onCancel"
      />
    </div>

    <AppButton variant="unstyled" class="browser-toolbar-btn p-1.5 rounded-md text-xs text-[var(--color-desk-ink-muted)] hover:bg-[var(--color-desk-panel)] disabled:opacity-30" :disabled="(!props.url || props.url === 'about:blank' || props.loading) && !props.hasAnnotation" aria-label="标注网页" title="标注网页" @click="emit('annotate')">标注</AppButton>

    <AppButton variant="unstyled" class="browser-toolbar-btn p-1.5 rounded-md text-xs text-[var(--color-desk-ink-muted)] hover:bg-[var(--color-desk-panel)] disabled:opacity-30" :disabled="!props.pickingElement && (!props.url || props.url === 'about:blank' || props.loading)" :aria-label="props.pickingElement ? '取消元素选择' : '选择网页元素'" @click="emit('pickElement')">{{ props.pickingElement ? '取消选择' : '选择元素' }}</AppButton>

    <!-- 打开 Chromium 开发者工具 -->
    <AppButton
      variant="unstyled"
      class="browser-toolbar-btn p-1.5 rounded-md text-[var(--color-desk-ink-muted)] hover:text-[var(--color-desk-ink)] hover:bg-[var(--color-desk-panel)] transition-colors"
      aria-label="打开开发者工具"
      title="打开开发者工具"
      @click="emit('openDevTools')"
    >
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m16 18 6-6-6-6" />
        <path d="m8 6-6 6 6 6" />
      </svg>
    </AppButton>

    <!-- 在系统默认浏览器中打开当前页面 -->
    <AppButton
      variant="unstyled"
      class="browser-toolbar-btn p-1.5 rounded-md text-[var(--color-desk-ink-muted)] hover:text-[var(--color-desk-ink)] hover:bg-[var(--color-desk-panel)] transition-colors"
      aria-label="在系统浏览器中打开"
      title="在系统浏览器中打开"
      :disabled="!props.url || props.url === 'about:blank'"
      @click="emit('openExternal')"
    >
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </AppButton>
  </div>
</template>
