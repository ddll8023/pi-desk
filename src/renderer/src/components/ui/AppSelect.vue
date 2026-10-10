<!-- 公共分组选择器：提供可搜索的自绘选项面板；选项与选中值由调用方控制。 -->
<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useAnchoredPopup } from '../../anchored-popup'

defineOptions({ inheritAttrs: false })

interface SelectOption {
  readonly value: string
  readonly label: string
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
const anchoredPopup = useAnchoredPopup({})
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
    <span class="app-select-value">{{ selectedLabel }}</span>
    <span class="app-select-chevron" :class="{ 'is-expanded': expanded }" aria-hidden="true"></span>
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
            {{ option.label }}
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-select-chevron {
  width: 0.45rem;
  height: 0.45rem;
  flex: none;
  transform: translateY(-0.12rem) rotate(45deg);
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  transition: transform 120ms ease;
}

.app-select-chevron.is-expanded {
  transform: translateY(0.12rem) rotate(225deg);
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
  padding: 0.4rem 0.65rem 0.25rem;
  color: var(--color-desk-muted);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.025em;
}

.app-select-option {
  position: relative;
  display: block;
  width: 100%;
  border-radius: var(--radius-desk-sm);
  padding: 0.45rem 0.65rem 0.45rem 0.8rem;
  color: var(--color-desk-ink);
  cursor: pointer;
  font-size: 0.875rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.app-select-option:hover,
.app-select-option.is-active {
  background: var(--color-desk-surface-subtle);
}

.app-select-option.is-selected {
  background: var(--color-desk-accent-soft);
  color: var(--color-desk-ink);
  box-shadow: inset 2px 0 0 var(--color-desk-accent);
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
}
</style>
