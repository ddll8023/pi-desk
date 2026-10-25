/**
 * 右侧面板文件条目的拖拽载荷、路径引用文本与「写入终端」前的转义。
 *
 * 拖拽只在应用内成立：载荷写进自定义 MIME，不写 `text/plain`，因此拖到应用外不会带出路径，
 * 也不会被别的输入框当成文本收下。载荷里带上项目路径，落点可以复核这次拖动是否仍属于当前项目。
 * 落点有两个：终端面板写入带引号的绝对路径，输入坞插入项目相对路径文本（不读文件内容）。
 *
 * 路径一律由主进程解析成绝对路径后才写入终端；这里的引号规则按终端实际启动的 shell 可执行名判定，
 * 因为终端的工作目录固定是项目根，但用户可能已经在里面切到别处，绝对路径不依赖当前目录。
 */
import type { ProjectDirectoryEntryKind } from '../../../shared/project-file-api'

/** 应用内文件拖拽的自定义 MIME；落点只认这一种载荷。 */
export const PROJECT_ENTRY_DRAG_MIME = 'application/x-pi-desk-project-entry'

/** 一次文件拖动携带的最小信息：项目根用于复核归属，相对路径用于交给主进程解析。 */
export interface ProjectEntryDragPayload {
  readonly projectPath: string
  readonly path: string
  readonly name: string
  readonly kind: ProjectDirectoryEntryKind
}

const ENTRY_KINDS: readonly string[] = ['directory', 'file', 'other']

/** 写入拖动载荷；不写 `text/plain`，避免拖到输入框时被当作纯文本插入。 */
export function setProjectEntryDragData(event: DragEvent, payload: ProjectEntryDragPayload): void {
  const transfer = event.dataTransfer
  if (transfer === null) return
  transfer.effectAllowed = 'copy'
  transfer.setData(PROJECT_ENTRY_DRAG_MIME, JSON.stringify(payload))
}

/**
 * 拖动经过落点时只读得到类型、读不到内容，因此用类型判断是否值得接受；
 * 内容是否合法留到 drop 时由 `readProjectEntryDragData` 判定。
 */
export function hasProjectEntryDragData(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  return types !== undefined && Array.from(types).includes(PROJECT_ENTRY_DRAG_MIME)
}

/** 读取并校验拖动载荷；不是本应用的载荷或结构不符时返回 null，落点据此忽略这次拖动。 */
export function readProjectEntryDragData(event: DragEvent): ProjectEntryDragPayload | null {
  const raw = event.dataTransfer?.getData(PROJECT_ENTRY_DRAG_MIME) ?? ''
  if (raw === '') return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const fields = value as Record<string, unknown>
  if (typeof fields.projectPath !== 'string' || fields.projectPath === '') return null
  if (typeof fields.path !== 'string' || fields.path === '') return null
  if (typeof fields.name !== 'string' || fields.name === '') return null
  if (typeof fields.kind !== 'string' || !ENTRY_KINDS.includes(fields.kind)) return null
  return {
    projectPath: fields.projectPath,
    path: fields.path,
    name: fields.name,
    kind: fields.kind as ProjectDirectoryEntryKind
  }
}

/**
 * 项目内条目的路径引用文本：含空白且不含双引号的路径用双引号包起来（含引号的路径原样写入，不删改字符），
 * 末尾补一个空格便于接着输入。输入坞的拖入落点与 `@` 补全共用这一条规则。
 */
export function projectEntryReferenceText(path: string): string {
  const quoted = /\s/u.test(path) && !path.includes('"') ? `"${path}"` : path
  return `${quoted} `
}

/** `cmd.exe` 不认单引号，只有它用双引号；zsh、bash 与 pwsh 都按 POSIX 单引号转义。 */
function isCmdShell(shellFile: string): boolean {
  const name = (shellFile.replace(/\\/gu, '/').split('/').pop() ?? '').toLowerCase()
  return name === 'cmd' || name === 'cmd.exe'
}

/** 路径加引号：单引号内除单引号本身都是字面量，单引号按 `'\''` 收尾再续。 */
export function quoteShellPath(shellFile: string, absolutePath: string): string {
  if (isCmdShell(shellFile)) return `"${absolutePath}"`
  return `'${absolutePath.replace(/'/gu, "'\\''")}'`
}

/** 插入终端的文本：带引号的绝对路径加一个空格，用户接着补命令，不隐式回车。 */
export function projectEntryInsertText(shellFile: string, absolutePath: string): string {
  return `${quoteShellPath(shellFile, absolutePath)} `
}
