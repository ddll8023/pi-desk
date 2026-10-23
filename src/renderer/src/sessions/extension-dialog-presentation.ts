/**
 * Extension 对话弹窗的展示层拆解：把 Pi 侧透传的纯文本 title / options 拆成问题、预览块、
 * 编号选项与说明行，供弹窗分层渲染；并提供多选作答草稿（`1,3; 自定义文本`）的编号解析与切换。
 *
 * 只做展示拆解，不改变协议与响应值：无法识别的文本一律原样回退，响应提交始终使用原始字符串。
 * 依赖的上游文本格式来自 @juicesharp/rpiv-ask-user-question 的 RPC 回退路径
 * （`N. 标签 — 描述`、`--- N. 标签 preview ---`）；格式变化只会退化为单段文本渲染。
 */

/** 解析后的选项：描述为 null 表示该行只有标签。 */
export interface DialogOption {
  readonly label: string
  readonly description: string | null
  /** 原始文本；提交响应时必须原样回传。 */
  readonly raw: string
}

/** 标题里的预览块；`index` 与 `label` 取自标记行，正文保留原始换行。 */
export interface DialogPreview {
  readonly index: number
  readonly label: string
  readonly text: string
}

/** 标题的拆解结果；除 `question` 外各字段缺省表示标题里没有对应内容。 */
export interface DialogContent {
  /** `[Header]` 前缀的分类标签；null 表示标题没有前缀。 */
  readonly header: string | null
  /** 问题正文（已去掉前缀、预览块与编号清单）；标题全空时回退为原始标题。 */
  readonly question: string
  readonly previews: readonly DialogPreview[]
  /** 标题内嵌的编号清单；null 表示标题里没有可识别的清单。 */
  readonly list: readonly DialogOption[] | null
  /** 清单之后的说明文字（多选指令、自定义回答提示）；null 表示没有。 */
  readonly hint: string | null
}

const HEADER_PREFIX = /^\[([^\]\n]{1,40})\][ \t]*/
const PREVIEW_MARKER = /^---[ \t]*(\d+)\.[ \t]*(.*?)[ \t]+preview[ \t]*---[ \t]*$/
const NUMBERED_LINE = /^[ \t]*(\d+)\.[ \t]+(\S.*)$/
const DESCRIPTION_SPLIT = /^([\s\S]*?)[ \t]+—[ \t]+([\s\S]+)$/

/** 清单至少两项才算清单，避免把正文里单独一行「1. …」误判为选项。 */
const MIN_LIST_ITEMS = 2

/** 取捕获组：缺失的组按空串处理，避免可空下标在解析逻辑里扩散。 */
function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? ''
}

/** 按 `标签 — 描述` 拆一行选项文本；没有分隔符时整行作为标签。 */
function toOption(raw: string): DialogOption {
  const match = DESCRIPTION_SPLIT.exec(raw)
  if (match === null) return { label: raw, description: null, raw }
  return { label: group(match, 1), description: group(match, 2), raw }
}

/** 从问题正文里拆出编号清单与清单后的说明；编号必须从 1 起连续，否则整段按正文处理。 */
function splitNumberedList(text: string): Pick<DialogContent, 'question' | 'list' | 'hint'> {
  const lines = text.split(/\r?\n/)
  for (let start = 0; start < lines.length; start++) {
    const firstLine = lines[start]
    if (firstLine === undefined) continue
    const first = NUMBERED_LINE.exec(firstLine)
    if (first === null || Number(group(first, 1)) !== 1) continue

    const list: DialogOption[] = [toOption(group(first, 2))]
    let end = start
    for (;;) {
      const nextLine = lines[end + 1]
      if (nextLine === undefined) break
      const next = NUMBERED_LINE.exec(nextLine)
      if (next === null || Number(group(next, 1)) !== end - start + 2) break
      end += 1
      list.push(toOption(group(next, 2)))
    }
    if (list.length < MIN_LIST_ITEMS) continue

    const hint = lines.slice(end + 1).join('\n').trim()
    return { question: lines.slice(0, start).join('\n').trim(), list, hint: hint === '' ? null : hint }
  }
  return { question: text, list: null, hint: null }
}

/** 拆解标题：`[Header]` 前缀、问题正文、预览块与内嵌编号清单。 */
export function parseDialogTitle(title: string): DialogContent {
  const headerMatch = HEADER_PREFIX.exec(title)
  const header = headerMatch === null ? null : group(headerMatch, 1)
  const body = headerMatch === null ? title : title.slice(group(headerMatch, 0).length)

  const questionLines: string[] = []
  const previews: DialogPreview[] = []
  let current: { index: number; label: string; lines: string[] } | null = null

  for (const line of body.split(/\r?\n/)) {
    const marker = PREVIEW_MARKER.exec(line)
    if (marker !== null) {
      if (current !== null) {
        previews.push({ index: current.index, label: current.label, text: current.lines.join('\n').trim() })
      }
      current = { index: Number(group(marker, 1)), label: group(marker, 2).trim(), lines: [] }
      continue
    }
    if (current === null) questionLines.push(line)
    else current.lines.push(line)
  }
  if (current !== null) {
    previews.push({ index: current.index, label: current.label, text: current.lines.join('\n').trim() })
  }

  const split = splitNumberedList(questionLines.join('\n').trim())
  return {
    header,
    question: split.question === '' ? (header ?? title.trim()) : split.question,
    previews,
    list: split.list,
    hint: split.hint
  }
}

/**
 * 拆解 select 的选项：整组都能识别为 `N. …` 且编号连续时才带标签与描述，
 * 否则整行作为标签回退（如 SDK 自身的 "Allow once" 类选项）。
 */
export function parseOptionRows(options: readonly string[]): readonly DialogOption[] {
  const numbered: DialogOption[] = []
  for (const [position, option] of options.entries()) {
    const match = NUMBERED_LINE.exec(option)
    if (match === null || Number(group(match, 1)) !== position + 1) {
      return options.map(raw => ({ label: raw, description: null, raw }))
    }
    numbered.push({ ...toOption(group(match, 2)), raw: option })
  }
  return numbered
}

/** 多选作答的草稿拆解：分号前是编号 token，分号后是自定义文本（没有分号时为 null）。 */
export interface SelectionDraft {
  readonly tokens: readonly string[]
  readonly custom: string | null
}

/** 按上游约定的 `1,3; 自定义文本` 格式拆草稿；非编号内容原样留在 token 里，不丢弃用户输入。 */
export function parseSelectionTokens(value: string): SelectionDraft {
  const separator = value.indexOf(';')
  const numbers = separator === -1 ? value : value.slice(0, separator)
  const custom = separator === -1 ? null : value.slice(separator + 1)
  return { tokens: numbers.split(/[,\s]+/).filter(token => token !== ''), custom }
}

/** 勾选或取消一个编号：自定义文本原样保留，编号按原顺序回写为逗号分隔。 */
export function toggleSelection(value: string, index: number): string {
  const { tokens, custom } = parseSelectionTokens(value)
  const token = String(index)
  const next = tokens.includes(token) ? tokens.filter(item => item !== token) : [...tokens, token]
  const numbers = next.join(',')
  return custom === null ? numbers : `${numbers};${custom}`
}
