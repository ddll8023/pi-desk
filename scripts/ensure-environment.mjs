/**
 * 环境预检与补齐：让开发启动与出包脚本在干净主机上直接可用，不需要先手工执行安装命令。
 *
 * 只处理三类可自动获取的前置资源：npm 依赖、Electron 二进制、受管记忆运行环境。
 * 三者都齐时只做存在性检查后立即退出；缺哪一项才补哪一项，失败就非零退出并说明缺口，
 * 不做部分成功后的继续启动。Node.js 与 npm 自身无法由本脚本安装，只报告缺失。
 *
 * 不写构建产物、不执行下载的 Python、不初始化或读取用户记忆库、不改 git 状态。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 与其他脚本一致：未显式设置镜像时兜底到同一站点，不影响已有环境变量。 */
const mirrorDefaults = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

/**
 * Windows 上的 npm 是 .cmd 包装，必须经 cmd.exe 执行；node 可直接调用。
 * 不用 spawnSync 的 shell 选项：它只把参数拼成字符串并会触发弃用警告，这里自己拼固定命令。
 */
function spawnCommand(command, args, options) {
  if (process.platform !== 'win32') return spawnSync(command, args, options)
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [command, ...args].join(' ')], options)
}

/** 固定入口执行；工作目录固定在仓库根，输出直接透传，不被本脚本改写。 */
function run(command, args, label, viaShell = false) {
  console.log(`[环境] ${label}`)
  const env = { ...process.env }
  for (const [name, value] of Object.entries(mirrorDefaults)) {
    if (!env[name]) env[name] = value
  }
  const spawn = viaShell ? spawnCommand : spawnSync
  const result = spawn(command, args, { cwd: projectRoot, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label}失败（退出码 ${result.status ?? '未知'}）。`)
}

function requireNode() {
  for (const [command, hint, viaShell] of [['node', 'Node.js', false], ['npm', 'npm', true]]) {
    const spawn = viaShell ? spawnCommand : spawnSync
    const probe = spawn(command, ['--version'], { stdio: 'ignore' })
    if (probe.error || probe.status !== 0) {
      throw new Error(`未找到 ${command} 命令，请先安装 ${hint} 后再运行。`)
    }
  }
}

/** 依赖缺失或 Electron 包存在但二进制未下载时，分别补齐；两者都由 npm 生态提供。 */
function ensureDependencies() {
  // electron 用于开发运行，electron-builder 用于出包；任一缺失都说明依赖树不完整。
  const installed = ['electron', 'electron-builder'].every(name =>
    isFile(join(projectRoot, 'node_modules', name, 'package.json')))
  if (!installed) {
    run('npm', ['install', '--no-audit', '--no-fund'], '安装项目依赖', process.platform === 'win32')
  }
  if (isDirectory(join(projectRoot, 'node_modules', 'electron', 'dist'))) return
  const installer = join(projectRoot, 'node_modules', 'electron', 'install.js')
  if (!isFile(installer)) throw new Error('Electron 安装脚本缺失，node_modules 可能不完整；请删除后重新运行。')
  run(process.execPath, [installer], '下载 Electron 二进制')
}

/**
 * 受管运行环境按固定清单身份判断，不只看目录是否存在。
 * 只有当前主机当前架构的一份会被准备；外平台归档只缓存，由对应主机自行准备。
 */
function ensureMemoryRuntime() {
  const spec = JSON.parse(readFileSync(join(projectRoot, 'resources', 'memory-runtime', 'manifest.json'), 'utf8'))
  const target = `${process.platform}-${process.arch}`
  if (!spec.targets?.[target]) {
    throw new Error(`受管记忆运行环境不支持当前平台 ${target}；记忆功能会报告不可用，构建仍需在其他受支持平台上进行。`)
  }
  const directory = join(projectRoot, 'runtime', 'memory', target, spec.bundleId)
  let metadata
  try {
    metadata = JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    run(process.execPath, [join(projectRoot, 'scripts', 'prepare-memory-runtime.mjs')], '准备受管记忆运行环境')
    return
  }
  const entry = spec.targets[target]
  if (metadata.bundleId === spec.bundleId && metadata.target === target
    && metadata.pythonSha256 === entry.sha256 && metadata.timezoneSha256 === spec.timezone.sha256
    && isFile(join(directory, entry.python)) && isFile(join(directory, spec.timezone.directory, 'UTC'))) {
    return
  }
  // 身份不符或内容缺失时不就地覆盖：prepare 自身会拒绝改写身份不匹配的既有目录。
  throw new Error(`受管记忆运行环境与清单不一致，未自动覆盖：${directory}。请显式确认后删除该目录再重试。`)
}

try {
  requireNode()
  ensureDependencies()
  ensureMemoryRuntime()
  console.log('[环境] 前置资源已就绪。')
} catch (error) {
  console.error(`[环境] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
