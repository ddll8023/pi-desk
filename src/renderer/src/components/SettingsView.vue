<!-- 设置页：左栏是按分组排列的分节导航，右栏是当前分节的内容；两栏各自滚动，页面本身不滚动。
     分节清单来自 settings-navigation，这里只做「渲染导航 + 按 id 分发内容」，新增设置项不必改模板结构；
     页面标题在左栏顶部，内容区只负责自己的分节标题。
     内容区沿用统一的水平内边距（p-6 / sm:p-8）：ModelSettingsView 的粘性流程条用负边距抵消它来贴边。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { usePreferencesStore } from '../stores/preferences'
import { useSettingsStore } from '../stores/settings'
import { SETTINGS_NAV_GROUPS } from '../settings-navigation'
import AppButton from './ui/AppButton.vue'
import ModelSettingsView from './ModelSettingsView.vue'
import QuickSendSection from './QuickSendSection.vue'
import ResourceView from './ResourceView.vue'
import SettingsNavIcon from './SettingsNavIcon.vue'
import VersionUpdateSection from './VersionUpdateSection.vue'

const preferencesStore = usePreferencesStore()
const settingsStore = useSettingsStore()
const { theme } = storeToRefs(preferencesStore)
const { activeSection } = storeToRefs(settingsStore)

const themeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
] as const
</script>

<template>
  <section class="settings-page">
    <nav class="settings-nav" aria-label="设置分节">
      <div class="settings-nav-scroll scroll-area">
        <p class="settings-nav-header">设置</p>
        <div v-for="group in SETTINGS_NAV_GROUPS" :key="group.id" class="settings-nav-group">
          <p class="settings-nav-group-label">{{ group.label }}</p>
          <AppButton
            v-for="item in group.items"
            :key="item.id"
            variant="unstyled"
            class="settings-nav-item"
            :class="{ 'is-selected': activeSection === item.id }"
            :aria-current="activeSection === item.id ? 'page' : undefined"
            @click="settingsStore.setActiveSection(item.id)"
          >
            <SettingsNavIcon :name="item.icon" />
            <span class="settings-nav-label">{{ item.label }}</span>
          </AppButton>
        </div>
      </div>
    </nav>

    <div class="settings-content scroll-area">
      <div class="settings-page-content">
        <template v-if="activeSection === 'appearance'">
          <header>
            <h1 class="text-xl font-semibold tracking-tight">外观</h1>
            <p class="mt-1 text-sm text-desk-muted">选择界面的颜色主题。</p>
          </header>

          <section class="settings-section" aria-labelledby="settings-theme-title">
            <div class="settings-section-heading">
              <div>
                <h2 id="settings-theme-title" class="settings-section-title">主题</h2>
                <p class="mt-1 text-xs text-desk-muted">跟随系统时使用操作系统的浅色或深色设置。</p>
              </div>
            </div>
            <div class="settings-row">
              <span class="text-sm font-medium">颜色主题</span>
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
        </template>

        <QuickSendSection v-else-if="activeSection === 'quick-send'" />
        <ModelSettingsView v-else-if="activeSection === 'model'" />
        <ResourceView v-else-if="activeSection === 'resources'" />
        <VersionUpdateSection v-else />
      </div>
    </div>
  </section>
</template>
