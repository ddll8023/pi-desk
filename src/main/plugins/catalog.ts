/**
 * 内置能力插件清单：一项能力由谁注册、依赖谁、停用后哪些通道不再装配，只在这里声明一次。
 *
 * 清单只覆盖「可独立启停的产品能力」，内核（窗口外壳、IPC 基座、会话运行时、模型认证、信任与写入守卫）
 * 不在此列，也不存在可关闭项。装配期按依赖顺序调用 `registerBuiltinPlugins`，被停用的插件整段跳过；
 * 主进程无法注销已注册通道，因此启停只在启动期决定装配，运行期切换需重启才完全生效。
 */
import type { PluginEntryView } from '../../shared/plugin-api'
import { registerProjectFileHandlers } from '../projects/ipc'
import { registerQuickCommandHandlers } from '../preferences/ipc'
import { registerTerminalHandlers } from '../terminal/ipc'
import { registerGitHandlers } from '../git/ipc'
import { registerWorktreeHandlers } from '../git/worktree-ipc'
import { registerGitCleanupHandlers } from '../git/git-cleanup-ipc'
import { registerLanRemoteHandlers } from '../lan-remote/ipc'
import { registerExpertHandlers } from '../sessions/expert-ipc'
import { registerTeamHandlers } from '../sessions/team-ipc'
import { registerMemoryHandlers } from '../memory/ipc'
import { registerUsageStatsHandlers } from '../usage/ipc'
import { configStore, projectManager } from '../services'
import { markPluginAssembly, startupDisabledPlugins } from './plugin-gate'

/** 一条内置插件的装配声明；`register` 为 null 表示该能力的通道由其他插件或内核代理。 */
export interface BuiltinPlugin {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly dependencies: readonly string[]
  readonly register: ((pageUrl: string) => void) | null
}

/** 清单顺序即展示顺序；依赖总是指向已在前面的条目。 */
export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = [
  {
    id: 'files',
    name: '文件与编辑预览',
    summary: '文件树、源码与 Markdown 编辑、HTML／表格／文档预览。',
    dependencies: [],
    register: pageUrl => registerProjectFileHandlers(pageUrl)
  },
  {
    id: 'terminal',
    name: '终端',
    summary: '常驻终端、守护进程与终端链接路由。',
    dependencies: [],
    register: pageUrl => registerTerminalHandlers(pageUrl)
  },
  {
    id: 'quick-commands',
    name: '快捷命令',
    summary: '在终端里一键运行预设命令；命令定义随偏好保存。',
    dependencies: ['terminal'],
    register: pageUrl => registerQuickCommandHandlers(pageUrl)
  },
  {
    id: 'git',
    name: '源代码管理',
    summary: '工作区状态与差异、提交历史、工作树隔离与仓库清理。',
    dependencies: [],
    register: pageUrl => {
      registerGitHandlers(pageUrl)
      registerWorktreeHandlers(pageUrl)
      registerGitCleanupHandlers(pageUrl)
    }
  },
  {
    id: 'lan-remote',
    name: '手机访问',
    summary: '局域网入口、扫码登记设备与手机会话接入。',
    dependencies: [],
    register: pageUrl => registerLanRemoteHandlers(pageUrl)
  },
  {
    id: 'experts',
    name: '专家与专家团',
    summary: '专家定义与专家团、会话绑定、能力与写入范围收窄、团队派活与账本。',
    dependencies: [],
    register: pageUrl => {
      registerExpertHandlers(pageUrl)
      registerTeamHandlers(pageUrl, {
        // 成员登记与会话绑定同源：开团物化的登记在这里被只读通道读回。
        teamSessions: {
          list: (projectPath, rootSessionId) => configStore.listTeamSessions(projectPath, rootSessionId),
          save: entries => configStore.saveTeamSessions(entries),
          forget: (projectPath, rootSessionId) => configStore.forgetTeamSessions(projectPath, rootSessionId)
        },
        // 只允许读取已添加项目：页面不能借成员通道探测任意目录。
        hasProject: projectPath => projectManager.hasProject(projectPath)
      })
    }
  },
  {
    id: 'memory',
    name: '记忆',
    summary: '用户级全局记忆：会话背景注入、开关与画像、语气风格维护。停用后不再向会话注入记忆，界面入口一并隐藏。',
    dependencies: [],
    register: pageUrl => registerMemoryHandlers(pageUrl)
  },
  {
    id: 'usage',
    name: '用量',
    summary: '会话用量明细与跨会话 Token 统计。',
    dependencies: [],
    register: pageUrl => registerUsageStatsHandlers(pageUrl)
  }
]

/** 按停用集合装配插件通道；依赖被停用的插件整段跳过，不留下半套接口。
 * 装配同时固定本次运行的停用快照：清单的 `active` 与记忆的宿主配置都读它，而不是读最新配置，
 * 否则刚切换过的插件会让人以为通道已经没了。 */
export function registerBuiltinPlugins(pageUrl: string, disabled: ReadonlySet<string>): void {
  markPluginAssembly(disabled)
  for (const plugin of BUILTIN_PLUGINS) {
    if (disabled.has(plugin.id)) continue
    if (plugin.dependencies.some(dependency => disabled.has(dependency))) continue
    plugin.register?.(pageUrl)
  }
}

/**
 * 生成清单视图：`enabled` 是配置状态，`active` 是本次启动实际装配与否。
 * 两列取自不同集合：`enabled` 看刚保存的配置，`active` 看启动快照，因此切换后页面能区分
 * 「已改配置、重启后生效」与「本次已经在跑」。只在配置里指依赖缺席时给出原因。
 */
export function describeBuiltinPlugins(disabled: ReadonlySet<string>): PluginEntryView[] {
  const startup = startupDisabledPlugins()
  return BUILTIN_PLUGINS.map((plugin) => {
    const enabled = !disabled.has(plugin.id)
    const missing = plugin.dependencies.find(dependency => disabled.has(dependency))
    const activeNow = !startup.has(plugin.id) && !plugin.dependencies.some(dependency => startup.has(dependency))
    return {
      id: plugin.id,
      name: plugin.name,
      summary: plugin.summary,
      source: 'builtin' as const,
      enabled,
      active: enabled && activeNow,
      requiresRestart: true,
      dependencies: [...plugin.dependencies],
      unavailableReason: enabled && missing !== undefined
        ? `依赖的「${nameOf(missing)}」已停用，重启后不会装配。`
        : null
    }
  })
}

/** 依赖标识转显示名；清单内的依赖一定存在，找不到时退回标识本身。 */
function nameOf(id: string): string {
  return BUILTIN_PLUGINS.find(plugin => plugin.id === id)?.name ?? id
}

/** 合法标识判定：切换通道只接受清单内存在的插件。 */
export function hasBuiltinPlugin(id: string): boolean {
  return BUILTIN_PLUGINS.some(plugin => plugin.id === id)
}
