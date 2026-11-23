/**
 * 设置页的界面状态：设置页是否占据工作区、当前停在哪个分节、是否停在某个插件详情。
 *
 * 只保存「看哪一页」，不保存任何设置项的值——那些由各自的 store 负责，也不做持久化，
 * 下次启动仍从默认分节进入。分节可以带参打开，供其他入口直接落到目标分节
 * （例如版本更新提示跳到「版本与更新」，快捷命令按钮落到终端的插件详情）。
 * 旧分节 id 经 `resolveSettingsSection` 解析成插件详情，页面侧不需要为历史入口另写分支。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { DEFAULT_SETTINGS_SECTION, resolveSettingsSection } from '../settings-navigation'
import type { SettingsSectionId } from '../settings-navigation'

export const useSettingsStore = defineStore('settings', () => {
  /** 设置页是否占据工作区；false 时工作区显示工作区标签与面板。 */
  const open = ref(false)
  /** 当前分节；始终是合法 id。 */
  const activeSection = ref<SettingsSectionId>(DEFAULT_SETTINGS_SECTION)
  /** 停在「插件」分节时正在看的插件标识；null 表示显示插件列表。 */
  const activePluginId = ref<string | null>(null)

  /** 打开设置页：带分节时先定位再显示，不带时沿用上次停留的分节。 */
  function openSettings(section?: string): void {
    if (section !== undefined) applySection(section)
    open.value = true
  }

  /** 关闭设置页，回到工作区标签面板。 */
  function closeSettings(): void {
    open.value = false
  }

  /** 切换分节；旧分节 id 落到对应插件详情，无法解析的 id 忽略并保持当前页。 */
  function setActiveSection(id: string): void {
    applySection(id)
  }

  /** 进入某个插件的详情页：从插件列表点「配置」或深链落到同一个入口。 */
  function openPlugin(id: string): void {
    activeSection.value = 'plugins'
    activePluginId.value = id
  }

  /** 从插件详情回到插件列表：保留分节，只清掉详情目标。 */
  function backToPlugins(): void {
    activeSection.value = 'plugins'
    activePluginId.value = null
  }

  /** 解析并落位；解析不到时什么都不做，不把当前页清空。 */
  function applySection(id: string): void {
    const target = resolveSettingsSection(id)
    if (target === null) return
    activeSection.value = target.section
    activePluginId.value = target.pluginId
  }

  return { open, activeSection, activePluginId, openSettings, closeSettings, setActiveSection, openPlugin, backToPlugins }
})
