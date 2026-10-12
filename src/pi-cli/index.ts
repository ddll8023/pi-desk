/**
 * 一次性 Pi CLI 运行器：用官方 SDK 的 CLI 入口执行主进程给定的固定参数。
 *
 * 只为资源/模型预读（`--mode rpc`）与 MCP 探测（`mcp list --json`）提供一次性进程，
 * 不建立会话、不驻留，也不接受页面传入的入口、可执行文件或参数：参数由主进程按调用点固定给出。
 * 环境标记与官方 CLI 入口保持一致，使运行器与被它取代的独立可执行文件行为相同。
 */
import { main } from '@earendil-works/pi-coding-agent'

process.env.PI_CODING_AGENT = 'true'
process.env.AI_AGENT = 'pi'

void main(process.argv.slice(2))
