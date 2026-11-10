/**
 * 对齐记忆库里来自旧机器、旧注册表的孤儿归属：按「旧项目 ID → 项目名」改判到名称派生 ID。
 *
 * 启动对齐（src/main/config/project-identity-migration.ts）只遍历当前注册表里的旧 ID，
 * 看不到别的机器注册时写下的归属；这类孤儿归属由本脚本按固定映射表处理。
 * 派生口径必须与 src/main/config/project-identity.ts 一致：同一命名空间、名称 NFKC + 去首尾空白 + 小写。
 * 只调用引擎 reassign 改归属，不写正文、不重建词项；重复运行幂等，已迁移的旧 ID 会被引擎按「没有归属」跳过。
 *
 * 用法：node scripts/align-project-identity.mjs [--store <dir>] [--python <path>] [--engine <path>] [--dry-run]
 * 环境变量：PI_MEMORY_STORE、PI_MEMORY_PYTHON、PI_MEMORY_ENGINE、PI_MEMORY_TZDATA 可代替同名参数。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 与 src/main/config/project-identity.ts 完全相同的命名空间；改动它等于一次全量身份迁移。 */
const PROJECT_NAMESPACE = '7f3c1d52-9a44-4e2b-8c11-6d5b9f0a2c33'
/**
 * 孤儿归属映射：只能由人来判定，脚本不按目录名或记录内容猜项目。
 * 左边是历史上出现过的随机项目 ID，右边是该项目在当前注册表里的名称。
 */
const LEGACY_PROJECTS = [
  { id: '01943432-e84f-4d77-a0be-3ed48c2c4e45', name: 'pi-desk' },
  { id: '8ec31225-b387-4cc1-8290-6755c00b3aae', name: 'pi-desk' },
  { id: '535f7d25-89b3-438b-8762-5770db50853c', name: 'yuanyi1' },
  { id: '20ecde08-ae8b-444b-94ac-d329526fbd2f', name: 'memory-manager-web' },
  { id: '8c91dc12-b604-48e6-8567-e686da51bfd7', name: 'note' },
  { id: 'add17090-3d53-4276-89ee-a9099e62111d', name: 'tools' },
  { id: '56b9ca28-acab-46ed-9d19-3c0dd01f2a50', name: 'aiqc' }
]

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`[align-identity] ${message}`)
  process.exit(1)
}

/** 名称归一与派生：任何一处不一致都会让同一项目在两处得到不同身份，因此集中在这里实现一次。 */
function normalizeProjectName(name) {
  return name.normalize('NFKC').trim().toLowerCase()
}

function projectIdForName(name) {
  const namespace = Buffer.from(PROJECT_NAMESPACE.replace(/-/g, ''), 'hex')
  const digest = createHash('sha1')
    .update(namespace)
    .update(Buffer.from(normalizeProjectName(name), 'utf8'))
    .digest()
  // RFC 4122：哈希前 16 字节标记为版本 5 与 RFC 变体，其余位保留。
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 只解析脚本自己的四个开关；未知参数直接报错，避免拼写错误静默跑成另一次迁移。 */
function parseArgs(argv) {
  const options = { store: null, python: null, engine: null, dryRun: false, tzdata: null }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--dry-run') { options.dryRun = true; continue }
    const value = argv[index + 1]
    if (!['--store', '--python', '--engine', '--tzdata'].includes(arg)) fail(`未知参数：${arg}`)
    if (value === undefined || value.startsWith('--')) fail(`${arg} 缺少取值`)
    options[arg.slice(2)] = value
    index += 1
  }
  return options
}

/** 受管运行时优先：随包解释器带时区数据，换机器时不必依赖系统 Python。 */
function detectPython(configured) {
  const candidates = [
    configured,
    process.env.PI_MEMORY_PYTHON,
    join(repoRoot, 'out/sdk-host/memory-runtime/distribution/python/python.exe'),
    join(repoRoot, 'out/sdk-host/memory-runtime/distribution/python/bin/python3')
  ].filter(value => typeof value === 'string' && value !== '')
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate)
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

