/**
 * 生成式界面的局部修改：把一组节点级补丁合并进现有文档，产出下一版完整文档。
 *
 * 边界：只做结构合并，不做校验——合并结果仍要过 `explainGenuiDocument` 整份校验，
 * 否则会产出渲染不出来的版本（参数与 `controls` 的交叉引用、节点数、序列化上限都要重新确认）。
 *
 * 为什么合并后的完整文档仍然整份写进 `details.ui`：投影层与渲染端只认结果里的 `details.ui`，
 * 各自拿不到分支视图。存补丁就得让投影层回溯合并，任一环损坏整份失效，rewind 后能否渲染
 * 还取决于链是否完整。合并后的结果是省模型的输出与漏字段风险，不省会话文件体积。
 *
 * 路径格式与 `ui_inspect` 的结构大纲一致（`0`、`0.1`），模型手里已经有这套路径，不必换算成
 * JSON Pointer。粒度到「节点」为止：改表格就 replace 整个表格节点，没有行级、项级补丁。
 */
import type { GenuiDocument, GenuiNode } from '../../shared/genui-api'

/** 补丁操作：`replace` / `remove` 的路径指向节点，`insert` 的路径指向要插入的容器。 */
export interface GenuiPatchOp {
  readonly op: 'replace' | 'insert' | 'remove'
  /** 节点路径；省略或空串表示文档顶层的 `nodes`。 */
  readonly path?: string
  /** 仅 `insert`：插入位置；省略表示追加到容器末尾。 */
  readonly index?: number
  /** `replace` 与 `insert` 必填：要放进去的节点。 */
  readonly node?: unknown
}

/** 文档级字段：省略表示保持不变；`params: null` 表示清空全部参数声明。 */
export interface GenuiDocumentPatch {
  readonly title?: unknown
  readonly fallback?: unknown
  readonly submitLabel?: unknown
  readonly params?: unknown
}

/** 合并失败：文案会进入模型上下文，因此直接说明哪一段路径不可用、可用范围是多少。 */
export class GenuiPatchError extends Error {}

/** 容器节点（`card` / `row`）的子节点数组；非容器返回 null。 */
function childrenOf(node: GenuiNode): readonly GenuiNode[] | null {
  if (node.type === 'card' || node.type === 'row') return node.children
  return null
}

/** 把路径拆成索引数组；空路径表示文档顶层。 */
function parsePath(path: string | undefined): number[] {
  if (path === undefined || path.trim() === '') return []
  return path.trim().split('.').map((segment) => {
    if (!/^\d+$/.test(segment)) {
      throw new GenuiPatchError(`路径「${path}」不合法：每段必须是非负整数（如 0、0.1），与 ui_inspect 的大纲一致。`)
    }
    return Number(segment)
  })
}

/** 取路径指向的容器（子节点数组）；顶层返回文档 `nodes`。路径不可达时抛出带范围的说明。 */
function containerAt(
  nodes: readonly GenuiNode[],
  containerPath: readonly number[],
  label: string
): readonly GenuiNode[] {
  let current: readonly GenuiNode[] = nodes
  for (const [depth, index] of containerPath.entries()) {
    const node = current[index]
    if (node === undefined) {
      throw new GenuiPatchError(`${label}：路径第 ${depth + 1} 段 ${index} 不存在，该层只有 0..${current.length - 1}。先 ui_inspect 核对结构。`)
    }
    const children = childrenOf(node)
    if (children === null) {
      throw new GenuiPatchError(`${label}：路径第 ${depth + 1} 段是 ${node.type} 节点，没有子节点，无法继续下钻。`)
    }
    current = children
  }
  return current
}

/** 用 `edit` 改写路径指向的容器，沿途容器逐层复制，原文档不被改动。 */
function withContainer(
  nodes: readonly GenuiNode[],
  containerPath: readonly number[],
  label: string,
  edit: (container: readonly GenuiNode[]) => GenuiNode[]
): GenuiNode[] {
  const container = containerAt(nodes, containerPath, label)
  if (containerPath.length === 0) return edit(container)
  const head = containerPath[0] ?? 0
  const parent = nodes[head]
  if (parent === undefined) return [...nodes]
  const children = childrenOf(parent)
  if (children === null) return [...nodes]
  const merged = withContainer(children, containerPath.slice(1), label, edit)
  // 按类型逐分支重建，不用交叉断言：容器的 `children` 字段在不同 kind 上语义相同。
  return nodes.map((node, index) => {
    if (index !== head) return node
    if (node.type === 'card') return { ...node, children: merged }
    if (node.type === 'row') return { ...node, children: merged }
    return node
  })
}

