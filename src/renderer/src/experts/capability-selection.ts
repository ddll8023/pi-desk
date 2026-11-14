/**
 * 专家能力范围的勾选换算：设置页编辑对话框与会话内草案卡片共用这一套规则。
 *
 * 界面只呈现「勾了哪些」与「继承还是仅用选中」，声明文件里却是 `skillIds` / `Add` / `Remove`
 * 三种写法；换算集中在这里，避免两处分叉后一边保存出的范围与显示不一致。
 * 全是纯函数：不读配置、不写盘，基线由调用方从能力候选里取，主进程仍是最终校验方。
 */

/** 能力范围的两种口径，与共享契约的 `ExpertCapabilityMode` 同义。 */
export type CapabilitySelectionMode = 'inherit' | 'only'

/** 基线展开：`null` 表示不限制，等于全部候选，与主进程的计算口径一致。 */
export function baseIds(baseline: readonly string[] | null, all: readonly string[]): readonly string[] {
  return baseline ?? all
}

/**
 * 按定义还原勾选：`only` 直接取白名单，继承模式在基线上加 `Add` 再减 `Remove`。
 * 定义里的引用可能已不在候选里，这里不做过滤——候选列表负责把它标成「当前不可用」。
 */
export function restoreSelection(input: {
  readonly mode: CapabilitySelectionMode
  readonly onlyIds: readonly string[]
  readonly addIds: readonly string[]
  readonly removeIds: readonly string[]
  readonly baseline: readonly string[] | null
  readonly all: readonly string[]
}): string[] {
  if (input.mode === 'only') return [...input.onlyIds]
  const base = baseIds(input.baseline, input.all)
  return [...new Set([...base, ...input.addIds])].filter(id => !input.removeIds.includes(id))
}

/**
 * 勾选结果换算成保存字段：`only` 写白名单，继承写相对基线的加减。
 * `inheritOnlyIds` 是继承模式下随定义带回的引用列表（专家定义的 `skills` 字段），
 * 会话内卡片没有这一项，留空即可。
 */
export function toSelectionFields(input: {
  readonly mode: CapabilitySelectionMode
  readonly selected: readonly string[]
  readonly baseline: readonly string[] | null
  readonly all: readonly string[]
  readonly inheritOnlyIds?: readonly string[]
}): {
  readonly mode: CapabilitySelectionMode
  readonly onlyIds: readonly string[]
  readonly addIds: readonly string[]
  readonly removeIds: readonly string[]
} {
  if (input.mode === 'only') {
    return { mode: 'only', onlyIds: [...input.selected], addIds: [], removeIds: [] }
  }
  const base = baseIds(input.baseline, input.all)
  return {
    mode: 'inherit',
    onlyIds: [...(input.inheritOnlyIds ?? [])],
    addIds: input.selected.filter(id => !base.includes(id)),
    removeIds: base.filter(id => !input.selected.includes(id))
  }
}

/**
 * 一行候选的状态文案：不可用优先；`only` 模式勾选本身已说明状态，不再重复；
 * 继承模式要能看出哪些是基线默认、哪些被手动加减。
 */
export function selectionState(input: {
  readonly unavailable: boolean
  readonly mode: CapabilitySelectionMode
  readonly checked: boolean
  readonly inBaseline: boolean
}): string {
  if (input.unavailable) return '当前不可用'
  if (input.mode === 'only') return ''
  if (input.inBaseline) return input.checked ? '基线默认' : '已排除'
  return input.checked ? '额外启用' : '未启用'
}
