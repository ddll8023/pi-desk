/**
 * 生成式界面的局部修改：把一组节点级补丁合并进现有文档，产出下一版完整文档。
 *
 * 边界：只做结构合并，不做校验——合并结果仍要过 `explainGenuiDocumentWithRepairs` 的两遍解析，
 * 否则会产出渲染不出来的版本（参数与 `controls` 的交叉引用、节点数、序列化上限都要重新确认）。
 *
 * 为什么合并后的完整文档仍然整份写进 `details.ui`：投影层与渲染端只认结果里的 `details.ui`，
 * 各自拿不到分支视图。存补丁就得让投影层回溯合并，任一环损坏整份失效，rewind 后能否渲染
 * 还取决于链是否完整。合并后的结果是省模型的输出与漏字段风险，不省会话文件体积。
 *
 * 路径格式与 `ui_inspect` 的结构大纲一致（`0`、`0.1`），模型手里已经有这套路径，不必换算成
 * JSON Pointer。粒度到「节点」为止：改表格就 replace 整个表格节点，没有行级、项级补丁。
 *
 * 容器与分组：顶层 `nodes`、card / row 的 `children`、collapse / tabs 的组内 `children` 都是容器。
 * 分组容器比 card / row 多一层——`0.1` 指第 2 组本身，`0.1.0` 指组内第一个节点。因此 `insert` 可以
 * 指向组（往这一组里加节点），而 `replace` / `remove` 只能指向节点：组不是节点，增删整组要 replace
 * 整个 collapse / tabs 节点。这条边界必须明确报错而不是就近兜底，否则补丁会改到不是模型想改的地方。
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

/**
 * 分组容器（`collapse` / `tabs`）的组：两者都是「标签 + 子节点数组」，
 * 遍历只关心子节点，标签不参与定位，因此统一看成同一种结构；
 * 带上 `kind` 是为了让错误文案能说出「组」还是「页」而不靠调用方再判一次。
 */
interface GroupEntry {
  readonly children: readonly GenuiNode[]
}

interface GroupList {
  readonly kind: 'collapse' | 'tabs'
  readonly items: readonly GroupEntry[]
}

