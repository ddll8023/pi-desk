/**
 * 设置页的界面状态：设置页是否占据工作区、当前停在哪个分节。
 *
 * 只保存「看哪一页」，不保存任何设置项的值——那些由各自的 store 负责，也不做持久化，
 * 下次启动仍从默认分节进入。分节可以带参打开，供其他入口直接落到目标分节
 * （例如版本更新提示跳到「版本与更新」）。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { DEFAULT_SETTINGS_SECTION, isSettingsSectionId } from '../settings-navigation'
import type { SettingsSectionId } from '../settings-navigation'

export const useSettingsStore = defineStore('settings', () => {
  /** 设置页是否占据工作区；false 时工作区显示工作区标签与面板。 */
  const open = ref(false)
  /** 当前分节；始终是合法 id。 */
  const activeSection = ref<SettingsSectionId>(DEFAULT_SETTINGS_SECTION)

  /** 打开设置页：带分节时先定位再显示，不带时沿用上次停留的分节。 */
  function openSettings(section?: SettingsSectionId): void {
    if (section !== undefined) activeSection.value = section
    open.value = true
  }

  /** 关闭设置页，回到工作区标签面板。 */
  function closeSettings(): void {
    open.value = false
  }

  /** 切换分节；非法 id 忽略，保持当前分节不变。 */
  function setActiveSection(id: string): void {
    if (!isSettingsSectionId(id)) return
    activeSection.value = id
  }

  return { open, activeSection, openSettings, closeSettings, setActiveSection }
})
