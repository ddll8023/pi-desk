/**
 * 文档子代理的写入守卫：由宿主以 `-e` 显式加载进子进程，把写入限制在本次任务声明的范围内。
 *
 * 这里是写入边界的唯一执行点：`--tools` 只能决定子进程拿到哪些工具，管不了工具写到哪。
 * 允许范围由宿主经环境变量 `PI_SUB_AGENT_WRITE_SCOPE` 传入（绝对路径 JSON 数组，目录以分隔符结尾）。
 * 范围缺失、格式非法、路径无法解析一律拒绝写入：宁可让任务失败，也不按默认放行兜底。
 */
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

/** 守卫管理的工具：两者都以 `path` 指定目标文件。 */
const GUARDED_TOOLS = new Set(['write', 'edit'])
/** 允许范围的来源变量；宿主按任务注入，子进程不继承父级同名变量。 */
const SCOPE_ENV = 'PI_SUB_AGENT_WRITE_SCOPE'

/** 一条允许范围：目录按前缀命中，文件按全路径命中。 */
interface ScopeEntry {
  readonly path: string
  readonly dir: boolean
}

/** 解析结果：要么拿到一组允许路径，要么给出拒绝原因。 */
type ScopeResult = { readonly ok: true; readonly allowed: readonly ScopeEntry[] } | { readonly ok: false; readonly reason: string }

/**
 * 取最近一个已存在的祖先的真实路径，再拼回剩余部分。
 * 直接 `realpath` 目标文件会因新建文件失败，而只比较字面路径又放过符号链接逃逸。
 */
function realpathOfTarget(target: string): string | null {
  let head = target
  const tail: string[] = []
  for (;;) {
    try {
      return resolve(realpathSync(head), ...tail)
    } catch {
      const parent = dirname(head)
      if (parent === head) return null
      tail.unshift(head.slice(parent.length).replace(/^[/\\]/, ''))
      head = parent
    }
  }
}

/** 读取并归一化允许范围；任何异常都变成拒绝，不吞掉后继续放行。 */
function readScope(): ScopeResult {
  const raw = process.env[SCOPE_ENV]
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: '本次任务未声明写入范围' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: '写入范围格式非法' }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { ok: false, reason: '写入范围为空' }
  const allowed: ScopeEntry[] = []
  for (const item of parsed) {
    if (typeof item !== 'string' || !isAbsolute(item)) return { ok: false, reason: '写入范围必须是绝对路径' }
    // 目录标记不能交给路径归一化保留：`resolve` 会吃掉尾部分隔符，必须在归一化前记下按目录处理。
    const dir = item.endsWith('/') || item.endsWith(sep)
    const real = realpathOfTarget(dir ? item.replace(/[/\\]+$/, '') : item)
    if (real === null) return { ok: false, reason: '写入范围无法解析' }
    allowed.push({ path: real, dir })
  }
  return { ok: true, allowed }
}

/** 目录范围按分隔符边界比对，避免 `docs/` 顺带放行 `docs-old/`。 */
function isAllowed(target: string, allowed: readonly ScopeEntry[]): boolean {
  for (const entry of allowed) {
    if (entry.dir) {
      if (target === entry.path || target.startsWith(`${entry.path}${sep}`)) return true
      continue
    }
    if (target === entry.path) return true
  }
  return false
}

const factory: ExtensionFactory = pi => {
  pi.on('tool_call', (event, ctx) => {
    if (!GUARDED_TOOLS.has(event.toolName)) return undefined
    const input = event.input as { readonly path?: unknown }
    if (typeof input.path !== 'string' || input.path.length === 0) {
      return { block: true, reason: '写入工具缺少目标路径，已按越界处理' }
    }
    const scope = readScope()
    if (!scope.ok) return { block: true, reason: `${scope.reason}，已拒绝写入` }
    const target = realpathOfTarget(resolve(ctx.cwd, input.path))
    if (target === null) return { block: true, reason: '目标路径无法解析，已拒绝写入' }
    if (isAllowed(target, scope.allowed)) return undefined
    return { block: true, reason: `${input.path} 不在本次任务的写入范围内，已拒绝写入` }
  })
}

export default factory
