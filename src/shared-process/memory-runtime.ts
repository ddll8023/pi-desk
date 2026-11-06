/** 受管记忆运行环境的固定布局与宿主配置；只读资源，不执行解释器或推断项目环境。 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface MemoryHostConfiguration {
  readonly version: 1
  readonly revision: number
  readonly enabled: boolean
  /** 是否由执行模式关闭：用户开关仍开着，但这个会话不注入记忆。 */
  readonly disabledByMode: boolean
  readonly available: boolean
  readonly store: string
  readonly engine: string
  readonly python: string
  readonly tzdata: string | null
  readonly pythonVersion: string | null
  readonly timezoneVersion: string | null
  readonly error: string | null
}
export interface MemoryConfigurationProvider {
  /** 按当前开关与资源状态生成一份配置；调用方每次建立宿主前读取一次。 */
  readonly read: (hostEntry: string) => Promise<MemoryHostConfiguration>
}
/**
 * 传递扩展进程内配置的环境变量。
 * 扩展工厂在资源加载阶段同步执行，早于宿主拿到资源加载器的时机，
 * 因此首次配置必须能从进程环境同步读到；后续变更走事件总线推送。
 */
export const MEMORY_CONFIGURATION_ENV = 'PI_DESK_MEMORY_CONFIG'
export function serializeMemoryConfiguration(configuration: MemoryHostConfiguration): string {
  return JSON.stringify(configuration)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function nullableText(value: unknown): boolean { return value === null || typeof value === 'string' }
export function isMemoryHostConfiguration(value: unknown): value is MemoryHostConfiguration {
  return record(value) && value.version === 1 && typeof value.revision === 'number'
    && Number.isSafeInteger(value.revision) && value.revision >= 0
    && typeof value.enabled === 'boolean' && typeof value.disabledByMode === 'boolean'
    && typeof value.available === 'boolean'
    && typeof value.store === 'string' && isAbsolute(value.store)
    && typeof value.engine === 'string' && isAbsolute(value.engine)
    && typeof value.python === 'string' && isAbsolute(value.python)
    && (value.tzdata === null || (typeof value.tzdata === 'string' && isAbsolute(value.tzdata)))
    && (!value.available || value.tzdata !== null)
    && nullableText(value.pythonVersion) && nullableText(value.timezoneVersion) && nullableText(value.error)
    && Object.keys(value).every(key => ['version', 'revision', 'enabled', 'disabledByMode', 'available', 'store', 'engine', 'python',
      'tzdata', 'pythonVersion', 'timezoneVersion', 'error'].includes(key))
}
function resource(root: string, name: unknown, directory = false): string {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\') || name.includes(':')
    || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('受管运行资源入口无效')
  const path = realpathSync(resolve(root, name))
  const part = relative(root, path)
  if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new Error('受管运行资源入口越界')
  const info = statSync(path)
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('受管运行资源类型不匹配')
  return path
}
export function globalMemoryDirectory(): string { return join(homedir(), '.agents', 'memory-store') }

/** 缺资源仍返回受管配置，使普通对话可用；记忆操作会明确失败，绝不回退系统解释器。 */
export function managedMemoryConfiguration(hostEntry: string, enabled: boolean, revision: number): MemoryHostConfiguration {
  const hostRoot = dirname(hostEntry)
  const runtimeRoot = join(hostRoot, 'memory-runtime')
  const engine = join(hostRoot, 'agent-resources/skills/memory/scripts/memory_store.py')
  const base: MemoryHostConfiguration = { version: 1, revision, enabled, disabledByMode: false, available: false,
    store: globalMemoryDirectory(), engine, python: join(runtimeRoot, 'unavailable'), tzdata: null,
    pythonVersion: null, timezoneVersion: null, error: null }
  if (!['win32', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
    return { ...base, error: '当前平台或架构没有受管记忆运行环境。' }
  }
  try {
    const root = realpathSync(runtimeRoot)
    const metadataPath = resource(root, 'runtime.json')
    if (statSync(metadataPath).size > 65_536) throw new Error('运行资源清单过大')
    const metadata: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'))
    if (!record(metadata) || metadata.version !== 1 || metadata.target !== `${process.platform}-${process.arch}`
      || typeof metadata.pythonVersion !== 'string' || typeof metadata.timezoneVersion !== 'string'
      || typeof metadata.pythonSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.pythonSha256)
      || typeof metadata.timezoneSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.timezoneSha256)) {
      throw new Error('运行资源清单与平台不匹配')
    }
    const python = resource(root, metadata.python)
    const tzdata = resource(root, metadata.timezoneDirectory, true)
    resource(tzdata, 'UTC')
    if (!statSync(engine).isFile()) throw new Error('配套记忆引擎缺失')
    return { ...base, available: true, python, tzdata, pythonVersion: metadata.pythonVersion,
      timezoneVersion: metadata.timezoneVersion, error: null }
  } catch {
    return { ...base, error: '受管 Python、配套引擎或时区资源缺失／无效；不会使用系统 Python 或项目虚拟环境。' }
  }
}
