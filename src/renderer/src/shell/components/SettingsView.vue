<!-- 设置页：左栏是按分组排列的分节导航，右栏是当前分节的内容；两栏各自滚动，页面本身不滚动。
     分节清单来自 settings-navigation，这里只做「渲染导航 + 按 id 分发内容」，新增内核设置项不必改模板结构；
     能力自己的设置项不占分节：它们收在「插件」分节，分节内部再分两栏——左边是插件列表，右边直接渲染选中项
     自己的设置组件，选中即切换，没有独立的详情页与返回路径。本页仍是插件清单的唯一持有者，两栏不会各读一份
     而出现状态分叉；进入分节时若还没有选中项，清单读成后自动选中第一项，右侧始终有内容。
     页面标题在左栏顶部，内容区每个分节自带一层页头（h1 加一句描述），其后按分节需要组织内容。
     内容区沿用统一的水平内边距，模型页的粘性认证摘要与正文在同一内容列对齐。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { isPluginListResult } from '../../../../shared/plugin-api'
import type { PluginEntryView } from '../../../../shared/plugin-api'
import { usePreferencesStore } from '../../preferences/stores/preferences'
import { useSettingsStore } from '../stores/settings'
import { SETTINGS_NAV_GROUPS } from '../settings-navigation'
import AppButton from '../../ui/AppButton.vue'
import ModelSettingsView from '../../providers/components/ModelSettingsView.vue'
import QuickSendSection from '../../preferences/components/QuickSendSection.vue'
import ExecutionModeSection from '../../preferences/components/ExecutionModeSection.vue'
import ResourceView from '../../resources/components/ResourceView.vue'
import SettingsNavIcon from './SettingsNavIcon.vue'
import PluginListPane from './PluginListPane.vue'
import PluginConfigPane from './PluginConfigPane.vue'
import VersionUpdateSection from '../../updates/components/VersionUpdateSection.vue'

const preferencesStore = usePreferencesStore()
const settingsStore = useSettingsStore()
const { theme } = storeToRefs(preferencesStore)
const { activeSection, activePluginId } = storeToRefs(settingsStore)

const themeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
] as const

/** 插件域桥接直接按 `PluginApi` 调用，不再本地声明一份弱化类型：契约改名时这里能看到编译报错。 */
const pluginEntries = ref<readonly PluginEntryView[]>([])
const pluginPhase = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const pluginError = ref<string | null>(null)
/** 正在切换的插件标识：过程中整表禁用开关，避免并发请求被静默丢弃。 */
const togglingPluginId = ref<string | null>(null)

/** 详情面板的插件标识；清单未读成时为空串，由面板组件按读取阶段给出原因。 */
const detailPluginId = computed(() => activePluginId.value ?? '')

/** 当前详情的清单条目；清单未读到或标识已失效时为 null，由详情组件按状态给出原因。 */
const activePlugin = computed<PluginEntryView | null>(() => {
  if (activePluginId.value === null) return null
  return pluginEntries.value.find(plugin => plugin.id === activePluginId.value) ?? null
})

/** 请求序号：响应回来时只采用最后一次请求的结果，避免先发后至的响应覆盖新状态。 */
let requestSeq = 0
/** 清单是否已经读过：只在进入插件分节时读一次，不为其它分节付跨进程开销。 */
const pluginLoaded = ref(false)

function pluginBridge(): NonNullable<typeof window.desktop> | null {
  return window.desktop ?? null
}

function invalidPluginResponse(): string {
  return '插件接口返回了不符合契约的结果。'
}

/** 读取清单；失败保留错误文本，不把旧清单当成功结果继续展示。 */
async function loadPlugins(): Promise<void> {
  const target = pluginBridge()
  if (target === null) {
    pluginPhase.value = 'error'
    pluginError.value = '当前环境没有桌面插件接口。'
    return
  }
  const seq = ++requestSeq
  pluginLoaded.value = true
  pluginPhase.value = 'loading'
  try {
    const response: unknown = await target.listPlugins()
    if (seq !== requestSeq) return
    if (!isPluginListResult(response)) {
      pluginPhase.value = 'error'
      pluginError.value = invalidPluginResponse()
      return
    }
    if (!response.ok) {
      pluginPhase.value = 'error'
      pluginError.value = response.error.message
      return
    }
    applyPluginList(response)
  } catch (error) {
    if (seq !== requestSeq) return
    pluginPhase.value = 'error'
    pluginError.value = error instanceof Error ? error.message : '插件清单读取失败。'
  }
}

