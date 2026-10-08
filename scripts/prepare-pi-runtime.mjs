/**
 * 准备固定版本的 Pi standalone Runtime。
 *
 * 从官方发布资产下载固定版本的 Pi 归档，校验字节数与 SHA-256 后解压到开发 staging 根
 * `runtime/pi/<平台>-<架构>/`，完整保留官方文件名与相对目录结构。
 *
 * 布局不变量：官方归档是平铺根目录，可执行文件与 package 资源同层。因此 Pi 的
 * `getPackageDir()` 默认值（`dirname(process.execPath)`）就等于 package 资源根，
 * 不需要设置 `PI_PACKAGE_DIR`；Photon WASM 与 TUI native helper 的可执行文件邻接
 * 查找也因此同时成立。若将来把可执行文件与资源根拆开，才需要显式设置该变量。
 *
 * 用法：
 *   node scripts/prepare-pi-runtime.mjs [--force]
 *
 * 只处理当前主机的平台与架构：非 macOS 主机不能正确准备 macOS 目标（tar 权限位）。
 * 解压只调用 Windows PowerShell 或 macOS 系统 tar，不启动 Pi，不调用 PATH 中的
 * 全局 Pi，失败时不留半成品目标目录。
 */
import { createHash } from 'node:crypto'
import { createWriteStream, chmodSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

/** 下载进度输出间隔，避免长下载期间完全没有输出。 */
const PROGRESS_STEP_BYTES = 10 * 1024 * 1024

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(projectRoot, 'runtime', 'pi-runtime.json')
const stagingRoot = join(projectRoot, 'runtime', 'pi')
const downloadDir = join(stagingRoot, '.download')

/** 脚本自身的可预期失败，用中文消息结束，不作为未捕获异常处理。 */
class PrepareError extends Error {}

function fail(message) {
  throw new PrepareError(message)
}

function parseArguments(argv) {
  let force = false
  for (const argument of argv) {
    if (argument === '--force') {
      force = true
    } else if (argument === '--help' || argument === '-h') {
      console.log('用法：node scripts/prepare-pi-runtime.mjs [--force]')
      console.log('  --force  已存在的目标目录也重新下载并重建')
      process.exit(0)
    } else if (argument === '--target' || argument.startsWith('--target=')) {
      fail('本脚本只在当前主机平台上准备 Runtime，不支持指定其他目标平台。')
    } else {
      fail(`无法识别的参数 ${argument}。`)
    }
  }
  return { force }
}

async function readManifest() {
  let raw
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    fail(`缺少固定清单 ${manifestPath}。`)
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch {
    fail(`固定清单 ${manifestPath} 不是合法 JSON。`)
  }
  if (typeof manifest?.version !== 'string' || typeof manifest?.tag !== 'string'
    || typeof manifest?.targets !== 'object' || manifest.targets === null) {
    fail(`固定清单 ${manifestPath} 缺少 version、tag 或 targets。`)
  }
  return manifest
}

function getTargetId(platform, arch) {
  return `${platform}-${arch}`
}

function getExecutableName(platform) {
  return platform === 'win32' ? 'pi.exe' : 'pi'
}

/** TUI native helper 的邻接相对路径，与 Pi 内部候选路径一致。 */
function getNativeHelperPath(platform, arch) {
  return `native/${platform}/prebuilds/${platform}-${arch}/${platform}-platform.node`
}

/** 缺失即失败的条目：对应 Pi 真实解析路径。 */
function getRequiredEntries(platform, arch) {
  return [
    getExecutableName(platform),
    'package.json',
    'photon_rs_bg.wasm',
    getNativeHelperPath(platform, arch),
    'theme',
    'assets',
    'export-html'
  ]
}

/** 缺失不影响启动的官方附带资料：README、docs、examples 会被系统提示与登录帮助引用为路径。 */
const OPTIONAL_ENTRIES = ['README.md', 'CHANGELOG.md', 'docs', 'examples']

async function pathExists(targetPath) {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

/** 读取目标目录中 package.json 的版本，文件缺失或非法时返回 null。 */
async function readStagedVersion(runtimeRoot) {
  try {
    const parsed = JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/** 已齐备且版本一致时视为已就绪，避免重复下载。 */
async function isStaged(runtimeRoot, expectedVersion, platform, arch) {
  if (!await pathExists(runtimeRoot)) return false
  for (const entry of getRequiredEntries(platform, arch)) {
    if (!await pathExists(join(runtimeRoot, entry))) return false
  }
  return await readStagedVersion(runtimeRoot) === expectedVersion
}

async function createStagingTempDir(targetId) {
  await mkdir(stagingRoot, { recursive: true })
  const tempDir = join(stagingRoot, `.stage-${targetId}-${process.pid}-${Date.now()}`)
  await mkdir(tempDir, { recursive: false })
  return tempDir
}

/** 流式下载并同时计算 SHA-256，返回本地归档路径与实测摘要。 */
async function downloadArchive(manifest, target) {
  const url = `${manifest.releaseBaseUrl}/${manifest.tag}/${target.asset}`
  await mkdir(downloadDir, { recursive: true })
  const archivePath = join(downloadDir, target.asset)
  const startedAt = Date.now()

  console.log(`[下载] ${target.asset}`)
  let response
  try {
    response = await fetch(url, { headers: { 'User-Agent': 'pi-desk-prepare' }, redirect: 'follow' })
  } catch (error) {
    fail(`下载 ${url} 失败：${error?.message ?? error}`)
  }
  if (!response.ok || !response.body) {
    fail(`下载 ${url} 返回 HTTP ${response.status}。`)
  }

  const declaredBytes = Number(response.headers.get('content-length') ?? Number.NaN)
  const hash = createHash('sha256')
  let receivedBytes = 0
  let reportedBytes = 0
  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => {
    receivedBytes += chunk.length
    hash.update(chunk)
    if (receivedBytes - reportedBytes >= PROGRESS_STEP_BYTES) {
      reportedBytes = receivedBytes
      console.log(`       已接收 ${(receivedBytes / 1048576).toFixed(1)} MiB`)
    }
  })

  try {
    await pipeline(source, createWriteStream(archivePath))
  } catch (error) {
    fail(`写入归档失败：${error?.message ?? error}`)
  }

  const sha256 = hash.digest('hex')
  console.log(`       完成 ${(receivedBytes / 1048576).toFixed(1)} MiB，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  if (Number.isFinite(declaredBytes) && declaredBytes !== receivedBytes) {
    fail(`归档长度与响应声明不符：声明 ${declaredBytes} 字节，实际 ${receivedBytes} 字节。`)
  }
  return { archivePath, sha256, bytes: receivedBytes }
}

/** 字节数与 SHA-256 都匹配才允许解压。 */
function verifyArchive(download, target) {
  if (Number.isInteger(target.bytes) && download.bytes !== target.bytes) {
    fail(`归档字节数不符：清单 ${target.bytes}，实际 ${download.bytes}。已放弃解压。`)
  }
  if (download.sha256 !== String(target.sha256).toLowerCase()) {
    fail(`归档 SHA-256 不符：\n        清单 ${target.sha256}\n        实际 ${download.sha256}\n        已放弃解压。`)
  }
  console.log('[校验] SHA-256 与固定清单一致')
}

function quoteForPowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`
}

/** Windows 用 PowerShell 解压（PATH 中的 GNU tar 不支持 zip），macOS 用系统 tar。 */
function extractArchive(archivePath, tempDir, platform) {
  console.log('[解压] 归档到临时目录')
  const result = platform === 'win32'
    ? spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath ${quoteForPowerShell(archivePath)} -DestinationPath ${quoteForPowerShell(tempDir)} -Force`
      ], { encoding: 'utf8', windowsHide: true })
    : spawnSync('/usr/bin/tar', ['-xzf', archivePath, '-C', tempDir], { encoding: 'utf8' })

  if (result.error) {
    fail(`无法执行解压命令：${result.error.message}`)
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim().slice(0, 400)
    fail(`解压失败（退出码 ${result.status}）：${stderr}`)
  }
}

/** 归档若是单层顶层目录则下钻一层，否则内容根就是解压根目录。 */
async function resolveContentRoot(tempDir) {
  const entries = await readdir(tempDir, { withFileTypes: true })
  if (entries.length === 1 && entries[0].isDirectory()) {
    return join(tempDir, entries[0].name)
  }
  return tempDir
}

/** 校验必需条目与固定版本，可选条目缺失只告警。 */
async function validateRuntime(runtimeRoot, expectedVersion, platform, arch) {
  const missing = []
  for (const entry of getRequiredEntries(platform, arch)) {
    if (!await pathExists(join(runtimeRoot, entry))) missing.push(entry)
  }
  if (missing.length > 0) {
    fail(`归档内容缺少必需条目：\n        ${missing.join('\n        ')}`)
  }

  const stagedVersion = await readStagedVersion(runtimeRoot)
  if (stagedVersion !== expectedVersion) {
    fail(`package.json 版本不符：清单 ${expectedVersion}，实际 ${stagedVersion ?? '无法读取'}。`)
  }

  const absentOptional = []
  for (const entry of OPTIONAL_ENTRIES) {
    if (!await pathExists(join(runtimeRoot, entry))) absentOptional.push(entry)
  }
  if (absentOptional.length > 0) {
    console.log(`[告警] 官方附带资料缺失（不影响启动）：${absentOptional.join('、')}`)
  }

  if (platform !== 'win32') {
    try {
      chmodSync(join(runtimeRoot, getExecutableName(platform)), 0o755)
    } catch {
      console.log('[告警] 无法设置可执行文件权限位。')
    }
  }
  console.log(`[校验] 必需条目齐备，package.json 版本 ${stagedVersion}`)
}

/** 全部校验通过后才替换目标目录，避免留下半成品。 */
async function publish(contentRoot, destination) {
  await rm(destination, { recursive: true, force: true })
  await mkdir(dirname(destination), { recursive: true })
  await rename(contentRoot, destination)
}

async function main() {
  const { force } = parseArguments(process.argv.slice(2))
  const manifest = await readManifest()
  const platform = process.platform
  const arch = process.arch
  const targetId = getTargetId(platform, arch)
  const target = manifest.targets[targetId]
  if (!target) {
    fail(`固定清单没有目标 ${targetId}，当前只支持 ${Object.keys(manifest.targets).join('、')}。`)
  }

  const destination = join(stagingRoot, targetId)
  if (!force && await isStaged(destination, manifest.version, platform, arch)) {
    console.log(`[跳过] ${targetId} 已就绪：${destination}`)
    console.log('       需要重建时加 --force。')
    return
  }

  console.log(`[准备] Pi ${manifest.version}（${manifest.tag}）/ ${targetId}`)
  console.log(`       目标目录 ${destination}`)

  let tempDir = null
  let archivePath = null
  try {
    const download = await downloadArchive(manifest, target)
    archivePath = download.archivePath
    verifyArchive(download, target)

    tempDir = await createStagingTempDir(targetId)
    extractArchive(archivePath, tempDir, platform)
    const contentRoot = await resolveContentRoot(tempDir)
    await validateRuntime(contentRoot, manifest.version, platform, arch)
    await publish(contentRoot, destination)

    console.log(`[完成] ${destination}`)
    console.log(`       可执行文件 ${join(destination, getExecutableName(platform))}`)
  } finally {
    // 平铺归档下 tempDir 已被 rename 消费，rm 为空操作；单层顶层目录时清理留下的空父目录。
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true })
    }
    if (archivePath !== null) {
      await rm(archivePath, { force: true })
    }
  }
}

main().catch((error) => {
  if (error instanceof PrepareError) {
    console.error(`[错误] ${error.message}`)
  } else {
    console.error(`[错误] 准备 Runtime 时发生未预期的失败：${error?.message ?? error}`)
  }
  process.exitCode = 1
})
