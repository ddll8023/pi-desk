<!-- 设置页的功能区块：控制生成式 UI 这项内置能力是否对模型开放，并提供清除已保存界面参数的入口。
     开关只改「是否注册内置扩展」，不改 Pi 配置，也不影响历史会话里已交付界面的渲染。
     生效时机是会话创建期，所以保存后只提示「重新加载资源后生效」，不自动重载、不打断正在运行的回答。
     参数清除只删本机旁路文件（genui-params.json）里的取值，不动会话与界面文档。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { clearGenuiParamsEverywhere } from '../genui/param-persistence'
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

/** 参数清除的展示状态：成功报条数，失败保留原始原因，不让失败看着像没点。 */
const clearing = ref(false)
const clearFeedback = ref<string | null>(null)
const clearError = ref<string | null>(null)

/**
 * 清除已保存的界面参数：磁盘成功后才清内存（顺序由持久化层保证）。
 * 不确认弹窗：这里删的只是可再生产的参数缓存，界面文档与对话历史都不受影响。
 */
async function clearParams(): Promise<void> {
  if (clearing.value) return
  clearing.value = true
  clearFeedback.value = null
  clearError.value = null
  const result = await clearGenuiParamsEverywhere()
  clearing.value = false
  if (!result.ok) {
    clearError.value = result.message
    return
  }
  clearFeedback.value = result.removed === 0
    ? '本机没有已保存的界面参数。'
    : `已清除 ${result.removed} 份界面的参数；已打开的界面会回到默认值。`
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

    <section class="settings-section" aria-labelledby="settings-genui-params-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-genui-params-title" class="settings-section-title">界面参数</h2>
          <p class="mt-1 text-xs text-desk-muted">
            界面上调过的参数保存在本机，重启后仍在；不随对话历史或项目同步。
          </p>
        </div>
        <AppButton variant="compact" :disabled="clearing" @click="clearParams">
          {{ clearing ? '清除中…' : '清除已保存的参数' }}
        </AppButton>
      </div>

      <div class="settings-row">
        <p class="max-w-prose text-xs leading-5 text-desk-muted">
          清除只删本机保存的参数取值，界面文档、对话历史与项目都不受影响。
          已打开的界面会回到各自的默认值，之后重新调节会再次保存。
        </p>
        <p v-if="clearFeedback !== null" role="status" class="text-2xs text-desk-muted">{{ clearFeedback }}</p>
      </div>

      <p v-if="clearError !== null" role="alert" class="status-notice status-notice-error mt-3">
        清除界面参数失败：{{ clearError }}
      </p>
    </section>
  </div>
</template>
