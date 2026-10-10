<!-- 设置页：承载主题偏好、Pi 资源和 Provider 认证入口。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { usePreferencesStore } from '../stores/preferences'
import AppButton from './ui/AppButton.vue'
import AuthPanel from './AuthPanel.vue'
import ResourcePanel from './ResourcePanel.vue'

const preferencesStore = usePreferencesStore()
const { theme } = storeToRefs(preferencesStore)
const showingResources = ref(false)
const showingAuth = ref(false)

function openResourcePanel(): void {
  showingAuth.value = false
  showingResources.value = true
}

function openAuthPanel(): void {
  showingResources.value = false
  showingAuth.value = true
}
</script>

<template>
  <section class="settings-page scroll-area min-h-0 flex-1 overflow-y-auto">
    <div class="settings-page-content">
      <header class="settings-page-header">
        <h1 class="text-xl font-semibold tracking-tight">设置</h1>
        <p class="mt-1 text-sm text-desk-muted">管理外观、Pi 资源与 Provider 认证。</p>
      </header>

      <section class="settings-section" aria-labelledby="settings-appearance-title">
        <div class="settings-section-heading">
          <div>
            <h2 id="settings-appearance-title" class="settings-section-title">外观</h2>
            <p class="mt-1 text-xs text-desk-muted">选择应用的颜色主题。</p>
          </div>
        </div>
        <div class="settings-row">
          <span class="text-sm font-medium">主题</span>
          <div class="flex flex-wrap gap-2" role="group" aria-label="主题">
            <AppButton
              variant="compact"
              class="settings-theme-option"
              :class="theme === 'system' ? 'is-selected' : ''"
              :aria-pressed="theme === 'system'"
              :disabled="!preferencesStore.ready"
              @click="preferencesStore.setTheme('system')"
            >
              跟随系统
            </AppButton>
            <AppButton
              variant="compact"
              class="settings-theme-option"
              :class="theme === 'light' ? 'is-selected' : ''"
              :aria-pressed="theme === 'light'"
              :disabled="!preferencesStore.ready"
              @click="preferencesStore.setTheme('light')"
            >
              浅色
            </AppButton>
            <AppButton
              variant="compact"
              class="settings-theme-option"
              :class="theme === 'dark' ? 'is-selected' : ''"
              :aria-pressed="theme === 'dark'"
              :disabled="!preferencesStore.ready"
              @click="preferencesStore.setTheme('dark')"
            >
              深色
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
            <h2 id="settings-pi-title" class="settings-section-title">Pi 资源</h2>
            <p class="mt-1 text-xs text-desk-muted">查看 Pi 提供的 Skills、模板、扩展与 MCP 状态。</p>
          </div>
          <AppButton variant="compact" @click="openResourcePanel">打开资源面板</AppButton>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="settings-auth-title">
        <div class="settings-section-heading">
          <div>
            <h2 id="settings-auth-title" class="settings-section-title">Provider 认证</h2>
            <p class="mt-1 text-xs text-desk-muted">管理 Provider 的 API Key 与账户认证。</p>
          </div>
          <AppButton variant="compact" @click="openAuthPanel">打开认证面板</AppButton>
        </div>
      </section>
    </div>
  </section>

  <Teleport to="body">
    <ResourcePanel :open="showingResources" @close="showingResources = false" />
    <AuthPanel :open="showingAuth" @close="showingAuth = false" />
  </Teleport>
</template>
