/**
 * 设置页左侧导航的数据定义：分组、分节、图标名与搜索关键词。
 *
 * 这里只描述「有哪些分节、怎么分组、按什么词能被搜到」，不承载分节内容，也不判断分节是否可用；
 * 内容由 SettingsView 按 id 分发，因此新增一个内核分节要在两处落下：这里加一条数据，再在 SettingsView 里接上内容组件。
 *
 * 能力自己的设置项不占主导航：它们收在「插件」分节里，由插件清单逐条列出，选中条目即在右侧渲染该插件的设置。
 * 原「文件、快捷命令、终端、Git、手机访问、专家与专家团、记忆、用量」八个分节因此降为插件选中项别名，
 * 旧 id 仍可深链（`resolveSettingsSection`），落到对应插件选中项而不是消失。
 */

/** 设置页的分节标识；也是内容分发与深链跳转的唯一键。 */
export type SettingsSectionId = 'appearance' | 'quick-send' | 'features' | 'model' | 'resources' | 'plugins' | 'version'

/** 导航条目可用的图标名；每个名字对应 SettingsNavIcon 里的一段内联 Lucide 路径。
 * 只保留导航实际使用的名字：模块分节迁入插件后不再需要各自的图标，残留名字只会让图标表越来越乱。 */
export type SettingsIconName = 'palette' | 'zap' | 'toggle-left' | 'bot' | 'blocks' | 'plugin' | 'refresh-cw'

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
      { id: 'quick-send', label: '快捷输入', icon: 'zap', keywords: ['短语', '发送', 'quick send'] },
      { id: 'features', label: '功能', icon: 'toggle-left', keywords: ['开关', 'feature', '执行模式', '快速模式', '标准模式'] },
      { id: 'model', label: '模型', icon: 'bot', keywords: ['供应商', '凭据', 'models.json', 'provider'] },
      { id: 'resources', label: '资源', icon: 'blocks', keywords: ['技能', '提示词模板', '扩展', 'MCP', 'skills'] }
    ]
  },
  {
    id: 'capabilities',
    label: '能力',
    items: [
      {
        id: 'plugins',
        label: '插件',
        icon: 'plugin',
        keywords: ['插件', '能力', '启用', '停用', 'plugin', '文件', '快捷命令', '终端', 'git', '手机访问', '专家', '专家团', '记忆', '用量']
      }
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

/**
 * 旧分节 id 到插件标识的映射：这些分节的内容已迁入插件分节，标识与插件 id 同名。
 * 保留映射是为了旧的深链入口（例如快捷命令按钮）继续落到正确位置。
 * 查表一律用 `Object.hasOwn`：防止 `constructor`、`toString` 这类原型键被当成插件标识。
 */
export const PLUGIN_SECTION_ALIASES: Readonly<Record<string, string>> = {
  files: 'files',
  'quick-commands': 'quick-commands',
  terminal: 'terminal',
  git: 'git',
  'lan-remote': 'lan-remote',
  experts: 'experts',
  memory: 'memory',
  usage: 'usage'
}

/** 解析后的落点：`plugins` 分节可能为空（清单读成后自动补首个启用项），也可能直接选中某个插件。 */
export interface SettingsSectionTarget {
  readonly section: SettingsSectionId
  readonly pluginId: string | null
}

/**
 * 把任意字符串解析成落点：合法分节原样返回，旧分节 id 转成对应的插件选中项，其余返回 null。
 * 深链与导航点击共用这一处规则，避免两套判断。
 */
export function resolveSettingsSection(value: string): SettingsSectionTarget | null {
  if (Object.hasOwn(PLUGIN_SECTION_ALIASES, value)) {
    return { section: 'plugins', pluginId: PLUGIN_SECTION_ALIASES[value] }
  }
  if (value === 'plugins') return { section: 'plugins', pluginId: null }
  const known = SETTINGS_NAV_GROUPS.some(group => group.items.some(item => item.id === value))
  return known ? { section: value as SettingsSectionId, pluginId: null } : null
}
