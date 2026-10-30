<!--
  设置页的文件管理分节：管理右侧文件树的隐藏与排除规则、全局显隐开关，以及 Markdown 打开默认视图。
  所有改动通过 preferencesStore 持久化到本地配置文件中，切换项目或重启后保持。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import {
  DEFAULT_FILE_EXCLUDE_PATTERNS,
  MAX_FILE_EXCLUDE_PATTERNS,
  MAX_FILE_EXCLUDE_PATTERN_LENGTH
} from '../../../../shared/preferences-api'
import type { MarkdownDefaultView } from '../../../../shared/preferences-api'
import { usePreferencesStore } from '../../preferences/stores/preferences'
import AppButton from '../../ui/AppButton.vue'

const preferencesStore = usePreferencesStore()
const {
  showHiddenFiles,
  fileExcludePatterns,
  markdownDefaultView,
  ready
} = storeToRefs(preferencesStore)

/** 常见预设排除项列表：提供快捷一键启闭。 */
const PRESET_PATTERNS = DEFAULT_FILE_EXCLUDE_PATTERNS

/** 自定义规则输入框内容。 */
const newPattern = ref('')
const inputError = ref<string | null>(null)

/** 是否显示隐藏条目的切换选项。 */
const showHiddenOptions = [
  { value: false, label: '隐藏已排除项' },
  { value: true, label: '显示已排除项（淡色）' }
] as const

/** Markdown 打开视图选项。 */
const markdownViewOptions = [
  { value: 'preview', label: '预览' },
  { value: 'code', label: '源码' }
] as const

/** 自定义规则：排除预设规则之后由用户手动添加的模式。 */
const customPatterns = computed(() => (
  fileExcludePatterns.value.filter((p) => !PRESET_PATTERNS.includes(p))
))

const atLimit = computed(() => fileExcludePatterns.value.length >= MAX_FILE_EXCLUDE_PATTERNS)

function isPresetEnabled(pattern: string): boolean {
  return fileExcludePatterns.value.includes(pattern)
}

async function togglePreset(pattern: string): Promise<void> {
  await preferencesStore.toggleFileExcludePattern(pattern)
}

async function addCustomPattern(): Promise<void> {
  inputError.value = null
  const trimmed = newPattern.value.trim()
  if (trimmed === '') return
  if (trimmed.length > MAX_FILE_EXCLUDE_PATTERN_LENGTH) {
    inputError.value = `规则长度不能超过 ${MAX_FILE_EXCLUDE_PATTERN_LENGTH} 个字符`
    return
  }
  if (fileExcludePatterns.value.includes(trimmed)) {
    inputError.value = '该规则已存在'
    return
  }
  if (atLimit.value) {
    inputError.value = `最多添加 ${MAX_FILE_EXCLUDE_PATTERNS} 条排除规则`
    return
  }
  const ok = await preferencesStore.addFileExcludePattern(trimmed)
  if (ok) {
    newPattern.value = ''
  } else {
    inputError.value = '添加规则失败'
  }
}

async function removePattern(pattern: string): Promise<void> {
  await preferencesStore.removeFileExcludePattern(pattern)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    void addCustomPattern()
  }
}
</script>

