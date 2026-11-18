<!-- 用户级全局记忆设置页：概览带（开关与读数）、记忆资产（画像与风格两个列表块）、运行与存储折叠块。
     资产读取、失败原因与刷新序列统一由 use-memory-assets 提供：页面只有一个刷新出口、一处错误条与一行操作反馈；
     契约与保存语义不变——开关只切能力，建库只建空库且不覆盖既有内容，资产编辑仍走各自的编辑对话框。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppButton from '../../ui/AppButton.vue'
import MemoryProfileSection from './MemoryProfileSection.vue'
import MemoryStyleSection from './MemoryStyleSection.vue'
import { initializeMemory, loadMemoryStatus, setMemoryEnabled } from '../services/memory'
import { useMemoryAssets } from '../use-memory-assets'
import { MEMORY_PROFILE_DOMAINS } from '../../../../shared/memory-api'
import type { MemorySnapshot } from '../../../../shared/memory-api'

const snapshot = ref<MemorySnapshot | null>(null)
const loading = ref(true)
const busy = ref(false)
const error = ref<string | null>(null)
/** 页面级反馈：开关、建库与两类资产保存都写这一行，不再分散在各卡片底部。 */
const statusLine = ref<string | null>(null)
const timezone = ref<string>('UTC')

const {
  profiles, styles, loading: assetsLoading, loaded: assetsLoaded, error: assetsError,
  totals, refresh: refreshAssets
} = useMemoryAssets()

/** 默认给系统时区：用户仍可改成任意合法 IANA 名称后重新创建。 */
function systemTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

const libraryReady = computed(() => snapshot.value?.library.state === 'ready')

const libraryLabels: Record<MemorySnapshot['library']['state'], string> = {
  missing: '尚未创建', ready: '可用', unavailable: '不可用', invalid: '需要人工检查'
}
const runtimeLabels: Record<MemorySnapshot['runtime']['state'], string> = {
  available: '可用', missing: '缺少资源', unsupported: '当前平台不支持'
}

/** 折叠块收起时的一行摘要：库状态、记录时区与 Python 版本，展开后才是逐项明细。 */
const runtimeSummary = computed(() => {
  const value = snapshot.value
  if (value === null) return ''
  const parts = [`库${libraryLabels[value.library.state]}`]
  if (value.library.timezone !== null) parts.push(value.library.timezone)
  if (value.runtime.pythonVersion !== null) parts.push(`Python ${value.runtime.pythonVersion}`)
  return parts.join(' · ')
})

/** 资产只对可用库有意义：读状态与建库之后都按同一个条件决定是否触发读取。 */
async function loadAssets(): Promise<void> {
  if (snapshot.value?.library.state === 'ready') await refreshAssets()
}

async function refresh(): Promise<void> {
  loading.value = true
  const result = await loadMemoryStatus()
  loading.value = false
  if (!result.ok) { error.value = result.error.message; return }
  error.value = null
  snapshot.value = result.data
  await loadAssets()
}

async function toggle(enabled: boolean): Promise<void> {
  if (busy.value || snapshot.value === null || snapshot.value.enabled === enabled) return
  busy.value = true
  statusLine.value = null
  const result = await setMemoryEnabled(enabled)
  busy.value = false
  if (!result.ok) { error.value = result.error.message; return }
  error.value = null
  snapshot.value = result.data
  statusLine.value = enabled ? '已开启全局记忆。' : '已停用全局记忆；既有记录仍然保留。'
}

async function create(): Promise<void> {
  if (busy.value) return
  busy.value = true
  statusLine.value = null
  const result = await initializeMemory(timezone.value.trim() || 'UTC')
  busy.value = false
  if (!result.ok) {
    // 用户取消不是故障：只提示未创建，不当作错误条。
    if (result.error.code === 'CANCELLED') { statusLine.value = '已取消，未创建记忆库。'; return }
    error.value = result.error.message
    return
  }
  error.value = null
  snapshot.value = result.data
  statusLine.value = '记忆库已创建，可以开始记录。'
  await loadAssets()
}

/** 资产保存后的反馈由列表块给出（两类的说法不同），页面只负责转述并重读。 */
async function onAssetSaved(message: string): Promise<void> {
  statusLine.value = message
  await refreshAssets()
}

onMounted(() => {
  timezone.value = systemTimezone()
  void refresh()
})
</script>

