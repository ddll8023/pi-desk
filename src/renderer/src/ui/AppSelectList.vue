<!-- 公共候选列表：搜索行、分组选项、选中高亮与键盘移动，供 AppSelect 浮层与输入坞二级面板共用。
     只管列表自身的渲染、过滤与交互，不持有展开状态、定位与触发器；收起与回焦由调用方决定，
     面板内嵌（embedded）时更不拦截 Tab 与 Escape，把这两次按键留给外层菜单。 -->
<script lang="ts">
/** 候选项的次级动作：不改变选中值，触发后由调用方执行自己的写入。 */
export interface SelectOptionAction {
  readonly label: string
  /** 键盘触发方式，用于按钮提示；缺失时不标快捷键。 */
  readonly shortcut?: string | undefined
}

/** 候选项。 */
export interface SelectOption {
  readonly value: string
  readonly label: string
  /* 以下四个可选字段允许显式传 undefined：调用方会在无值时直接传 undefined，
     在 exactOptionalPropertyTypes 下必须写进类型，否则不能赋给可选属性。 */
  /** 选项首字母徽标；缺失时不渲染。 */
  readonly badge?: string | undefined
  /** 次行元信息，如上下文长度；缺失时不渲染。 */
  readonly description?: string | undefined
  /** 右侧能力小徽标，如图片输入；缺失时不渲染。 */
  readonly tag?: string | undefined
  /** 右侧次级动作，如「设为默认」；缺失时不渲染。 */
  readonly action?: SelectOptionAction | undefined
}

/** 选项分组；无 label 的分组不渲染组标题。 */
export interface SelectGroup {
  readonly label?: string
  readonly options: readonly SelectOption[]
}
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue'

const props = withDefaults(defineProps<{
  /** listbox 元素 id：浮层模式下由触发键的 aria-controls 指向它。 */
  readonly id: string
  readonly label: string
  readonly groups: readonly SelectGroup[]
  readonly modelValue: string
  readonly searchable?: boolean
  readonly searchPlaceholder?: string
  readonly emptyResultsLabel?: string
  /** 首次渲染的落焦位置；面板内常驻的列表用 none，不把焦点从输入坞抢走。 */
  readonly autofocus?: 'search' | 'option' | 'listbox' | 'none'
  /** 面板内嵌：隐去首字母徽标、次级动作宽度自适应，且不拦截 Tab 与 Escape。 */
  readonly embedded?: boolean
  readonly disabled?: boolean
}>(), {
  searchable: false,
  searchPlaceholder: '搜索…',
  emptyResultsLabel: '没有匹配项',
  autofocus: 'none',
  embedded: false,
  disabled: false
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** 候选项次级动作被触发；动作不改选中值，结果由调用方处理。 */
  'option-action': [value: string]
  /** 请求外层收起；restoreFocus 表示收起后应把焦点还给触发键。 */
  dismiss: [restoreFocus: boolean]
}>()

const instanceId = useId()
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
const activeOptionId = computed(() => (
  activeIndex.value >= 0 && activeIndex.value < visibleOptions.value.length
    ? optionId(activeIndex.value)
    : undefined
))

function optionId(index: number): string {
  return `${props.id}-option-${index}`
}

function setOptionElement(value: string, element: unknown): void {
  if (element instanceof HTMLElement) optionElements.set(value, element)
  else optionElements.delete(value)
}

/** 面板内嵌时把描述与小标签并到一行：窄面板没有第二列放标签，行高也不会因折行变化。 */
function embeddedDescription(option: SelectOption): string | undefined {
  if (!props.embedded) return option.description
  const parts = [option.description, option.tag]
    .filter((part): part is string => part !== undefined && part !== '')
  return parts.length > 0 ? parts.join(' · ') : undefined
}

function resetActiveIndex(): void {
  const selectedIndex = visibleOptions.value.findIndex((option) => option.value === props.modelValue)
  activeIndex.value = selectedIndex >= 0 ? selectedIndex : (visibleOptions.value.length > 0 ? 0 : -1)
}

/** 把列表里高亮的那一条带进可视范围；高亮变化后调用，已可见时不会产生位移。 */
function scrollActiveOptionIntoView(): void {
  const option = visibleOptions.value[activeIndex.value]
  if (option !== undefined) optionElements.get(option.value)?.scrollIntoView({ block: 'nearest' })
}

function focusActiveOption(): void {
  const option = visibleOptions.value[activeIndex.value]
  if (option !== undefined) optionElements.get(option.value)?.focus()
}

/** 落焦策略由调用方按打开方式决定：搜索框、选中项或列表本身。 */
function focusInitial(): void {
  if (props.autofocus === 'none') return
  if (props.searchable && props.autofocus === 'search') {
    searchInput.value?.focus()
    void nextTick(scrollActiveOptionIntoView)
    return
  }
  if (props.autofocus === 'option' && activeIndex.value >= 0) focusActiveOption()
  else listbox.value?.focus()
}

function clearSearch(): void {
  searchQuery.value = ''
  searchInput.value?.focus()
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

function chooseOption(option: SelectOption): void {
  if (props.disabled) return
  if (option.value !== props.modelValue) emit('update:modelValue', option.value)
  if (!props.embedded) emit('dismiss', true)
}

function chooseActiveOption(): void {
  const option = visibleOptions.value[activeIndex.value]
  if (option !== undefined) chooseOption(option)
}

/** 触发候选项的次级动作：动作不改选中值，收起后由调用方处理结果。 */
function runOptionAction(option: SelectOption): void {
  if (props.disabled || option.action === undefined) return
  emit('option-action', option.value)
  if (!props.embedded) emit('dismiss', true)
}

/** 对当前高亮项执行次级动作；高亮项没有动作时不响应。 */
function runActiveOptionAction(): void {
  const option = visibleOptions.value[activeIndex.value]
  if (option !== undefined) runOptionAction(option)
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Enter' && event.altKey) {
    event.preventDefault()
    runActiveOptionAction()
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    chooseActiveOption()
    return
  }
  if (props.embedded) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('dismiss', true)
  }
  if (event.key === 'Tab') emit('dismiss', false)
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
  if (event.key === 'Enter' && event.altKey) {
    event.preventDefault()
    runActiveOptionAction()
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    chooseActiveOption()
    return
  }
  if (props.embedded) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('dismiss', true)
  }
  if (event.key === 'Tab') emit('dismiss', false)
}

