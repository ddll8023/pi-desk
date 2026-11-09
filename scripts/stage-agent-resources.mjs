/**
 * 将唯一维护源 resources/agent 原样暂存到 SDK 宿主产物旁，并生成内容指纹清单。
 *
 * 只由获准的构建流程调用，不执行扩展、Python 或用户配置，不安装依赖、初始化记忆或重载会话。
 * 不合并或转译扩展模块，保留 import.meta.url、相对引擎路径和门禁加载指纹的语义。
 * 只写本次源文件和生成清单，不删除目录；历史残留不作为加载来源。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(projectRoot, 'resources', 'agent')
const outputRoot = join(projectRoot, 'out', 'sdk-host', 'agent-resources')

/**
 * 组件聚合摘要：与运行期 componentDigestOf 完全同规则。
 * 按相对路径码位序排序（不用 localeCompare，避免区域设置影响），再拼接「路径 \0 指纹」行取 sha256。
 */
function componentDigest(fingerprints, files) {
  const lines = [...files]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map(name => `${name}\u0000${fingerprints[name] ?? ''}`)
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** 与运行期身份比对一致：只归一化 BOM 和换行，不改写实际复制的字节。 */
function fingerprint(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  return createHash('sha256').update(text).digest('hex')
}

/** 收集显式维护的普通文件；拒绝符号链接，避免把仓库外文件带进产品。 */
async function collect(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`产品资源不允许符号链接：${path}`)
    if (entry.isDirectory()) await collect(path, files)
    else if (entry.isFile()) files.push(path)
    else throw new Error(`产品资源必须是普通文件：${path}`)
  }
  return files
}

/** 清单中的入口只能指向当前资源树内的已收集文件。 */
function requireEntry(value, files) {
  if (typeof value !== 'string' || isAbsolute(value) || value.includes('\\')
    || value.split('/').some(part => !part || part === '.' || part === '..') || !files.has(value)) {
    throw new Error('产品资源清单包含无效或缺失的文件入口')
  }
}

async function stage() {
  const source = await realpath(sourceRoot)
  const files = new Map()
  for (const path of await collect(source)) {
    const name = relative(source, path).split(sep).join('/')
    if (name === 'bundle.json') continue
    files.set(name, await readFile(path))
  }
  const bundle = JSON.parse(await readFile(join(source, 'bundle.json'), 'utf8'))
  if (bundle.version !== 1 || !Array.isArray(bundle.extensions) || !Array.isArray(bundle.skills)) {
    throw new Error('产品资源清单格式无效')
  }
  const ids = new Set()
  for (const item of [...bundle.extensions, ...bundle.skills]) {
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id) || !Array.isArray(item.files)
      || item.files.length === 0 || !item.files.includes(item.entry)) throw new Error('产品资源身份或组成文件无效')
    ids.add(item.id)
    requireEntry(item.entry, files)
    for (const name of item.files) requireEntry(name, files)
  }
  requireEntry(bundle.memoryEngine, files)
  const fingerprints = {}
  for (const [name, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    fingerprints[name] = fingerprint(bytes)
    const target = join(outputRoot, name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
  // 组件摘要写在清单里，运行期会按 fingerprints 重算复核；它区分副本与本机版本的偏离程度，不用于准入。
  const componentDigests = {}
  for (const item of [...bundle.extensions, ...bundle.skills]) {
    componentDigests[item.id] = componentDigest(fingerprints, item.files)
  }
  // 清单最后写入；部分暂存失败时，运行期不能把混合版本误当作完整资源。
  await writeFile(join(outputRoot, 'bundle.json'),
    `${JSON.stringify({ ...bundle, fingerprints, componentDigests }, null, 2)}\n`)
  console.log(`产品 Agent 资源已暂存：${outputRoot}`)
}

await stage()
