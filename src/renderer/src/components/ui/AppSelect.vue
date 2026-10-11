<!-- 公共分组选择器：提供可搜索的自绘选项面板；选项与选中值由调用方控制。 -->
<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useAnchoredPopup } from '../../anchored-popup'

defineOptions({ inheritAttrs: false })

interface SelectOption {
  readonly value: string
  readonly label: string
  /** 选项首字母徽标；缺失时不渲染。 */
  readonly badge?: string
  /** 次行元信息，如上下文长度；缺失时不渲染。 */
  readonly description?: string
  /** 右侧能力小徽标，如图片输入；缺失时不渲染。 */
  readonly tag?: string
}

interface SelectGroup {
  readonly label?: string
  readonly options: readonly SelectOption[]
}

const props = withDefaults(defineProps<{
  readonly id: string
  readonly label: string
  readonly groups: readonly SelectGroup[]
  readonly modelValue: string
  readonly disabled?: boolean
  readonly searchable?: boolean
  readonly searchPlaceholder?: string
  readonly emptyLabel?: string
  readonly emptyResultsLabel?: string
  /** 触发键里模型名前的 provider 小字；缺失时不渲染，用于分层展示。 */
  readonly selectedMeta?: string
  /** 触发键首字母徽标；缺失时不渲染。 */
  readonly selectedBadge?: string
}>(), {
  disabled: false,
  searchable: false,
  searchPlaceholder: '搜索…',
  emptyLabel: '请选择',
  emptyResultsLabel: '没有匹配项'
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const instanceId = useId()
const popupId = `app-select-list-${instanceId}`
// 展开状态与浮层几何由 composable 持有；这里按模板与逻辑里的既有名字接出来。
// 浮层最小宽度 320px：模型名较长时选项不换行截断，仍受视窗约束。
const anchoredPopup = useAnchoredPopup({ minWidth: 320 })
const { trigger, popup, isOpen: expanded, position: popupPosition } = anchoredPopup
const searchQuery = ref('')
const activeIndex = ref(0)
const searchInput = ref<HTMLInputElement | null>(null)
const listbox = ref<HTMLElement | null>(null)
const optionElements = new Map<string, HTMLElement>()

const filteredGroups = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase()
  return props.groups
    .map((group) => {
      const groupMatches = group.label?.toLocaleLowerCase().includes(query) ?? false
      const options = query === '' || groupMatches
        ? group.options
        : group.options.filter((option) => (
          option.label.toLocaleLowerCase().includes(query)
          || option.value.toLocaleLowerCase().includes(query)
        ))
      return { ...group, options }
    })
    .filter((group) => group.options.length > 0)
})
const visibleOptions = computed(() => filteredGroups.value.flatMap((group) => group.options))
const visibleOptionIndexes = computed(() => new Map(
  visibleOptions.value.map((option, index) => [option.value, index])
))
const selectedOption = computed(() => props.groups
  .flatMap((group) => group.options)
  .find((option) => option.value === props.modelValue))
const selectedLabel = computed(() => selectedOption.value?.label ?? props.emptyLabel)
const activeOptionId = computed(() => (
  activeIndex.value >= 0 && activeIndex.value < visibleOptions.value.length
    ? optionId(activeIndex.value)
    : undefined
))
const popupStyle = computed(() => ({
  left: `${popupPosition.value.left}px`,
  top: `${popupPosition.value.top}px`,
  width: `${popupPosition.value.width}px`,
  maxHeight: `${popupPosition.value.maxHeight}px`
}))

function optionId(index: number): string {
  return `${popupId}-option-${index}`
}

function setOptionElement(value: string, element: unknown): void {
  if (element instanceof HTMLElement) optionElements.set(value, element)
  else optionElements.delete(value)
}

function resetActiveIndex(): void {
  const selectedIndex = visibleOptions.value.findIndex((option) => option.value === props.modelValue)
  activeIndex.value = selectedIndex >= 0 ? selectedIndex : (visibleOptions.value.length > 0 ? 0 : -1)
}

function scrollActiveOptionIntoView(): void {
  const option = visibleOptions.value[activeIndex.value]
  if (option !== undefined) optionElements.get(option.value)?.scrollIntoView({ block: 'nearest' })
}

watch(searchQuery, () => {
  resetActiveIndex()
  void nextTick(scrollActiveOptionIntoView)
})
watch(() => props.groups, resetActiveIndex)
watch(() => props.modelValue, resetActiveIndex)
watch(() => props.disabled, (disabled) => {
  if (disabled) closePopup()
})

function openPopup(): void {
  if (props.disabled || expanded.value) return
  searchQuery.value = ''
  resetActiveIndex()
  anchoredPopup.open()
  void nextTick(() => {
    if (props.searchable) {
      searchInput.value?.focus()
      scrollActiveOptionIntoView()
    } else if (activeIndex.value >= 0) focusActiveOption()
    else listbox.value?.focus()
  })
}

