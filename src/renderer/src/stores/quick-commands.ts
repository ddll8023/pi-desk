/**
 * 快捷命令清单：全局与项目范围共用一份清单，页面按当前项目筛选。
 *
 * 清单只保存用户维护的命令；运行目标是终端，因此这里不碰 Runtime、会话与标签状态。
 * 保存是整份清单替换：主进程规范化成功后页面才采纳返回值，失败保留原清单并把原因交给界面展示。
 * 保存单飞：同一时刻只有一个写请求，在途期间的新编辑被拒绝（界面据此禁用入口），避免后写者覆盖先写者。
 * 编辑弹窗与删除确认的目标也留在这里：它们只描述「正在改哪一条命令」，不涉及其他能力的展示状态。
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { PreferencesError } from '../../../shared/preferences-api'
import type { QuickCommand, QuickCommandScope } from '../../../shared/quick-commands-api'
import { getQuickCommands, setQuickCommands } from '../services/quick-commands'

/** 清单保存状态；失败时保留原清单，由界面展示原因。 */
type QuickCommandsView =
  | { readonly phase: 'idle' }
  | { readonly phase: 'saving' }
  | { readonly phase: 'error'; readonly error: PreferencesError }

export const useQuickCommandsStore = defineStore('quick-commands', () => {
  const commands = ref<QuickCommand[]>([])
  const view = ref<QuickCommandsView>({ phase: 'idle' })
  /** 首次读取是否已结束；读取失败也结束等待，界面按空清单展示。 */
  const ready = ref(false)
  /**
   * 编辑弹窗状态：`target` 为 null 表示新增；关闭后回到 null。
   * 只存「正在编辑哪一条、默认范围与项目」，表单内容由弹窗自己持有。
   */
  const editor = shallowRef<{
    readonly target: QuickCommand | null
    readonly scope: QuickCommandScope
    readonly projectPath: string | null
  } | null>(null)
  /** 待确认删除的命令；确认后提交整份清单，取消不改动任何文件。 */
  const pendingRemoval = shallowRef<QuickCommand | null>(null)

  /** 全局命令；顺序即清单里的顺序。 */
  const globalCommands = computed(() => commands.value.filter((command) => command.scope === 'global'))

  /** 某个项目的项目级命令；项目路径为空时没有项目级命令。 */
  function commandsOfProject(projectPath: string | null): readonly QuickCommand[] {
    if (projectPath === null) return []
    return commands.value.filter((command) => command.scope === 'project' && command.projectPath === projectPath)
  }

  /**
   * 菜单展示用：当前项目的命令在前（更具体，命中当前上下文），全局命令在后。
   * 项目路径为空（没有当前项目）时只剩全局命令。
   */
  function commandsForProject(projectPath: string | null): readonly QuickCommand[] {
    return [...commandsOfProject(projectPath), ...globalCommands.value]
  }

  /** 页面挂载后读取一次；已有结果时不重复请求。 */
  async function initialize(): Promise<void> {
    if (ready.value) return
    const result = await getQuickCommands()
    if (result.ok) commands.value = result.data.commands.map((command) => ({ ...command }))
    else view.value = { phase: 'error', error: result.error }
    ready.value = true
  }

  /** 保存整份清单；成功采纳主进程返回值，失败保留原清单并记录原因。 */
  async function saveCommands(next: readonly QuickCommand[]): Promise<boolean> {
    if (view.value.phase === 'saving') return false
    view.value = { phase: 'saving' }
    const result = await setQuickCommands(next)
    if (!result.ok) {
      view.value = { phase: 'error', error: result.error }
      return false
    }
    commands.value = result.data.commands.map((command) => ({ ...command }))
    view.value = { phase: 'idle' }
    return true
  }

  /** 新增或替换一条命令；id 已存在时原位替换，保持展示顺序不变。 */
  async function upsertCommand(command: QuickCommand): Promise<boolean> {
    const exists = commands.value.some((candidate) => candidate.id === command.id)
    const next = exists
      ? commands.value.map((candidate) => (candidate.id === command.id ? command : candidate))
      : [...commands.value, command]
    return saveCommands(next)
  }

  /** 删除一条命令；id 不存在时也会提交一次同内容清单，不额外判断。 */
  async function removeCommand(id: string): Promise<boolean> {
    return saveCommands(commands.value.filter((command) => command.id !== id))
  }

  /** 收起错误提示；只有错误态才需要清理。 */
  function clearError(): void {
    if (view.value.phase === 'error') view.value = { phase: 'idle' }
  }

  /** 打开编辑弹窗：新增时 target 为 null，编辑时以命令自身的范围与项目作为初始值。 */
  function openEditor(target: QuickCommand | null, scope: QuickCommandScope, projectPath: string | null): void {
    editor.value = { target, scope, projectPath }
  }

  /** 关闭编辑弹窗并丢弃编辑目标；表单内容随弹窗卸载一起清空。 */
  function closeEditor(): void {
    editor.value = null
  }

  /** 记下待删除的命令；确认前不提交任何写请求。 */
  function requestRemoval(command: QuickCommand): void {
    pendingRemoval.value = command
  }

  function cancelRemoval(): void {
    pendingRemoval.value = null
  }

  /** 确认后提交整份清单；失败原因交给界面提示，已加载的命令不变。 */
  async function confirmRemoval(): Promise<void> {
    const command = pendingRemoval.value
    pendingRemoval.value = null
    if (command !== null) await removeCommand(command.id)
  }

  return {
    commands,
    view,
    ready,
    editor,
    pendingRemoval,
    globalCommands,
    commandsOfProject,
    commandsForProject,
    initialize,
    saveCommands,
    upsertCommand,
    removeCommand,
    clearError,
    openEditor,
    closeEditor,
    requestRemoval,
    cancelRemoval,
    confirmRemoval
  }
})
