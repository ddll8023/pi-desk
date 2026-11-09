/**
 * 产品 Agent 资源的固定布局、清单读取与副本身份判定。
 * 只读取主进程指定的产物目录，不执行扩展、不发现用户配置、不创建或迁移记忆数据。
 * 身份由「组件形状」证明：目录与入口同名且组成文件齐备，即认定同一组件的副本；
 * 内容摘要与部署登记只决定诊断措辞，既不证明来源，也不是 Skill 已读证据、用户授权或安全边界。
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
  /** 仅供子代理进程按目录名读取、不进入主会话技能列表：子代理身份规范不属于主代理能力。 */
  readonly subAgentOnly: boolean
}

export interface AgentResourceBundle {
  readonly root: string
  readonly extensions: readonly AgentResource[]
  readonly skills: readonly AgentResource[]
  readonly memoryEngine: string
  readonly fingerprints: Readonly<Record<string, string>>
  /** 每个组件的组成文件聚合摘要；读取时按 fingerprints 重算复核，不能由清单自证。 */
  readonly componentDigests: Readonly<Record<string, string>>
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
    || (value.subAgentOnly !== undefined && typeof value.subAgentOnly !== 'boolean')) {
    throw new Error('产品资源组成清单无效')
  }
  const base = posix.dirname(value.entry)
  if (value.files.some(path => !path.startsWith(`${base}/`))) throw new Error('产品组件文件不在入口所属目录内')
  return {
    id: value.id, entry: value.entry, files: value.files,
    requiredTools: value.requiredTools ?? [], subAgentOnly: value.subAgentOnly === true
  }
}

/**
 * 组件摘要：按相对路径码位序排序后拼接「路径 \0 指纹」行再取 sha256。
 * 暂存脚本与运行期必须使用同一规则，否则清单复核会失败；排序不依赖区域设置。
 */
export function componentDigestOf(fingerprints: Readonly<Record<string, string>>, files: readonly string[]): string {
  const lines = [...files]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map(name => `${name}\u0000${fingerprints[name] ?? ''}`)
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** 目录身份比较不二次解析链接；Windows 盘符与大小写不区分。 */
function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
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
  if (!record(raw.componentDigests)) throw new Error('产品资源组件摘要缺失')
  const componentDigests: Record<string, string> = {}
  for (const item of [...extensions, ...skills]) {
    const digest = raw.componentDigests[item.id]
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)
      || digest !== componentDigestOf(fingerprints, item.files)) {
      throw new Error(`产品资源组件摘要与内容不一致：${item.id}`)
    }
    componentDigests[item.id] = digest
  }
  return { root, extensions, skills, memoryEngine: raw.memoryEngine, fingerprints, componentDigests }
}

/** 部署登记条目：同步流程写入的薄证据，只用于区分「与产品不同」和「部署后被改过」。 */
export interface AgentDeploymentEntry {
  readonly componentId: string
  readonly contentDigest: string
  /** 同步时写入的目标目录绝对路径；与候选目录不符时该条证据不可用。 */
  readonly target: string
  readonly sourceRevision: string | null
}

const DEPLOYMENT_MANIFEST_NAME = '.pi-desk-deployments.json'
const MAX_DEPLOYMENT_ENTRIES = 64

/**
 * 读取 agent 目录根下的部署登记。
 * 缺失、损坏、字段越界、指向目录外或同一组件重复登记，一律降级为「没有可用证据」；
 * 本函数不抛错、不改变加载结论，只影响副本身份的措辞精度。
 */
