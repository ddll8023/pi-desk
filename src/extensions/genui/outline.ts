/**
 * 把一份界面文档压成结构大纲：模型据此在后续轮次里改字段并用 ui_patch 交付新版本，而不必重读整份历史。
 *
 * 大纲只描述结构与短预览，不回灌完整文本——它进的是模型上下文，体积必须可控。
 * 缩进用节点在树中的位置（`0`、`0.1`）表示，与 `ui_catalog` 的字段说明互补：
 * 目录讲「字段能填什么」，大纲讲「这份界面现在是什么」。
 */
import type { GenuiChartNode, GenuiDiagramNode, GenuiDocument, GenuiNode, GenuiParam, GenuiPayload } from '../../shared/genui-api'
import type { DocumentSummary } from './session-scan'

/** 单条文本预览的字符上限；超出只给前缀，不假装是全文。 */
const PREVIEW_CHARS = 60

/** 大纲行数上限；超出停止展开，明确说明被截断。 */
const MAX_OUTLINE_LINES = 120

/** 截断预览；只在真的超长时加省略号。 */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS)}…`
}

/** 节点类型的一行描述；容器类型只描述自身，子节点另起行。 */
function describeNode(node: GenuiNode): string {
  switch (node.type) {
    case 'text':
      return `[text] ${preview(node.text)}`
    case 'list':
      return `[list] ${node.items.length} 项${node.ordered === true ? '（有序）' : ''}：${preview(node.items.join(' / '))}`
    case 'metric':
      return `[metric] ${node.label}=${node.value}${node.unit === undefined ? '' : ` ${node.unit}`}`
    case 'table':
      return `[table] 列：${node.columns.map((column) => column.key).join(', ')}；${node.rows.length} 行`
        + (node.caption === undefined ? '' : `；说明：${preview(node.caption)}`)
    case 'steps':
      return `[steps] ${node.items.length} 步：${preview(node.items.map((item) => item.title).join(' / '))}`
    case 'card':
      return `[card]${node.title === undefined ? '' : ` ${preview(node.title)}`}`
    case 'row':
      return `[row]${node.columns === undefined ? '（自动换行）' : ` ${node.columns} 列`}`
    case 'controls':
      return `[controls] ${node.params === undefined ? '全部参数' : node.params.join(', ')}`
    case 'diagram':
      return describeDiagram(node)
    case 'chart':
      return describeChart(node)
  }
}

/** 图表节点的一行描述：种类、点数与数值范围。 */
function describeChart(node: GenuiChartNode): string {
  const values = node.points.map((point) => point.value)
  const range = values.length === 0 ? '无数据' : `${Math.min(...values)}..${Math.max(...values)}`
  const unit = node.unit === undefined ? '' : ` ${node.unit}`
  const title = node.title === undefined ? '' : ` 《${preview(node.title)}》`
  return `[chart:${node.kind}]${title} ${node.points.length} 点，范围 ${range}${unit}`
}

/** 图示节点的一行描述：kind 加最能定位它的静态事实（零件数、齿数序列或 r/l）。 */
function describeDiagram(node: GenuiDiagramNode): string {
  const binds = node.binds === undefined
    ? ''
    : `；绑定 ${Object.entries(node.binds).map(([key, id]) => `${key}=${id}`).join(', ')}`
  switch (node.kind) {
    case 'exploded':
      return `[diagram:exploded] ${node.parts.length} 个零件：${preview(node.parts.map((part) => part.label).join(' / '))}${binds}`
    case 'gear':
      return `[diagram:gear] 齿数 ${node.gears.map((gear) => gear.teeth).join(':')}${binds}`
    case 'crank':
      return `[diagram:crank] r=${node.crank} l=${node.rod}${node.unit === undefined ? '' : ` ${node.unit}`}${binds}`
  }
}

/** 子节点；非容器返回 null，调用方据此不再递归。 */
function childrenOf(node: GenuiNode): readonly GenuiNode[] | null {
  if (node.type === 'card' || node.type === 'row') return node.children
  return null
}

/** 参数声明的单行描述：类型、区间或选项、占位、默认值。 */
function describeParam(param: GenuiParam): string {
  switch (param.type) {
    case 'number':
      return `number ${param.min}..${param.max}`
        + (param.step === undefined ? '' : ` step ${param.step}`)
        + ` 默认 ${param.default}`
        + (param.unit === undefined ? '' : ` ${param.unit}`)
    case 'select':
      return `select ${param.options.map((option) => option.value).join('|')} 默认 ${param.default}`
    case 'toggle':
      return `toggle 默认 ${param.default ? 'true' : 'false'}`
    case 'text':
      return `text 默认 ${param.default === '' ? '（空）' : `「${param.default}」`}`
        + (param.placeholder === undefined ? '' : ` 占位「${param.placeholder}」`)
  }
}

/** 逐层展开节点树；行数到达上限后停止，返回是否被截断。 */
function walkNodes(
  nodes: readonly GenuiNode[],
  pathPrefix: string,
  depth: number,
  lines: string[]
): boolean {
  for (const [index, node] of nodes.entries()) {
    if (lines.length >= MAX_OUTLINE_LINES) return true
    const path = pathPrefix === '' ? `${index}` : `${pathPrefix}.${index}`
    lines.push(`${'  '.repeat(depth)}${path} ${describeNode(node)}`)
    const children = childrenOf(node)
    if (children !== null && walkNodes(children, path, depth + 1, lines)) return true
  }
  return false
}

/**
 * 界面大纲：标题与版本、节点树、参数声明。
 * `revision > 0` 时提示这是同一界面的第 N 版，避免模型把旧版当唯一版本。
 */
export function formatDocumentOutline(payload: GenuiPayload): string {
  const document: GenuiDocument = payload.document
  const lines: string[] = [
    `《${document.title}》 documentId=${payload.documentId} revision=${payload.revision}`,
    `fallback：${preview(document.fallback)}`
  ]
  if (document.submitLabel !== undefined) lines.push(`提交按钮：${document.submitLabel}`)
  lines.push('节点树（路径为节点在树中的位置）：')
  const truncated = walkNodes(document.nodes, '', 0, lines)
  const params = document.params ?? []
  if (params.length > 0) {
    lines.push('参数声明：')
    for (const param of params) lines.push(`- ${param.id}（${param.label}）：${describeParam(param)}`)
  }
  if (truncated) lines.push(`（节点超过 ${MAX_OUTLINE_LINES} 行，已截断；完整内容需按节点分批查看。）`)
  return lines.join('\n')
}

/** 列表里的一项：标识、标题、当前版本与版本数。 */
export type DocumentListEntry = DocumentSummary

/** 界面列表；空列表给出明确说明，不返回空白文本。 */
export function formatDocumentList(entries: readonly DocumentListEntry[]): string {
  if (entries.length === 0) return '当前会话分支上还没有生成过界面，没有可查看的 documentId。'
  const lines = [`当前分支上的界面 ${entries.length} 份：`]
  for (const entry of entries) {
    const title = entry.title === '' ? '（标题缺失）' : `《${entry.title}》`
    lines.push(`- ${entry.documentId} ${title} 当前 revision=${entry.revision}，共 ${entry.versions} 个版本`)
  }
  lines.push('查看某份界面的结构用 ui_inspect({documentId})；修改时用 ui_patch 只发改动部分（path 取大纲里的节点路径），结构大改时带同一个 documentId 用 ui_render 重发整份。')
  return lines.join('\n')
}
