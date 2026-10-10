<!-- 通用按钮：统一语义按钮的视觉变体（含方形图标键），同时透传原生属性、事件与调用方样式。 -->
<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  readonly variant?: 'default' | 'primary' | 'danger' | 'compact' | 'ghost' | 'quiet-danger' | 'icon' | 'icon-primary' | 'unstyled'
}>(), {
  variant: 'default'
})

const variantClass = computed(() => {
  switch (props.variant) {
    case 'primary': return 'control-button-primary'
    case 'danger': return 'control-button-danger'
    case 'compact': return 'control-button-sm'
    case 'ghost': return 'control-button-ghost'
    case 'quiet-danger': return 'control-button-quiet-danger'
    case 'icon': return 'icon-button-square'
    case 'icon-primary': return 'icon-button-square-primary'
    case 'unstyled': return ''
    default: return 'control-button'
  }
})
</script>

<template>
  <button type="button" :class="variantClass"><slot /></button>
</template>
