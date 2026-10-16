/**
 * 修复 node-pty 预编译助手的执行权限。
 *
 * node-pty 的 macOS 预编译产物 spawn-helper 以不可执行的权限发布，而它通过 posix_spawn 直接执行该文件，
 * 缺少执行位会让每次启动终端都失败（posix_spawnp failed.）。上游稳定版尚未修复，因此在开发启动与出包前各修一次。
 *
 * 边界：只处理当前平台与架构的 spawn-helper，其他平台目录不参与；文件不存在（Windows 或依赖未安装）时跳过；
 * 修复失败直接以非 0 退出，让问题在启动或出包时暴露，而不是留到运行时。
 */
import { chmodSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 目标文件：node-pty 只加载当前平台与架构的预编译产物。 */
function spawnHelperPath() {
  return resolve(
    projectRoot,
    'node_modules',
    'node-pty',
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper'
  )
}

/** 确保当前平台的 spawn-helper 可执行；文件不存在时返回 null。 */
export function ensureSpawnHelperExecutable() {
  const helper = spawnHelperPath()
  if (!existsSync(helper)) return null
  chmodSync(helper, 0o755)
  return helper
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    const helper = ensureSpawnHelperExecutable()
    console.log(helper === null ? '未找到 node-pty 预编译助手，跳过权限修复。' : `node-pty 预编译助手已可执行：${helper}`)
  } catch (error) {
    console.error(`修复 node-pty 预编译助手权限失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
