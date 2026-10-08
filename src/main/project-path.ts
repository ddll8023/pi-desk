/**
 * 项目路径归一化的唯一入口：目录选择、手输路径、列表切换与 Runtime 启动都经这里校验。
 *
 * 以 `realpath` 结果作为同一目录的唯一形式，因此符号链接、Windows 短名与大小写写法都收敛到
 * 同一条记录；不做大小写折叠，也不主动添加 `\\?\` 前缀。调用方按自身错误码族映射失败。
 */
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

/** 归一化失败；只描述可展示的原因，不携带底层文件错误。 */
export class ProjectPathError extends Error {}

/** 校验并返回规范绝对路径；相对路径、空值、不存在的路径与非目录一律拒绝。 */
export async function normalizeProjectPath(input: unknown): Promise<string> {
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\u0000')) {
    throw new ProjectPathError('项目目录必须是非空的绝对路径。')
  }
  const trimmed = input.trim()
  if (!isAbsolute(trimmed)) {
    throw new ProjectPathError('项目目录必须是绝对路径。')
  }

  let canonical: string
  try {
    // realpath 解析符号链接、平台短名与规范大小写，并去掉尾部分隔符。
    canonical = await realpath(trimmed)
  } catch {
    throw new ProjectPathError(`项目目录不存在或无法访问：${trimmed}`)
  }

  let isDirectory = false
  try {
    isDirectory = (await stat(canonical)).isDirectory()
  } catch {
    throw new ProjectPathError(`项目目录无法访问：${canonical}`)
  }
  if (!isDirectory) {
    throw new ProjectPathError(`项目路径不是目录：${canonical}`)
  }
  return canonical
}

/** 项目默认名称取规范路径的末段；文件系统根目录没有末段，退回整条路径。 */
export function projectNameFromPath(canonicalPath: string): string {
  const name = basename(canonicalPath)
  return name === '' ? canonicalPath : name
}
