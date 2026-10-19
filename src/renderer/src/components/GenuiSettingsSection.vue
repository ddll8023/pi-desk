<!-- 设置页的功能区块：控制生成式 UI 这项内置能力是否对模型开放。
     开关只改「是否注册内置扩展」，不改 Pi 配置，也不影响历史会话里已交付界面的渲染。
     生效时机是会话创建期，所以保存后只提示「重新加载资源后生效」，不自动重载、不打断正在运行的回答。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { usePreferencesStore } from '../stores/preferences'
import { useSessionStore } from '../stores/session'
import AppButton from './ui/AppButton.vue'

const preferencesStore = usePreferencesStore()
const sessionStore = useSessionStore()
const { genuiEnabled, genuiView } = storeToRefs(preferencesStore)

/** 保存成功后置位：提示需要重载才生效，直到用户点重载或再改一次开关。 */
const saved = ref(false)

const saving = computed(() => genuiView.value.phase === 'saving')
const saveError = computed(() => (
  genuiView.value.phase === 'error' ? genuiView.value.error.message : null
))
const reloading = computed(() => sessionStore.opening)

/** 两态切换的选项；与外观页主题切换同构，用分段控件表达布尔开关。 */
const genuiOptions = [
  { value: true, label: '开启' },
  { value: false, label: '关闭' }
] as const

async function toggle(enabled: boolean): Promise<void> {
  saved.value = false
  if (await preferencesStore.saveGenuiEnabled(enabled)) saved.value = true
}

/** 复用既有的重载入口：中断确认与信任确认都在那里处理，这里不另做一套。 */
function reload(): void {
  void sessionStore.reloadCurrent()
}
</script>

<template>
  <div class="space-y-4">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">功能</h1>
      <p class="mt-1 text-sm text-desk-muted">
        这些是本应用内置的能力，开关只影响本应用的行为，不修改 Pi 的配置。
      </p>
    </header>

    <section class="settings-section" aria-labelledby="settings-genui-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-genui-title" class="settings-section-title">生成式界面</h2>
          <p class="mt-1 text-xs text-desk-muted">
            模型可以在回答里交付可交互界面：对比、指标、表格、步骤与可调参数。
          </p>
        </div>
        <div class="segment w-full sm:w-48" role="group" aria-label="生成式界面">
          <AppButton
            v-for="option in genuiOptions"
            :key="String(option.value)"
            variant="unstyled"
            class="segment-option"
            :class="genuiEnabled === option.value ? 'is-selected' : ''"
            :aria-pressed="genuiEnabled === option.value"
            :disabled="saving"
            @click="toggle(option.value)"
          >
            {{ option.label }}
          </AppButton>
        </div>
      </div>

      <div class="settings-row">
        <p class="max-w-prose text-xs leading-5 text-desk-muted">
          关闭后模型看不到这项能力，也不会尝试生成；已交付的界面照常显示，参数照常可调。
          开关在会话创建时生效，改动后需重新加载资源。
        </p>
        <div v-if="saved" class="flex items-center gap-2">
          <p class="text-2xs text-desk-muted">已保存</p>
          <AppButton variant="compact" :disabled="reloading" @click="reload">
            {{ reloading ? '重新加载中…' : '立即重新加载' }}
          </AppButton>
        </div>
      </div>

      <p v-if="saveError !== null" role="alert" class="status-notice status-notice-error mt-3">
        保存生成式界面开关失败：{{ saveError }}
      </p>
    </section>
  </div>
</template>
