<!--
  设置页插件分节的配置面板：渲染左侧选中的那个插件自己的设置组件。

  「哪个插件用哪个组件」只在这里声明一次，设置页不再按插件堆 v-if 分支；
  内容组件各自带页头与错误提示，本组件不重复它们的状态处理，也不加面包屑——
  当前选中项由左侧列表表达，面板只需要区分读到了、还在读、读失败与清单里没有这一项。
  依赖缺席时补一行原因：窄栏列表放不下这句话，而它决定用户改完设置会不会生效。
-->
<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import AppButton from '../../ui/AppButton.vue'
import type { PluginEntryView } from '../../../../shared/plugin-api'
import FileSettingsSection from '../../editor/components/FileSettingsSection.vue'
import QuickCommandsSection from '../../preferences/components/QuickCommandsSection.vue'
import QuickSendSection from '../../preferences/components/QuickSendSection.vue'
import ExecutionModeSection from '../../preferences/components/ExecutionModeSection.vue'
import TerminalSettingsSection from '../../workspace/components/TerminalSettingsSection.vue'
import GitSettingsSection from '../../git/components/GitSettingsSection.vue'
import LanRemoteSettingsSection from '../../lan-remote/components/LanRemoteSettingsSection.vue'
import ExpertSettingsSection from '../../experts/components/ExpertSettingsSection.vue'
import MemorySettingsSection from '../../memory/components/MemorySettingsSection.vue'
import UsageStatsSection from '../../sessions/components/UsageStatsSection.vue'

interface Props {
  /** 目标插件标识；由设置状态给出，可能来自旧分节 id 的别名解析。 */
  readonly pluginId: string
  /** 该插件在清单里的条目；读取中、读取失败或标识已失效时为 null。 */
  readonly entry: PluginEntryView | null
  /** 清单读取阶段：区分「还在读」「读失败」与「确实没有这一项」。 */
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly error: string | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  reload: []
}>()

/** 插件标识到设置组件的唯一映射；新增可配置插件在这里加一条。 */
const PLUGIN_SETTINGS_VIEWS: Readonly<Record<string, Component>> = {
  files: FileSettingsSection,
  'quick-commands': QuickCommandsSection,
  terminal: TerminalSettingsSection,
  git: GitSettingsSection,
  'lan-remote': LanRemoteSettingsSection,
  experts: ExpertSettingsSection,
  memory: MemorySettingsSection,
  usage: UsageStatsSection,
  'quick-send': QuickSendSection,
  'execution-mode': ExecutionModeSection
}

const settingsView = computed<Component | null>(() => (
  Object.hasOwn(PLUGIN_SETTINGS_VIEWS, props.pluginId) ? PLUGIN_SETTINGS_VIEWS[props.pluginId] : null
))
</script>

<template>
  <div class="plugin-pane">
    <div v-if="phase === 'error'" class="plugin-pane-notice">
      <p role="alert" class="text-xs text-desk-danger">{{ error ?? '插件清单读取失败。' }}</p>
      <AppButton variant="compact" class="mt-2" @click="emit('reload')">重试</AppButton>
    </div>

    <p v-else-if="entry === null && (phase === 'idle' || phase === 'loading')" role="status" class="plugin-pane-notice">
      正在读取插件清单…
    </p>

    <p v-else-if="entry === null" role="status" class="plugin-pane-notice">
      当前清单里没有「{{ pluginId }}」这项插件，可能已被移除或来自更早的版本。
    </p>

    <template v-else>
      <p v-if="entry.unavailableReason" role="status" class="plugin-pane-warning">
        {{ entry.unavailableReason }}
      </p>
      <component :is="settingsView" v-if="settingsView !== null" />
      <p v-else class="plugin-pane-notice">这项插件没有可配置的设置项。</p>
    </template>
  </div>
</template>
