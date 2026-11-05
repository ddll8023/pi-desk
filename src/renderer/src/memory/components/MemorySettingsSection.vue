<!-- 用户级全局记忆设置页：开关、受管运行时、库状态与首次创建；不覆盖既有库、不推断项目身份。 -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppButton from '../../ui/AppButton.vue'
import { initializeMemory, loadMemoryStatus, setMemoryEnabled } from '../services/memory'
import type { MemorySnapshot } from '../../../../shared/memory-api'

const snapshot = ref<MemorySnapshot | null>(null)
const loading = ref(true)
const busy = ref(false)
const error = ref<string | null>(null)
const feedback = ref<string | null>(null)
const timezone = ref<string>('UTC')

/** 默认给系统时区：用户仍可改成任意合法 IANA 名称后重新创建。 */
function systemTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

async function refresh(): Promise<void> {
  loading.value = true
  const result = await loadMemoryStatus()
  loading.value = false
  if (!result.ok) { error.value = result.error.message; return }
  error.value = null
  snapshot.value = result.data
}

async function toggle(enabled: boolean): Promise<void> {
  if (busy.value || snapshot.value === null || snapshot.value.enabled === enabled) return
  busy.value = true
  feedback.value = null
  const result = await setMemoryEnabled(enabled)
  busy.value = false
  if (!result.ok) { error.value = result.error.message; return }
  error.value = null
  snapshot.value = result.data
  feedback.value = enabled ? '已开启全局记忆。' : '已停用全局记忆；既有记录仍然保留。'
}

async function create(): Promise<void> {
  if (busy.value) return
  busy.value = true
  feedback.value = null
  const result = await initializeMemory(timezone.value.trim() || 'UTC')
  busy.value = false
  if (!result.ok) {
    // 用户取消不是故障：只提示未创建，不当作错误条。
    if (result.error.code === 'CANCELLED') { feedback.value = '已取消，未创建记忆库。'; return }
    error.value = result.error.message
    return
  }
  error.value = null
  snapshot.value = result.data
  feedback.value = '记忆库已创建，可以开始记录。'
}

const libraryLabels: Record<MemorySnapshot['library']['state'], string> = {
  missing: '尚未创建', ready: '可用', unavailable: '不可用', invalid: '需要人工检查'
}
const runtimeLabels: Record<MemorySnapshot['runtime']['state'], string> = {
  available: '可用', missing: '缺少资源', unsupported: '当前平台不支持'
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
        记忆保存在本机用户目录，所有项目共用，不写入项目目录，也不随对话历史同步。
      </p>
    </header>

    <p v-if="loading" role="status" class="text-xs text-desk-muted">读取记忆状态…</p>
    <p v-else-if="error !== null" role="alert" class="status-notice status-notice-error">
      {{ error }}
    </p>

    <template v-if="snapshot !== null">
      <section class="settings-section" aria-labelledby="settings-memory-toggle">
        <div class="settings-section-heading">
          <div>
            <h2 id="settings-memory-toggle" class="settings-section-title">全局记忆</h2>
            <p class="mt-1 max-w-prose text-xs leading-5 text-desk-muted">
              开启后，模型可以在回答前读取你的历史记录与偏好，并在你明确要求时提出保存。
              关闭只停用这项能力，已保存的记录仍然保留。
            </p>
          </div>
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

        <p v-if="snapshot.notice !== null" role="status" class="status-notice status-notice-warn mt-3">
          {{ snapshot.notice }}
        </p>
        <p v-if="feedback !== null" role="status" class="mt-3 text-2xs text-desk-muted">{{ feedback }}</p>
      </section>

      <section class="settings-section" aria-labelledby="settings-memory-runtime">
        <div class="settings-section-heading">
          <div>
            <h2 id="settings-memory-runtime" class="settings-section-title">运行环境</h2>
            <p class="mt-1 max-w-prose text-xs leading-5 text-desk-muted">
              记忆由随应用发布的 Python 与时区数据运行，不使用系统 Python，也不依赖项目虚拟环境。
            </p>
          </div>
        </div>
        <div class="settings-row">
          <span class="text-sm font-medium">受管运行环境</span>
          <p class="text-2xs text-desk-muted">
            {{ runtimeLabels[snapshot.runtime.state] }}
            <template v-if="snapshot.runtime.pythonVersion !== null">· Python {{ snapshot.runtime.pythonVersion }}</template>
            <template v-if="snapshot.runtime.timezoneVersion !== null">· 时区数据 {{ snapshot.runtime.timezoneVersion }}</template>
          </p>
        </div>
        <p
          v-if="snapshot.runtime.message !== null"
          role="status"
          class="status-notice status-notice-warn mt-3"
        >
          {{ snapshot.runtime.message }}
        </p>
      </section>

      <section class="settings-section" aria-labelledby="settings-memory-library">
        <div class="settings-section-heading">
          <div>
            <h2 id="settings-memory-library" class="settings-section-title">记忆库</h2>
            <p class="mt-1 max-w-prose text-xs leading-5 text-desk-muted">
              首次使用需要创建空的记忆库；已存在的内容不会被覆盖或迁移。
            </p>
          </div>
        </div>

        <div class="settings-row">
          <span class="text-sm font-medium">当前状态</span>
          <p class="text-2xs text-desk-muted">
            {{ libraryLabels[snapshot.library.state] }}
            <template v-if="snapshot.library.timezone !== null">· 时区 {{ snapshot.library.timezone }}</template>
          </p>
        </div>
        <div class="settings-row">
          <span class="text-sm font-medium">保存位置</span>
          <p class="break-all text-2xs text-desk-muted">{{ snapshot.library.path }}</p>
        </div>

        <p
          v-if="snapshot.library.message !== null"
          role="status"
          class="status-notice status-notice-warn mt-3"
        >
          {{ snapshot.library.message }}
        </p>

        <template v-if="snapshot.library.state === 'missing'">
          <div class="settings-row">
            <label class="block space-y-1">
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
          </div>
          <p class="mt-1 max-w-prose text-2xs text-desk-muted">
            用于按日期归档记录；创建后不再随系统设置变化，请填写你要长期使用的 IANA 时区。
          </p>
          <div class="mt-3 flex items-center gap-2">
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
      </section>
    </template>
  </div>
</template>
