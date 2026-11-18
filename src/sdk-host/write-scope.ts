/**
 * 写入路径的共用判定：真实路径解析、目录前缀比较与允许范围解析。
 *
 * 子代理写入守卫与专家写入守卫共用这一份实现：两边都按真实路径比较、目录按分隔符边界命中，
 * 避免 `docs/` 顺带放行 `docs-old/`，也让符号链接与新建文件只有一种解析方式。
 * 本模块只做路径判断，不读环境变量、不注册工具钩子，也不决定范围从哪里来。
 */
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

/** 一条允许范围：目录按前缀命中，文件按全路径命中。 */
export interface WriteScopeEntry {
  /** 解析后的绝对真实路径；目录不带尾部分隔符。 */
  readonly path: string
  readonly dir: boolean
}

/**
 * 取最近一个已存在的祖先的真实路径，再拼回剩余部分。
 * 直接 `realpath` 目标文件会因新建文件失败，而只比较字面路径又放过符号链接逃逸。
 */
export function realpathOfTarget(target: string): string | null {
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

/** 目录范围按分隔符边界比对，避免 `docs/` 顺带放行 `docs-old/`。 */
export function isInsideWriteScope(target: string, allowed: readonly WriteScopeEntry[]): boolean {
  for (const entry of allowed) {
    if (entry.dir) {
      if (target === entry.path || target.startsWith(`${entry.path}${sep}`)) return true
      continue
    }
    if (target === entry.path) return true
  }
  return false
}

/**
 * 把绝对路径列表解析成允许范围；任一项不是绝对路径或无法解析即返回 `null`，由调用方按拒绝处理。
 * 目录标记不能交给路径归一化保留：`resolve` 会吃掉尾部分隔符，必须在归一化前记下按目录处理。
 */
export function resolveWriteScope(entries: readonly string[]): readonly WriteScopeEntry[] | null {
  const allowed: WriteScopeEntry[] = []
  for (const item of entries) {
    if (typeof item !== 'string' || !isAbsolute(item)) return null
    const dir = item.endsWith('/') || item.endsWith(sep)
    const real = realpathOfTarget(dir ? item.replace(/[/\\]+$/, '') : item)
    if (real === null) return null
    allowed.push({ path: real, dir })
  }
  return allowed
}

/**
 * 把项目内相对路径解析成绝对路径，目录保留尾部分隔符。
 * 相对路径以会话执行根为基准，不按应用启动目录，切换到子目录打开时也不会把范围指到别处。
 */
export function toAbsoluteWriteScope(cwd: string, entries: readonly string[]): string[] {
  return entries.map(entry => {
    const dir = entry.endsWith('/') || entry.endsWith(sep)
    const absolute = resolve(cwd, dir ? entry.replace(/[/\\]+$/, '') : entry)
    return dir ? `${absolute}/` : absolute
  })
}
