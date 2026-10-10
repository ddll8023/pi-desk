<!-- 设置页：外观与 Thinking 默认状态常驻首页，Pi 资源与 Provider 认证作为同级子页切换；偏好统一交给 store 保存，子页读写各自负责。 -->
<script setup lang="ts">
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { usePreferencesStore } from '../stores/preferences'
import AppButton from './ui/AppButton.vue'
import AuthView from './AuthView.vue'
import ResourceView from './ResourceView.vue'

/** 设置页的三个平级区域；外观是首页，另外两个是全宽子页。 */
type SettingsSection = 'appearance' | 'resources' | 'auth'

const preferencesStore = usePreferencesStore()
const { theme, thinkingDefaultExpanded } = storeToRefs(preferencesStore)
const section = ref<SettingsSection>('appearance')

const themeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
] as const

const thinkingOptions = [
  { value: false, label: '默认收起' },
  { value: true, label: '默认展开' }
] as const

function openSection(next: SettingsSection): void {
  section.value = next
}

function backToAppearance(): void {
  section.value = 'appearance'
}
</script>

<template>
  <section class="settings-page scroll-area min-h-0 flex-1 overflow-y-auto">
    <div class="settings-page-content">
      <template v-if="section === 'appearance'">
        <header class="settings-page-header">
          <h1 class="text-xl font-semibold tracking-tight">设置</h1>
          <p class="mt-1 text-sm text-desk-muted">管理外观、Pi 资源与 Provider 认证。</p>
        </header>

        <section class="settings-section" aria-labelledby="settings-appearance-title">
          <div class="settings-section-heading">
            <div>
              <h2 id="settings-appearance-title" class="settings-section-title">外观</h2>
              <p class="mt-1 text-xs text-desk-muted">选择颜色主题与思考过程的默认展示方式。</p>
            </div>
          </div>
          <div class="settings-row">
            <span class="text-sm font-medium">主题</span>
            <div class="segment w-full sm:w-80" role="group" aria-label="主题">
              <AppButton
                v-for="option in themeOptions"
                :key="option.value"
                variant="unstyled"
                class="segment-option"
                :class="theme === option.value ? 'is-selected' : ''"
                :aria-pressed="theme === option.value"
                :disabled="!preferencesStore.ready"
                @click="preferencesStore.setTheme(option.value)"
              >
                {{ option.label }}
              </AppButton>
            </div>
          </div>
          <div class="settings-row">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">Thinking 默认状态</p>
              <p class="mt-0.5 text-xs text-desk-muted">
                每次进入对话时应用，生成期间也遵循此设置；手动开合只影响当前展示，不修改默认值。
              </p>
            </div>
            <div class="segment w-full sm:w-80" role="group" aria-label="Thinking 默认状态">
              <AppButton
                v-for="option in thinkingOptions"
                :key="option.label"
                variant="unstyled"
                class="segment-option"
                :class="thinkingDefaultExpanded === option.value ? 'is-selected' : ''"
                :aria-pressed="thinkingDefaultExpanded === option.value"
                :disabled="!preferencesStore.ready"
                @click="preferencesStore.setThinkingDefaultExpanded(option.value)"
              >
                {{ option.label }}
              </AppButton>
            </div>
          </div>
          <p v-if="preferencesStore.actionError" role="alert" class="mt-3 text-xs text-desk-danger">
            {{ preferencesStore.actionError.message }}
          </p>
        </section>

        <section class="settings-section" aria-labelledby="settings-pi-title">
          <div class="settings-section-heading">
            <div>
              <h2 id="settings-pi-title" class="settings-section-title">Pi 集成</h2>
              <p class="mt-1 text-xs text-desk-muted">查看 Pi 提供的 Skills、模板、扩展命令与 MCP 连接状态。</p>
            </div>
          </div>
          <div class="settings-row">
            <div class="min-w-0">
              <p class="text-sm font-medium">Pi 资源</p>
              <p class="mt-0.5 text-xs text-desk-muted">
                查看 Skills、模板、扩展命令与 MCP 服务器；未启动 Runtime 时用磁盘预读与 mcp.json 列举，
                改动配置后需要重启 Runtime 才会生效。
              </p>
            </div>
            <AppButton variant="compact" @click="openSection('resources')">打开资源</AppButton>
          </div>
          <div class="settings-row">
            <div class="min-w-0">
              <p class="text-sm font-medium">Provider 认证</p>
              <p class="mt-0.5 text-xs text-desk-muted">
                查看每个 Provider 的凭据来源，录入 API Key 或完成账户登录。
              </p>
            </div>
            <AppButton variant="compact" @click="openSection('auth')">管理认证</AppButton>
          </div>
        </section>
      </template>

      <template v-else>
        <AppButton variant="unstyled" class="settings-back-button" @click="backToAppearance">
          ← 返回设置
        </AppButton>
        <ResourceView v-if="section === 'resources'" />
        <AuthView v-else />
      </template>
    </div>
  </section>
</template>