/** 收起浮层；需要时把焦点还给触发键。几何与监听都由 composable 负责。 */
function closePopup(restoreFocus = false): void {
  const wasOpen = anchoredPopup.close()
  if (restoreFocus && wasOpen) void nextTick(() => trigger.value?.focus())
}

function togglePopup(): void {
  if (expanded.value) closePopup()
  else openPopup()
}

function focusActiveOption(): void {
  const option = visibleOptions.value[activeIndex.value]
  if (option !== undefined) optionElements.get(option.value)?.focus()
}

function moveActive(direction: -1 | 1): void {
  const count = visibleOptions.value.length
  if (count === 0) {
    activeIndex.value = -1
    return
  }
  const start = activeIndex.value < 0 ? (direction === 1 ? -1 : 0) : activeIndex.value
  activeIndex.value = (start + direction + count) % count
  if (props.searchable) void nextTick(scrollActiveOptionIntoView)
  else void nextTick(focusActiveOption)
}

function moveToBoundary(boundary: 'first' | 'last'): void {
  const count = visibleOptions.value.length
  if (count === 0) return
  activeIndex.value = boundary === 'first' ? 0 : count - 1
  if (props.searchable) void nextTick(scrollActiveOptionIntoView)
  else void nextTick(focusActiveOption)
}

function chooseActiveOption(): void {
  const option = visibleOptions.value[activeIndex.value]
  if (option !== undefined) chooseOption(option)
}

function chooseOption(option: SelectOption): void {
  if (option.value !== props.modelValue) emit('update:modelValue', option.value)
  closePopup(true)
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!expanded.value) openPopup()
    else moveActive(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if ((event.key === 'Enter' || event.key === ' ') && expanded.value) {
    event.preventDefault()
    chooseActiveOption()
    return
  }
  if (event.key === 'Escape' && expanded.value) {
    event.preventDefault()
    event.stopPropagation()
    closePopup(true)
  }
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    chooseActiveOption()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closePopup(true)
  }
  if (event.key === 'Tab') {
    closePopup()
    trigger.value?.focus()
  }
}

function onListboxKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    moveToBoundary(event.key === 'Home' ? 'first' : 'last')
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    chooseActiveOption()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closePopup(true)
  }
  if (event.key === 'Tab') {
    closePopup()
    trigger.value?.focus()
  }
}
</script>

<template>
  <button
    v-bind="$attrs"
    :id="props.id"
    ref="trigger"
    type="button"
    class="text-control app-select-trigger"
    :disabled="props.disabled"
    aria-haspopup="listbox"
    :aria-expanded="expanded"
    :aria-controls="popupId"
    @click="togglePopup"
    @keydown="onTriggerKeydown"
  >
    <span class="app-select-value">
      <span
        v-if="props.selectedBadge"
        class="app-select-badge"
        aria-hidden="true"
      >{{ props.selectedBadge }}</span>
      <span v-if="props.selectedMeta" class="app-select-meta">{{ props.selectedMeta }}</span>
      <span class="app-select-name">{{ selectedLabel }}</span>
    </span>
    <svg
      class="app-select-chevron"
      :class="{ 'is-expanded': expanded }"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  <Teleport to="body">
    <div
      v-if="expanded"
      ref="popup"
      class="app-select-popup"
      :style="popupStyle"
      data-app-select-popup
    >
      <input
        v-if="props.searchable"
        ref="searchInput"
        v-model="searchQuery"
        type="search"
        class="app-select-search"
        :placeholder="props.searchPlaceholder"
        :aria-label="`${props.label}搜索`"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded="true"
        :aria-controls="popupId"
        :aria-activedescendant="activeOptionId"
        @keydown="onSearchKeydown"
      >
      <div
        :id="popupId"
        ref="listbox"
        class="app-select-listbox"
        role="listbox"
        :aria-label="`${props.label}选项`"
        :tabindex="props.searchable ? undefined : -1"
        @keydown="onListboxKeydown"
      >
        <div
          v-for="(group, groupIndex) in filteredGroups"
          :key="`${group.label ?? ''}-${groupIndex}`"
          role="group"
          :aria-label="group.label"
        >
          <p v-if="group.label" class="app-select-group-label" aria-hidden="true">{{ group.label }}</p>
          <div
            v-for="option in group.options"
            :id="optionId(visibleOptionIndexes.get(option.value) ?? -1)"
            :key="option.value"
            :ref="(element) => setOptionElement(option.value, element)"
            class="app-select-option"
            :class="{
              'is-active': visibleOptionIndexes.get(option.value) === activeIndex,
              'is-selected': props.modelValue === option.value
            }"
            role="option"
            :aria-selected="props.modelValue === option.value"
            tabindex="-1"
            @mousedown.prevent
            @click="chooseOption(option)"
          >
            <span v-if="option.badge" class="app-select-badge" aria-hidden="true">{{ option.badge }}</span>
            <span class="app-select-option-main">
              <span class="app-select-option-label">{{ option.label }}</span>
              <span v-if="option.description" class="app-select-option-desc">{{ option.description }}</span>
            </span>
            <span v-if="option.tag" class="app-select-option-tag" aria-hidden="true">{{ option.tag }}</span>
            <svg class="app-select-check" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2 6.5L4.8 9L10 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
        </div>
        <div
          v-if="visibleOptions.length === 0"
          class="app-select-empty"
          role="option"
          aria-selected="false"
          aria-disabled="true"
          tabindex="-1"
        >
          {{ props.emptyResultsLabel }}
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.app-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  text-align: left;
  cursor: pointer;
}