watch(searchQuery, () => {
  resetActiveIndex()
  void nextTick(scrollActiveOptionIntoView)
})
watch(() => props.groups, resetActiveIndex)
watch(() => props.modelValue, resetActiveIndex)

// 浮层每次打开都会重建这棵子树，挂载即落焦；面板内嵌时 autofocus 为 none，不会抢走输入坞焦点。
onMounted(focusInitial)

defineExpose({ focusInitial, chooseActiveOption })
</script>

<template>
  <div class="app-select-list" :class="{ 'is-embedded': props.embedded }">
    <div v-if="props.searchable" class="app-select-search-row">
      <input
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
        :aria-controls="props.id"
        :aria-activedescendant="activeOptionId"
        @keydown="onSearchKeydown"
      >
      <!-- 原生清除按钮跟随平台配色且暗色主题下不受控，改用自绘按钮；Tab 仍按既有约定收起浮层，这里不参与键盘次序。 -->
      <button
        v-if="searchQuery !== ''"
        type="button"
        class="app-select-clear"
        tabindex="-1"
        :aria-label="`清空${props.label}搜索`"
        @mousedown.prevent
        @click="clearSearch"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
    </div>
    <div
      :id="props.id"
      ref="listbox"
      class="app-select-listbox"
      role="listbox"
      :aria-label="`${props.label}选项`"
      :aria-disabled="props.disabled"
      :tabindex="props.searchable ? undefined : -1"
      @keydown="onListboxKeydown"
    >
      <div
        v-for="(group, groupIndex) in filteredGroups"
        :key="`${group.label ?? ''}-${groupIndex}`"
        class="app-select-group"
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
          :aria-disabled="props.disabled"
          tabindex="-1"
          @mousedown.prevent
          @click="chooseOption(option)"
        >
          <span v-if="option.badge && !props.embedded" class="app-select-badge" aria-hidden="true">{{ option.badge }}</span>
          <span class="app-select-option-main">
            <span class="app-select-option-label">{{ option.label }}</span>
            <span v-if="embeddedDescription(option)" class="app-select-option-desc">{{ embeddedDescription(option) }}</span>
          </span>
          <span v-if="option.tag && !props.embedded" class="app-select-option-tag" aria-hidden="true">{{ option.tag }}</span>
          <button
            v-if="option.action"
            type="button"
            class="app-select-option-action"
            tabindex="-1"
            :aria-label="`${option.label}：${option.action.label}`"
            :title="option.action.shortcut === undefined ? option.action.label : `${option.action.label}（${option.action.shortcut}）`"
            @mousedown.prevent
            @click.stop="runOptionAction(option)"
          >{{ option.action.label }}</button>
          <svg v-if="!props.embedded" class="app-select-check" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
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
</template>

<style scoped>
/* 列表本体：浮层里占满剩余高度自己滚动；面板内嵌时同样按容器高度收缩，不撑开菜单。 */
.app-select-list {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

/* 搜索行：输入框占满剩余宽度，清除按钮固定在右端；分隔线画在行上。 */
.app-select-search-row {
  display: flex;
  flex: none;
  align-items: center;
  border-bottom: 1px solid var(--color-desk-line);
}

.app-select-search {
  display: block;
  flex: 1;
  min-width: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0.65rem 0.75rem;
  color: var(--color-desk-ink);
  font: inherit;
}

/* 焦点由浮层或面板的描边表达：输入框再画一圈会和外层描边叠成双框，且方角焦点环会被圆角裁切。 */
.app-select-search:focus-visible {
  outline: none;
}

/* 原生搜索清除按钮跟随平台配色、暗色主题下不受控；隐掉后由 .app-select-clear 替代。 */
.app-select-search::-webkit-search-cancel-button,
.app-select-search::-webkit-search-decoration {
  appearance: none;
  display: none;
}

.app-select-search::placeholder {
  color: var(--color-desk-muted);
}

.app-select-clear {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  margin-right: 0.5rem;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--color-desk-muted);
  cursor: pointer;
  transition: background var(--motion-duration-fast) ease, color var(--motion-duration-fast) ease;
}

