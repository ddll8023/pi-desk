/**
 * 固定应用使用的 Pi agent 目录，并向受管进程传递相同的绝对路径。
 *
 * 按当前 SDK 展开环境路径，不擅自 trim；相对值统一以应用启动 cwd 为基准，避免切换项目
 * 或宿主工作目录后改变配置真相。只解析路径，不读取配置、不创建目录或修改全局环境。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const startupCwd = process.cwd()
const configuredAgentDir = process.env.PI_CODING_AGENT_DIR
let agentDir: string | null = null

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

/** 所有桌面读取者使用同一运行期路径；项目变化不会重新解释相对环境值。 */
export function getPiAgentDir(): string {
  agentDir ??= resolve(startupCwd, configuredAgentDir
    ? expandAgentPath(configuredAgentDir) : join(homedir(), '.pi', 'agent'))
  return agentDir
}

/** 保留现有环境与调用方覆盖，但 agent 目录必须来自应用的唯一解析结果。 */
export function getPiProcessEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides, PI_CODING_AGENT_DIR: getPiAgentDir() }
}
