/**
 * 子代理与团队成员轮的写入守卫：由宿主以 `-e` 显式加载进子进程，把写入限制在本次任务声明的范围内。
 *
 * 这里是写入边界的唯一执行点：`--tools` 只能决定子进程拿到哪些工具，管不了工具写到哪。
 * 允许范围由宿主经环境变量 `PI_SUB_AGENT_WRITE_SCOPE` 传入（绝对路径 JSON 数组，目录以分隔符结尾）。
 * 范围缺失、格式非法、路径无法解析一律拒绝写入：宁可让任务失败，也不按默认放行兜底。
 * 路径解析与边界比较复用 `write-scope`，与专家写入守卫共用同一份实现。
 */
import { resolve } from 'node:path'
import { isInsideWriteScope, realpathOfTarget, resolveWriteScope } from '../write-scope'
import type { WriteScopeEntry } from '../write-scope'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

/** 守卫管理的工具：两者都以 `path` 指定目标文件。 */
const GUARDED_TOOLS = new Set(['write', 'edit'])
/** 允许范围的来源变量；宿主按任务注入，子进程不继承父级同名变量。 */
const SCOPE_ENV = 'PI_SUB_AGENT_WRITE_SCOPE'

/** 解析结果：要么拿到一组允许路径，要么给出拒绝原因。 */
type ScopeResult = { readonly ok: true; readonly allowed: readonly WriteScopeEntry[] } | { readonly ok: false; readonly reason: string }

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
  if (!parsed.every((item): item is string => typeof item === 'string')) {
    return { ok: false, reason: '写入范围必须是绝对路径' }
  }
  const allowed = resolveWriteScope(parsed)
  return allowed === null ? { ok: false, reason: '写入范围无法解析' } : { ok: true, allowed }
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
    if (isInsideWriteScope(target, scope.allowed)) return undefined
    return { block: true, reason: `${input.path} 不在本次任务的写入范围内，已拒绝写入` }
  })
}

export default factory
