/** 固定运行资源的显式准备入口：只下载、核对归档并解压，不执行解释器或触碰用户记忆库。 */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, lstat, realpath, readdir, rename, writeFile, cp } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const spec = JSON.parse(await readFile(join(root, 'resources/memory-runtime/manifest.json'), 'utf8'))
const cache = join(root, 'runtime/memory-cache')
const target = `${process.platform}-${process.arch}`
// Git 自带 GNU tar 会把 Windows 盘符当作远程主机；固定使用系统自带的 libarchive tar。
const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--all')) throw new Error('用法：node scripts/prepare-memory-runtime.mjs [--all]')
if (spec.version !== 1 || !/^[a-z0-9.-]+$/.test(spec.bundleId)) throw new Error('受管运行时清单无效')

function inside(parent, path) {
  const part = relative(parent, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}
async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
async function download(entry) {
  const url = new URL(entry.url)
  if (url.protocol !== 'https:' || !['github.com', 'files.pythonhosted.org'].includes(url.hostname)
    || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('资源 URL 或内容指纹无效')
  await mkdir(cache, { recursive: true })
  const path = join(cache, `${entry.sha256}.tar.gz`)
  if (!await exists(path)) {
    const temporary = `${path}.${randomUUID()}.part`
    console.log(`获取固定资源：${decodeURIComponent(url.pathname.split('/').at(-1))}`)
    execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https',
      '--proto-redir', '=https', '--connect-timeout', '30', '--max-time', '300', '--output', temporary, url.href], { stdio: 'inherit' })
    const digest = createHash('sha256').update(await readFile(temporary)).digest('hex')
    if (digest !== entry.sha256) throw new Error(`下载资源指纹不一致，保留隔离文件：${temporary}`)
    await rename(temporary, path)
  }
  if (createHash('sha256').update(await readFile(path)).digest('hex') !== entry.sha256) {
    throw new Error(`缓存指纹不一致，不覆盖原文件：${path}`)
  }
  return path
}
async function checkTree(directory, boundary = directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (!inside(boundary, await realpath(path))) throw new Error(`归档链接越界：${path}`)
    if (item.isDirectory()) await checkTree(path, boundary)
  }
}
async function extract(archive, output) {
  const listing = execFileSync(tar, ['-tzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  for (const name of listing.split(/\r?\n/).filter(Boolean)) {
    const normalized = name.replaceAll('\\', '/')
    if (normalized.startsWith('/') || normalized.includes(':') || normalized.includes('\0')
      || normalized.split('/').includes('..')) throw new Error('归档含越界入口，未解压')
  }
  await mkdir(output, { recursive: true })
  execFileSync(tar, ['-xzf', archive, '-C', output], { stdio: 'inherit' })
  await checkTree(output)
}

const timezoneArchive = await download(spec.timezone)
const targets = args[0] === '--all' ? Object.keys(spec.targets) : [target]
for (const name of targets) {
  const entry = spec.targets[name]
  if (!entry) throw new Error(`不支持的运行环境：${name}`)
  const archive = await download(entry)
  // 外平台归档只缓存，不在 Windows 上创建 macOS 符号链接；对应主机显式准备后再暂存。
  if (name !== target) { console.log(`外平台固定归档已缓存：${name}`); continue }
  const parent = join(root, 'runtime/memory', name)
  const output = join(parent, spec.bundleId)
  if (await exists(output)) {
    const metadata = JSON.parse(await readFile(join(output, 'runtime.json'), 'utf8'))
    if (metadata.bundleId !== spec.bundleId || metadata.target !== name || metadata.pythonSha256 !== entry.sha256
      || metadata.timezoneSha256 !== spec.timezone.sha256) throw new Error(`现有资源身份不匹配，未覆盖：${output}`)
    await lstat(join(output, entry.python))
    await lstat(join(output, spec.timezone.directory, 'UTC'))
    console.log(`保留已有固定资源：${name}`)
    continue
  }
  await mkdir(parent, { recursive: true })
  const staging = join(cache, `staging-${name}-${randomUUID()}`)
  await extract(archive, join(staging, 'distribution'))
  await extract(timezoneArchive, join(staging, 'timezone'))
  if (!(await lstat(join(staging, entry.python))).isFile()
    || !(await lstat(join(staging, spec.timezone.directory, 'UTC'))).isFile()) throw new Error('归档布局与固定入口不匹配')
  const metadata = { version: 1, bundleId: spec.bundleId, target: name, pythonVersion: spec.pythonVersion,
    python: entry.python, timezoneVersion: spec.timezone.version, timezoneDirectory: spec.timezone.directory,
    pythonSha256: entry.sha256, timezoneSha256: spec.timezone.sha256 }
  await cp(join(root, 'resources/memory-runtime/NOTICE.md'), join(staging, 'NOTICE.md'))
  await writeFile(join(staging, 'runtime.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  await rename(staging, output)
  console.log(`固定资源已准备：${name} → ${output}`)
}
