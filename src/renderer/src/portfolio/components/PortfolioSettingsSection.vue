<!-- 作品库设置分节：浏览、查看、改名、截封面与删除已登记的界面成品。
     封面与快照都不内嵌渲染，统一交给系统默认程序打开；页面不持有作品目录与文件访问能力。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppButton from '../../ui/AppButton.vue'
import {
  capturePortfolioCover,
  deletePortfolioEntry,
  loadPortfolioDetail,
  loadPortfolioEntries,
  openPortfolioAsset,
  renamePortfolioEntry,
  replaceEntry
} from '../services/portfolio'
import type { PortfolioDetail, PortfolioEntry, PortfolioMutationResult } from '../../../../shared/portfolio-api'

const entries = ref<PortfolioEntry[]>([])
const detail = ref<PortfolioDetail | null>(null)
const loading = ref(true)
const busy = ref(false)
const error = ref<string | null>(null)
const feedback = ref<string | null>(null)
const renaming = ref(false)
const renameDraft = ref('')
const confirmingDelete = ref(false)

const cover = computed(() => detail.value?.assets.find(asset => asset.kind === 'cover') ?? null)
const snapshots = computed(() => detail.value?.assets.filter(asset => asset.kind === 'snapshot') ?? [])

function formatDate(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Date(time).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 列表与详情分开读取：清单不含要点全文，详情只在选中时取。 */
async function refresh(): Promise<void> {
  loading.value = true
  try {
    const result = await loadPortfolioEntries()
    if (!result.ok) {
      error.value = result.error
      return
    }
    error.value = null
    entries.value = [...result.data.entries]
    const current = detail.value
    if (current !== null && !entries.value.some(entry => entry.id === current.id)) detail.value = null
  } finally {
    loading.value = false
  }
}

async function select(entry: PortfolioEntry): Promise<void> {
  if (busy.value) return
  renaming.value = false
  confirmingDelete.value = false
  feedback.value = null
  busy.value = true
  try {
    const result = await loadPortfolioDetail(entry.id)
    if (!result.ok) {
      error.value = result.error
      return
    }
    error.value = null
    detail.value = result.data.entry
  } finally {
    busy.value = false
  }
}

/**
 * 写操作成功后重读详情：素材清单由主进程给出，页面不自己拼装。
 * 返回是否成功，调用方据此决定要不要关闭表单，避免失败时丢掉输入。
 */
async function perform(action: () => Promise<PortfolioMutationResult>, message: string): Promise<boolean> {
  const current = detail.value
  if (current === null || busy.value) return false
  busy.value = true
  error.value = null
  feedback.value = null
  try {
    const result = await action()
    if (!result.ok) {
      error.value = result.error
      return false
    }
    if (result.data.entry !== null) entries.value = replaceEntry(entries.value, result.data.entry)
    const reloaded = await loadPortfolioDetail(current.id)
    if (!reloaded.ok) {
      error.value = reloaded.error
      return false
    }
    detail.value = reloaded.data.entry
    feedback.value = message
    return true
  } finally {
    busy.value = false
  }
}

function startRename(): void {
  if (detail.value === null) return
  renameDraft.value = detail.value.name
  renaming.value = true
  confirmingDelete.value = false
}

async function submitRename(): Promise<void> {
  const current = detail.value
  if (current === null) return
  const next = renameDraft.value.trim()
  if (next === current.name) {
    renaming.value = false
    return
  }
  if (await perform(() => renamePortfolioEntry(current.id, next), '已改名。')) renaming.value = false
}

async function captureCover(): Promise<void> {
  const current = detail.value
  if (current === null) return
  await perform(() => capturePortfolioCover(current.id), '已截取封面。')
}

async function remove(): Promise<void> {
  const current = detail.value
  if (current === null || busy.value) return
  busy.value = true
  error.value = null
  try {
    const result = await deletePortfolioEntry(current.id)
    if (!result.ok) {
      error.value = result.error
      return
    }
    entries.value = entries.value.filter(entry => entry.id !== current.id)
    detail.value = null
    feedback.value = '已移入系统废纸篓，可从废纸篓还原。'
  } finally {
    busy.value = false
    confirmingDelete.value = false
  }
}

async function openAsset(path: string): Promise<void> {
  const current = detail.value
  if (current === null || busy.value) return
  busy.value = true
  error.value = null
  try {
    const result = await openPortfolioAsset(current.id, path)
    if (!result.ok) {
      error.value = result.error
      return
    }
    feedback.value = '已用系统默认程序打开。'
  } finally {
    busy.value = false
  }
}

onMounted(() => { void refresh() })
</script>

<template>
  <div class="settings-section-stack">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">作品</h1>
      <p class="mt-1 text-sm text-desk-muted">
        已确认的界面成品保存在本机用户目录，所有项目共用；只有你明确要求「存进作品库」时才会写入。
      </p>
    </header>

    <p v-if="loading" role="status" class="text-xs text-desk-muted">读取作品清单…</p>
    <p v-else-if="error !== null" role="alert" class="status-notice status-notice-error">{{ error }}</p>
    <p v-if="feedback !== null" role="status" class="text-2xs text-desk-muted">{{ feedback }}</p>

    <section v-if="!loading" class="settings-section" aria-labelledby="settings-portfolio-list">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-portfolio-list" class="settings-section-title">作品清单</h2>
          <p class="mt-1 text-2xs text-desk-muted">共 {{ entries.length }} 件</p>
        </div>
      </div>

      <p v-if="error === null && entries.length === 0" class="text-xs text-desk-muted">
        还没有作品。在会话里让模型用 work_save 登记，或在后续任务中先让它读取已有要点。
      </p>

      <ul v-else class="mt-2 divide-y divide-desk-line">
        <li v-for="entry in entries" :key="entry.id">
          <AppButton
            variant="unstyled"
            class="flex w-full items-start justify-between gap-3 rounded-md px-2 py-2 text-left hover:bg-desk-surface-subtle"
            :class="detail?.id === entry.id ? 'bg-desk-surface-subtle' : ''"
            :aria-current="detail?.id === entry.id ? 'true' : undefined"
            :disabled="busy"
            @click="select(entry)"
          >
            <span class="min-w-0">
              <span class="block truncate text-sm font-medium">{{ entry.name }}</span>
              <span class="mt-0.5 block truncate text-2xs text-desk-muted">
                {{ entry.scene }} · {{ entry.assetCount }} 个素材 · {{ formatDate(entry.updatedAt) }}
              </span>
            </span>
            <span v-if="entry.hasCover" class="shrink-0 text-2xs text-desk-muted">有封面</span>
          </AppButton>
        </li>
      </ul>
    </section>

    <section v-if="detail !== null" class="settings-section" aria-labelledby="settings-portfolio-detail">
      <div class="settings-section-heading">
        <div class="min-w-0">
          <h2 id="settings-portfolio-detail" class="settings-section-title truncate">{{ detail.name }}</h2>
          <p class="mt-1 text-2xs text-desk-muted">
            {{ detail.scene }} · 创建 {{ formatDate(detail.createdAt) }} · 更新 {{ formatDate(detail.updatedAt) }}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <AppButton :disabled="busy" @click="startRename">改名</AppButton>
          <AppButton
            v-if="!confirmingDelete"
            :disabled="busy"
            @click="confirmingDelete = true"
          >
            删除
          </AppButton>
          <template v-else>
            <AppButton variant="danger" :disabled="busy" @click="remove">确认删除</AppButton>
            <AppButton :disabled="busy" @click="confirmingDelete = false">取消</AppButton>
          </template>
        </div>
      </div>

      <form v-if="renaming" class="mt-3 flex items-center gap-2" @submit.prevent="submitRename">
        <label class="block flex-1 space-y-1">
          <span class="field-label">作品名称</span>
          <input
            v-model="renameDraft"
            class="text-control"
            type="text"
            maxlength="100"
            :disabled="busy"
            @keydown.enter.prevent="submitRename"
          >
        </label>
        <AppButton variant="primary" :disabled="busy" @click="submitRename">保存</AppButton>
        <AppButton :disabled="busy" @click="renaming = false">取消</AppButton>
      </form>

      <div class="mt-4 space-y-1">
        <h3 class="text-sm font-medium">设计要点</h3>
        <p class="whitespace-pre-wrap text-xs leading-6 text-desk-muted">
          {{ detail.points.trim() === '' ? '（未填写）' : detail.points }}
        </p>
      </div>

      <div class="settings-row mt-4">
        <span class="text-sm font-medium">封面</span>
        <div class="flex items-center gap-2">
          <AppButton v-if="cover !== null" :disabled="busy" @click="openAsset(cover.path)">打开封面</AppButton>
          <span v-else class="text-2xs text-desk-muted">尚未截取</span>
          <AppButton :disabled="busy" @click="captureCover">从内置浏览器截取</AppButton>
        </div>
      </div>

      <div class="mt-4 space-y-1">
        <h3 class="text-sm font-medium">快照</h3>
        <p v-if="snapshots.length === 0" class="text-2xs text-desk-muted">没有留存源文件。</p>
        <ul v-else class="divide-y divide-desk-line">
          <li v-for="asset in snapshots" :key="asset.path" class="flex items-center justify-between gap-3 py-2">
            <span class="min-w-0">
              <span class="block truncate text-xs">{{ asset.path }}</span>
              <span class="block text-2xs text-desk-muted">{{ formatBytes(asset.bytes) }}</span>
            </span>
            <AppButton :disabled="busy" @click="openAsset(asset.path)">打开</AppButton>
          </li>
        </ul>
      </div>

      <div class="mt-4 space-y-1">
        <h3 class="text-sm font-medium">来源</h3>
        <p v-if="detail.sources.length === 0" class="text-2xs text-desk-muted">未记录来源。</p>
        <ul v-else class="space-y-1">
          <li v-for="(source, index) in detail.sources" :key="`${source.project}-${index}`" class="text-2xs text-desk-muted">
            {{ source.project }} · {{ source.path }} · {{ source.date }}
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>
