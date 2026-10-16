/**
 * 设置页左侧导航的数据定义：分组、分节、图标名与搜索关键词。
 *
 * 这里只描述「有哪些分节、怎么分组、按什么词能被搜到」，不承载分节内容，也不判断分节是否可用；
 * 内容由 SettingsView 按 id 分发，因此新增一个设置分节只需要在这里加一条数据。
 * 关键词为后续的设置项搜索预留：当前分节数还没到需要搜索框的规模，先落数据不渲染输入框。
 */

/** 设置页的分节标识；也是内容分发与深链跳转的唯一键。 */
export type SettingsSectionId = 'appearance' | 'quick-send' | 'model' | 'resources' | 'version'

/** 导航条目可用的图标名；每个名字对应 SettingsNavIcon 里的一段内联 Lucide 路径。 */
export type SettingsIconName = 'palette' | 'zap' | 'bot' | 'blocks' | 'refresh-cw'

/** 一个分节条目：标签是导航上显示的名字，关键词除标签本身外补上用户可能输入的别名。 */
export interface SettingsNavItem {
  readonly id: SettingsSectionId
  readonly label: string
  readonly icon: SettingsIconName
  readonly keywords: readonly string[]
}

/** 一组分节；分组标签是导航上的小标题，本身不可点击。 */
export interface SettingsNavGroup {
  readonly id: string
  readonly label: string
  readonly items: readonly SettingsNavItem[]
}

/** 导航分组与其中的分节；顺序即展示顺序。 */
export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] = [
  {
    id: 'general',
    label: '常规',
    items: [
      { id: 'appearance', label: '外观', icon: 'palette', keywords: ['主题', '浅色', '深色', 'theme'] },
      { id: 'quick-send', label: '快捷输入', icon: 'zap', keywords: ['短语', '发送', 'quick send'] }
    ]
  },
  {
    id: 'pi',
    label: 'Pi',
    items: [
      { id: 'model', label: '模型', icon: 'bot', keywords: ['供应商', '凭据', 'models.json', 'provider'] },
      { id: 'resources', label: '资源', icon: 'blocks', keywords: ['技能', '提示词模板', '扩展', 'MCP', 'skills'] }
    ]
  },
  {
    id: 'about',
    label: '关于',
    items: [
      { id: 'version', label: '版本与更新', icon: 'refresh-cw', keywords: ['更新', '版本', 'update'] }
    ]
  }
]

/** 打开设置页且未指定分节时的落点。 */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'appearance'

/** 校验任意字符串是不是合法分节 id；用于接收来自其他入口（如更新提示）的跳转目标。 */
export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_NAV_GROUPS.some((group) => group.items.some((item) => item.id === value))
}