/** 分组容器的组；非分组容器返回 null。 */
function groupsOf(node: GenuiNode): GroupList | null {
  if (node.type === 'collapse' || node.type === 'tabs') return { kind: node.type, items: node.items }
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

/** 用新的子节点重建容器节点；只对真正带 children 的容器生效。 */
function rebuildChildren(node: GenuiNode, children: readonly GenuiNode[]): GenuiNode {
  if (node.type === 'card') return { ...node, children }
  if (node.type === 'row') return { ...node, children }
  return node
}

/**
 * 按路径在 `nodes` 这一层下钻，并对终点容器执行 `edit`；`segments` 为空表示容器就是 `nodes` 本身。
 * 每段先选一个节点，再按节点类型决定下一层是子节点（card / row）还是分组（collapse / tabs）。
 * 沿途容器逐层复制，原文档不被改动。
 */
function editContainer(
  nodes: readonly GenuiNode[],
  segments: readonly number[],
  label: string,
  op: GenuiPatchOp['op'],
  edit: (container: readonly GenuiNode[]) => GenuiNode[]
): GenuiNode[] {
  const head = segments[0]
  if (head === undefined) return edit(nodes)
  const node = nodes[head]
  if (node === undefined) {
    throw new GenuiPatchError(`${label}：路径中的下标 ${head} 不存在，该层只有 0..${nodes.length - 1}。先 ui_inspect 核对结构。`)
  }
  const rebuilt = editNode(node, segments.slice(1), label, op, edit)
  return nodes.map((item, index) => (index === head ? rebuilt : item))
}

/**
 * 在单个节点内部继续下钻；`segments` 为空表示这个节点本身就是终点容器。
 * 分组容器的第一段选组，其余段在组内节点里继续下钻。
 *
 * `op` 只用于把错误说准：组列表本身既不是节点、也不是可插入的容器，
 * 不同操作的正确写法不同，混写成一句会把模型引到另一个错上。
 */
function editNode(
  node: GenuiNode,
  segments: readonly number[],
  label: string,
  op: GenuiPatchOp['op'],
  edit: (container: readonly GenuiNode[]) => GenuiNode[]
): GenuiNode {
  const children = childrenOf(node)
  if (children !== null) return rebuildChildren(node, editContainer(children, segments, label, op, edit))

  const groups = groupsOf(node)
  if (groups !== null) {
    const groupIndex = segments[0]
    if (groupIndex === undefined) {
      throw new GenuiPatchError(`${label}：${groupHint(groups.kind, op)}`)
    }
    const group = groups.items[groupIndex]
    if (group === undefined) {
      throw new GenuiPatchError(
        `${label}：路径中的组下标 ${groupIndex} 不存在，该层只有 0..${groups.items.length - 1} 个组。先 ui_inspect 核对结构。`
      )
    }
    const nextChildren = editContainer(group.children, segments.slice(1), label, op, edit)
    // 按类型逐分支重建：两者的 items 元素类型不同（折叠分组带 title / open，标签页只带 label），
    // 分开写才能保持元素类型，不做交叉断言。
    switch (node.type) {
      case 'collapse':
        return {
          ...node,
          items: node.items.map((item, index) => (index === groupIndex ? { ...item, children: nextChildren } : item))
        }
      case 'tabs':
        return {
          ...node,
          items: node.items.map((item, index) => (index === groupIndex ? { ...item, children: nextChildren } : item))
        }
      default:
        // `groupsOf` 已经限定了容器类型，这里不可达；保留分支是为了让类型检查闭合。
        throw new GenuiPatchError(`${label}：${node.type} 不是分组容器。`)
    }
  }

  throw new GenuiPatchError(`${label}：这一层是 ${node.type} 节点，没有子节点，无法继续下钻。`)
}

/** 组层被当成目标时的提示：按操作给出它真正该写什么路径。 */
function groupHint(kind: 'collapse' | 'tabs', op: GenuiPatchOp['op']): string {
  const target = kind === 'collapse' ? '组' : '页'
  if (op === 'insert') {
    return `这一层是分组容器（${kind}）的分${target}列表，不是可插入的容器：`
      + `往第 2 ${target}里加节点请把 path 写成 0.1（该${target}的子节点容器），`
      + `要新增一${target}请 replace 整个 ${kind} 节点。`
  }
  return `这一层是分组容器（${kind}）的分${target}列表，分${target}本身不是节点：`
    + `replace / remove 只能指向节点，改${target}内内容请写到 0.1.0；`
    + `要增删整${target}请 replace 整个 ${kind} 节点。`
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
    return editContainer(nodes, containerPath, label, op.op, (container) => {
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
    return editContainer(nodes, containerPath, label, op.op, (container) => {
      if (container[index] === undefined) {
        throw new GenuiPatchError(`${label}：路径 ${op.path ?? ''} 不存在，该层只有 0..${container.length - 1}。先 ui_inspect 核对结构。`)
      }
      return container.map((node, current) => (current === index ? (op.node as GenuiNode) : node))
    })
  }
  return editContainer(nodes, containerPath, label, op.op, (container) => {
    if (container[index] === undefined) {
      throw new GenuiPatchError(`${label}：路径 ${op.path ?? ''} 不存在，该层只有 0..${container.length - 1}。先 ui_inspect 核对结构。`)
    }
    if (container.length === 1) {
      throw new GenuiPatchError(
        `${label} 会删掉这个容器里的最后一个节点：每个容器至少要保留一个节点，`
        + '这种情况请改用 replace 换掉它，或把整个上级容器节点一起 replace。'
      )
    }
    return container.filter((_, current) => current !== index)
  })
}

/**
 * 合并补丁：先按顺序应用节点补丁，再覆盖文档级字段。
 * 返回的对象还没校验，交给 `explainGenuiDocumentWithRepairs` 确认整份仍然成立。
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
