<!-- 设置页功能区块的执行模式切换：决定新建会话加载哪些规范 Skill，以及是否要求先讨论方案。
     模式只收缩能力集与讨论环节，不改变文件改动清单审批与运行、测试授权，因此文案必须把这一点写明，
     否则用户会把「快速」读成「免确认」。模式在会话创建期读取，已打开的会话保持原来的能力集，
     所以这里不提供重载入口，只说明生效时机。被剔除的技能名从主进程现读，不在文案里手写名单以免与宿主漂移。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { ExecutionMode } from '../../../../shared/preferences-api'
import { usePreferencesStore } from '../stores/preferences'
import { listFastModeExclusions } from '../../experts/services/expert'
import AppButton from '../../ui/AppButton.vue'

const preferencesStore = usePreferencesStore()
const { executionMode, executionModeView, executionModeLoaded } = storeToRefs(preferencesStore)

/** 快速模式实际会剔除的用户级技能；读到之前不写名单，避免先闪一句空话再改口。 */
const fastModeSkillIds = ref<readonly string[]>([])
const exclusionsLoaded = ref(false)

/** 剔除说明：有可剔除的技能时逐条给名字，没有时明确说「没有」，不留模糊的省略号。 */
const exclusionText = computed(() => {
  if (!exclusionsLoaded.value) return '快速模式会裁剪规范类技能，正在读取当前可剔除的名单。'
  if (fastModeSkillIds.value.length === 0) return '快速模式会裁剪规范类技能；当前用户级技能目录里没有可剔除的项。'
  return `快速模式不加载 ${fastModeSkillIds.value.join('、')} 这些用户级规范 Skill`
})

onMounted(async () => {
  const result = await listFastModeExclusions()
  fastModeSkillIds.value = result.ok ? result.data.skillIds : []
  exclusionsLoaded.value = true
})

const saving = computed(() => executionModeView.value.phase === 'saving')
const saveError = computed(() => (
  executionModeView.value.phase === 'error' ? executionModeView.value.error.message : null
))

/** 两档执行模式；与外观页的主题切换同构，用分段控件表达互斥选择。 */
const modeOptions: readonly { readonly value: ExecutionMode; readonly label: string }[] = [
  { value: 'fast', label: '快速' },
  { value: 'standard', label: '标准' }
]

async function select(mode: ExecutionMode): Promise<void> {
  if (mode === executionMode.value) return
  await preferencesStore.saveExecutionMode(mode)
}
</script>

<template>
  <section class="settings-section" aria-labelledby="settings-execution-mode-title">
    <div class="settings-section-heading">
      <div>
        <h2 id="settings-execution-mode-title" class="settings-section-title">执行模式</h2>
      </div>
      <div class="segment w-full sm:w-48" role="group" aria-label="执行模式">
        <AppButton
          v-for="option in modeOptions"
          :key="option.value"
          variant="unstyled"
          class="segment-option"
          :class="executionMode === option.value ? 'is-selected' : ''"
          :aria-pressed="executionMode === option.value"
          :disabled="saving"
          @click="select(option.value)"
        >
          {{ option.label }}
        </AppButton>
      </div>
    </div>

    <div class="settings-row">
      <p class="max-w-prose text-xs leading-5 text-desk-muted">
        {{ exclusionText }}，也不要求先讨论方案；
        逐文件清单审批与运行、测试授权照常，不会因选快速模式被跳过。模式只对新建会话生效，已打开的会话保持原能力集。
      </p>
      <p v-if="saving" class="text-2xs text-desk-muted">保存中…</p>
    </div>

    <p v-if="!executionModeLoaded" role="status" class="status-notice status-notice-warn mt-3">
      未能读取已保存的执行模式，当前显示的是默认值；重新选择一次即可写入。
    </p>

    <p v-if="saveError !== null" role="alert" class="status-notice status-notice-error mt-3">
      保存执行模式失败：{{ saveError }}
    </p>
  </section>
</template>
