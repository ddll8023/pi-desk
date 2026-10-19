<!-- 设置页的功能区块：控制生成式 UI 这项内置能力是否对模型开放，并管理本机保存的界面参数缓存。
     开关只改「是否注册内置扩展」，不改 Pi 配置，也不影响历史会话里已交付界面的渲染。
     生效时机是会话创建期，所以保存成功后显示「已保存，待重新加载」并提供重载入口，不自动重载、
     不打断正在运行的回答；重载成功才把开关标记为已生效，失败原因就地展示，不静默失败。
     参数缓存与能力开关放在同一张卡片里：前者依附后者，平级并列会让人读成两个独立功能。
     清除只删本机旁路文件（genui-params.json）里的取值，不动会话与界面文档；已挂载的界面不会被强制重建，
     因此文案只说「重新打开或改版的界面会回到默认值」。清除按钮在参数预加载结束前禁用：此时磁盘记录可能还在路上，
     清完会被迟到的预加载补回内存。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { clearGenuiParamsEverywhere, genuiParamPersistence } from '../genui/param-persistence'
import { usePreferencesStore } from '../stores/preferences'
import { useSessionStore } from '../stores/session'
import AppButton from './ui/AppButton.vue'

const preferencesStore = usePreferencesStore()
const sessionStore = useSessionStore()
const {
  genuiEnabled,
  genuiView,
  genuiSavedEnabled,
  genuiAppliedEnabled,
  genuiLoaded,
  ready
} = storeToRefs(preferencesStore)

const saving = computed(() => genuiView.value.phase === 'saving')
const saveError = computed(() => (
  genuiView.value.phase === 'error' ? genuiView.value.error.message : null
))
const reloading = computed(() => sessionStore.opening)

/** 已保存但尚未在当前会话生效：两者不等时提示重载，而不是笼统地说「已保存」。 */
const awaitingReload = computed(() => genuiSavedEnabled.value !== genuiAppliedEnabled.value)

/** 重载刚成功：显示一次「已生效」，下一次改动或离开本页即消失。 */
const reloadApplied = ref(false)

/** 重载未完成的原因；`severe` 区分真正失败（错误条）与被确认流程拦下（提示条）。 */
const reloadFailure = ref<{ readonly message: string; readonly severe: boolean } | null>(null)

/** 两态切换的选项；与外观页主题切换同构，用分段控件表达布尔开关。 */
const genuiOptions = [
  { value: true, label: '开启' },
  { value: false, label: '关闭' }
] as const

async function toggle(enabled: boolean): Promise<void> {
  reloadApplied.value = false
  reloadFailure.value = null
  await preferencesStore.saveGenuiEnabled(enabled)
}

/**
 * 重新加载资源并据此显示生效结果。
 * 复用既有的重载入口：中断确认与信任确认都在那里处理，这里只把「没重载成」的原因显示出来；
 * 重载成功后的生效标记由会话 store 统一写入，其他设置页触发的重载同样能收敛这份状态。
 */
async function reload(): Promise<void> {
  reloadApplied.value = false
  reloadFailure.value = null
  const reloaded = await sessionStore.reloadCurrent()
  if (reloaded) {
    reloadApplied.value = true
    return
  }
  const message = sessionStore.actionError?.message ?? null
  reloadFailure.value = message === null
    ? { message: '重新加载未完成：请先处理当前的确认提示，或等运行中的操作结束。', severe: false }
    : { message, severe: true }
}

/** 参数清除的展示状态：成功报条数，失败保留原始原因，不让失败看着像没点。 */
const clearing = ref(false)
const clearFeedback = ref<string | null>(null)
const clearError = ref<string | null>(null)

/** 已保存的界面份数；预加载结束前不报数，避免把「还没读到」显示成「没有」。 */
const paramCountLabel = computed(() => {
  if (!genuiParamPersistence.ready) return '读取中…'
  const count = genuiParamPersistence.recordCount
  return count === 0 ? '暂无已保存的参数' : `已保存 ${count} 份界面的参数`
})

/**
 * 清除已保存的界面参数：磁盘成功后才清内存（顺序由持久化层保证）。
 * 预加载未结束时禁用：此时磁盘记录可能还在路上，清完又会被补回内存。
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
    : `已清除 ${result.removed} 份界面的参数；重新打开或改版的界面会回到默认值。`
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
            模型可以在回答里交付可交互界面：方案对比、指标、表格、图表、机制图解、步骤与可调参数。
          </p>
        </div>
        <div class="segment w-full sm:w-48" role="group" aria-label="生成式界面开关">
          <AppButton
            v-for="option in genuiOptions"
            :key="String(option.value)"
            variant="unstyled"
            class="segment-option"
            :class="genuiEnabled === option.value ? 'is-selected' : ''"
            :aria-pressed="genuiEnabled === option.value"
            :disabled="saving || !ready"
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
        <div v-if="ready" class="flex items-center gap-2">
          <p v-if="saving" class="text-2xs text-desk-muted">保存中…</p>
          <template v-else-if="awaitingReload">
            <p class="text-2xs text-desk-muted">已保存，待重新加载</p>
            <AppButton variant="compact" :disabled="reloading" @click="reload">
              {{ reloading ? '重新加载中…' : '立即重新加载' }}
            </AppButton>
          </template>
          <p v-else-if="reloadApplied" class="text-2xs text-desk-muted">已重新加载，开关已生效</p>
        </div>
      </div>

      <p v-if="ready && !genuiLoaded" role="status" class="status-notice status-notice-warn mt-3">
        未能读取已保存的开关，当前显示的是默认值；重新切换一次即可写入。
      </p>

      <p v-if="saveError !== null" role="alert" class="status-notice status-notice-error mt-3">
        保存生成式界面开关失败：{{ saveError }}
      </p>

      <p
        v-if="reloadFailure !== null"
        :role="reloadFailure.severe ? 'alert' : 'status'"
        class="status-notice mt-3"
        :class="reloadFailure.severe ? 'status-notice-error' : 'status-notice-warn'"
      >
        {{ reloadFailure.severe ? `重新加载失败：${reloadFailure.message}` : reloadFailure.message }}
      </p>

      <div class="settings-row">
        <div>
          <p class="text-sm font-medium">界面参数缓存</p>
          <p class="mt-1 max-w-prose text-xs leading-5 text-desk-muted">
            界面上调过的参数保存在本机，重启后仍在；不随对话历史或项目同步。
            清除只删本机保存的取值，界面文档与对话历史不受影响。
          </p>
          <p v-if="genuiParamPersistence.failed" role="status" class="mt-1 text-2xs text-desk-danger">
            本机参数保存失败，最近一次调节可能没有写入。
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <p class="text-2xs text-desk-muted">{{ paramCountLabel }}</p>
          <AppButton
            variant="compact"
            :disabled="clearing || !genuiParamPersistence.ready"
            @click="clearParams"
          >
            {{ clearing ? '清除中…' : '清除已保存的参数' }}
          </AppButton>
        </div>
      </div>

      <p v-if="clearFeedback !== null" role="status" class="mt-3 text-2xs text-desk-muted">
        {{ clearFeedback }}
      </p>

      <p v-if="clearError !== null" role="alert" class="status-notice status-notice-error mt-3">
        清除界面参数失败：{{ clearError }}
      </p>
    </section>
  </div>
</template>
