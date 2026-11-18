<!-- 记忆设置页的语气风格块：列出名称、场景、句数与日期，点行打开只读查看弹窗，「编辑」再进编辑对话框。
     数据由页面统一读取后经 records 传入；保存后由页面重读并回报一行反馈，本块只负责列表与两个弹窗。 -->
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { MemoryStyleReadRecord } from '../../../../shared/memory-api'
import MemoryAssetDetailDialog from './MemoryAssetDetailDialog.vue'
import MemoryStyleEditorDialog from './MemoryStyleEditorDialog.vue'

const props = defineProps<{ readonly records: readonly MemoryStyleReadRecord[] }>()
const emit = defineEmits<{ saved: [message: string] }>()

const viewing = ref<MemoryStyleReadRecord | null>(null)
const editing = ref<MemoryStyleReadRecord | null>(null)
const editorOpen = ref(false)
const listRef = ref<HTMLElement | null>(null)

/** 原句总数：与画像的条数口径分开统计，避免把「句」和「条」混成一个数。 */
const sampleCount = computed(() => props.records.reduce((sum, record) => sum + record.samples.length, 0))

/** 已有名称用于改名校验：换成另一条已有名称会把两条合并，因此先在前端挡下来。 */
const takenNames = computed(() => props.records.map(record => record.name))

function excerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 行内元信息：场景、原句数、日期；空字段不占分隔符。 */
function metaText(record: MemoryStyleReadRecord): string {
  return [record.scene, `${record.samples.length} 句`, record.date]
    .filter(part => part !== '')
    .join(' · ')
}

function startEditing(): void {
  editing.value = viewing.value
  viewing.value = null
  editorOpen.value = editing.value !== null
}

/** 保存后由页面重读列表再把焦点交给它：改名或覆盖后原来的行不再存在于文档里。 */
async function onSaved(): Promise<void> {
  editorOpen.value = false
  emit('saved', '风格已保存。')
  await nextTick()
  listRef.value?.focus()
}
</script>

<template>
  <div class="memory-asset-block">
    <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 class="text-sm font-semibold">语气风格</h3>
      <span class="text-2xs tabular-nums text-desk-muted">{{ records.length }} 条 · {{ sampleCount }} 句</span>
    </div>

    <p v-if="records.length === 0" class="memory-asset-empty">
      还没有风格；在会话里由你明确要求提炼表达风格时才会生成。
    </p>
    <ul v-else ref="listRef" tabindex="-1" class="memory-asset-rows outline-none">
      <li v-for="record in records" :key="record.id">
        <button type="button" class="memory-asset-row" aria-haspopup="dialog" @click="viewing = record">
          <span class="memory-asset-row-head">
            <span class="memory-asset-row-title">{{ record.name }}</span>
            <span class="memory-asset-row-meta">{{ metaText(record) }}</span>
          </span>
          <span class="memory-asset-row-hint">{{ excerpt(record.points) }}</span>
        </button>
      </li>
    </ul>

    <MemoryAssetDetailDialog
      :open="viewing !== null"
      kind="style"
      :profile="null"
      :style-record="viewing"
      @cancel="viewing = null"
      @edit="startEditing"
    />

    <MemoryStyleEditorDialog
      :open="editorOpen"
      :style-record="editing"
      :taken-names="takenNames"
      @cancel="editorOpen = false"
      @saved="onSaved"
    />
  </div>
</template>
