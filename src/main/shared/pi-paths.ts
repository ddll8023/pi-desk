/**
 * 固定应用使用的 Pi agent 目录，并向受管进程传递相同的绝对路径与运行时 SDK 入口。
 *
 * 产品自己的运行时状态（凭据、设置、模型、MCP、会话与已装包）落在应用自有的 agent 目录，
 * 由 `app-lifecycle` 在 ready 前注入；终端 CLI 的目录只作为只读来源与首启导入的源，不再被产品写入。
 * `PI_CODING_AGENT_DIR` 保留为显式共享的逃生口（设成 CLI 目录即回到共用一份配置的行为），
 * `PI_DESK_SHARED_AGENT_DIR` 可指定另一处只读来源。只解析路径与当前运行时指针，不读取其余配置、不创建目录。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRuntimeSdkEnv } from '../updates/pi-runtime'

const startupCwd = process.cwd()
const configuredAgentDir = process.env.PI_CODING_AGENT_DIR
const configuredSharedAgentDir = process.env.PI_DESK_SHARED_AGENT_DIR
/** 应用注入的产品目录；未注入时留空，由 `getPiAgentDir` 走不与其他宿主冲突的兜底。 */
let productAgentDir: string | null = null
let resolvedAgentDir: string | null = null
let resolvedSharedAgentDir: string | null = null

/** 复用当前 SDK 的路径输入语义；不把 shell 风格路径误当成另一处配置目录。 */
function expandAgentPath(input: string): string {
  let path = input
  if (process.platform === 'win32' && path.startsWith('/')
    && !path.startsWith('//') && !path.includes('\\')) {
    const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path)
    if (match?.[1] !== undefined) {
      path = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll('/', '\\') ?? ''}`
    }
  }
  if (path === '~') return homedir()
  if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) {
    return join(homedir(), path.slice(2))
  }
  return path.startsWith('file://') ? fileURLToPath(path) : path
}

/**
 * 由应用入口注入产品目录；只在首次解析前调用，避免已读路径与进程环境不一致。
 * 共享目录由环境变量或默认的 `~/.agents` 决定，不经此入口覆盖。
 */
export function configurePiAgentDirectories(input: { readonly product: string }): void {
  if (resolvedAgentDir !== null) return
  productAgentDir = resolve(startupCwd, input.product)
}

/** 显式共享：`PI_CODING_AGENT_DIR` 已把产品指向别处，首启导入与隔离都不再适用。 */
export function hasExplicitAgentDirectory(): boolean {
  return configuredAgentDir !== undefined && configuredAgentDir !== ''
}

/** 所有桌面读取者使用同一运行期路径；项目变化不会重新解释相对环境值。 */
export function getPiAgentDir(): string {
  resolvedAgentDir ??= resolve(startupCwd, configuredAgentDir
    ? expandAgentPath(configuredAgentDir)
    // 注入缺失时也不回落到 CLI 目录：宁可落在产品自有的独立路径，也不与他人共用可变状态。
    : productAgentDir ?? join(homedir(), '.pi-desk', 'agent'))
  return resolvedAgentDir
}

/**
 * 只读来源：用户级 AGENTS.md 与 skills 从这里加载，首启导入也以它为源。
 * 缺省取 `~/.agents`——用户级技能与规则目录实际部署在那里，取旧目录会让部署结果读不到。
 */
export function getSharedPiAgentDir(): string {
  resolvedSharedAgentDir ??= resolve(startupCwd, configuredSharedAgentDir
    ? expandAgentPath(configuredSharedAgentDir)
    : join(homedir(), '.agents'))
  return resolvedSharedAgentDir
}

/** 保留现有环境与调用方覆盖，但 agent 目录与运行时入口必须来自应用的唯一解析结果。 */
export function getPiProcessEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    ...getRuntimeSdkEnv(),
    PI_CODING_AGENT_DIR: getPiAgentDir()
  }
}
