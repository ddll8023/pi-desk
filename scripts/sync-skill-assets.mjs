/**
 * 从唯一维护源 `resources/agent` 生成 pi-skill-setup 的发布快照（assets/pi-memory 与 assets/memory）。
 *
 * 只读维护源与目标快照，不执行扩展、Python 或用户配置，不部署到 agent 目录，不改本机 config.json。
 * 快照必须与维护源逐字节一致：复制组件声明文件与 README，删除已从源移除的旧文件，
 * 并按原始字节重算 memory-bundle.json 的 files 指纹；memory_contract 等描述字段不在这里改写。
 * 用法：`npm run skill-assets:sync`，或用第一个参数指定快照目录。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(projectRoot, 'resources', 'agent')
const targetRoot = resolve(process.argv[2] ?? join(homedir(), '.pi', 'agent', 'skills', 'pi-skill-setup', 'assets'))
const manifestName = 'memory-bundle.json'

/** 快照内由本脚本改写的两个目录；其余内容（配置模板、AGENTS 模板）不在职责内。 */
const extensionDirectory = join(targetRoot, 'extensions')
const memoryDirectory = join(targetRoot, 'memory')

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/** 组件目录里除声明文件外还要随包发布的使用说明；它不进入指纹清单。 */
async function explanationFiles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.filter(entry => entry.isFile() && entry.name === 'README.md').map(entry => entry.name)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/** 目录内现有普通文件（相对该目录、按 `/` 分隔）；目录不存在时返回空集合。 */
async function collectExisting(directory, base = directory, files = []) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return files
    throw error
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collectExisting(path, base, files)
    else if (entry.isFile()) files.push(relative(base, path).split(sep).join('/'))
  }
  return files
}

/** 删除不期望保留的旧文件与随之变空的目录；非空目录保持原样。 */
async function prune(directory, keep, removed) {
  for (const name of await collectExisting(directory)) {
    if (keep.has(name)) continue
    await rm(join(directory, ...name.split('/')), { force: true })
    removed.push(join(directory, ...name.split('/')))
  }
  await pruneEmptyDirectories(directory)
}

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
  try {
    await rmdir(directory)
  } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
  }
}

async function writeAsset(relativePath, bytes) {
  const path = join(targetRoot, ...relativePath.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return path
}

async function syncExtension(item) {
  const sourceDirectory = join(sourceRoot, ...item.files[0].split('/').slice(0, -1))
  const targetName = item.files[0].split('/')[1]
  const keep = new Set()
  const assets = []
  for (const name of [...item.files.map(file => file.split('/').pop()), ...await explanationFiles(sourceDirectory)]) {
    const relativePath = `extensions/${targetName}/${name}`
    const bytes = await readFile(join(sourceDirectory, name))
    await writeAsset(relativePath, bytes)
    keep.add(name)
    assets.push({ component: 'pi_memory_extension', asset: `assets/${relativePath}`, target: name, sha256: digest(bytes) })
  }
  const removed = []
  await prune(join(extensionDirectory, targetName), keep, removed)
  return { assets, removed }
}

async function syncMemorySkill(item) {
  const prefix = item.entry.split('/').slice(0, 2).join('/')
  const keep = new Set()
  const assets = []
  for (const file of item.files) {
    const name = file.slice(prefix.length + 1)
    const targetName = name === 'SKILL.md' ? 'SKILL.md.template' : name
    const bytes = await readFile(join(sourceRoot, ...file.split('/')))
    await writeAsset(`memory/${targetName}`, bytes)
    keep.add(targetName)
    assets.push({ component: 'memory_skill', asset: `assets/memory/${targetName}`, target: name, sha256: digest(bytes) })
  }
  const removed = []
  await prune(memoryDirectory, keep, removed)
  return { assets, removed }
}

async function main() {
  const bundle = await readJson(join(sourceRoot, 'bundle.json'))
  const manifestPath = join(targetRoot, manifestName)
  const manifest = await readJson(manifestPath)
  const extension = bundle.extensions.find(item => item.id === 'pi-memory')
  const skill = bundle.skills.find(item => item.id === 'memory')
  if (!extension || !skill) throw new Error('维护源缺少 pi-memory 扩展或 memory Skill')
  if (!Array.isArray(manifest.files)) throw new Error('目标快照的清单缺少 files')

  // 配置模板由目标机生成，不在维护源内：保留现有文件与指纹，不随本脚本改写。
  const configEntry = manifest.files.find(item => item.component === 'pi_memory_config_template')
  const memory = await syncMemorySkill(skill)
  const piMemory = await syncExtension(extension)
  const files = [...memory.assets, ...piMemory.assets]
  if (configEntry !== undefined) {
    const bytes = await readFile(join(targetRoot, ...configEntry.asset.split('/')))
    files.push({ ...configEntry, sha256: digest(bytes) })
  }
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, files }, null, 2)}\n`)

  for (const path of [...memory.removed, ...piMemory.removed]) console.log(`已移除旧文件：${path}`)
  console.log(`发布快照已同步：${targetRoot}（${files.length} 个文件指纹）`)
}

await main()
