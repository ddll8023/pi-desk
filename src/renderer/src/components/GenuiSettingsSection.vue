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

/** 原生 checkbox 的选中值；失败时不回退显示，因为 store 只在保存成功后才提交本地值。 */
function inputChecked(event: Event): boolean {
  return event.target instanceof HTMLInputElement ? event.target.checked : false
}

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
  <section class="space-y-4">
    <div>
      <h2 class="text-sm font-semibold text-desk-ink">功能</h2>
      <p class="mt-1 text-xs text-desk-muted">
        这些是本应用内置的能力，开关只影响本应用的行为，不修改 Pi 的配置。
      </p>
    </div>

    <div class="list-card">
      <label class="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          class="mt-0.5"
          :checked="genuiEnabled"
          :disabled="saving"
          @change="toggle(inputChecked($event))"
        >
        <span>
          生成式界面
          <span class="text-desk-muted">
            开启后模型可以在回答里交付可交互界面（对比、指标、表格、步骤与可调参数）。
            关闭后模型不再看到这项能力，也不会尝试生成；对话里已经交付过的界面仍按原样显示，参数照常可调。
            开关在会话创建时生效，因此改动后需要重新加载资源。
          </span>
        </span>
      </label>

      <p v-if="saveError !== null" role="alert" class="status-notice status-notice-error mt-2">
        保存生成式界面开关失败：{{ saveError }}
      </p>

      <div v-if="saved" class="mt-2 flex flex-wrap items-center gap-2">
        <p class="text-2xs text-desk-muted">已保存。重新加载资源后生效。</p>
        <AppButton variant="compact" :disabled="reloading" @click="reload">
          {{ reloading ? '重新加载中…' : '立即重新加载' }}
        </AppButton>
      </div>
    </div>
  </section>
</template>
