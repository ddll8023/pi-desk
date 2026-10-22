/**
 * `git status --porcelain=v2` 的增量解析器：纯函数、无 I/O，便于单测。
 *
 * 为什么自己解析而不是解析 `--porcelain`（v1）或用 `git status --json` 一类封装：
 * v1 的 `XY` 与重命名字段在路径含空格/引号时容易切错，v2 有固定的字段数与显式的
 * `# branch.*` 头，且 `u` 记录直接给出冲突类型。v2 自 Git 2.11 起可用，与 pi-desk 的运行环境相符。
 *
 * 实现要点（每条都对应一类真实输入）：
 * - 分块到达：`update` 只处理完整行，尾部不完整的一行留到下一块（`carry`）。
 * - CRLF：Windows 上的 git 输出可能带 `\r`，逐行剥掉。
 * - 路径引号：即使传了 `-c core.quotePath=false`，含 `"`、`\`、制表符或换行的路径仍会被 C 风格转义，
 *   因此按 git 的规则还原（含三位八进制字节），否则中文/空格/引号路径会错位或显示成转义串。
 * - 一条记录可能拆成两条条目：索引侧与工作区侧各有改动时，`1`/`2` 记录要按 `XY` 分别产出。
 * - 上限：条目数超过上限即返回 true，让调用方停掉 git 子进程，避免超大仓库把内存打满。
 */
import type { GitChangeEntry, GitChangeStatus, GitConflictKind, GitUpstream } from '../../shared/git-api'

/** 一次状态读取的解析结果；路径是**仓库根相对**的 POSIX 路径，由调用方折算成项目内路径。 */
export interface GitStatusSnapshot {
  readonly head: string | null
  readonly branch: string | null
  readonly detached: boolean
  readonly upstream: GitUpstream | null
  readonly entries: readonly GitChangeEntry[]
  readonly ignoredPaths: readonly string[]
  /** 实际看到的改动条目数（含超过上限被丢弃的部分）。 */
  readonly totalCount: number
  readonly truncated: boolean
}

export interface GitStatusParser {
  /** 喂一块文本；返回 true 表示已达到上限，调用方应停止 git。 */
  readonly update: (chunk: string) => boolean
  readonly finish: () => GitStatusSnapshot
}

/** C 风格转义的还原：git 只对少数控制字符与不可见字节做转义。 */
const ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '\\': 0x5c,
  '"': 0x22
}

/**
 * 还原 git 的 C 风格引号路径。
 * 形如 `"a\tb"`、`"caf\303\251"`：先按字节收集再整体按 UTF-8 解码，否则多字节字符会被拆坏。
 */
export function decodeGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw

  const body = raw.slice(1, -1)
  const bytes: number[] = []
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === undefined) break
    if (char !== '\\') {
      for (const byte of Buffer.from(char, 'utf8')) bytes.push(byte)
      continue
    }
    const next = body[index + 1]
    if (next === undefined) {
      bytes.push(0x5c)
      break
    }
    const escaped = ESCAPES[next]
    if (escaped !== undefined) {
      bytes.push(escaped)
      index += 1
      continue
    }
    const octal = body.slice(index + 1, index + 4)
    if (/^[0-7]{3}$/u.test(octal)) {
      bytes.push(Number.parseInt(octal, 8))
      index += 3
      continue
    }
    // 未知转义按原样保留反斜杠与字符，不吞掉内容。
    bytes.push(0x5c)
  }
  return Buffer.from(bytes).toString('utf8')
}

/** porcelain v2 的 `X`/`Y` 字符到改动类型；未知字符按修改处理，不丢条目。 */
function statusOf(char: string): GitChangeStatus {
  switch (char) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
    case 'M':
      return 'modified'
    default:
      return 'modified'
  }
}

/** 未合并记录的 `XY` 组合到冲突类型；其余组合不产生条目。 */
function conflictKindOf(xy: string): GitConflictKind | null {
  switch (xy) {
    case 'UU':
      return 'both_modified'
    case 'AA':
      return 'both_added'
    case 'DD':
      return 'both_deleted'
    case 'AU':
      return 'added_by_us'
    case 'UA':
      return 'added_by_them'
    case 'DU':
      return 'deleted_by_us'
    case 'UD':
      return 'deleted_by_them'
    default:
      return null
  }
}

/** 冲突条目的展示状态：只有「双方都删除」能确定结果，其余交给冲突类型文案。 */
function conflictStatusOf(kind: GitConflictKind): GitChangeStatus {
  return kind === 'both_deleted' ? 'deleted' : 'modified'
}

function parseAheadBehind(value: string): { ahead: number; behind: number } | null {
  const match = /^\+(\d+) -(\d+)$/u.exec(value.trim())
  if (match === null) return null
  return { ahead: Number.parseInt(match[1] ?? '0', 10), behind: Number.parseInt(match[2] ?? '0', 10) }
}

/**
 * 创建一个增量解析器；`limit` 为条目上限（0 表示不设上限，仅测试使用）。
 * 达到上限后仍会记录 `totalCount`，但不再累积条目，并让调用方停掉 git。
 */