<template>
  <div class="settings-section-stack">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">记忆</h1>
      <p class="mt-1 text-sm text-desk-muted">
        记忆保存在本机用户目录，所有项目共用，不写入项目目录。
      </p>
    </header>

    <p v-if="loading" role="status" class="text-xs text-desk-muted">读取记忆状态…</p>
    <p v-else-if="error !== null" role="alert" class="status-notice status-notice-error">{{ error }}</p>

    <template v-if="snapshot !== null">
      <!-- 概览带：开关与读数同属一处页面级状态，所以它不是卡片，也不用阴影强调。 -->
      <section class="memory-overview" aria-labelledby="settings-memory-overview">
        <div class="memory-overview-head">
          <h2 id="settings-memory-overview" class="flex items-center gap-1.5 text-sm font-semibold">
            <span
              class="status-dot"
              :class="snapshot.enabled ? 'status-dot-ok' : 'status-dot-idle'"
              aria-hidden="true"
            ></span>
            {{ snapshot.enabled ? '已开启' : '已停用' }}
          </h2>
          <p class="min-w-0 flex-1 text-xs leading-5 text-desk-muted">
            回答前可读取历史记录与偏好；关闭只停用这项能力，已保存的记录仍然保留。
          </p>
          <div class="segment w-full sm:w-48" role="group" aria-label="全局记忆开关">
            <AppButton
              variant="unstyled"
              class="segment-option"
              :class="snapshot.enabled === true ? 'is-selected' : ''"
              :aria-pressed="snapshot.enabled === true"
              :disabled="busy"
              @click="toggle(true)"
            >
              开启
            </AppButton>
            <AppButton
              variant="unstyled"
              class="segment-option"
              :class="snapshot.enabled === false ? 'is-selected' : ''"
              :aria-pressed="snapshot.enabled === false"
              :disabled="busy"
              @click="toggle(false)"
            >
              关闭
            </AppButton>
          </div>
        </div>

        <dl v-if="libraryReady" class="memory-metrics">
          <div class="memory-metric">
            <dt class="text-2xs text-desk-muted">个人画像</dt>
            <dd class="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
              <span class="text-xl font-semibold tabular-nums">{{ totals.profiles }}</span>
              <span class="text-2xs text-desk-muted">
                条 · 覆盖 {{ totals.domains }}/{{ MEMORY_PROFILE_DOMAINS.length }} 领域
              </span>
            </dd>
          </div>
          <div class="memory-metric">
            <dt class="text-2xs text-desk-muted">语气风格</dt>
            <dd class="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
              <span class="text-xl font-semibold tabular-nums">{{ totals.styles }}</span>
              <span class="text-2xs text-desk-muted">条</span>
            </dd>
          </div>
          <div class="memory-metric">
            <dt class="text-2xs text-desk-muted">原句样本</dt>
            <dd class="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
              <span class="text-xl font-semibold tabular-nums">{{ totals.samples }}</span>
              <span class="text-2xs text-desk-muted">句</span>
            </dd>
          </div>
        </dl>
      </section>

      <p v-if="snapshot.notice !== null" role="status" class="status-notice status-notice-warn">
        {{ snapshot.notice }}
      </p>
      <p v-if="statusLine !== null" role="status" class="text-xs text-desk-muted">{{ statusLine }}</p>

      <!-- 记忆资产：画像与风格同在一张卡内分层，页面只有一个刷新入口与一处错误条。 -->
      <section v-if="libraryReady" class="settings-section" aria-labelledby="settings-memory-assets">
        <div class="settings-section-heading">
          <h2 id="settings-memory-assets" class="settings-section-title">记忆资产</h2>
          <AppButton variant="compact" :disabled="assetsLoading" @click="refreshAssets">
            {{ assetsLoading ? '读取中…' : '重新读取' }}
          </AppButton>
        </div>

        <p v-if="assetsError !== null" role="alert" class="status-notice status-notice-error mt-3">
          {{ assetsError }}
        </p>
        <!-- 读取失败时保留上一次成功的列表：错误条只说原因，不用空列表冒充「没有内容」。 -->
        <p v-if="!assetsLoaded" role="status" class="mt-3 text-xs text-desk-muted">
          {{ assetsLoading ? '读取记忆资产…' : '尚未读取到资产。' }}
        </p>
        <template v-else>
          <MemoryProfileSection :records="profiles" class="mt-4" @saved="onAssetSaved" />
          <MemoryStyleSection :records="styles" @saved="onAssetSaved" />
        </template>
      </section>

      <!-- 运行与存储：库不可用时默认展开（要先看原因或建库），可用时收成一行摘要。 -->
      <details class="fold-group" :open="!libraryReady">
        <summary>
          <span class="disclosure" aria-hidden="true"></span>
          <span>运行与存储</span>
          <span class="ml-auto text-2xs font-normal tabular-nums text-desk-muted">{{ runtimeSummary }}</span>
        </summary>
        <div class="fold-group-body">
          <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span class="text-sm font-medium">受管运行环境</span>
            <span class="text-2xs text-desk-muted">
              {{ runtimeLabels[snapshot.runtime.state] }}
              <template v-if="snapshot.runtime.pythonVersion !== null">· Python {{ snapshot.runtime.pythonVersion }}</template>
              <template v-if="snapshot.runtime.timezoneVersion !== null">· 时区数据 {{ snapshot.runtime.timezoneVersion }}</template>
            </span>
          </div>
          <p v-if="snapshot.runtime.message !== null" role="status" class="status-notice status-notice-warn">
            {{ snapshot.runtime.message }}
          </p>

          <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span class="text-sm font-medium">记忆库</span>
            <span class="text-2xs text-desk-muted">
              {{ libraryLabels[snapshot.library.state] }}
              <template v-if="snapshot.library.timezone !== null">· 时区 {{ snapshot.library.timezone }}</template>
            </span>
          </div>
          <p class="break-all font-mono text-2xs leading-5 text-desk-muted">{{ snapshot.library.path }}</p>
          <p v-if="snapshot.library.message !== null" role="status" class="status-notice status-notice-warn">
            {{ snapshot.library.message }}
          </p>

          <template v-if="snapshot.library.state === 'missing'">
            <label class="mt-2 block space-y-1">
              <span class="field-label">记录时区</span>
              <input
                v-model="timezone"
                class="text-control"
                type="text"
                maxlength="128"
                placeholder="Asia/Shanghai"
                :disabled="busy"
              >
            </label>
            <p class="text-2xs leading-5 text-desk-muted">用于按日期归档记录；创建后不再随系统设置变化。</p>
            <div class="mt-2 flex items-center gap-2">
              <AppButton
                variant="primary"
                :disabled="busy || snapshot.runtime.state !== 'available'"
                @click="create"
              >
                {{ busy ? '处理中…' : '创建记忆库' }}
              </AppButton>
              <p v-if="snapshot.runtime.state !== 'available'" class="text-2xs text-desk-muted">
                运行环境不可用，暂不能创建。
              </p>
            </div>
          </template>
        </div>
      </details>
    </template>
  </div>
</template>
