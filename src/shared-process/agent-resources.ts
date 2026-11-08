/**
 * 产品 Agent 资源的固定布局、清单读取与同源身份比对。
 * 只读取主进程指定的产物目录，不执行扩展、不发现用户配置、不创建或迁移记忆数据。
 * 内容指纹证明的是文件身份，不是 Skill 已读证据、用户授权或系统安全沙箱。
 */
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

const RESOURCE_DIRECTORY = 'agent-resources'
const MANIFEST_NAME = 'bundle.json'
const MAX_MANIFEST_BYTES = 131_072
const MAX_RESOURCE_BYTES = 2_097_152

export interface AgentResource {
  readonly id: string
  readonly entry: string
  readonly files: readonly string[]
  readonly requiredTools: readonly string[]
  readonly localConfigFiles: readonly string[]
  /** 仅供子代理进程按目录名读取、不进入主会话技能列表：子代理身份规范不属于主代理能力。 */
  readonly subAgentOnly: boolean
}

export interface AgentResourceBundle {
  readonly root: string
  readonly extensions: readonly AgentResource[]
  readonly skills: readonly AgentResource[]
  readonly memoryEngine: string
  readonly fingerprints: Readonly<Record<string, string>>
}

/** SDK 宿主入口及其产品资源使用同一产物根，不随业务项目变化。 */
export function agentResourcesDirectory(hostEntry: string): string {
  return join(dirname(hostEntry), RESOURCE_DIRECTORY)
}

function inside(root: string, target: string): boolean {
  const part = relative(root, target)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resourceName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !value.includes('\\')
    && !value.includes(':') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0)
}

/** 相对入口同时核对词法边界与实际落点，不允许链接把资源带出指定目录。 */
export function agentResourcePath(root: string, name: string): string {
  if (!resourceName(name)) throw new Error('产品资源入口不是受限相对路径')
  const path = resolve(root, name)
  const actual = realpathSync(path)
  if (!inside(root, actual) || !statSync(actual).isFile()) throw new Error(`产品资源越界或不是普通文件：${name}`)
  return actual
}

/** 与构建暂存脚本保持一致；只归一化文本身份，不更改执行文件。 */
function fingerprint(path: string): string {
  const info = statSync(path)
  if (!info.isFile() || info.size > MAX_RESOURCE_BYTES) throw new Error('产品资源文件无效或超过读取上限')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))
    .replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  return createHash('sha256').update(text).digest('hex')
}

function parseResource(value: unknown): AgentResource {
  if (!record(value) || typeof value.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value.id)
    || !resourceName(value.entry) || !strings(value.files) || value.files.length === 0
    || value.files.length > 128 || !value.files.every(resourceName) || !value.files.includes(value.entry)
    || (value.requiredTools !== undefined && !strings(value.requiredTools))
    || (value.subAgentOnly !== undefined && typeof value.subAgentOnly !== 'boolean')
    || (value.localConfigFiles !== undefined && (!strings(value.localConfigFiles) || !value.localConfigFiles.every(resourceName)))) {
    throw new Error('产品资源组成清单无效')
  }
  const base = posix.dirname(value.entry)
  if (value.files.some(path => !path.startsWith(`${base}/`))) throw new Error('产品组件文件不在入口所属目录内')
  return {
    id: value.id, entry: value.entry, files: value.files,
    requiredTools: value.requiredTools ?? [], localConfigFiles: value.localConfigFiles ?? [],
    subAgentOnly: value.subAgentOnly === true
  }
}

/** 运行期只接受已生成指纹的产物清单；源码目录不能作为缺失产物的隐式回退。 */
export function readAgentResourceBundle(directory: string): AgentResourceBundle {
  if (!isAbsolute(directory)) throw new Error('产品资源目录必须是绝对路径')
  const root = realpathSync(directory)
  const manifestPath = agentResourcePath(root, MANIFEST_NAME)
  if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) throw new Error('产品资源清单超过读取上限')
  const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.extensions) || !Array.isArray(raw.skills)
    || !resourceName(raw.memoryEngine) || !record(raw.fingerprints)) throw new Error('产品资源清单缺失或版本无效')
  const extensions = raw.extensions.map(parseResource)
  const skills = raw.skills.map(parseResource)
  const ids = [...extensions, ...skills].map(item => item.id)
  if (new Set(ids).size !== ids.length || extensions.some(item => item.requiredTools.length === 0)
    || !extensions.some(item => item.id === 'skill-guard')
    || !extensions.some(item => item.id === 'pi-memory') || !skills.some(item => item.id === 'memory')) {
    throw new Error('产品必要能力缺失或身份重复')
  }
  const fingerprints: Record<string, string> = {}
  const entries = Object.entries(raw.fingerprints)
  if (entries.length === 0 || entries.length > 256) throw new Error('产品资源指纹清单无效')
  for (const [name, digest] of entries) {
    if (!resourceName(name) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error('产品资源内容指纹无效')
    }
    if (fingerprint(agentResourcePath(root, name)) !== digest) throw new Error(`产品资源内容与清单不一致：${name}`)
    fingerprints[name] = digest
  }
  for (const name of [...extensions, ...skills].flatMap(item => item.files).concat(raw.memoryEngine)) {
    if (!Object.hasOwn(fingerprints, name)) throw new Error(`产品资源缺少内容指纹：${name}`)
  }
  return { root, extensions, skills, memoryEngine: raw.memoryEngine, fingerprints }
}

/**
 * 仅把入口和完整组成文件都相同的副本认作同源部署；目录同名不构成身份依据。
 * 带本地配置的副本不自动排除，避免把用户定制误判为产品旧部署。
 */
export function matchesAgentResource(bundle: AgentResourceBundle, item: AgentResource, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false
  try {
    const actual = realpathSync(candidate)
    const product = agentResourcePath(bundle.root, item.entry)
    if (actual === product) return true
    if (basename(actual) !== posix.basename(item.entry)) return false
    const base = dirname(actual)
    for (const name of item.localConfigFiles) {
      try {
        statSync(resolve(base, name))
        return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const sourceBase = posix.dirname(item.entry)
    for (const name of item.files) {
      const path = realpathSync(resolve(base, posix.relative(sourceBase, name)))
      if (!inside(base, path) || fingerprint(path) !== bundle.fingerprints[name]) return false
    }
    return true
  } catch (error) {
    // 不存在或路径形状不匹配表示不是这份副本；权限和解析故障不能伪装成不匹配。
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return false
    throw error
  }
}
