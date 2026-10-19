/**
 * 把生成式界面文档序列化成 Markdown，供界面上的「复制 Markdown」使用。
 *
 * 边界：只做结构到文本的映射，不读 DOM、不做视觉还原、不引入 Markdown 渲染器。
 * 图形节点输出的是数据与结论——图表的坐标映射、图解的传动比与位移都已由几何层算出，
 * 这里直接复用它们的 `notes`，不另写一套计算，避免复制出的结论与屏幕上不一致。
 *
 * 取值来源是参数上下文里的当前值：图解绑定（`binds`）会随用户调节变化，
 * 复制时取的是屏幕上的那一刻，回落规则与渲染端共用 `readGenuiBinding`。
 *
 * 表格输出全部行，不受界面上「前 6 行」预览的限制；单元格里的竖线与换行做转义，
 * 否则一行数据会把整张表拆坏。正文文本原样输出，不转义 Markdown 标记：用户或模型写的
 * `*`、`_` 应当保持原意，替他们决定哪些该被转义反而会改变内容。
 */
import type {
  GenuiChartNode,
  GenuiDiagramNode,
  GenuiDocument,
  GenuiNode,
  GenuiParam,
  GenuiParamValue,
  GenuiTableNode
} from '../../../shared/genui-api'
import { formatShare, layoutBarChart, layoutLineChart, layoutPieChart } from './chart-geometry'
import { layoutCrank, layoutExploded, layoutGearTrain } from './diagram-geometry'
import { readGenuiBinding } from './param-state'
import type { SvgLayout } from './svg-shapes'

/** 卡片与分栏嵌套时标题最多降到六级，再深就退回加粗行。 */
const MAX_HEADING_LEVEL = 6

