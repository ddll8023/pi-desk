/**
 * Pi 本机目录的解析：agent 目录是会话、mcp.json、auth.json 等 Pi 数据的共同根。
 *
 * 取值与 Pi 官方 `getAgentDir()` 一致：`PI_CODING_AGENT_DIR` 只在是绝对路径时生效，
 * 相对值与空值都交给 Pi 的默认位置 `~/.pi/agent`。只做解析，不读配置、不创建目录。
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Pi 的 agent 配置目录（例如 `~/.pi/agent`）。 */
export function getPiAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim()
  if (configured !== undefined && configured !== '' && isAbsolute(configured)) return configured
  return join(homedir(), '.pi', 'agent')
}