function detectEngine(configured) {
  const candidates = [
    configured,
    process.env.PI_MEMORY_ENGINE,
    join(repoRoot, 'resources/agent/skills/memory/scripts/memory_store.py'),
    join(repoRoot, 'out/sdk-host/agent-resources/skills/memory/scripts/memory_store.py')
  ].filter(value => typeof value === 'string' && value !== '')
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate)
  }
  fail('找不到记忆引擎 memory_store.py；用 --engine 指定')
}

/** 随包时区目录按版本命名，取最新一个即可；系统已有 zoneinfo 时不传。 */
function detectTzdata(configured) {
  if (typeof configured === 'string' && configured !== '') return resolve(configured)
  if (process.env.PI_MEMORY_TZDATA) return resolve(process.env.PI_MEMORY_TZDATA)
  const root = join(repoRoot, 'out/sdk-host/memory-runtime/timezone')
  if (!existsSync(root)) return null
  for (const entry of readdirSync(root)) {
    const candidate = join(root, entry, 'src/tzdata/zoneinfo')
    if (existsSync(candidate) && existsSync(join(candidate, 'UTC'))) return candidate
  }
  return null
}

/** 调用引擎改判一条归属：成功取 reassigned 数，「没有归属」视为该旧 ID 已无记录。 */
function reassign(python, engine, tzdata, store, pair, target) {
  const args = ['-I', '-B', engine, ...(tzdata === null ? [] : ['--tzdata', tzdata]),
    '--store', store, 'reassign', '--from', pair.id, '--to', target, '--approved']
  const result = spawnSync(python, args, { encoding: 'utf8', windowsHide: true })
  if (result.error) fail(`无法启动记忆引擎：${result.error.message}`)
  let payload = null
  try { payload = result.stdout.trim() ? JSON.parse(result.stdout) : null } catch { payload = null }
  if (result.status === 0 && payload?.ok === true) {
    const count = typeof payload.data?.reassigned === 'number' ? payload.data.reassigned : 0
    return { status: 'migrated', count }
  }
  const message = typeof payload?.error?.message === 'string' ? payload.error.message : (result.stderr ?? '').trim()
  // 该旧 ID 在库里没有记录属于正常情况：别的机器已经迁移过。
  if (/没有归属/.test(message)) return { status: 'skipped', count: 0, message }
  return { status: 'failed', count: 0, message: message || `exit ${result.status ?? 'unknown'}` }
}

const options = parseArgs(process.argv.slice(2))
const store = resolve(options.store ?? process.env.PI_MEMORY_STORE ?? join(homedir(), '.agents/memory-store'))
const python = detectPython(options.python)
const engine = detectEngine(options.engine)
const tzdata = detectTzdata(options.tzdata)
const plan = LEGACY_PROJECTS.map(pair => ({ pair, target: projectIdForName(pair.name) }))

console.log(`[align-identity] store=${store}`)
console.log(`[align-identity] python=${python}`)
console.log(`[align-identity] engine=${engine}`)
console.log(`[align-identity] tzdata=${tzdata ?? '(未使用，依赖系统 zoneinfo)'}`)
for (const item of plan) {
  console.log(`  ${item.pair.id} (${item.pair.name}) -> ${item.target}`)
}
if (options.dryRun) {
  console.log('[align-identity] --dry-run：只列出映射，未调用引擎、未改库')
  process.exit(0)
}

let migrated = 0
let skipped = 0
const failed = []
for (const item of plan) {
  const result = reassign(python, engine, tzdata, store, item.pair, item.target)
  if (result.status === 'migrated') {
    migrated += result.count
    console.log(`  migrated ${result.count} 条：${item.pair.id} (${item.pair.name})`)
  } else if (result.status === 'skipped') {
    skipped += 1
    console.log(`  skipped：${item.pair.id} (${item.pair.name}) 无待改判记录`)
  } else {
    failed.push(item.pair.name)
    console.error(`  failed：${item.pair.id} (${item.pair.name}) ${result.message}`)
  }
}
console.log(`[align-identity] 完成：改判 ${migrated} 条，跳过 ${skipped} 项，失败 ${failed.length} 项`)
if (failed.length > 0) fail(`以下项目未完成：${failed.join('、')}`)