/** 表格单元格转义：竖线会切断列，换行会切断行。 */
function cellText(value: string | number | undefined): string {
  if (value === undefined) return ''
  const text = typeof value === 'number' ? String(value) : value
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

/** 按层级输出标题；超过六级时用加粗行代替，不造出不存在的 Markdown 语法。 */
function heading(level: number, text: string): string {
  return level <= MAX_HEADING_LEVEL ? `${'#'.repeat(level)} ${text}` : `**${text}**`
}

/** 拼接多个块：空块直接跳过，块之间只留一个空行，避免控件这类不输出内容的节点堆出连续空行。 */
function joinBlocks(blocks: readonly (readonly string[])[]): string[] {
  const lines: string[] = []
  for (const block of blocks) {
    if (block.length === 0) continue
    if (lines.length > 0) lines.push('')
    lines.push(...block)
  }
  return lines
}

/** 表格：列顺序按声明顺序，行数全量。 */
function tableMarkdown(node: GenuiTableNode): string[] {
  const lines = [
    `| ${node.columns.map((column) => cellText(column.label)).join(' | ')} |`,
    `| ${node.columns.map(() => '---').join(' | ')} |`
  ]
  for (const row of node.rows) {
    lines.push(`| ${node.columns.map((column) => cellText(row[column.key])).join(' | ')} |`)
  }
  if (node.caption !== undefined) lines.push('', node.caption)
  return lines
}

/**
 * 图表：数据表 + 结论。图形本身不复制，复制的是它能表达的事实。
 * 柱/折线按序列展成多列；饼/环图改给「数值 + 占比」两列，并补一行总计。
 */
function chartMarkdown(node: GenuiChartNode): string[] {
  const share = node.kind === 'pie' || node.kind === 'donut'
  const layout = chartLayout(node)
  const lines: string[] = []
  if (node.title !== undefined) lines.push(heading(3, node.title))
  const unit = node.unit === undefined ? '' : ` ${node.unit}`
  if (share) {
    const values = node.series[0]?.values ?? []
    const total = values.reduce((sum, value) => sum + value, 0)
    lines.push('| 分类 | 数值 | 占比 |', '| --- | --- | --- |')
    for (const [index, label] of node.labels.entries()) {
      const value = values[index] ?? 0
      lines.push(`| ${cellText(label)} | ${value}${unit} | ${formatShare(value, total)} |`)
    }
    lines.push(`| 总计 | ${total}${unit} | 100% |`)
  } else {
    // 列名取序列名；无名序列（旧形状或单序列）统一叫「数值」，与几何层的说明口径一致。
    const headers = node.series.map((series, index) => cellText(series.name ?? (index === 0 ? '数值' : `序列 ${index + 1}`)))
    lines.push(`| 分类 | ${headers.join(' | ')} |`, `| --- | ${node.series.map(() => '---').join(' | ')} |`)
    for (const [index, label] of node.labels.entries()) {
      const cells = node.series.map((series) => `${series.values[index] ?? 0}${unit}`)
      lines.push(`| ${cellText(label)} | ${cells.join(' | ')} |`)
    }
  }
  if (node.caption !== undefined) lines.push('', node.caption)
  lines.push('', ...layout.notes.map((note) => `- ${note}`))
  return lines
}

/** 按 kind 取几何；显式分派，避免新增种类时被当成折线图算。 */
function chartLayout(node: GenuiChartNode): SvgLayout {
  switch (node.kind) {
    case 'bar': return layoutBarChart(node.labels, node.series, node.unit)
    case 'line': return layoutLineChart(node.labels, node.series, node.unit)
    case 'pie':
    case 'donut': return layoutPieChart(node.labels, node.series[0]?.values ?? [], node.unit, node.kind === 'donut')
  }
}

/** 图解：按种类给出静态数据与几何层算出的结论；绑定取值取当前参数。 */
function diagramMarkdown(node: GenuiDiagramNode, values: Readonly<Record<string, GenuiParamValue>>): string[] {
  const angle = readGenuiBinding(values, node.binds?.angle) ?? 0
  const spread = readGenuiBinding(values, node.binds?.spread) ?? 0
  const lines: string[] = []
  switch (node.kind) {
    case 'exploded': {
      const layout = layoutExploded(node.parts, spread)
      lines.push('零件：')
      for (const [index, part] of node.parts.entries()) {
        lines.push(`- ${index + 1}. ${part.label}${part.note === undefined ? '' : `：${part.note}`}`)
      }
      lines.push('', ...layout.notes.map((note) => `- ${note}`))
      break
    }
    case 'gear': {
      const layout = layoutGearTrain(node.gears, angle)
      lines.push('齿轮：')
      for (const gear of node.gears) lines.push(`- ${gear.label}：${gear.teeth} 齿`)
      lines.push('', ...layout.notes.map((note) => `- ${note}`))
      break
    }
    case 'crank': {
      const layout = layoutCrank(node.crank, node.rod, angle, node.unit)
      lines.push(`曲柄 ${node.crank}${node.unit ?? ''}，连杆 ${node.rod}${node.unit ?? ''}`)
      lines.push('', ...layout.notes.map((note) => `- ${note}`))
      break
    }
  }
  if (node.caption !== undefined) lines.push('', node.caption)
  return lines
}

/** 参数小节的取值文本：与提交层同一口径，带单位、空文本写明未填写。 */
function paramValueText(param: GenuiParam, value: GenuiParamValue | undefined): string {
  const current = value === undefined ? param.default : value
  switch (param.type) {
    case 'number': {
      const unit = param.unit === undefined ? '' : ` ${param.unit}`
      return `${typeof current === 'number' ? current : param.default}${unit}`
    }
    case 'select': {
      const raw = typeof current === 'string' ? current : param.default
      const option = param.options.find((item) => item.value === raw)
      return option === undefined || option.label === raw ? raw : `${option.label}（${raw}）`
    }
    case 'toggle':
      return (typeof current === 'boolean' ? current : param.default) ? '是' : '否'
    case 'text': {
      const raw = typeof current === 'string' ? current : param.default
      return raw === '' ? '（未填写）' : raw
    }
  }
}

/** 单节点输出；`level` 是当前允许使用的标题层级，由外层容器决定。 */
function nodeMarkdown(node: GenuiNode, values: Readonly<Record<string, GenuiParamValue>>, level: number): string[] {
  switch (node.type) {
    case 'text':
      return [node.text]
    case 'list':
      return node.items.map((item, index) => (node.ordered === true ? `${index + 1}. ${item}` : `- ${item}`))
    case 'metric': {
      const unit = node.unit === undefined ? '' : ` ${node.unit}`
      return [`**${node.label}**：${node.value}${unit}`]
    }
    case 'table':
      return tableMarkdown(node)
    case 'steps':
      return node.items.flatMap((item, index) => [
        `${index + 1}. **${item.title}**`,
        ...(item.description === undefined ? [] : [`   ${item.description}`])
      ])
    case 'timeline':
      // 时间是可横向比较的列，表格比「列表 + 时间前缀」更贴合数据结构；时间原样输出，不重排。
      return [
        '| 时间 | 事件 | 说明 |',
        '| --- | --- | --- |',
        ...node.items.map((item) => `| ${cellText(item.time)} | ${cellText(item.title)} | ${cellText(item.description)} |`)
      ]
    case 'card': {
      const children = node.children.map((child) => nodeMarkdown(child, values, level + 1))
      return joinBlocks([node.title === undefined ? [] : [heading(level, node.title)], ...children])
    }
    case 'row':
      // 分栏在纯文本里没有并排语义，按声明顺序展开，保持阅读顺序与屏幕一致。
      return joinBlocks(node.children.map((child) => nodeMarkdown(child, values, level)))
    case 'controls':
      // 控件本身不复制，当前取值统一放在文末的参数小节，避免与界面元素重复。
      return []
    case 'diagram':
      return diagramMarkdown(node, values)
    case 'chart':
      return chartMarkdown(node)
  }
}

/**
 * 整份界面的 Markdown：标题 + 按节点顺序的正文 + 参数小节。
 * 不输出 `fallback`：它是界面无法渲染时的替代文本，与正文内容重复。
 */
export function genuiDocumentToMarkdown(
  document: GenuiDocument,
  values: Readonly<Record<string, GenuiParamValue>>
): string {
  const blocks: string[] = [heading(1, document.title)]
  for (const node of document.nodes) {
    const lines = nodeMarkdown(node, values, 2)
    if (lines.length > 0) blocks.push(lines.join('\n'))
  }
  const params = document.params ?? []
  if (params.length > 0) {
    const rows = params.map((param) => `| ${cellText(param.label)} | ${cellText(paramValueText(param, values[param.id]))} |`)
    blocks.push([heading(2, '参数'), '', '| 参数 | 当前取值 |', '| --- | --- |', ...rows].join('\n'))
  }
  return `${blocks.join('\n\n').trimEnd()}\n`
}