.app-select-trigger:disabled {
  cursor: not-allowed;
}

.app-select-value {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  overflow: hidden;
}

/* provider 小字与模型名分层；模型名用等宽字体，与路径、代码的呈现一致。 */
.app-select-meta {
  flex: none;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}

.app-select-meta::after {
  content: "/";
  margin-left: 0.35rem;
  color: var(--color-desk-line-strong);
}

.app-select-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 0.71875rem;
}

.app-select-badge {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 1.125rem;
  height: 1.125rem;
  border-radius: 5px;
  background: var(--color-desk-accent-soft);
  color: var(--color-desk-accent);
  font-size: 0.625rem;
  font-weight: 700;
}

.app-select-chevron {
  flex: none;
  transition: transform var(--motion-duration-fast) var(--motion-ease-entrance);
}

.app-select-chevron.is-expanded {
  transform: rotate(180deg);
}

.app-select-popup {
  position: fixed;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--color-desk-line-strong);
  border-radius: var(--radius-desk-md);
  background: var(--color-desk-surface);
  box-shadow: var(--shadow-desk-pop);
  color: var(--color-desk-ink);
  transform-origin: top;
  animation: app-select-popup-in var(--motion-duration-base) var(--motion-ease-entrance) both;
}

@keyframes app-select-popup-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.app-select-search {
  display: block;
  width: 100%;
  flex: none;
  border: 0;
  border-bottom: 1px solid var(--color-desk-line);
  border-radius: 0;
  background: var(--color-desk-surface);
  padding: 0.65rem 0.75rem;
  color: var(--color-desk-ink);
  font: inherit;
  outline-offset: -2px;
}

.app-select-search::placeholder {
  color: var(--color-desk-muted);
}

.app-select-listbox {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0.25rem;
}

.app-select-group-label {
  position: sticky;
  top: -0.25rem;
  z-index: 1;
  margin: 0;
  background: var(--color-desk-surface);
  padding: 0.45rem 0.65rem 0.25rem;
  color: var(--color-desk-muted);
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.app-select-option {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  border-radius: var(--radius-desk-sm);
  padding: 0.4rem 0.65rem 0.4rem 0.65rem;
  color: var(--color-desk-ink);
  cursor: pointer;
  font-size: 0.875rem;
  line-height: 1.4;
  transition: background var(--motion-duration-fast) ease;
}

.app-select-option-main {
  flex: 1;
  min-width: 0;
}

.app-select-option-label {
  display: block;
  font-family: var(--font-mono);
  font-size: 0.78125rem;
  overflow-wrap: anywhere;
}

.app-select-option-desc {
  display: block;
  margin-top: 0.1rem;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}

.app-select-option-tag {
  flex: none;
  border: 1px solid var(--color-desk-line);
  border-radius: 4px;
  padding: 0 0.3rem;
  color: var(--color-desk-muted);
  font-size: 0.625rem;
  line-height: 1.6;
}

.app-select-check {
  flex: none;
  display: none;
  color: var(--color-desk-accent);
}

.app-select-option:hover,
.app-select-option.is-active {
  background: var(--color-desk-surface-subtle);
}

.app-select-option.is-selected {
  background: var(--color-desk-accent-soft);
  color: var(--color-desk-accent);
}

.app-select-option.is-selected .app-select-option-label {
  font-weight: 600;
}

.app-select-option.is-selected .app-select-check {
  display: inline-flex;
}

.app-select-option.is-selected.is-active,
.app-select-option.is-selected:hover {
  background: var(--color-desk-accent-soft);
}

.app-select-empty {
  margin: 0;
  padding: 0.75rem;
  color: var(--color-desk-muted);
  font-size: 0.8rem;
}

@media (prefers-reduced-motion: reduce) {
  .app-select-chevron {
    transition: none;
  }

  .app-select-popup {
    animation: none;
  }
}
</style>