export function createGitStatusParser(limit: number): GitStatusParser {
  const entries: GitChangeEntry[] = []
  const ignoredPaths: string[] = []
  let carry = ''
  let totalCount = 0
  let truncated = false

  let head: string | null = null
  let branch: string | null = null
  let detached = false
  let upstreamName: string | null = null
  let aheadBehind: { ahead: number; behind: number } | null = null

  const exceeded = (): boolean => limit > 0 && totalCount > limit

  function push(entry: GitChangeEntry): void {
    totalCount += 1
    if (limit > 0 && entries.length >= limit) {
      truncated = true
      return
    }
    entries.push(entry)
  }

  function parseBranchHeader(line: string): void {
    if (line.startsWith('# branch.oid ')) {
      const value = line.slice('# branch.oid '.length).trim()
      head = value === '' || value === '(initial)' ? null : value
      return
    }
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim()
      if (value === '' || value === '(detached)') {
        branch = null
        detached = true
      } else {
        branch = value
        detached = false
      }
      return
    }
    if (line.startsWith('# branch.upstream ')) {
      const value = line.slice('# branch.upstream '.length).trim()
      upstreamName = value === '' ? null : value
      return
    }
    if (line.startsWith('# branch.ab ')) {
      aheadBehind = parseAheadBehind(line.slice('# branch.ab '.length))
    }
  }

  /** 类型 1/2 记录：`X` 是索引侧、`Y` 是工作区侧，`.` 表示该侧没有改动。 */
  function parseChangedEntry(line: string): void {
    const isRename = line.startsWith('2 ')
    const parts = line.split(' ')
    const xy = parts[1] ?? ''
    const indexChar = xy[0] ?? '.'
    const worktreeChar = xy[1] ?? '.'

    let path: string
    let oldPath: string | null = null
    if (isRename) {
      // 重命名记录的路径与原名以制表符分隔；路径本身可能含空格，因此不能按空格切最后一段。
      const tabParts = line.split('\t')
      path = decodeGitPath((tabParts[0] ?? '').split(' ').slice(9).join(' '))
      oldPath = tabParts.length > 1 ? decodeGitPath(tabParts.slice(1).join('\t')) : null
    } else {
      path = decodeGitPath(parts.slice(8).join(' '))
    }
    if (path === '') return

    if (indexChar !== '.') {
      push({
        path,
        area: 'staged',
        status: statusOf(indexChar),
        ...(oldPath === null || oldPath === '' ? {} : { oldPath })
      })
    }
    if (worktreeChar !== '.') {
      // 工作区侧的重命名没有意义（原名已在索引里），因此只在索引侧带 oldPath。
      push({ path, area: 'unstaged', status: statusOf(worktreeChar) })
    }
  }

  /** 未合并记录：`u XY sub m1 m2 m3 mW h1 h2 h3 path`，路径从第 11 个字段开始。 */
  function parseUnmergedEntry(line: string): void {
    const parts = line.split(' ')
    const kind = conflictKindOf(parts[1] ?? '')
    if (kind === null) return
    const path = decodeGitPath(parts.slice(10).join(' '))
    if (path === '') return
    push({ path, area: 'unstaged', status: conflictStatusOf(kind), conflictKind: kind })
  }

  function parseLine(line: string): void {
    if (line === '') return
    const first = line[0]
    if (first === '#') {
      parseBranchHeader(line)
      return
    }
    if (first === '1' || first === '2') {
      parseChangedEntry(line)
      return
    }
    if (first === 'u') {
      parseUnmergedEntry(line)
      return
    }
    if (first === '?') {
      const path = decodeGitPath(line.slice(2))
      if (path !== '') push({ path, area: 'untracked', status: 'untracked' })
      return
    }
    if (first === '!') {
      const path = decodeGitPath(line.slice(2))
      if (path !== '') ignoredPaths.push(path)
    }
  }

  function update(chunk: string): boolean {
    const text = carry + chunk
    let start = 0
    while (true) {
      const newline = text.indexOf('\n', start)
      if (newline === -1) break
      let end = newline
      if (end > start && text.charCodeAt(end - 1) === 13) end -= 1
      parseLine(text.slice(start, end))
      start = newline + 1
      if (exceeded()) {
        carry = ''
        truncated = true
        return true
      }
    }
    carry = text.slice(start)
    return false
  }

  function finish(): GitStatusSnapshot {
    // 最后一行可能没有换行符（正常 git 输出都有，测试与异常输入可能没有）。
    if (carry !== '') {
      parseLine(carry.endsWith('\r') ? carry.slice(0, -1) : carry)
      carry = ''
    }
    return {
      head,
      branch,
      detached,
      upstream: upstreamName === null
        ? null
        : { name: upstreamName, ahead: aheadBehind?.ahead ?? 0, behind: aheadBehind?.behind ?? 0 },
      entries,
      ignoredPaths,
      totalCount,
      truncated: truncated || exceeded()
    }
  }

  return { update, finish }
}

/** 一次性解析完整输出；测试与「已经拿到全部输出」的调用方用。 */
export function parseGitStatusOutput(output: string, limit = 0): GitStatusSnapshot {
  const parser = createGitStatusParser(limit)
  parser.update(output)
  return parser.finish()
}
