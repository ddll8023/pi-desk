/**
 * 启动时补齐受管子进程的命令搜索路径（PATH）。
 *
 * 背景：从图形界面（Finder、Dock、launchd）启动的应用只拿到系统默认 PATH，
 * 通常不含 Homebrew、nvm、volta、mise 等由登录 shell 配置注入的目录，
 * 于是 SDK 与受管脚本里对 `npm`、`git` 的查找会以 `spawn npm ENOENT` 失败。
 *
 * 做法：向登录 shell 要一次它自己的 PATH（`-ilc`，交互式以读到 .zshrc 一类的配置），
 * 与当前进程已有的 PATH 合并去重后写回 `process.env.PATH`。所有受管子进程都从
 * `process.env` 派生环境，因此在 `app.whenReady()` 之前调用一次即可覆盖全部调用点。
 *
 * 边界：只读且尽力而为。解析失败、超时或平台不支持时保留原 PATH 并补上常见安装目录，
 * 不抛出异常、不阻断启动；不解析或改写任何 shell 配置文件。
 */
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** 登录 shell 的等待上限：只影响启动的一次性读取，超时就退回静态候选目录。 */
const SHELL_TIMEOUT_MS = 3_000
/** 输出哨兵：shell 的启动脚本可能先打印无关内容，只取哨兵之间的部分。 */
const MARKER = '__PI_DESK_LOGIN_PATH__'

/**
 * 向登录 shell 询问 PATH；输出里可能混有 shell 启动脚本的打印，因此用哨兵夹出真正的一段。
 * 任何失败（shell 不存在、超时、退出码非零）都返回空数组，由调用方回退。
 */
function readLoginShellPath(): string[] {
  if (process.platform === 'win32') return []
  const shell = process.env.SHELL?.trim() || '/bin/sh'
  try {
    const output = execFileSync(shell, ['-ilc', `printf '${MARKER}%s${MARKER}' "$PATH"`], {
      encoding: 'utf8',
      timeout: SHELL_TIMEOUT_MS,
      // 交互式 shell 的提示与告警一律丢弃：只有 stdout 里的哨兵片段参与解析。
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const start = output.indexOf(MARKER)
    const end = output.lastIndexOf(MARKER)
    if (start < 0 || end <= start) return []
    return output.slice(start + MARKER.length, end).split(delimiter)
  } catch {
    return []
  }
}

/** 登录 shell 解析不到时的兜底目录：覆盖本机常见的包管理器安装位置，不存在的目录由命令查找自然忽略。 */
function fallbackPathEntries(): string[] {
  if (process.platform === 'win32') return []
  return ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')]
}

/**
 * 合并候选 PATH 片段：按出现顺序去重，保留先出现的目录。
 * 登录 shell 的结果优先，其次是进程已有 PATH，最后是兜底目录。
 */
function mergePathEntries(groups: readonly string[][]): string {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const group of groups) {
    for (const raw of group) {
      const entry = raw.trim()
      if (entry === '' || seen.has(entry)) continue
      seen.add(entry)
      entries.push(entry)
    }
  }
  return entries.join(delimiter)
}

/**
 * 补齐当前进程的 PATH；只在结果非空且与现有值不同时写回，重复调用是幂等的。
 * 返回值仅用于调用方日志，不影响后续流程。
 */
export function applyLoginShellPath(): boolean {
  const current = process.env.PATH ?? ''
  const merged = mergePathEntries([readLoginShellPath(), current.split(delimiter), fallbackPathEntries()])
  if (merged === '' || merged === current) return false
  process.env.PATH = merged
  return true
}
