/**
 * 会话级 MCP 配置的读取与收窄：把 agent 目录与受信项目两处 `mcp.json` 合并成一份服务器清单，
 * 并按专家许可集把范围外的服务器标为停用（保留在清单里，`/mcp` 仍能看到）。
 *
 * 为什么在本地合并：SDK 只导出 `createMcpExtension` 的 `loadConfig` 钩子，不导出它自己那份
 * `loadMcpConfig`；要按会话收窄就只能在钩子里交给它一份同形状的结果。合并规则与 Pi 文档一致：
 * 项目条目缺少 `command`／`url`／`type` 时只覆盖同名全局条目的 `enabled`／`exposure`／`toolExposure`，
 * 否则整条替换；项目配置只在项目受信任时读取。
 * 这里只做键级读取，不展开变量、不连接服务器、不写任何文件；读不到或写坏按空配置处理。
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 单个配置文件读取上限；与资源模块的同类读取一致，超限不读入内存。 */
const MAX_CONFIG_BYTES = 512 * 1024
/** 与 Pi 一致：项目级配置固定放在 `<项目>/.pi/mcp.json`。 */
const PROJECT_CONFIG_DIR = '.pi'
const CONFIG_FILE_NAME = 'mcp.json'

/** 一条合并后的 MCP 服务器；`config` 保留原始键值，只按需改写 `enabled`。 */
export interface McpSessionServer {
  readonly name: string
  readonly config: Record<string, unknown>
  readonly source: string
  readonly scope: 'global' | 'project'
  /** 项目级覆盖来源；不是覆盖项时为 null。 */
  readonly override: string | null
}

export interface McpSessionConfig {
  readonly servers: readonly McpSessionServer[]
  readonly errors: readonly string[]
  /** 受信项目下的项目级配置文件路径；未读取时为 null。 */
  readonly projectConfig: string | null
}

type JsonFile = {
  readonly entries: readonly (readonly [string, Record<string, unknown>])[]
  readonly errors: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取一份 mcp.json；缺失不算错误，其余问题只进 errors，不影响其他条目。 */
function readJsonFile(filePath: string): JsonFile {
  let text: string
  try {
    const info = statSync(filePath)
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) {
      return { entries: [], errors: [`${filePath}：文件超过 ${MAX_CONFIG_BYTES} 字节上限，未读取`] }
    }
    text = readFileSync(filePath, 'utf8')
  } catch {
    return { entries: [], errors: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { entries: [], errors: [`${filePath}：无法解析 JSON`] }
  }
  if (!isRecord(parsed)) return { entries: [], errors: [`${filePath}：顶层必须是对象`] }
  const servers = parsed.mcpServers
  if (servers === undefined) return { entries: [], errors: [] }
  if (!isRecord(servers)) return { entries: [], errors: [`${filePath}：mcpServers 必须是对象`] }
  const entries: (readonly [string, Record<string, unknown>])[] = []
  const errors: string[] = []
  for (const [name, value] of Object.entries(servers)) {
    if (!isRecord(value)) {
      errors.push(`${filePath}：服务器 "${name}" 的配置必须是对象`)
      continue
    }
    entries.push([name, value])
  }
  return { entries, errors }
}

/** 覆盖型项目条目：没有启动方式字段时，只改启用状态与暴露方式。 */
function isOverride(value: Record<string, unknown>): boolean {
  return value.command === undefined && value.url === undefined && value.type === undefined
}

/**
 * 合并全局与受信项目的服务器；项目条目按 Pi 的覆盖规则应用，未受信时完全不读项目配置。
 */
export function readMcpSessionConfig(input: {
  readonly agentDir: string
  readonly cwd: string
  readonly projectTrusted: boolean
}): McpSessionConfig {
  const globalPath = join(input.agentDir, CONFIG_FILE_NAME)
  const projectPath = input.projectTrusted ? join(input.cwd, PROJECT_CONFIG_DIR, CONFIG_FILE_NAME) : null
  const servers = new Map<string, McpSessionServer>()
  const errors: string[] = []

  const globalFile = readJsonFile(globalPath)
  errors.push(...globalFile.errors)
  for (const [name, value] of globalFile.entries) {
    servers.set(name, { name, config: value, source: globalPath, scope: 'global', override: null })
  }

  if (projectPath !== null) {
    const projectFile = readJsonFile(projectPath)
    errors.push(...projectFile.errors)
    for (const [name, value] of projectFile.entries) {
      const base = servers.get(name)
      if (isOverride(value)) {
        if (base === undefined) {
          errors.push(`${projectPath}：服务器 "${name}" 既没有 command 或 url，也没有可覆盖的同名全局条目`)
          continue
        }
        servers.set(name, {
          ...base,
          config: { ...base.config, ...value },
          override: projectPath
        })
        continue
      }
      servers.set(name, { name, config: value, source: projectPath, scope: 'project', override: null })
    }
  }

  return { servers: [...servers.values()], errors, projectConfig: projectPath }
}

/**
 * 按许可集收窄：`null` 表示不限制；给了列表时，范围外的服务器改成 `enabled: false`，
 * 保留在清单里而不是删掉——用户在 `/mcp` 里能看到它被当前专家停用，而不是以为配置丢了。
 */
export function limitMcpServers(
  config: McpSessionConfig,
  permitted: readonly string[] | null
): McpSessionConfig {
  if (permitted === null) return config
  const allowed = new Set(permitted)
  return {
    ...config,
    servers: config.servers.map(server => (allowed.has(server.name)
      ? server
      : { ...server, config: { ...server.config, enabled: false } }))
  }
}
