/**
 * 提交历史与提交内文件清单的解析器：纯函数、无 I/O，便于单测。
 *
 * 两种输入格式都刻意用「自定义分隔符 + NUL 记录」而不是逐行文本：
 * - `git log --format=<字段用 %x1f 分隔> -z`：记录之间是 NUL，字段之间是 0x1f。
 *   标题里可能出现任何字符（包括空格、冒号、引号），用固定字段数 + 把剩余部分整体当标题才不会切错。
 * - `git diff-tree --raw --numstat -z`：先输出 `:模式 模式 sha sha 状态\0路径\0[原路径\0]` 的原始段，
 *   再输出 `增\t删\t路径`（重命名时路径字段为空，原路径与新路径各占一个 NUL 字段）。
 *   两段共用 NUL 分隔，因此必须按「先原始段、后 numstat 段」的顺序读。
 */
import type { GitChangeStatus, GitCommitFile } from '../../shared/git-api'

/** 字段分隔符：与命令行里的 `%x1f` 对应。 */
const FIELD_SEPARATOR = '\u001f'

/** 一条 log 记录解析后的样子（尚未折算成项目内路径）。 */
export interface ParsedCommit {
  readonly oid: string
  readonly shortOid: string
  readonly authorName: string
  readonly authorEmail: string
  /** 作者时间（毫秒）。 */
  readonly authoredAt: number
  readonly parents: readonly string[]
  readonly refs: readonly string[]
  readonly subject: string
}

/**
 * 解析 `git log -z --format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%s` 的输出。
 * 字段少于 8 个的记录直接丢弃：那说明输出被截断或格式被改动，宁可少一条也不编造。
 */
export function parseGitLog(output: string): ParsedCommit[] {
  const commits: ParsedCommit[] = []
  for (const record of output.split('\0')) {
    if (record === '') continue
    const parts = record.split(FIELD_SEPARATOR)
    if (parts.length < 8) continue

    const oid = parts[0] ?? ''
    const shortOid = parts[1] ?? ''
    const authorName = parts[2] ?? ''
    const authorEmail = parts[3] ?? ''
    const authoredAtSeconds = Number.parseInt(parts[4] ?? '', 10)
    const parents = (parts[5] ?? '').split(' ').filter((entry) => entry !== '')
    const refs = (parts[6] ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
    // 标题在最后：允许它自身含有分隔符，因此把剩余部分整体拼回来。
    const subject = parts.slice(7).join(FIELD_SEPARATOR).replace(/\n+$/u, '')

    if (oid === '' || !Number.isFinite(authoredAtSeconds)) continue
    commits.push({
      oid,
      shortOid,
      authorName,
      authorEmail,
      authoredAt: authoredAtSeconds * 1000,
      parents,
      refs,
      subject
    })
  }
  return commits
}

/** `--raw` 段里的状态字母到改动类型；`T`（类型变化）按修改处理。 */
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
    default:
      return 'modified'
  }
}

const RAW_RECORD = /^:[0-7]{6} [0-7]{6} [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/u

/**
 * 解析 `git diff-tree --root --no-commit-id -r --raw --numstat -z -M -C <oid>` 的输出。
 * 路径仍是**仓库根相对**的写法，由调用方折算成项目内路径。
 */
export function parseDiffTreeFiles(output: string): GitCommitFile[] {
  const records = output.split('\0')
  const files: GitCommitFile[] = []
  const stats = new Map<string, { readonly added?: number; readonly removed?: number }>()
  let index = 0

  // 第一段：`--raw` 的状态与路径。
  while (index < records.length) {
    const record = records[index] ?? ''
    if (!record.startsWith(':')) break
    const matched = RAW_RECORD.exec(record)
    index += 1
    const path = records[index] ?? ''
    index += 1
    if (matched === null || path === '') continue

    const status = statusOf(matched[1] ?? '')
    if (status === 'renamed' || status === 'copied') {
      // 重命名/复制：先原路径，后新路径。
      const newPath = records[index] ?? ''
      index += 1
      files.push({ path: newPath === '' ? path : newPath, status, oldPath: path })
      continue
    }
    files.push({ path, status })
  }

  // 第二段：`--numstat` 的行数；重命名记录的空路径后面跟着原路径与新路径。
  while (index < records.length) {
    const record = records[index] ?? ''
    index += 1
    if (record === '') continue
    const parts = record.split('\t')
    if (parts.length < 3) continue
    let path = parts[2] ?? ''
    if (path === '') {
      index += 1
      path = records[index] ?? ''
      index += 1
    }
    if (path === '') continue
    const addedRaw = parts[0] === '-' ? Number.NaN : Number.parseInt(parts[0] ?? '', 10)
    const removedRaw = parts[1] === '-' ? Number.NaN : Number.parseInt(parts[1] ?? '', 10)
    stats.set(path, {
      ...(Number.isFinite(addedRaw) ? { added: addedRaw } : {}),
      ...(Number.isFinite(removedRaw) ? { removed: removedRaw } : {})
    })
  }

  return files.map((file) => {
    const stat = stats.get(file.path)
    if (stat === undefined) return file
    return { ...file, ...stat }
  })
}
