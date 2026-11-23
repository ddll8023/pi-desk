<!--
  单个插件的设置详情：面包屑回到插件列表，正文是该插件自己的设置组件。

  「哪个插件用哪个组件」只在这里声明一次，设置页不再按分节堆 v-if 分支；
  内容组件各自带页头与错误提示，本组件不重复它们的状态处理。
  清单条目缺席时按读取阶段区分：还在读、读失败（可重试）、确实不在清单里，三种情况不混为一个结论。
-->
<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import AppButton from '../../ui/AppButton.vue'
import type { PluginEntryView } from '../../../../shared/plugin-api'
import FileSettingsSection from '../../editor/components/FileSettingsSection.vue'
import QuickCommandsSection from '../../preferences/components/QuickCommandsSection.vue'
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
  back: []
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
  usage: UsageStatsSection
}

const settingsView = computed<Component | null>(() => (
  Object.hasOwn(PLUGIN_SETTINGS_VIEWS, props.pluginId) ? PLUGIN_SETTINGS_VIEWS[props.pluginId] : null
))
</script>

<template>
  <div class="settings-section-stack">
    <nav aria-label="插件导航" class="flex flex-wrap items-center gap-2 text-xs text-desk-muted">
      <AppButton variant="compact" @click="emit('back')">插件</AppButton>
      <span aria-hidden="true">/</span>
      <span class="font-medium text-desk-ink">{{ entry?.name ?? pluginId }}</span>
    </nav>

    <p v-if="phase === 'error'" role="alert" class="text-xs text-desk-danger">
      {{ error ?? '插件清单读取失败。' }}
      <AppButton variant="compact" @click="emit('reload')">重试</AppButton>
    </p>

    <p v-else-if="entry === null && (phase === 'idle' || phase === 'loading')" role="status" class="text-xs text-desk-muted">
      正在读取插件清单…
    </p>

    <p v-else-if="entry === null" role="status" class="text-xs text-desk-muted">
      当前清单里没有「{{ pluginId }}」这项插件，可能已被移除或来自更早的版本。
    </p>

    <template v-else>
      <p v-if="!entry.enabled" class="text-xs text-desk-warning">
        该插件已停用：设置仍可查看与修改，但重启后不会装配它的界面入口与通道。
      </p>
      <component :is="settingsView" v-if="settingsView !== null" />
      <p v-else class="text-xs text-desk-muted">这项插件没有可配置的设置项。</p>
    </template>
  </div>
</template>
