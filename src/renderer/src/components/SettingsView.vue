<!-- 设置页：首页常驻「外观」与「快捷输入」两块直接控件卡片，模型与 Pi 资源作为同级子页切换；偏好统一交给 store 保存，子页读写各自负责。 -->
<script setup lang="ts">
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { usePreferencesStore } from '../stores/preferences'
import AppButton from './ui/AppButton.vue'
import ModelSettingsView from './ModelSettingsView.vue'
import QuickSendSection from './QuickSendSection.vue'
import ResourceView from './ResourceView.vue'

/** 设置页的三个平级区域；外观是首页，其他两个是全宽子页。 */
type SettingsSection = 'appearance' | 'resources' | 'model'

const preferencesStore = usePreferencesStore()
const { theme } = storeToRefs(preferencesStore)
const section = ref<SettingsSection>('appearance')

const themeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
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
          <p class="mt-1 text-sm text-desk-muted">管理界面外观、快捷输入、Pi 配置与对话页模型显示。</p>
        </header>

        <section class="settings-section" aria-labelledby="settings-appearance-title">
          <div class="settings-section-heading">
            <div>
              <h2 id="settings-appearance-title" class="settings-section-title">外观</h2>
              <p class="mt-1 text-xs text-desk-muted">选择界面的颜色主题。</p>
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
          <p v-if="preferencesStore.actionError" role="alert" class="mt-3 text-xs text-desk-danger">
            {{ preferencesStore.actionError.message }}
          </p>
        </section>

        <QuickSendSection />

        <section class="settings-section" aria-labelledby="settings-pi-models-title">
          <div class="settings-section-heading">
            <div>
              <h2 id="settings-pi-models-title" class="settings-section-title">Pi 与模型</h2>
              <p class="mt-1 text-xs text-desk-muted">Pi 的供应商、凭据、模型与资源。</p>
            </div>
          </div>
          <div class="settings-entry">
            <div class="min-w-0">
              <p class="text-sm font-medium">模型</p>
              <p class="mt-0.5 text-xs text-desk-muted">供应商与凭据、models.json 里的自定义供应商，以及对话页显示哪些模型。</p>
            </div>
            <AppButton variant="compact" aria-label="管理模型" @click="openSection('model')">管理</AppButton>
          </div>
          <div class="settings-entry">
            <div class="min-w-0">
              <p class="text-sm font-medium">Pi 资源</p>
              <p class="mt-0.5 text-xs text-desk-muted">查看 Skills、模板、扩展命令与 MCP 服务器。</p>
            </div>
            <AppButton variant="compact" aria-label="管理 Pi 资源" @click="openSection('resources')">管理</AppButton>
          </div>
          <p class="mt-3 text-xs text-desk-muted">其中 Pi 配置的改动需要在重新加载会话后才会生效。</p>
        </section>
      </template>

      <template v-else>
        <AppButton variant="unstyled" class="settings-back-button" @click="backToAppearance">
          ← 返回设置
        </AppButton>
        <ResourceView v-if="section === 'resources'" />
        <ModelSettingsView v-else />
      </template>
    </div>
  </section>
</template>
