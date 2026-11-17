<!-- 记忆设置页的语气风格小节：列出全部风格与原句条数，点「编辑」打开对话框；保存后重读列表。
     本页只展示与编辑已有风格，不取样、不新建、不删除条目。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import type { MemoryStyleReadRecord } from '../../../../shared/memory-api'
import AppButton from '../../ui/AppButton.vue'
import { loadMemoryStyles } from '../services/memory'
import MemoryStyleEditorDialog from './MemoryStyleEditorDialog.vue'

const styles = ref<readonly MemoryStyleReadRecord[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const feedback = ref<string | null>(null)
const editing = ref<MemoryStyleReadRecord | null>(null)
const editorOpen = ref(false)
const listRef = ref<HTMLElement | null>(null)
/** 换代计数：连续刷新时，迟到的响应不能覆盖更新的列表。 */
let loadSequence = 0

/** 列表读取：失败保留真实原因，不用空列表冒充「没有风格」。 */
async function refresh(): Promise<void> {
  const sequence = ++loadSequence
  loading.value = true
  const result = await loadMemoryStyles()
  if (sequence !== loadSequence) return
  loading.value = false
  if (!result.ok) {
    error.value = result.error.message
    return
  }
  error.value = null
  styles.value = result.data.styles
}

/** 已有名称用于改名校验：换成另一条已有名称会把两条合并，因此先在前端挡下来。 */
const takenNames = computed(() => styles.value.map(style => style.name))

function excerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function openEditor(style: MemoryStyleReadRecord): void {
  editing.value = style
  editorOpen.value = true
}

/** 保存后重读列表再把焦点交给列表：改名或覆盖后原行的「编辑」按钮已不在文档里。 */
async function onSaved(): Promise<void> {
  editorOpen.value = false
  feedback.value = '风格已保存。'
  await refresh()
  await nextTick()
  listRef.value?.focus()
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <section class="settings-section" aria-labelledby="settings-memory-styles">
    <div class="settings-section-heading">
      <div>
        <h2 id="settings-memory-styles" class="settings-section-title">语气风格</h2>
        <p class="mt-1 max-w-prose text-xs leading-5 text-desk-muted">
          风格资产记录你通常怎么表达，要点与全部原句随每轮背景注入；改名保存会替换本条，保持名称则覆盖原内容。
        </p>
      </div>
      <AppButton variant="compact" :disabled="loading" @click="refresh">重新读取</AppButton>
    </div>

    <p v-if="loading" role="status" class="mt-3 text-xs text-desk-muted">读取风格…</p>
    <p v-else-if="error !== null" role="alert" class="status-notice status-notice-error mt-3">{{ error }}</p>
    <template v-else>
      <p v-if="styles.length === 0" class="mt-3 text-xs text-desk-muted">
        还没有风格；在会话里由你明确要求提炼表达风格时才会生成。
      </p>
      <ul v-else ref="listRef" tabindex="-1" class="memory-asset-list outline-none">
        <li v-for="style in styles" :key="style.id" class="memory-asset-row">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium">{{ style.name }}</span>
              <span v-if="style.scene !== ''" class="memory-asset-badge">{{ style.scene }}</span>
              <span class="memory-asset-badge">{{ style.samples.length }} 句</span>
              <span v-if="style.date !== ''" class="memory-asset-badge">{{ style.date }}</span>
            </div>
            <p class="memory-asset-excerpt">{{ excerpt(style.points) }}</p>
          </div>
          <AppButton variant="compact" @click="openEditor(style)">编辑</AppButton>
        </li>
      </ul>
    </template>

    <p v-if="feedback !== null" role="status" class="mt-3 text-2xs text-desk-muted">{{ feedback }}</p>

    <MemoryStyleEditorDialog
      :open="editorOpen"
      :style-record="editing"
      :taken-names="takenNames"
      @cancel="editorOpen = false"
      @saved="onSaved"
    />
  </section>
</template>
