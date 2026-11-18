<!-- 记忆设置页的个人画像块：按领域筛选后列出画像，点行打开只读查看弹窗，弹窗内再进编辑。
     数据由页面统一读取后经 records 传入；保存后由页面重读并回报一行反馈，本块只负责筛选、列表与两个弹窗。 -->
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { MEMORY_PROFILE_DOMAINS } from '../../../../shared/memory-api'
import type { MemoryProfileReadRecord } from '../../../../shared/memory-api'
import { MEMORY_BASIS_LABELS, MEMORY_DOMAIN_LABELS, memoryScopeLabel } from '../labels'
import AppButton from '../../ui/AppButton.vue'
import MemoryAssetDetailDialog from './MemoryAssetDetailDialog.vue'
import MemoryProfileEditorDialog from './MemoryProfileEditorDialog.vue'

const props = defineProps<{ readonly records: readonly MemoryProfileReadRecord[] }>()
const emit = defineEmits<{ saved: [message: string] }>()

/** 领域筛选：`'all'` 不过滤；chip 只列库里真实有画像的领域，空领域不占位。 */
const selection = ref<string>('all')
const viewing = ref<MemoryProfileReadRecord | null>(null)
const editing = ref<MemoryProfileReadRecord | null>(null)
const editorOpen = ref(false)
const listRef = ref<HTMLElement | null>(null)

const chips = computed(() => {
  const all = { domain: 'all', label: '全部', count: props.records.length }
  const domains = MEMORY_PROFILE_DOMAINS
    .map(domain => ({ domain, count: props.records.filter(record => record.domain === domain).length }))
    .filter(item => item.count > 0)
    .map(item => ({ domain: item.domain, label: MEMORY_DOMAIN_LABELS[item.domain] ?? item.domain, count: item.count }))
  return [all, ...domains]
})

/** 覆盖到的领域数：与 chips 同源，避免两处各算一遍。 */
const coveredDomains = computed(() => chips.value.length - 1)

/** 重读后选中的领域可能已经没有画像：这时按「全部」呈现，不留一个筛出空列表的选中项。 */
const activeDomain = computed(
  () => chips.value.some(chip => chip.domain === selection.value) ? selection.value : 'all'
)

const visible = computed(() => activeDomain.value === 'all'
  ? props.records
  : props.records.filter(record => record.domain === activeDomain.value))

/** 摘要压成单行：换行与连续空白折叠，行高不随正文格式跳动。 */
function excerpt(content: string): string {
  return content.replace(/\s+/g, ' ').trim()
}

/** 行内元信息：按领域筛选时不再重复领域名，其余属性始终显示。 */
function metaText(record: MemoryProfileReadRecord): string {
  const parts: string[] = []
  if (activeDomain.value === 'all') parts.push(MEMORY_DOMAIN_LABELS[record.domain] ?? record.domain)
  parts.push(memoryScopeLabel(record.scope), MEMORY_BASIS_LABELS[record.basis] ?? record.basis)
  if (record.source_record_ids.length > 0) parts.push(`来源 ${record.source_record_ids.length} 条`)
  return parts.join(' · ')
}

/** 查看弹窗里点「编辑」：先关查看再开编辑，记录本身就带领域与来源，不需再查一次。 */
function startEditing(): void {
  editing.value = viewing.value
  viewing.value = null
  editorOpen.value = editing.value !== null
}

/** 保存后由页面重读列表再把焦点交给它：旧条目已被替换，原来的行不再存在于文档里。 */
async function onSaved(result: { readonly droppedSources: number }): Promise<void> {
  editorOpen.value = false
  emit('saved', result.droppedSources > 0
    ? `画像已保存；${result.droppedSources} 条来源记录已不存在，已按剩余来源保存。`
    : '画像已保存，同领域的旧版本已被替换。')
  await nextTick()
  listRef.value?.focus()
}
</script>

<template>
  <div class="memory-asset-block">
    <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 class="text-sm font-semibold">个人画像</h3>
      <span class="text-2xs tabular-nums text-desk-muted">
        {{ records.length }} 条 · 覆盖 {{ coveredDomains }}/{{ MEMORY_PROFILE_DOMAINS.length }} 领域
      </span>
    </div>

    <div v-if="records.length > 0" class="memory-asset-chips" role="group" aria-label="按领域筛选画像">
      <AppButton
        v-for="chip in chips"
        :key="chip.domain"
        variant="unstyled"
        class="memory-asset-chip"
        :class="activeDomain === chip.domain ? 'is-selected' : ''"
        :aria-pressed="activeDomain === chip.domain"
        @click="selection = chip.domain"
      >
        {{ chip.label }}<span class="memory-asset-chip-count">{{ chip.count }}</span>
      </AppButton>
    </div>

    <p v-if="records.length === 0" class="memory-asset-empty">
      还没有画像；偏好只在会话里明确要求维护时生成。
    </p>
    <div v-else ref="listRef" tabindex="-1" class="outline-none">
      <p v-if="visible.length === 0" class="memory-asset-empty">该领域还没有画像。</p>
      <ul v-else class="memory-asset-rows">
        <li v-for="record in visible" :key="record.id">
          <button type="button" class="memory-asset-row" aria-haspopup="dialog" @click="viewing = record">
            <span class="memory-asset-row-head">
              <span class="memory-asset-row-title">
                {{ record.title !== '' ? record.title : memoryScopeLabel(record.scope) }}
              </span>
              <span class="memory-asset-row-meta">{{ metaText(record) }}</span>
            </span>
            <span class="memory-asset-row-hint">{{ excerpt(record.content) }}</span>
          </button>
        </li>
      </ul>
    </div>

    <MemoryAssetDetailDialog
      :open="viewing !== null"
      kind="profile"
      :profile="viewing"
      :style-record="null"
      @cancel="viewing = null"
      @edit="startEditing"
    />

    <MemoryProfileEditorDialog
      :open="editorOpen"
      :profile="editing"
      @cancel="editorOpen = false"
      @saved="onSaved"
    />
  </div>
</template>
