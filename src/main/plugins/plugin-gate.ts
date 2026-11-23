/**
 * 本次启动生效的能力插件集合：装配期写入一次，业务装配与清单读取只读取。
 *
 * 单独成模块是为了让读取方（如记忆的宿主配置）不必导入 `plugins/catalog`——那里会连带导入各能力的
 * IPC 注册函数，形成回指环。这里没有导入，只有一份启动期快照，回答「本次运行是否装配了某项插件」。
 */
let startupDisabled: ReadonlySet<string> = new Set()

/** 装配期固定本次运行的停用集合；重复调用以最后一次为准，只发生在启动装配阶段。 */
export function markPluginAssembly(disabled: ReadonlySet<string>): void {
  startupDisabled = new Set(disabled)
}

/** 本次启动是否停用了该插件；未装配前按未停用处理。 */
export function isPluginDisabledAtStartup(id: string): boolean {
  return startupDisabled.has(id)
}

/** 本次启动生效的停用集合快照；清单视图据此区分「配置状态」与「本次实际装配」。 */
export function startupDisabledPlugins(): ReadonlySet<string> {
  return startupDisabled
}
