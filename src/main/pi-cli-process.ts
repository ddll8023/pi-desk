/**
 * 受管一次性入口的定位与启动：`out/sdk-host/pi-cli.mjs`（用 Electron 自带的 Node 加载官方 SDK 的 CLI 入口，
 * 因此不需要单独的 Pi 可执行文件）与 `out/sdk-host/update-check.mjs`（一次性版本检查脚本）。
 * 命令行参数由调用点固定给出，页面不能指定入口、可执行文件或参数。
 * 这里只启动进程并交回句柄，不读写管道、不判定成败；失败分类与超时终止由调用方负责。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { getPiProcessEnvironment } from './pi-paths'

/** 运行器入口的固定文件名与所在产物目录；页面不能指定路径。 */
const CLI_ENTRY_NAME = 'pi-cli.mjs'
const UPDATE_CHECK_ENTRY_NAME = 'update-check.mjs'
const CLI_OUTPUT_DIRECTORY = 'sdk-host'

/** 入口与主进程产物保持固定相邻布局：开发态与打包态读取同一相对子路径，页面不能指定路径。 */
function managedEntryPath(entryName: string): string {
  return resolve(__dirname, '..', CLI_OUTPUT_DIRECTORY, entryName)
}

export function getPiCliEntryPath(): string {
  return managedEntryPath(CLI_ENTRY_NAME)
}

/** 版本检查脚本入口；与 CLI 运行器同一个产物目录与解析方式。 */
export function getUpdateCheckEntryPath(): string {
  return managedEntryPath(UPDATE_CHECK_ENTRY_NAME)
}

export interface PiCliSpawnOptions {
  readonly cwd: string
  /** RPC 预读需要向运行器写请求；CLI 子命令与版本检查不需要标准输入。 */
  readonly stdin: boolean
  /** 调用点额外的环境覆盖；agent 目录统一由应用解析结果给出。 */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * 启动一个受管的一次性入口：用 Electron 自带的 Node 跑入口文件，环境沿用应用解析出的 agent 目录。
 * 独立进程组使超时终止能连同入口启动的子进程（例如 stdio MCP 服务器、git）一起收敛。
 */
function spawnManagedEntry(
  entryPath: string,
  args: readonly string[],
  options: PiCliSpawnOptions
): ChildProcess {
  return spawn(process.execPath, [entryPath, ...args], {
    cwd: options.cwd,
    env: getPiProcessEnvironment({ ELECTRON_RUN_AS_NODE: '1', ...options.env }),
    stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  })
}

export function spawnPiCli(args: readonly string[], options: PiCliSpawnOptions): ChildProcess {
  return spawnManagedEntry(getPiCliEntryPath(), args, options)
}

/** 启动一次性版本检查脚本；参数由调用点固定给出（当前项目路径）。 */
export function spawnUpdateCheck(args: readonly string[], options: PiCliSpawnOptions): ChildProcess {
  return spawnManagedEntry(getUpdateCheckEntryPath(), args, options)
}
