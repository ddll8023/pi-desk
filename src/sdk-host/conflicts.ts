/**
 * 扩展加载结果的分级判定：区分「产品件必须完整可注册」与「外来扩展的问题只作诊断」。
 * 只读加载结果里的工具名与路径，不解析扩展正文、不执行扩展、不改动加载清单；
 * 判定口径与 SDK 一致（同名工具首个注册者生效），避免把 SDK 已降级的情况升级成不可恢复失败。
 */
import type { ResourceIssue } from '../shared/runtime-api'

/** SDK 加载结果里本模块需要的最小投影；真实对象由宿主传入，测试用结构假件。 */
export interface LoadedExtensionLike {
  readonly path: string
  readonly tools: ReadonlyMap<string, unknown>
}

/** SDK 的 `extensions.errors` 条目：冲突与加载失败共用同一个数组。 */
export interface ExtensionErrorLike {
  readonly path: string
  readonly error: string
}

/** 产品工具名归属：工具名 → 组件标识与产品入口路径。 */
export interface ProductToolOwner {
  readonly componentId: string
  readonly tool: string
  readonly path: string
}

export interface ToolConflict {
  readonly tool: string
  readonly ownerPath: string
  readonly otherPath: string
}

export interface LoadedExtensionJudgement {
  /** 必须拒绝建立会话的问题：产品件损坏，或外来路径争用产品工具名。 */
  readonly fatal: readonly ResourceIssue[]
  /** 只作诊断的问题：外来扩展之间的问题不影响产品会话。 */
  readonly warnings: readonly ResourceIssue[]
}

/** SDK 冲突文案的固定前缀；只用于把已按结构判定的冲突从加载失败里排除。 */
const CONFLICT_MARKER = 'conflicts with'

/**
 * 按「首个注册者生效」的同一口径找重复工具名。
 * 同一路径重复出现不算冲突：那是同一扩展被重复列举，不是两个实现。
 */
export function collectToolConflicts(extensions: readonly LoadedExtensionLike[]): ToolConflict[] {
  const owners = new Map<string, string>()
  const conflicts: ToolConflict[] = []
  for (const extension of extensions) {
    for (const tool of extension.tools.keys()) {
      const owner = owners.get(tool)
      if (owner === undefined) owners.set(tool, extension.path)
      else if (owner !== extension.path) conflicts.push({ tool, ownerPath: owner, otherPath: extension.path })
    }
  }
  return conflicts
}

/**
 * 判定加载结果是否可以建立会话。
 * 不变式：只有信息足够定位到「产品件」的问题才被升级为致命，其余一律降级为诊断；
 * `productPaths` 同时用于把加载失败按路径归到组件，避免把外来扩展的语法错误算到产品头上。
 */
export function judgeLoadedExtensions(input: {
  readonly extensions: readonly LoadedExtensionLike[]
  readonly loadErrors: readonly ExtensionErrorLike[]
  readonly productPaths: ReadonlyMap<string, string>
  readonly productTools: readonly ProductToolOwner[]
}): LoadedExtensionJudgement {
  const fatal: ResourceIssue[] = []
  const warnings: ResourceIssue[] = []
  const conflicts = collectToolConflicts(input.extensions)
  const productToolOwners = new Map(input.productTools.map(item => [item.tool, item] as const))
  for (const conflict of conflicts) {
    const productTool = productToolOwners.get(conflict.tool)
    const otherIsProduct = input.productPaths.has(conflict.otherPath)
    const ownerIsProduct = input.productPaths.has(conflict.ownerPath)
    if (productTool !== undefined && (otherIsProduct || ownerIsProduct)) {
      fatal.push({
        kind: 'tool-conflict', componentId: productTool.componentId, tool: conflict.tool,
        productPath: productTool.path,
        // 对端必须是非产品路径：否则这是同一组件被列举两次，不是争用。
        otherPath: otherIsProduct ? conflict.ownerPath : conflict.otherPath
      })
      continue
    }
    warnings.push({
      kind: 'tool-duplicate', componentId: productTool?.componentId ?? null, tool: conflict.tool,
      productPath: null, otherPath: conflict.otherPath
    })
  }
  for (const entry of input.loadErrors) {
    // 已按结构判定的冲突不再重复算作加载失败，否则一次冲突会产出两条互相矛盾的建议。
    if (isConflictReport(entry, conflicts)) continue
    const componentId = input.productPaths.get(entry.path)
    if (componentId === undefined) {
      warnings.push({ kind: 'extension-load-failed', componentId: null, tool: null, productPath: null, otherPath: entry.path })
      continue
    }
    fatal.push({ kind: 'extension-load-failed', componentId, tool: null, productPath: entry.path, otherPath: null })
  }
  return { fatal, warnings }
}

/** SDK 把冲突写成 `Tool "x" conflicts with <owner>`：只认「这条错误确实对应一个结构冲突」的组合。 */
function isConflictReport(entry: ExtensionErrorLike, conflicts: readonly ToolConflict[]): boolean {
  if (!entry.error.includes(CONFLICT_MARKER)) return false
  return conflicts.some(conflict => conflict.otherPath === entry.path)
}
