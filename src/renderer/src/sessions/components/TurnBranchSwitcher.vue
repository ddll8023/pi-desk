<!-- 回合分支切换器：在同一用户提问存在多个探索分支时呈现，支持无损横向切换历史方案。 -->
<script setup lang="ts">
const props = defineProps<{
  readonly currentIndex: number
  readonly total: number
}>()

const emit = defineEmits<{
  select: [index: number]
}>()

function handlePrev(): void {
  if (props.currentIndex > 0) {
    emit('select', props.currentIndex - 1)
  }
}

function handleNext(): void {
  if (props.currentIndex < props.total - 1) {
    emit('select', props.currentIndex + 1)
  }
}
</script>

<template>
  <div v-if="props.total > 1" class="turn-branch-switcher inline-flex items-center gap-1.5 px-2 py-0.5 my-1 rounded-full bg-neutral-800/80 border border-neutral-700/60 text-[11px] text-neutral-300 select-none">
    <button
      type="button"
      class="w-4 h-4 inline-flex items-center justify-center rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-neutral-400 transition-colors"
      :disabled="props.currentIndex <= 0"
      aria-label="前一个分支方案"
      @click="handlePrev"
    >
      ‹
    </button>
    <span class="font-mono text-neutral-400 text-[10px]">
      <strong class="text-neutral-200 font-semibold">{{ props.currentIndex + 1 }}</strong> / {{ props.total }}
    </span>
    <button
      type="button"
      class="w-4 h-4 inline-flex items-center justify-center rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-neutral-400 transition-colors"
      :disabled="props.currentIndex >= props.total - 1"
      aria-label="后一个分支方案"
      @click="handleNext"
    >
      ›
    </button>
  </div>
</template>