.app-select-clear:hover {
  background: var(--color-desk-surface-subtle);
  color: var(--color-desk-ink);
}

.app-select-listbox {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0.25rem;
}

.app-select-group + .app-select-group {
  margin-top: 0.35rem;
  padding-top: 0.35rem;
  border-top: 1px solid var(--color-desk-line);
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

/* 面板内嵌：行固定两行，名称与描述各自单行省略，不因长名折成三行把行高撑开。 */
.app-select-list.is-embedded .app-select-option {
  padding: 0.35rem 0.45rem;
  gap: 0.35rem;
}
.app-select-list.is-embedded .app-select-option-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  overflow-wrap: normal;
}
.app-select-list.is-embedded .app-select-option-desc {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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

/* 能力标签有最小宽度并居中：选项行右端不会因标签长短左右移动。 */
.app-select-option-tag {
  flex: none;
  min-width: 2.25rem;
  border: 1px solid var(--color-desk-line);
  border-radius: 4px;
  padding: 0 0.3rem;
  color: var(--color-desk-muted);
  font-size: 0.625rem;
  line-height: 1.6;
  text-align: center;
}

/* 候选项次级动作：与选中勾共用固定宽度的一列，不改变行的选中态，只在调用方给出 action 时渲染。 */
.app-select-option-action {
  flex: none;
  width: 3.5rem;
  border: 0;
  border-radius: 4px;
  background: transparent;
  padding: 0.15rem 0;
  color: var(--color-desk-muted);
  cursor: pointer;
  font-size: var(--text-2xs);
  line-height: 1.45;
  text-align: center;
  transition: background var(--motion-duration-fast) ease, color var(--motion-duration-fast) ease;
}

/* 面板内嵌时次级动作浮在行右端，默认不可见也不接受点击：窄面板的常态只留给名称与描述，
   悬停、键盘高亮或已选中时才露出。自带底色盖住被它盖住的描述尾巴，不让两段文字叠在一起。 */
.app-select-list.is-embedded .app-select-option-action {
  position: absolute;
  top: 50%;
  right: 0.35rem;
  width: auto;
  padding: 0.15rem 0.3rem;
  transform: translateY(-50%);
  background: var(--color-desk-surface);
  box-shadow: -0.5rem 0 0 var(--color-desk-surface);
  opacity: 0;
  pointer-events: none;
}
.app-select-list.is-embedded .app-select-option:hover .app-select-option-action,
  .app-select-list.is-embedded .app-select-option.is-active .app-select-option-action,
  .app-select-list.is-embedded .app-select-option:focus-within .app-select-option-action {
    background: var(--color-desk-surface-subtle);
    box-shadow: -0.5rem 0 0 var(--color-desk-surface-subtle);
    opacity: 1;
    pointer-events: auto;
  }
/* 选中行自带强调底，动作块的盖板与显隐前底色都要跟着换色，否则会露出一块白。 */
.app-select-list.is-embedded .app-select-option.is-selected .app-select-option-action {
  background: var(--color-desk-accent-soft);
  box-shadow: -0.5rem 0 0 var(--color-desk-accent-soft);
  opacity: 1;
  pointer-events: auto;
}
/* 指针落在动作块上时回到强调色，与其它位置的次级动作反馈一致。 */
.app-select-list.is-embedded .app-select-option .app-select-option-action:hover {
  background: var(--color-desk-accent-soft);
  box-shadow: -0.5rem 0 0 var(--color-desk-accent-soft);
  color: var(--color-desk-accent);
}

.app-select-option-action:hover {
  background: var(--color-desk-accent-soft);
  color: var(--color-desk-accent);
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

/* 选中项只用浅强调底 + 强调色模型名 + 右端勾表达；再叠左侧竖条会在圆角行上切出方角，并与左端徽标争位置。 */
.app-select-option.is-selected {
  background: var(--color-desk-accent-soft);
  color: var(--color-desk-accent);
}

.app-select-option.is-selected .app-select-option-label {
  font-weight: 600;
  color: var(--color-desk-accent);
}

.app-select-option.is-selected .app-select-option-desc {
  color: color-mix(in srgb, var(--color-desk-accent) 70%, var(--color-desk-muted));
}

.app-select-option.is-selected .app-select-check {
  display: inline-flex;
}

.app-select-option.is-selected.is-active,
.app-select-option.is-selected:hover {
  background: var(--color-desk-accent-soft);
}

/* 不可选择（如模型锁定）时只压文字与光标，行的位置与选中态保持可见。 */
.app-select-listbox[aria-disabled="true"] .app-select-option {
  cursor: not-allowed;
  color: var(--color-desk-muted);
}

.app-select-empty {
  margin: 0;
  padding: 0.75rem;
  color: var(--color-desk-muted);
  font-size: 0.8rem;
}
</style>
