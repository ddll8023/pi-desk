/**
 * 将唯一维护源 resources/agent 原样暂存到 SDK 宿主产物旁，并生成内容指纹清单。
 *
 * 只由获准的构建流程调用，不执行扩展、Python 或用户配置，不安装依赖、初始化记忆或重载会话。
 * 不合并或转译扩展模块，保留 import.meta.url、相对引擎路径和门禁加载指纹的语义。
 * 只写本次源文件和生成清单，并删除产物目录中本次未声明的旧文件：历史残留会让「拷贝产物目录」
 * 把已从源删除的模块带回部署副本，使副本组成与当前版本不一致。
 * 暂存前先核对工具声明：扩展必需工具与仓库内可证的 `registerTool` 注册必须都出现在清单的 tools 段，
 * 不满足则终止，不写出混合版本产物；SDK 内建与外部扩展工具没有注册源码可证，不在核对范围。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
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

/**
 * 仓库内可见的工具注册来源：随包扩展与 SDK 宿主内联扩展。
 * SDK 内建工具（read／write／bash 等）、SDK 自带扩展（codemode／tool_search）与用户安装扩展提供的工具
 * 在仓库里没有注册源码，无法静态证明，因此不在核对范围内；只保证「仓库里能证的注册」不漏声明。
 */
const TOOL_SOURCE_DIRECTORIES = [
  join(projectRoot, 'resources', 'agent', 'extensions'),
  join(projectRoot, 'src', 'sdk-host')
]

/** 递归收集工具源码：只取 `.ts`，跳过测试文件与依赖目录。 */
async function collectToolSources(directory, files = []) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return files
    throw error
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__pycache__') continue
      await collectToolSources(path, files)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path)
  }
  return files
}

/**
 * 从一个源码文件里取 `registerTool({ name: … })` 的工具名。
 * 只认字面量与单文件常量（含 `const A = B` 别名）；动态拼接的名字直接忽略，
 * 漏抓只会少核对，不会误报。每个 `registerTool({` 之后只看首个 `name:`：声明字段顺序固定。
 */
function registeredToolNamesOf(text) {
  const constants = new Map()
  const declaration = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))/g
  for (const match of text.matchAll(declaration)) {
    const [, name, single, double, alias] = match
    constants.set(name, single ?? double ?? alias)
  }
  const resolveConstant = name => {
    let current = name
    for (let depth = 0; depth < 4; depth += 1) {
      const next = constants.get(current)
      if (next === undefined || next === current) return undefined
      if (constants.has(next)) {
        current = next
        continue
      }
      return next
    }
    return undefined
  }
  const names = new Set()
  for (const segment of text.split(/registerTool\s*\(\s*\{/).slice(1)) {
    const match = /^[\s\S]{0,2000}?name:\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$.]*))/.exec(segment)
    if (match === null) continue
    const [, single, double, identifier] = match
    if (single !== undefined || double !== undefined) {
      names.add(single ?? double)
      continue
    }
    const resolved = resolveConstant(identifier.split('.').pop())
    if (resolved !== undefined) names.add(resolved)
  }
  return names
}

/**
 * 构建期门禁：清单的工具声明必须覆盖扩展必需工具与仓库内可证的注册。
 * 不满足就终止暂存：漏声明的工具在设置页无法勾选，在「仅用选中」下会被当成范围外。
 */
async function assertToolDeclarations(bundle) {
  const declared = Array.isArray(bundle.tools) ? bundle.tools : []
  const declaredNames = new Set(declared
    .map(item => (item !== null && typeof item === 'object' ? item.name : undefined))
    .filter(name => typeof name === 'string'))
  const requiredTools = bundle.extensions.flatMap(item => (Array.isArray(item.requiredTools) ? item.requiredTools : []))
  const missing = requiredTools.filter(name => !declaredNames.has(name))
  for (const directory of TOOL_SOURCE_DIRECTORIES) {
    for (const path of await collectToolSources(directory)) {
      const text = await readFile(path, 'utf8')
      for (const name of registeredToolNamesOf(text)) {
        if (declaredNames.has(name)) continue
        missing.push(`${name}（${relative(projectRoot, path).split(sep).join('/')}）`)
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`工具声明遗漏：${[...new Set(missing)].join('、')}；先在 resources/agent/bundle.json 的 tools 段补齐`)
  }
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
    // Python 字节码缓存不可能是产品资源：它不是 UTF-8 文本（指纹解码会直接失败），也不应随包分发。
    // 记忆引擎在源目录里被导入时会就地生成，因此按名字跳过，不要求维护者手工清理。
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue
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

/** 产物目录里现有的普通文件；目录不存在时返回空集合，不把首次构建当成故障。 */
async function collectExisting(directory, files = []) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return files
    throw error
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collectExisting(path, files)
    else if (entry.isFile()) files.push(path)
  }
  return files
}

/** 删除清完旧文件后剩下的空目录；非空目录保持原样。 */
async function pruneEmptyDirectories(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await pruneEmptyDirectories(join(directory, entry.name))
  }
  if (directory === outputRoot) return
  try {
    await rmdir(directory)
  } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
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
  if (bundle.version !== 1 || !Array.isArray(bundle.extensions) || !Array.isArray(bundle.skills)
    || (bundle.experts !== undefined && !Array.isArray(bundle.experts))
    || (bundle.teams !== undefined && !Array.isArray(bundle.teams))) {
    throw new Error('产品资源清单格式无效')
  }
  // 专家段与团队段同构，但都可以由旧清单直接缺省；缺省时产物里也不写这一项。
  const components = [...bundle.extensions, ...bundle.skills,
    ...(Array.isArray(bundle.experts) ? bundle.experts : []),
    ...(Array.isArray(bundle.teams) ? bundle.teams : [])]
  const ids = new Set()
  for (const item of components) {
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id) || !Array.isArray(item.files)
      || item.files.length === 0 || !item.files.includes(item.entry)) throw new Error('产品资源身份或组成文件无效')
    ids.add(item.id)
    requireEntry(item.entry, files)
    for (const name of item.files) requireEntry(name, files)
  }
  requireEntry(bundle.memoryEngine, files)
  // 工具声明与仓库内可证注册、扩展必需工具一次性核对；在清理旧产物之前失败，不留下半份暂存。
  await assertToolDeclarations(bundle)
  // 先清掉本次未声明的旧文件：夹在两次构建之间的产物目录不应同时存在两个版本的组成。
  const declared = new Set([...files.keys(), 'bundle.json'])
  let removed = 0
  for (const path of await collectExisting(outputRoot)) {
    if (declared.has(relative(outputRoot, path).split(sep).join('/'))) continue
    await rm(path, { force: true })
    removed += 1
  }
  await pruneEmptyDirectories(outputRoot)
  const fingerprints = {}
  for (const [name, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    fingerprints[name] = fingerprint(bytes)
    const target = join(outputRoot, name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
  // 组件摘要写在清单里，运行期会按 fingerprints 重算复核；它区分副本与本机版本的偏离程度，不用于准入。
  const componentDigests = {}
  for (const item of components) {
    componentDigests[item.id] = componentDigest(fingerprints, item.files)
  }
  // 清单最后写入；部分暂存失败时，运行期不能把混合版本误当作完整资源。
  await writeFile(join(outputRoot, 'bundle.json'),
    `${JSON.stringify({ ...bundle, fingerprints, componentDigests }, null, 2)}\n`)
  console.log(`产品 Agent 资源已暂存：${outputRoot}（清理旧文件 ${removed} 个）`)
}

await stage()
