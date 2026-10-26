<!-- 设置页：左栏是按分组排列的分节导航，右栏是当前分节的内容；两栏各自滚动，页面本身不滚动。
     分节清单来自 settings-navigation，这里只做「渲染导航 + 按 id 分发内容」，新增设置项不必改模板结构；
     页面标题在左栏顶部，内容区每个分节自带一层页头（h1 加一句描述），其后按分节需要组织内容。
     内容区沿用统一的水平内边距，模型页的粘性认证摘要与正文在同一内容列对齐。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { usePreferencesStore } from '../../preferences/stores/preferences'
import { useSettingsStore } from '../stores/settings'
import { SETTINGS_NAV_GROUPS } from '../settings-navigation'
import AppButton from '../../ui/AppButton.vue'
import ModelSettingsView from '../../providers/components/ModelSettingsView.vue'
import QuickSendSection from '../../preferences/components/QuickSendSection.vue'
import QuickCommandsSection from '../../preferences/components/QuickCommandsSection.vue'
import TerminalSettingsSection from '../../workspace/components/TerminalSettingsSection.vue'
import ResourceView from '../../resources/components/ResourceView.vue'
import GenuiSettingsSection from '../../genui/components/GenuiSettingsSection.vue'
import SettingsNavIcon from './SettingsNavIcon.vue'
import VersionUpdateSection from '../../updates/components/VersionUpdateSection.vue'
import LanRemoteSettingsSection from '../../lan-remote/components/LanRemoteSettingsSection.vue'

const preferencesStore = usePreferencesStore()
const settingsStore = useSettingsStore()
const { theme, markdownDefaultView } = storeToRefs(preferencesStore)
const { activeSection } = storeToRefs(settingsStore)

const themeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
] as const

/** Markdown 默认视图的两档；只影响新打开的标签，已打开的保持各自当前视图。 */
const markdownViewOptions = [
  { value: 'preview', label: '预览' },
  { value: 'code', label: '源码' }
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
            <p class="mt-1 text-sm text-desk-muted">选择界面的颜色主题，以及 Markdown 文件默认打开的视图。</p>
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

          <section class="settings-section" aria-labelledby="settings-markdown-view-title">
            <div class="settings-section-heading">
              <div>
                <h2 id="settings-markdown-view-title" class="settings-section-title">文件预览</h2>
                <p class="mt-1 text-xs text-desk-muted">
                  打开 Markdown 文件时默认进入哪个视图；已打开的标签保持它当前的视图，不受影响。
                </p>
              </div>
            </div>
            <div class="settings-row">
              <span class="text-sm font-medium">Markdown 默认视图</span>
              <div class="segment w-full sm:w-80" role="group" aria-label="Markdown 默认视图">
                <AppButton
                  v-for="option in markdownViewOptions"
                  :key="option.value"
                  variant="unstyled"
                  class="segment-option"
                  :class="markdownDefaultView === option.value ? 'is-selected' : ''"
                  :aria-pressed="markdownDefaultView === option.value"
                  :disabled="!preferencesStore.ready"
                  @click="preferencesStore.setMarkdownDefaultView(option.value)"
                >
                  {{ option.label }}
                </AppButton>
              </div>
            </div>
          </section>
        </template>

        <QuickSendSection v-else-if="activeSection === 'quick-send'" />
        <QuickCommandsSection v-else-if="activeSection === 'quick-commands'" />
        <TerminalSettingsSection v-else-if="activeSection === 'terminal'" />
        <LanRemoteSettingsSection v-else-if="activeSection === 'lan-remote'" />
        <ModelSettingsView v-else-if="activeSection === 'model'" />
        <ResourceView v-else-if="activeSection === 'resources'" />
        <GenuiSettingsSection v-else-if="activeSection === 'features'" />
        <VersionUpdateSection v-else />
      </div>
    </div>
  </section>
</template>
