/**
 * 技能来源目录清单：会话装配、设置页候选与启动前预读共用的唯一口径。
 *
 * 全局来源由专家能力范围表达并收窄：产品自有 agent 目录下的 `skills`、只读共享目录下的 `skills`。
 * 项目来源随工作区变化，专家是全局定义因而无法表达，装配后不参与技能许可集裁剪：
 * 工作目录的 `.pi/skills`，以及工作目录及其祖先的 `.agents/skills`（祖先只向上找到含 `.git` 的目录为止）。
 * 只做存在性判断与路径去重，不读取技能内容、不创建目录、不写入。
 */
import { existsSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** 两个全局来源路径：产品自有目录在前，只读共享目录在后。 */
export interface GlobalSkillSourceInput {
  readonly agentDir: string
  readonly sharedAgentDir: string
}

/** 项目来源只取决于工作目录与共享目录（后者用于排除用户级同名路径）。 */
export interface ProjectSkillSourceInput {
  readonly cwd: string
  readonly sharedAgentDir: string
}

/** 一份完整的来源输入；未受信项目不返回任何项目目录。 */
export interface SkillSourceInput extends GlobalSkillSourceInput, ProjectSkillSourceInput {
  readonly projectTrusted: boolean
}

export interface SkillSourceDirectories {
  readonly global: readonly string[]
  readonly project: readonly string[]
}

/** 全局来源目录：缺失的跳过，同路径只用一份（共享目录被指到 agent 目录时不重复装配）。 */
export function globalSkillDirectories(input: GlobalSkillSourceInput): readonly string[] {
  const directories: string[] = []
  for (const directory of [join(input.agentDir, 'skills'), join(input.sharedAgentDir, 'skills')]) {
    if (directories.some(item => samePath(item, directory))) continue
    if (isDirectory(directory)) directories.push(directory)
  }
  return directories
}

/**
 * 项目来源目录：`.pi/skills` 只取工作目录，`.agents/skills` 从工作目录逐级向上。
 * 向上在遇到含 `.git` 的目录后停止（与 SDK 的祖先收集一致），避免把仓外目录当成本项目技能；
 * 与共享用户级目录同路径的那份被排除，否则同一个技能会被两份来源各装一次。
 */
export function projectSkillDirectories(input: ProjectSkillSourceInput): readonly string[] {
  const shared = join(input.sharedAgentDir, 'skills')
  const directories: string[] = []
  const push = (directory: string): void => {
    if (samePath(directory, shared)) return
    if (directories.some(item => samePath(item, directory))) return
    if (isDirectory(directory)) directories.push(directory)
  }
  let current = resolve(input.cwd)
  push(join(current, '.pi', 'skills'))
  push(join(current, '.agents', 'skills'))
  while (!existsSync(join(current, '.git'))) {
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
    push(join(current, '.agents', 'skills'))
  }
  return directories
}

/** 组合两类来源；不受信的项目不参与，会话与预读因此与信任状态一致。 */
export function collectSkillSources(input: SkillSourceInput): SkillSourceDirectories {
  return {
    global: globalSkillDirectories(input),
    project: input.projectTrusted ? projectSkillDirectories(input) : []
  }
}

/**
 * 判断技能文件是否落在给定目录之下：装配时用它区分项目技能与全局技能。
 * 只比对规范化后的路径前缀，约定技能入口在目录下一层，因此不做符号链接解析。
 */
export function isUnderSkillDirectory(filePath: string, directories: readonly string[]): boolean {
  const target = normalizePath(filePath)
  return directories.some((directory) => {
    const root = normalizePath(directory)
    return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  })
}

function normalizePath(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
