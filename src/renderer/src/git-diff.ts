/**
 * 把两侧文本折成可渲染的行级差异：纯函数、无 DOM、可单测。
 *
 * 为什么自己算而不是把补丁文本丢给界面：主进程给的是「原内容 + 新内容」，界面需要行号、增删计数
 * 与可滚动的统一视图。这里用「去公共前后缀 + LCS」的经典做法：真实改动通常只占文件的一小段，
 * 去掉公共部分后中间区域很小，LCS 的 O(n·m) 才不会被大文件拖死；中间区域仍然过大时退化为
 * 「整段删除 + 整段新增」，并标记 `truncated`，界面据此提示而不是假装算完。
 */

/** 一行的角色：上下文、新增或删除。 */
export type GitDiffRowKind = 'context' | 'add' | 'remove'

/** 统一视图的一行；`oldLine`/`newLine` 在另一侧不存在时为 null。 */
export interface GitDiffRow {
  readonly kind: GitDiffRowKind
  readonly text: string
  readonly oldLine: number | null
  readonly newLine: number | null
}

export interface GitDiffRows {
  readonly rows: readonly GitDiffRow[]
  readonly added: number
  readonly removed: number
  /** 因为体积或行数上限只给了粗略结果；界面据此提示。 */
  readonly truncated: boolean
}

/** 中间区域参与 LCS 的最大单元数：2000×2000。超出即退化为整段替换。 */
const MAX_LCS_CELLS = 4_000_000

/** 单次渲染的最大行数；再多也没有阅读价值，滚动本身会成为负担。 */
const MAX_DIFF_ROWS = 5000

/** 按 `\n` 切行；末尾换行不算多出一行。 */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 计算行级差异；一侧为 null 表示该侧不存在（新增或删除文件），全部按新增/删除处理。
 */
export function buildDiffRows(original: string | null, modified: string | null): GitDiffRows {
  const before = original === null ? [] : splitLines(original)
  const after = modified === null ? [] : splitLines(modified)

  if (original === null) {
    return finish(after.map((text, index) => row('add', text, null, index + 1)), 0)
  }
  if (modified === null) {
    return finish(before.map((text, index) => row('remove', text, index + 1, null)), 0)
  }

  // 1) 去掉公共前缀与后缀：绝大多数改动只落在中间一小段。
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const rows: GitDiffRow[] = []
  for (let index = 0; index < prefix; index += 1) {
    rows.push(row('context', before[index] ?? '', index + 1, index + 1))
  }

  const middleBefore = before.slice(prefix, before.length - suffix)
  const middleAfter = after.slice(prefix, after.length - suffix)
  const middle = diffMiddle(middleBefore, middleAfter, prefix)
  rows.push(...middle.rows)

  const contextStart = before.length - suffix
  for (let index = 0; index < suffix; index += 1) {
    const lineNumber = contextStart + index + 1
    rows.push(row('context', before[contextStart + index] ?? '', lineNumber, after.length - suffix + index + 1))
  }

  return finish(rows, middle.truncated ? 1 : 0)
}

function diffMiddle(before: readonly string[], after: readonly string[], offset: number): { rows: GitDiffRow[]; truncated: boolean } {
  if (before.length === 0) {
    return {
      rows: after.map((text, index) => row('add', text, null, offset + index + 1)),
      truncated: false
    }
  }
  if (after.length === 0) {
    return {
      rows: before.map((text, index) => row('remove', text, offset + index + 1, null)),
      truncated: false
    }
  }
  if (before.length * after.length > MAX_LCS_CELLS) {
    return {
      rows: [
        ...before.map((text, index) => row('remove', text, offset + index + 1, null)),
        ...after.map((text, index) => row('add', text, null, offset + index + 1))
      ],
      truncated: true
    }
  }

  // 2) LCS：`table[i][j]` 是 before[i..] 与 after[j..] 的最长公共子序列长度。
  const width = after.length + 1
  const table = new Int32Array((before.length + 1) * width)
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = before[i] === after[j]
        ? (table[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
    }
  }

  const rows: GitDiffRow[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      rows.push(row('context', before[i] ?? '', offset + i + 1, offset + j + 1))
      i += 1
      j += 1
      continue
    }
    const down = table[(i + 1) * width + j] ?? 0
    const right = table[i * width + j + 1] ?? 0
    if (down >= right) {
      rows.push(row('remove', before[i] ?? '', offset + i + 1, null))
      i += 1
      continue
    }
    rows.push(row('add', after[j] ?? '', null, offset + j + 1))
    j += 1
  }
  while (i < before.length) {
    rows.push(row('remove', before[i] ?? '', offset + i + 1, null))
    i += 1
  }
  while (j < after.length) {
    rows.push(row('add', after[j] ?? '', null, offset + j + 1))
    j += 1
  }
  return { rows, truncated: false }
}

function row(kind: GitDiffRowKind, text: string, oldLine: number | null, newLine: number | null): GitDiffRow {
  return { kind, text, oldLine, newLine }
}

/** 统计增删行并按上限截断；`forcedTruncated` 用于把「粗略结果」也标成截断。 */
function finish(rows: readonly GitDiffRow[], forcedTruncated: number): GitDiffRows {
  let added = 0
  let removed = 0
  for (const entry of rows) {
    if (entry.kind === 'add') added += 1
    if (entry.kind === 'remove') removed += 1
  }
  const truncated = rows.length > MAX_DIFF_ROWS || forcedTruncated > 0
  return {
    rows: truncated ? rows.slice(0, MAX_DIFF_ROWS) : rows,
    added,
    removed,
    truncated
  }
}
