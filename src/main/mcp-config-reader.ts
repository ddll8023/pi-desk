/**
 * Pi 的 mcp.json 的浅层只读列举：读取 `<agent-dir>/mcp.json` 与 `<项目>/.pi/mcp.json`，
 * 说明配置了哪些服务器、各自在哪个文件里、是否启用、启动摘要与项目级覆盖关系。
 *
 * 只做键级读取：不解析 `${VAR}`、不推断 exposure 默认值、不重算 Pi 的校验与合并结果，
 * 也不连接任何服务器、不写任何文件。文件不存在按「没有配置」处理，解析或格式错误如实进入 `errors`；
 * 项目级配置是否会被 Pi 读取取决于信任决定，由调用方传入，这里只如实回传。
 * 使用 `pi mcp list --json` 探测连接状态是另一条通道：它没有「只列举不连接」的模式。
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { McpConfigListing, McpConfigServer } from '../shared/runtime-api'
import { getPiAgentDir } from './pi-paths'

/** 与 Pi 一致：项目级配置固定放在 `<项目>/.pi/mcp.json`。 */
const PROJECT_CONFIG_DIR = '.pi'
const CONFIG_FILE_NAME = 'mcp.json'
/** 启动摘要长度上限；超长截断，不伪装成完整命令。 */
const MAX_TRANSPORT_CHARS = 300
/** 单个配置文件的读取上限；与仓库其他有界读取一致，超限不读入内存，按错误文本如实报告。 */
const MAX_CONFIG_BYTES = 512 * 1024

interface ConfigFile {
  readonly entries: readonly (readonly [string, Record<string, unknown>])[]
  readonly errors: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * 读取一个 mcp.json；文件缺失不算错误。
 * `mcpServers` 必须是对象，条目必须是对象，其余情况如实写入错误文本。
 * 先看文件大小，超限不读入内存。
 */
async function readConfigFile(filePath: string): Promise<ConfigFile> {
  const errors: string[] = []
  let text: string
  try {
    const info = await stat(filePath)
    if (info.size > MAX_CONFIG_BYTES) {
      errors.push(`${filePath}：文件超过 ${MAX_CONFIG_BYTES} 字节上限，未读取`)
      return { entries: [], errors }
    }
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if (isMissingPath(error)) return { entries: [], errors: [] }
    errors.push(`${filePath}：无法读取（${error instanceof Error ? error.message : String(error)}）`)
    return { entries: [], errors }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    errors.push(`${filePath}：无法解析 JSON（${error instanceof Error ? error.message : String(error)}）`)
    return { entries: [], errors }
  }

  if (!isRecord(parsed)) {
    errors.push(`${filePath}：顶层必须是对象`)
    return { entries: [], errors }
  }
  const servers = parsed.mcpServers
  if (servers === undefined) return { entries: [], errors: [] }
  if (!isRecord(servers)) {
    errors.push(`${filePath}：mcpServers 必须是对象`)
    return { entries: [], errors }
  }

  const entries: (readonly [string, Record<string, unknown>])[] = []
  for (const [name, value] of Object.entries(servers)) {
    if (!isRecord(value)) {
      errors.push(`${filePath}：服务器 "${name}" 的配置必须是对象`)
      continue
    }
    entries.push([name, value])
  }
  return { entries, errors }
}

/** Pi 的覆盖判定：项目级条目没有 command、url 与 type 时，它只覆盖同名全局条目。 */
function isOverride(value: Record<string, unknown>): boolean {
  return value.command === undefined && value.url === undefined && value.type === undefined
}

/** 未声明 `enabled` 时按启用处理，与 Pi 的默认值一致。 */
function readEnabled(value: Record<string, unknown>): boolean | null {
  return typeof value.enabled === 'boolean' ? value.enabled : null
}

function truncate(text: string): string {
  return text.length > MAX_TRANSPORT_CHARS ? `${text.slice(0, MAX_TRANSPORT_CHARS)}…` : text
}

/**
 * 启动摘要：HTTP 配置取 url，stdio 配置取 command 与字符串形式的 args。
 * 只拼接配置文本，不展开变量、不校验可执行文件是否存在。
 */
function readTransport(value: Record<string, unknown>): string | null {
  if (typeof value.url === 'string' && value.url.trim() !== '') return truncate(value.url.trim())
  if (typeof value.command === 'string' && value.command.trim() !== '') {
    const args = Array.isArray(value.args) ? value.args.filter((arg) => typeof arg === 'string') : []
    return truncate([value.command.trim(), ...args].join(' '))
  }
  return null
}

/**
 * 列举全局与项目两处 mcp.json 的服务器。
 * `projectPath` 为 null 或不是绝对路径时只读全局配置；`projectConfigTrusted` 由调用方按信任决定给出，
 * 未信任时项目级条目仍会列出，但不会生效，页面据此如实标注。
 */
export async function readMcpConfigListing(
  projectPath: string | null,
  projectConfigTrusted: boolean
): Promise<McpConfigListing> {
  const globalConfigPath = join(getPiAgentDir(), CONFIG_FILE_NAME)
  const absoluteProjectPath = projectPath !== null && isAbsolute(projectPath) ? projectPath : null
  const projectConfigPath = absoluteProjectPath === null
    ? null
    : join(absoluteProjectPath, PROJECT_CONFIG_DIR, CONFIG_FILE_NAME)
  const servers = new Map<string, McpConfigServer>()
  const errors: string[] = []

  const globalFile = await readConfigFile(globalConfigPath)
  errors.push(...globalFile.errors)
  for (const [name, value] of globalFile.entries) {
    servers.set(name, {
      name,
      scope: 'global',
      source: globalConfigPath,
      enabled: readEnabled(value) ?? true,
      transport: readTransport(value),
      override: null
    })
  }

  if (projectConfigPath !== null) {
    const projectFile = await readConfigFile(projectConfigPath)
    errors.push(...projectFile.errors)
    for (const [name, value] of projectFile.entries) {
      const base = servers.get(name)
      if (isOverride(value)) {
        if (base === undefined) {
          errors.push(`${projectConfigPath}：服务器 "${name}" 既没有 command 或 url，也没有可覆盖的同名全局条目`)
          continue
        }
        // 覆盖只改启用状态；启动方式仍来自被覆盖的全局条目，不在这里重算。
        servers.set(name, {
          ...base,
          enabled: readEnabled(value) ?? base.enabled,
          override: projectConfigPath
        })
        continue
      }
      servers.set(name, {
        name,
        scope: 'project',
        source: projectConfigPath,
        enabled: readEnabled(value) ?? true,
        transport: readTransport(value),
        override: null
      })
    }
  }

  return {
    servers: [...servers.values()],
    errors,
    globalConfigPath,
    projectConfigPath,
    projectConfigTrusted
  }
}
