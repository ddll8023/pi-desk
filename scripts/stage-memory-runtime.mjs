/** 将当前主机固定运行资源暂存到宿主旁；不下载、不执行解释器、不构建或初始化用户库。 */
import { cp, lstat, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const spec = JSON.parse(await readFile(join(root, 'resources/memory-runtime/manifest.json'), 'utf8'))
const target = `${process.platform}-${process.arch}`
const entry = spec.targets[target]
if (!entry) throw new Error(`不支持的受管运行环境：${target}`)
const source = join(root, 'runtime/memory', target, spec.bundleId)
const output = join(root, 'out/sdk-host/memory-runtime')
let metadata
try { metadata = JSON.parse(await readFile(join(source, 'runtime.json'), 'utf8')) } catch (error) {
  if (error.code === 'ENOENT') throw new Error('受管运行环境尚未准备；请显式运行 npm run memory-runtime:prepare，不会自动下载。')
  throw error
}
if (metadata.version !== 1 || metadata.bundleId !== spec.bundleId || metadata.target !== target
  || metadata.pythonSha256 !== entry.sha256 || metadata.timezoneSha256 !== spec.timezone.sha256
  || metadata.python !== entry.python || metadata.timezoneDirectory !== spec.timezone.directory) {
  throw new Error('固定运行资源身份不匹配，未暂存')
}
await lstat(join(source, metadata.python))
await lstat(join(source, metadata.timezoneDirectory, 'UTC'))
try {
  const old = JSON.parse(await readFile(join(output, 'runtime.json'), 'utf8'))
  if (old.bundleId !== spec.bundleId || old.target !== target) throw new Error('产物存在其他运行资源，须由明确构建清理后再暂存')
} catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(dirname(output), { recursive: true })
await cp(source, output, { recursive: true, force: true, dereference: false, verbatimSymlinks: true })
console.log(`当前主机运行资源已暂存：${target} → ${output}`)