<template>
  <div class="settings-section-stack">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">文件</h1>
      <p class="mt-1 text-sm text-desk-muted">管理右侧面板文件树的排除与隐藏规则，以及文件打开默认偏好。</p>
    </header>

    <!-- 1. 文件树显隐控制 -->
    <section class="settings-section" aria-labelledby="settings-hidden-toggle-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-hidden-toggle-title" class="settings-section-title">文件树显示模式</h2>
          <p class="mt-1 text-xs text-desk-muted">
            是否在右侧文件树与检索中展示已被排除的文件与文件夹。也可在文件树顶部通过眼睛按钮快速切换。
          </p>
        </div>
      </div>
      <div class="settings-row">
        <span class="text-sm font-medium">已排除项显示</span>
        <div class="segment w-full sm:w-80" role="group" aria-label="已排除项显示模式">
          <AppButton
            v-for="option in showHiddenOptions"
            :key="String(option.value)"
            variant="unstyled"
            class="segment-option"
            :class="showHiddenFiles === option.value ? 'is-selected' : ''"
            :aria-pressed="showHiddenFiles === option.value"
            :disabled="!ready"
            @click="preferencesStore.setShowHiddenFiles(option.value)"
          >
            {{ option.label }}
          </AppButton>
        </div>
      </div>
    </section>

    <!-- 2. 预设排除规则 -->
    <section class="settings-section" aria-labelledby="settings-presets-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-presets-title" class="settings-section-title">常见排除规则</h2>
          <p class="mt-1 text-xs text-desk-muted">常用开发产物、版本控制与操作系统临时文件，点击可开启或禁用。</p>
        </div>
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <AppButton
          v-for="pattern in PRESET_PATTERNS"
          :key="pattern"
          variant="unstyled"
          class="file-preset-badge"
          :class="{ 'is-active': isPresetEnabled(pattern) }"
          :aria-pressed="isPresetEnabled(pattern)"
          :title="isPresetEnabled(pattern) ? `点击禁用 ${pattern}` : `点击启用 ${pattern}`"
          @click="togglePreset(pattern)"
        >
          <span class="file-preset-dot"></span>
          <span>{{ pattern }}</span>
        </AppButton>
      </div>
    </section>

    <!-- 3. 自定义排除规则管理 -->
    <section class="settings-section" aria-labelledby="settings-custom-rules-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-custom-rules-title" class="settings-section-title">自定义排除规则</h2>
          <p class="mt-1 text-xs text-desk-muted">
            支持完整文件名（如 secret.env）、相对路径（如 docs/draft/）或通配符模式（如 *.tmp）。也可在文件树右键条目选择「隐藏此项」。
          </p>
        </div>
        <span class="text-2xs text-desk-muted">{{ fileExcludePatterns.length }} / {{ MAX_FILE_EXCLUDE_PATTERNS }}</span>
      </div>

      <div class="mt-3 flex gap-2">
        <input
          v-model="newPattern"
          type="text"
          class="text-control flex-1"
          placeholder="例如：*.tmp、temp/ 或 debug.log"
          aria-label="新增排除规则"
          :maxlength="MAX_FILE_EXCLUDE_PATTERN_LENGTH"
          :disabled="atLimit"
          @keydown="onKeydown"
        />
        <AppButton
          variant="primary"
          :disabled="newPattern.trim() === '' || atLimit"
          @click="addCustomPattern"
        >
          添加规则
        </AppButton>
      </div>
      <p v-if="inputError !== null" class="mt-2 text-xs text-desk-danger" role="alert">{{ inputError }}</p>

      <div class="mt-4">
        <p class="text-xs font-medium text-desk-muted mb-2">已添加的自定义规则</p>
        <p v-if="customPatterns.length === 0" class="text-xs text-desk-muted py-2">
          暂无自定义排除规则，可在上方输入框添加，或在右侧文件树右键具体文件进行隐藏。
        </p>
        <ul v-else class="space-y-1.5 max-h-60 overflow-y-auto scroll-area">
          <li
            v-for="pattern in customPatterns"
            :key="pattern"
            class="flex items-center justify-between rounded px-2.5 py-1.5 text-xs bg-desk-surface border border-desk-border"
          >
            <span class="font-mono text-desk-text truncate mr-2">{{ pattern }}</span>
            <AppButton
              variant="unstyled"
              class="text-desk-muted hover:text-desk-danger p-1"
              aria-label="删除此规则"
              title="删除此规则"
              @click="removePattern(pattern)"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </AppButton>
          </li>
        </ul>
      </div>
    </section>

    <!-- 4. Markdown 文件打开视图 -->
    <section class="settings-section" aria-labelledby="settings-markdown-view-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-markdown-view-title" class="settings-section-title">Markdown 默认视图</h2>
          <p class="mt-1 text-xs text-desk-muted">
            打开 Markdown 文件时默认进入哪个视图；已打开的标签保持它当前的视图，不受影响。
          </p>
        </div>
      </div>
      <div class="settings-row">
        <span class="text-sm font-medium">默认打开视图</span>
        <div class="segment w-full sm:w-80" role="group" aria-label="Markdown 默认视图">
          <AppButton
            v-for="option in markdownViewOptions"
            :key="option.value"
            variant="unstyled"
            class="segment-option"
            :class="markdownDefaultView === option.value ? 'is-selected' : ''"
            :aria-pressed="markdownDefaultView === option.value"
            :disabled="!ready"
            @click="preferencesStore.setMarkdownDefaultView(option.value)"
          >
            {{ option.label }}
          </AppButton>
        </div>
      </div>
    </section>
  </div>
</template>
