<!-- 记忆设置页的个人画像小节：按领域列出全部画像，点「编辑」打开对话框；保存后重读列表。
     本页只展示与编辑已有画像，不新建、不删除，也不编辑提炼来源。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { MEMORY_PROFILE_DOMAINS } from '../../../../shared/memory-api'
import type { MemoryProfileReadRecord } from '../../../../shared/memory-api'
import { MEMORY_BASIS_LABELS, MEMORY_DOMAIN_LABELS } from '../labels'
import AppButton from '../../ui/AppButton.vue'
import { loadMemoryProfiles } from '../services/memory'
import MemoryProfileEditorDialog from './MemoryProfileEditorDialog.vue'

const profiles = ref<readonly MemoryProfileReadRecord[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const feedback = ref<string | null>(null)
const editing = ref<MemoryProfileReadRecord | null>(null)
const editorOpen = ref(false)
const listRef = ref<HTMLElement | null>(null)
/** 换代计数：连续刷新时，迟到的响应不能覆盖更新的列表。 */
let loadSequence = 0

/** 列表读取：失败保留上一次的真实原因，不用空列表冒充「没有画像」。 */
async function refresh(): Promise<void> {
  const sequence = ++loadSequence
  loading.value = true
  const result = await loadMemoryProfiles()
  if (sequence !== loadSequence) return
  loading.value = false
  if (!result.ok) {
    error.value = result.error.message
    return
  }
  error.value = null
  profiles.value = result.data.profiles
}

/** 固定按四个领域分组：领域顺序不随库里已有内容变化。 */
const groups = computed(() => MEMORY_PROFILE_DOMAINS.map(domain => ({
  domain,
  label: MEMORY_DOMAIN_LABELS[domain] ?? domain,
  items: profiles.value.filter(profile => profile.domain === domain)
})))

function scopeLabel(scope: string): string {
  return scope.startsWith('domain:') ? '本领域' : '全库'
}

/** 摘要压成单行：换行与连续空白折叠，避免行高随正文格式跳动。 */
function excerpt(content: string): string {
  return content.replace(/\s+/g, ' ').trim()
}

function openEditor(profile: MemoryProfileReadRecord): void {
  editing.value = profile
  editorOpen.value = true
}

/** 保存后重读列表再把焦点交给列表：旧条目已被替换，原来的「编辑」按钮不再存在于文档里。 */
async function onSaved(result: { readonly droppedSources: number }): Promise<void> {
  editorOpen.value = false
  feedback.value = result.droppedSources > 0
    ? `画像已保存；${result.droppedSources} 条来源记录已不存在，已按剩余来源保存。`
    : '画像已保存，同领域的旧版本已被替换。'
  await refresh()
  await nextTick()
  listRef.value?.focus()
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <section class="settings-section" aria-labelledby="settings-memory-profiles">
    <div class="settings-section-heading">
      <div>
        <h2 id="settings-memory-profiles" class="settings-section-title">个人画像</h2>
        <p class="mt-1 max-w-prose text-xs leading-5 text-desk-muted">
          画像记录稳定的长期偏好，按四个领域分别维护；保存后同领域的旧版本被新内容替换。
        </p>
      </div>
      <AppButton variant="compact" :disabled="loading" @click="refresh">重新读取</AppButton>
    </div>

    <p v-if="loading" role="status" class="mt-3 text-xs text-desk-muted">读取画像…</p>
    <p v-else-if="error !== null" role="alert" class="status-notice status-notice-error mt-3">{{ error }}</p>
    <template v-else>
      <p v-if="profiles.length === 0" class="mt-3 text-xs text-desk-muted">
        还没有画像；偏好只在会话里明确要求维护时生成。
      </p>
      <div v-else ref="listRef" tabindex="-1" class="outline-none">
        <div v-for="group in groups" :key="group.domain" class="mt-5">
          <h3 class="memory-asset-group">
            {{ group.label }}
            <span class="memory-asset-count">{{ group.items.length }}</span>
          </h3>
          <p v-if="group.items.length === 0" class="memory-asset-empty">该领域没有画像。</p>
          <ul v-else class="memory-asset-list">
            <li v-for="profile in group.items" :key="profile.id" class="memory-asset-row">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-sm font-medium">{{ profile.title !== '' ? profile.title : profile.scope }}</span>
                  <span class="memory-asset-badge">{{ scopeLabel(profile.scope) }}</span>
                  <span class="memory-asset-badge">{{ MEMORY_BASIS_LABELS[profile.basis] ?? profile.basis }}</span>
                  <span v-if="profile.source_record_ids.length > 0" class="memory-asset-badge">
                    来源 {{ profile.source_record_ids.length }} 条
                  </span>
                </div>
                <p class="memory-asset-excerpt">{{ excerpt(profile.content) }}</p>
              </div>
              <AppButton variant="compact" @click="openEditor(profile)">编辑</AppButton>
            </li>
          </ul>
        </div>
      </div>
    </template>

    <p v-if="feedback !== null" role="status" class="mt-3 text-2xs text-desk-muted">{{ feedback }}</p>

    <MemoryProfileEditorDialog
      :open="editorOpen"
      :profile="editing"
      @cancel="editorOpen = false"
      @saved="onSaved"
    />
  </section>
</template>
