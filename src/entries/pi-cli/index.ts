/**
 * 一次性 Pi CLI 运行器：用官方 SDK 的 CLI 入口执行主进程给定的固定参数。
 *
 * 只为资源/模型预读（`--mode rpc`）与 MCP 探测（`mcp list --json`）提供一次性进程，
 * 不建立会话、不驻留，也不接受页面传入的入口、可执行文件或参数：参数由主进程按调用点固定给出。
 * SDK 从运行时目录或应用自带版本加载（由主进程注入的入口决定），环境标记与官方 CLI 入口保持一致，
 * 使运行器与被它取代的独立可执行文件行为相同。
 */
import { loadSdkModule } from '../../shared-process/runtime'

async function run(): Promise<void> {
  process.env.PI_CODING_AGENT = 'true'
  process.env.AI_AGENT = 'pi'
  const sdk = await loadSdkModule()
  await sdk.main(process.argv.slice(2))
}

void run().catch((error: unknown) => {
  console.error(`Pi CLI 运行器失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