/** 切换启停：响应带回整份清单，状态与依赖缺席原因因此始终同源。 */
async function togglePlugin(id: string, enabled: boolean): Promise<void> {
  const target = pluginBridge()
  if (target === null) return
  const seq = ++requestSeq
  togglingPluginId.value = id
  try {
    const response: unknown = await target.setPluginEnabled(id, enabled)
    if (seq !== requestSeq) return
    if (!isPluginListResult(response)) {
      pluginPhase.value = 'error'
      pluginError.value = invalidPluginResponse()
      return
    }
    if (!response.ok) {
      pluginPhase.value = 'error'
      pluginError.value = response.error.message
      return
    }
    applyPluginList(response)
  } catch (error) {
    if (seq !== requestSeq) return
    pluginPhase.value = 'error'
    pluginError.value = error instanceof Error ? error.message : '插件启停状态保存失败。'
  } finally {
    if (seq === requestSeq) togglingPluginId.value = null
  }
}

/**
 * 插件分节里没有选中项时补一个默认值：右侧面板始终有内容，用户不必先点一下。
 * 深链已经给出标识时不覆盖；清单读成后由 `applyPluginList` 调用。
 */
function selectDefaultPlugin(plugins: readonly PluginEntryView[]): void {
  if (activeSection.value !== 'plugins' || activePluginId.value !== null) return
  const first = plugins.find(plugin => plugin.enabled) ?? plugins[0]
  if (first !== undefined) settingsStore.openPlugin(first.id)
}

function applyPluginList(result: { readonly ok: true; readonly data: { readonly plugins: readonly PluginEntryView[] } }): void {
  pluginEntries.value = result.data.plugins
  pluginError.value = null
  pluginPhase.value = 'ready'
  selectDefaultPlugin(result.data.plugins)
}

/**
 * 进入插件分节或深链落到某个插件时才读清单；读过就不再重复请求。
 * 已经读过清单再回到本分节时没有选中项（点侧栏「插件」会清掉选中），这时直接补默认项，不等下一次请求。
 */
watch(
  () => [activeSection.value, activePluginId.value] as const,
  () => {
    if (activeSection.value !== 'plugins') return
    if (activePluginId.value === null && pluginPhase.value === 'ready') {
      selectDefaultPlugin(pluginEntries.value)
      return
    }
    if (!pluginLoaded.value) void loadPlugins()
  },
  { immediate: true }
)
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
      <div v-if="activeSection === 'plugins'" class="plugin-split">
        <PluginListPane
          :plugins="pluginEntries"
          :selected-id="activePluginId"
          :phase="pluginPhase"
          :error="pluginError"
          :toggling-id="togglingPluginId"
          @select="settingsStore.openPlugin"
          @toggle="togglePlugin"
          @reload="loadPlugins"
        />
        <PluginConfigPane
          :plugin-id="detailPluginId"
          :entry="activePlugin"
          :phase="pluginPhase"
          :error="pluginError"
          @reload="loadPlugins"
        />
      </div>

      <div v-else class="settings-page-content">
        <template v-if="activeSection === 'appearance'">
          <header>
            <h1 class="text-xl font-semibold tracking-tight">外观</h1>
            <p class="mt-1 text-sm text-desk-muted">选择界面的颜色主题与视觉偏好。</p>
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
        <ExecutionModeSection v-else-if="activeSection === 'features'" />
        <ModelSettingsView v-else-if="activeSection === 'model'" />
        <ResourceView v-else-if="activeSection === 'resources'" />

        <VersionUpdateSection v-else />
      </div>
    </div>
  </section>
</template>