export function readAgentDeploymentManifest(agentDir: string): ReadonlyMap<string, AgentDeploymentEntry> {
  const entries = new Map<string, AgentDeploymentEntry>()
  try {
    const root = realpathSync(agentDir)
    const path = join(root, DEPLOYMENT_MANIFEST_NAME)
    if (statSync(path).size > MAX_MANIFEST_BYTES) return entries
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!record(raw) || raw.schema !== 1 || !Array.isArray(raw.deployments)
      || raw.deployments.length > MAX_DEPLOYMENT_ENTRIES) return entries
    const duplicated = new Set<string>()
    for (const value of raw.deployments) {
      if (!record(value) || typeof value.componentId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value.componentId)
        || typeof value.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentDigest)
        || !resourceName(value.target)) continue
      const target = resolve(root, value.target)
      if (!inside(root, target) || samePath(target, root)) continue
      if (entries.has(value.componentId)) {
        duplicated.add(value.componentId)
        continue
      }
      entries.set(value.componentId, {
        componentId: value.componentId, contentDigest: value.contentDigest, target,
        sourceRevision: typeof value.sourceRevision === 'string' && value.sourceRevision.length <= 64
          ? value.sourceRevision : null
      })
    }
    // 同一组件两条登记互相矛盾时，不挑一条采用：按没有证据处理。
    for (const id of duplicated) entries.delete(id)
  } catch { /* 没有登记文件不是故障，调用方按内容比对降级处理。 */ }
  return entries
}

/** 候选副本的身份结论；除 `product` 外都需要在生产装配时排除。 */
export type AgentResourceCopyKind = 'product' | 'identical' | 'outdated' | 'modified' | 'foreign'

export interface AgentResourceCopyClassification {
  readonly kind: AgentResourceCopyKind
  /** 与当前产品版本不同的组成文件（相对路径）；调用方自行截断展示。 */
  readonly changedFiles: readonly string[]
  /** 部署登记与磁盘内容的关系；`none` 表示没有可用证据。 */
  readonly marker: 'none' | 'consistent' | 'inconsistent'
}

const FOREIGN_COPY: AgentResourceCopyClassification = { kind: 'foreign', changedFiles: [], marker: 'none' }

/**
 * 按组件形状判定副本身份，再用内容摘要与部署登记区分三种偏离程度。
 * 不变式：形状命中即认定「同一组件的副本」，排除方向永远安全，因此本函数从不建议继续加载；
 * 部署登记只影响措辞——缺失或矛盾时退回到「与本机产品版本不同」，不阻断会话。
 */
export function classifyAgentResourceCopy(bundle: AgentResourceBundle, item: AgentResource,
  candidate: string, deployments: ReadonlyMap<string, AgentDeploymentEntry>): AgentResourceCopyClassification {
  if (!isAbsolute(candidate)) return FOREIGN_COPY
  try {
    const actual = realpathSync(candidate)
    if (samePath(actual, agentResourcePath(bundle.root, item.entry))) {
      return { kind: 'product', changedFiles: [], marker: 'none' }
    }
    if (basename(actual) !== posix.basename(item.entry)) return FOREIGN_COPY
    const base = dirname(actual)
    // 目录名也要与入口所属目录同名：同名目录 + 同名入口 + 组成文件齐备才是同一组件的副本。
    if (basename(base) !== posix.basename(posix.dirname(item.entry))) return FOREIGN_COPY
    const sourceBase = posix.dirname(item.entry)
    const digests: Record<string, string> = {}
    for (const name of item.files) {
      const path = realpathSync(resolve(base, posix.relative(sourceBase, name)))
      // 缺一个组成文件就不是完整副本：按外部件处理，交给冲突分级判定。
      if (!inside(base, path)) return FOREIGN_COPY
      digests[name] = fingerprint(path)
    }
    const changedFiles = item.files.filter(name => digests[name] !== bundle.fingerprints[name])
    const deployment = deployments.get(item.id)
    const evidence = deployment !== undefined && samePath(deployment.target, base) ? deployment.contentDigest : null
    const diskDigest = componentDigestOf(digests, item.files)
    if (changedFiles.length === 0) {
      const marker = evidence === null ? 'none' : evidence === diskDigest ? 'consistent' : 'inconsistent'
      return { kind: 'identical', changedFiles, marker }
    }
    if (evidence === null) return { kind: 'outdated', changedFiles, marker: 'none' }
    // 登记摘要等于磁盘摘要时副本仍是同步写入的原样内容；不等则部署后被动过或同步中断。
    return evidence === diskDigest
      ? { kind: 'outdated', changedFiles, marker: 'consistent' }
      : { kind: 'modified', changedFiles, marker: 'inconsistent' }
  } catch (error) {
    // 不存在或路径形状不匹配表示不是这份副本；权限和解析故障不能伪装成不匹配。
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return FOREIGN_COPY
    throw error
  }
}
