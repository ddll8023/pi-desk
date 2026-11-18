/**
 * 专家写入守卫：把 `write` 与 `edit` 的目标限制在专家声明的写入范围内。
 *
 * 只在专家声明了范围时装配（不写声明等于不限制）；范围是项目内相对路径，装配期以会话执行根为基准解析成绝对路径。
 * 这里与工具范围正交：工具范围决定本会话有没有写工具，这一层决定能写到哪里。
 * 边界说明：`bash` 的重定向同样能写文件，它不经过工具参数的路径检查，本守卫不声称已闭合那条路。
 */
import { resolve } from 'node:path'
import { isInsideWriteScope, realpathOfTarget, resolveWriteScope, toAbsoluteWriteScope } from './write-scope'
import type { WriteScopeEntry } from './write-scope'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

/** 守卫管理的工具：两者都以 `path` 指定目标文件。 */
const GUARDED_TOOLS = new Set(['write', 'edit'])

/** 该扩展在会话装配里的名字：与其他扩展并列，便于替换与诊断。 */
export const EXPERT_WRITE_GUARD_EXTENSION_NAME = 'expert-write-guard'

/**
 * 组装专家写入守卫。范围在工厂外解析一次：会话创建时算好，本会话内不再随文件系统变动重算。
 * 解析失败或范围项非法时宁可直接拒绝传入，也不退化成“不限制”。
 */
export function createExpertWriteGuardExtension(input: {
  readonly expertName: string
  readonly cwd: string
  /** 声明里的相对路径列表；空数组表示只读。 */
  readonly scope: readonly string[]
}): ExtensionFactory {
  const allowed = resolveScope(input.cwd, input.scope)
  return pi => {
    pi.on('tool_call', (event, ctx) => {
      if (!GUARDED_TOOLS.has(event.toolName)) return undefined
      const target = event.input as { readonly path?: unknown }
      if (typeof target.path !== 'string' || target.path.length === 0) {
        return { block: true, reason: '写入工具缺少目标路径，已按越界处理' }
      }
      if (allowed === null) {
        return { block: true, reason: `${input.expertName}的写入范围无法解析，已拒绝写入` }
      }
      const real = realpathOfTarget(resolve(ctx.cwd, target.path))
      if (real === null) return { block: true, reason: '目标路径无法解析，已拒绝写入' }
      if (isInsideWriteScope(real, allowed)) return undefined
      const hint = input.scope.length === 0
        ? '本专家为只读，不修改任何文件'
        : `本专家只能写：${input.scope.join('、')}`
      return { block: true, reason: `${input.expertName}：${target.path} 不在写入范围内，已拒绝写入；${hint}` }
    })
  }
}

/** 相对路径 → 绝对路径 → 真实路径；目录保持尾部分隔符，判定与子代理守卫同一套实现。 */
function resolveScope(cwd: string, scope: readonly string[]): readonly WriteScopeEntry[] | null {
  if (scope.length === 0) return []
  return resolveWriteScope(toAbsoluteWriteScope(cwd, scope))
}