/** 应用一条补丁，返回合并后的顶层节点数组。 */
function applyOp(nodes: readonly GenuiNode[], op: GenuiPatchOp, ordinal: number): GenuiNode[] {
  const label = `第 ${ordinal} 条补丁（${String(op.op)}${op.path === undefined ? '' : ` ${op.path}`}）`
  if (op.op !== 'insert' && op.op !== 'replace' && op.op !== 'remove') {
    throw new GenuiPatchError(`${label}：op 只能是 replace / insert / remove。`)
  }
  if (op.op === 'insert') {
    if (op.node === undefined) throw new GenuiPatchError(`${label} 缺少 node：insert 必须给出要插入的节点。`)
    const containerPath = parsePath(op.path)
    return withContainer(nodes, containerPath, label, (container) => {
      const at = op.index ?? container.length
      if (!Number.isSafeInteger(at) || at < 0 || at > container.length) {
        throw new GenuiPatchError(`${label} 的 index=${String(op.index)} 越界：该容器可插入位置是 0..${container.length}。`)
      }
      return [...container.slice(0, at), op.node as GenuiNode, ...container.slice(at)]
    })
  }
  const segments = parsePath(op.path)
  if (segments.length === 0) {
    throw new GenuiPatchError(`${label} 需要具体节点路径：${op.op} 不能直接作用于文档顶层 nodes。`)
  }
  const containerPath = segments.slice(0, -1)
  const index = segments[segments.length - 1] ?? 0
  if (op.op === 'replace') {
    if (op.node === undefined) throw new GenuiPatchError(`${label} 缺少 node：replace 必须给出替换后的节点。`)
    return withContainer(nodes, containerPath, label, (container) => {
      if (container[index] === undefined) {
        throw new GenuiPatchError(`${label}：路径 ${op.path ?? ''} 不存在，该层只有 0..${container.length - 1}。先 ui_inspect 核对结构。`)
      }
      return container.map((node, current) => (current === index ? (op.node as GenuiNode) : node))
    })
  }
  return withContainer(nodes, containerPath, label, (container) => {
    if (container[index] === undefined) {
      throw new GenuiPatchError(`${label}：路径 ${op.path ?? ''} 不存在，该层只有 0..${container.length - 1}。先 ui_inspect 核对结构。`)
    }
    if (container.length === 1) {
      throw new GenuiPatchError(`${label} 会删掉最后一个节点：文档至少要有一个节点，这种情况请改用 replace。`)
    }
    return container.filter((_, current) => current !== index)
  })
}

/**
 * 合并补丁：先按顺序应用节点补丁，再覆盖文档级字段。
 * 返回的对象还没校验，交给 `explainGenuiDocument` 确认整份仍然成立。
 */
export function applyGenuiPatch(
  document: GenuiDocument,
  ops: readonly GenuiPatchOp[],
  fields: GenuiDocumentPatch
): Record<string, unknown> {
  if (ops.length === 0 && Object.keys(fields).length === 0) {
    throw new GenuiPatchError('补丁为空：ops 至少一条，或给出要改的文档级字段（title / fallback / submitLabel / params）。')
  }
  let nodes: GenuiNode[] = [...document.nodes]
  for (const [ordinal, op] of ops.entries()) nodes = applyOp(nodes, op, ordinal + 1)
  const merged: Record<string, unknown> = {
    version: document.version,
    title: document.title,
    fallback: document.fallback,
    nodes
  }
  if (document.params !== undefined) merged.params = document.params
  if (document.submitLabel !== undefined) merged.submitLabel = document.submitLabel
  if (fields.title !== undefined) merged.title = fields.title
  if (fields.fallback !== undefined) merged.fallback = fields.fallback
  if (fields.submitLabel !== undefined) merged.submitLabel = fields.submitLabel
  // null 表示清空参数声明：文档里不带 params 才是「没有可调参数」。
  if (fields.params === null) delete merged.params
  else if (fields.params !== undefined) merged.params = fields.params
  return merged
}
