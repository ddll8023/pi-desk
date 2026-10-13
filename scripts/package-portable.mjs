/**
 * 便携出包入口：按当前主机平台产出一份免安装包（Windows 为 zip，macOS 为含 .app 的 zip）。
 *
 * 只做参数解析、环境准备与进程转发，不改变打包内容；镜像只在同名环境变量为空时兜底，
 * 已显式设置的值（换镜像站或复用离线缓存）不被覆盖。不做安装器，也不做跨平台出包：
 * electron-builder 不能在非 macOS 主机上产 mac 包，Windows 目标的图标改写也依赖主机平台，
 * 因此平台参数与主机不一致时直接失败，不产出一个看似成功却不可用的包。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mirrorDefaults = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}
/** 平台参数、主机平台与架构参数都是固定集合；只出当前主机平台，不在这里跨平台映射。 */
const platforms = {
  win32: { argument: '--win', name: 'Windows' },
  darwin: { argument: '--mac', name: 'macOS' }
}
const archArguments = { x64: '--x64', arm64: '--arm64' }

/** 入口由包自身声明，不假定 bin 目录结构与平台后缀。 */
function resolveBuilderEntry() {
  const manifestFile = resolve(projectRoot, 'node_modules', 'electron-builder', 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  } catch {
    throw new Error('未安装 electron-builder；请先在项目根目录执行 npm install。')
  }
  const declared = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['electron-builder']
  if (typeof declared !== 'string') throw new Error('electron-builder 未声明可执行入口。')
  return resolve(projectRoot, 'node_modules', 'electron-builder', declared)
}

/** 平台参数缺省取当前主机；显式指定时必须是本机能出的平台。 */
function resolvePlatform() {
  const requested = process.argv.slice(2).filter((value) => value === '--win' || value === '--mac')
  if (requested.length > 1) throw new Error('一次只能指定一个平台参数：--win 或 --mac。')
  const host = platforms[process.platform]
  if (requested.length === 0) {
    if (!host) throw new Error(`当前平台 ${process.platform} 不在支持的出包平台内。`)
    return host
  }
  const target = Object.values(platforms).find((platform) => platform.argument === requested[0])
  if (!host || target.argument !== host.argument) {
    const targetName = target?.name ?? requested[0]
    throw new Error(`只能在本机产出本机平台的包：请在 ${targetName} 主机上执行 ${requested[0]}。`)
  }
  return target
}

const platform = resolvePlatform()
const archArgument = archArguments[process.arch]
if (!archArgument) throw new Error(`当前架构 ${process.arch} 不在支持的出包架构内。`)

const env = { ...process.env }
for (const [name, value] of Object.entries(mirrorDefaults)) {
  if (!env[name]) env[name] = value
}

const result = spawnSync(
  process.execPath,
  [resolveBuilderEntry(), platform.argument, archArgument],
  { cwd: projectRoot, env, stdio: 'inherit' }
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`便携产物已生成：${resolve(projectRoot, 'release')}`)
