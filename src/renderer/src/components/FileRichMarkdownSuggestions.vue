<!-- 光标锚定的斜杠与文档补全列表：输入仍在文档里，支持方向键、Enter 和 Escape。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, watch } from 'vue'
import { useAnchoredPopup } from '../anchored-popup'
import type { RichSuggestionItem } from '../file-rich-markdown-suggestions'
const props = defineProps<{ items: readonly RichSuggestionItem[]; active: number; left: number; top: number; menuId: string; loading: boolean; message: string }>()
const emit = defineEmits<{ choose: [item: RichSuggestionItem]; close: []; hover: [index: number] }>()
const { trigger, popup, position, open, update } = useAnchoredPopup({ width: 300, minHeight: 70, maxHeightCap: 430, onClose: () => emit('close') })
const style = computed(() => ({ left: `${position.value.left}px`, top: `${position.value.top}px`, width: `${position.value.width}px`, maxHeight: `${position.value.maxHeight}px` }))
watch(() => [props.left, props.top, props.items.length], () => void nextTick(update))
watch(() => props.active, () => void nextTick(() => popup.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })))
onMounted(() => open())
</script>
<template>
  <Teleport to="body">
    <span ref="trigger" class="file-rich-caret-anchor" :style="{ left: `${left}px`, top: `${top}px` }"></span>
    <div ref="popup" class="file-rich-suggestions scroll-area" :style="style" :id="menuId" role="listbox" aria-label="插入内容" @mousedown.prevent>
      <template v-for="(item, index) in items" :key="item.id">
        <p v-if="index === 0 || items[index - 1]?.group !== item.group" class="file-rich-menu-group">{{ item.group }}</p>
        <button type="button" role="option" :id="`${menuId}-${index}`" :aria-selected="active === index" :class="{ 'is-active': active === index }" @mouseenter="emit('hover', index)" @click="emit('choose', item)">
          <span class="file-rich-command-icon" aria-hidden="true">{{ item.icon }}</span><span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span>
        </button>
      </template>
      <p v-if="!items.length" class="file-rich-menu-empty" role="status">{{ loading ? '正在读取项目文档…' : '没有匹配项' }}</p>
      <p v-if="message" class="file-rich-menu-empty" role="status">{{ message }}</p>
      <footer>↑↓ 选择 · Enter 插入 · Esc 关闭</footer>
    </div>
  </Teleport>
</template>
