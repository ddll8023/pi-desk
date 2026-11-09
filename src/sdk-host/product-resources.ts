/**
 * 桌面产品资源装配：先解析和筛选来源，再让 SDK 求值扩展。
 * 不修改用户 settings、不移除用户文件，不用加载后的 extensionsOverride 掩盖重复注册。
 * 身份按组件形状判定：形状命中的副本一律排除；只有产品件自身损坏或外来路径争用产品工具名才拒绝建立会话，
 * 其余问题作为结构化诊断交给页面。未识别的外部扩展仍保留 SDK 的冲突诊断；本层不是第三方代码的副作用隔离器。
 */
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  CreateAgentSessionServicesOptions, EventBus, InlineExtension, ResourceDiagnostic, ResourceLoader, SettingsManager, Skill
} from '@earendil-works/pi-coding-agent'
import { RESOURCE_ISSUE_LIMIT, isResourceIssue } from '../shared/runtime-api'
import type { ResourceIssue } from '../shared/runtime-api'
import {
  agentResourcePath, classifyAgentResourceCopy, readAgentDeploymentManifest, readAgentResourceBundle
} from '../shared-process/agent-resources'
import type { AgentResource, AgentResourceCopyClassification } from '../shared-process/agent-resources'
import { judgeLoadedExtensions } from './conflicts'
import {
  MEMORY_CONFIGURATION_ENV, serializeMemoryConfiguration
} from '../shared-process/memory-runtime'
import type { MemoryHostConfiguration } from '../shared-process/memory-runtime'
import type { ExecutionMode } from '../shared/preferences-api'

/**
 * 快速模式下不加载的规范 Skill：它们要求先讨论方案或同步文档，与快速模式的定位相反。
 * 只作用于用户级 Skill；随包产品 Skill 是必要能力，裁掉会让 assertLoaded 失败。
 */
const FAST_MODE_BLOCKED_SKILLS: readonly string[] = ['design-protocol', 'code-doc-sync', 'architecture-redesign']

type Sdk = typeof import('@earendil-works/pi-coding-agent')
type ResourceOptions = NonNullable<CreateAgentSessionServicesOptions['resourceLoaderOptions']>

interface ProductResourceInput {
  readonly directory: string
  readonly cwd: string
  readonly agentDir: string
  readonly settingsManager: SettingsManager
  readonly extensionFactories: InlineExtension[]
  /** 宿主唯一的扩展事件总线；记忆配置变更与扩展订阅走同一条通道。 */
  readonly eventBus: EventBus
  /** 桌面受管记忆配置；非空时扩展必须能同步读到同一份配置，不允许静默退回 CLI 探测。 */
  readonly memory: MemoryHostConfiguration | null
  /** 主进程给出的执行模式；决定用户级 Skill 裁剪，以及记忆被派生为关闭时是否留诊断。 */
  readonly mode: ExecutionMode
}

interface ProductResourceAssembly {
  readonly options: ResourceOptions
  readonly diagnostics: readonly string[]
  /** 装配阶段的非致命诊断；页面用它列出副本落后、外来扩展失败等需要处置的事实。 */
  readonly issues: readonly ResourceIssue[]
  /** 必要组件的来源与工具注册均确认之后，宿主才允许绑定会话。 */
  assertLoaded(loader: ResourceLoader): void
}

/**
 * 产品资源核验失败：致命项同时已记入 `issues`，调用方据此保留完整诊断。
 * 消息只拼产品组件标识、工具名与路径，不掺杂任何扩展正文。
 */
function describeFatal(issues: readonly ResourceIssue[]): string {
  const detail = issues.map(issue => `${issue.kind}:${issue.componentId ?? '-'}:${issue.tool ?? '-'}`).join('；')
  return `资源装配存在必须处理的冲突：${detail}`
}

/** 每次创建／重载会话重新解析，不能把上个项目的显式加载清单带到新工作区。 */
export async function prepareProductResources(sdk: Sdk, input: ProductResourceInput): Promise<ProductResourceAssembly> {
  const bundle = readAgentResourceBundle(input.directory)
  const builtinExtensions = input.extensionFactories.flatMap(item =>
    typeof item !== 'function' && item.builtin ? [item.name] : [])
  const resolver = new sdk.DefaultPackageManager({
    cwd: input.cwd, agentDir: input.agentDir, settingsManager: input.settingsManager, builtinExtensions
  })
  // 发现来源本身不启动扩展。沿用同一信任设置，未信任项目的资源不会被提升为显式加载项。
  const resolved = await resolver.resolve(async () => 'error')
  const diagnostics: string[] = []
  // 快速模式的记忆开关由宿主派生，不是用户改动了开关；没有这条诊断会看成记忆配置丢失。
  if (input.mode === 'fast' && input.memory !== null && !input.memory.enabled) {
    diagnostics.push('快速模式未注入记忆：本会话的记忆库与后台召回不生效')
  }
  const externalExtensions: string[] = []
  // 部署登记只用于区分「版本不同」与「部署后被改过」；缺失或矛盾时按内容比对降级，不改变是否排除。
  const deployments = readAgentDeploymentManifest(input.agentDir)
  const issues: ResourceIssue[] = []
  /** 诊断条目有界：超限或字段不合规的条目直接丢弃，避免整帧被状态校验拒收。 */
  const pushIssue = (issue: ResourceIssue): void => {
    if (issues.length >= RESOURCE_ISSUE_LIMIT || !isResourceIssue(issue)) return
    issues.push(issue)
  }
  for (const resource of resolved.extensions) {
    if (!resource.enabled) continue
    // 内联来源不是文件，不参与组件身份判定。
    if (resource.path.startsWith('builtin:')) {
      externalExtensions.push(resource.path)
      continue
    }
    let identified = false
    for (const item of bundle.extensions) {
      const copy = classifyAgentResourceCopy(bundle, item, resource.path, deployments)
      if (copy.kind === 'foreign') continue
      identified = true
      // 产品自身来源与形状命中的副本都由产品版本接管，均不进入显式加载清单。
      if (copy.kind === 'product') continue
      const message = describeCopy(item, copy, resource.path)
      diagnostics.push(message)
      const issue = copyIssue(item, copy, resource.path)
      if (issue !== null) pushIssue(issue)
    }
    if (!identified) externalExtensions.push(resource.path)
  }

  const productSkills = bundle.skills.flatMap(item => {
    const path = agentResourcePath(bundle.root, item.entry)
    const loaded = sdk.loadSkillsFromDir({ dir: dirname(path), source: 'pi-desk-product' })
    if (loaded.skills.length !== 1 || loaded.skills[0]?.name !== item.id
      || loaded.diagnostics.some(entry => entry.type === 'error')) throw new Error(`产品 Skill 不可用：${item.id}`)
    return loaded.skills
  })
  // 子代理身份规范只由子进程按目录读取：主会话技能列表去掉它们，避免模型把「派子代理」当成「加载技能」。
  const sessionSkills = productSkills.filter(skill =>
    !bundle.skills.some(item => item.subAgentOnly && item.id === skill.name))

  function skillsOverride(base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }): typeof base {
    /** 本次替换给出的说明；用户副本路径必须留在技能诊断里，不能只出现在宿主日志。 */
    const skillNotes: ResourceDiagnostic[] = []

    /**
     * 同名 Skill 只核对身份并留诊断：Skill 是纯文本指令，产品版本仍按 `reserved` 优先。
     * 内容不同的副本不采用，也不静默覆盖；扩展侧的重复加载在装载结果阶段判定，不在这里处理。
     */
    function reportForeignSkill(item: AgentResource, path: string): void {
      const copy = classifyAgentResourceCopy(bundle, item, path, deployments)
      if (copy.kind === 'identical' || copy.kind === 'product') return
      const message = copy.kind === 'foreign'
        ? `同名 Skill ${item.id} 与产品配套规范内容不一致，已改用产品版本：${path}`
        : describeCopy(item, copy, path)
      console.warn(`[product-resources] ${message}`)
      diagnostics.push(message)
      skillNotes.push({ type: 'warning', message, path })
    }

    for (const item of bundle.skills) {
      for (const skill of base.skills) {
        if (skill.name === item.id) reportForeignSkill(item, skill.filePath)
      }
      // SDK 已经按名字去重，仍须核对被去重的候选，不能只看胜出的那份。
      for (const diagnostic of base.diagnostics) {
        const collision = diagnostic.collision
        if (collision?.resourceType === 'skill' && collision.name === item.id) {
          reportForeignSkill(item, collision.winnerPath)
          reportForeignSkill(item, collision.loserPath)
        }
      }
    }
    const reserved = new Set(bundle.skills.map(item => item.id))
    const userSkills = base.skills.filter(item => !reserved.has(item.name))
    const blocked = new Set(input.mode === 'fast' ? FAST_MODE_BLOCKED_SKILLS : [])
    if (blocked.size > 0) {
      // 留诊断：会话里看不到这些 Skill 是模式导致的，不是安装或加载出了问题。
      for (const skill of userSkills) {
        if (blocked.has(skill.name)) {
          skillNotes.push({ type: 'warning', message: `快速模式未加载 Skill ${skill.name}`, path: skill.filePath })
        }
      }
    }
    return {
      skills: [...sessionSkills, ...userSkills.filter(item => !blocked.has(item.name))],
      // 只丢掉 SDK 的同名 collision 条目；本层给出的说明保留，冲突双方路径因此仍可见。
      diagnostics: [...skillNotes, ...base.diagnostics.filter(item => !item.collision
        || item.collision.resourceType !== 'skill' || !reserved.has(item.collision.name))]
    }
  }

  return {
    diagnostics,
    issues,
    options: {
      // 关闭默认扩展求值，只显式加载已筛选来源；不关闭技能、模板、上下文或其他 SDK 发现能力。
      noExtensions: true,
      additionalExtensionPaths: [
        ...bundle.extensions.map(item => agentResourcePath(bundle.root, item.entry)), ...externalExtensions
      ],
      // 显式给出总线：扩展从这里订阅，宿主推送也走同一实例，不依赖加载结果反取。
      eventBus: input.eventBus,
      additionalSkillPaths: bundle.skills.filter(item => !item.subAgentOnly)
        .map(item => agentResourcePath(bundle.root, item.entry)),
      extensionFactories: input.extensionFactories,
      skillsOverride
    },
    assertLoaded(loader) {
      const extensions = loader.getExtensions()
      const productPaths = new Map<string, string>()
      for (const item of bundle.extensions) productPaths.set(agentResourcePath(bundle.root, item.entry), item.id)
      // 冲突与加载失败共用 SDK 的 errors 数组；这里按结构与路径归到组件，不用一句「有错」打死整个会话。
      const judgement = judgeLoadedExtensions({
        extensions: extensions.extensions.map(entry => ({
          path: realpathOrSynthetic(entry.resolvedPath), tools: entry.tools
        })),
        loadErrors: extensions.errors.map(entry => ({
          path: safeRealpath(entry.path), error: entry.error
        })),
        productPaths,
        productTools: bundle.extensions.flatMap(item => item.requiredTools.map(tool => ({
          componentId: item.id, tool, path: agentResourcePath(bundle.root, item.entry)
        })))
      })
      // 致命项优先入列：诊断条数有上限，不能让外来扩展的警告把冲突原因挤出页面。
      if (judgement.fatal.length > 0) {
        for (const issue of judgement.fatal) {
          pushIssue(issue)
          // 只记录产品组件标识、工具名与路径，不把扩展异常正文或配置内容复制到日志与页面。
          console.error(`[product-resources] ${issue.kind}：${issue.componentId ?? '-'} ${issue.tool ?? '-'} `
            + `${issue.otherPath ?? issue.productPath ?? '-'}`)
        }
        throw new Error(describeFatal(judgement.fatal))
      }
      for (const issue of judgement.warnings) pushIssue(issue)
      for (const item of bundle.extensions) {
        const path = agentResourcePath(bundle.root, item.entry)
        const loaded = extensions.extensions.find(entry => realpathOrSynthetic(entry.resolvedPath) === path)
        if (!loaded || item.requiredTools.some(name => !loaded.tools.has(name))) {
          console.error(`[product-resources] 产品必要扩展或工具未加载：${item.id}`)
          throw new Error(`产品必要扩展或工具未加载：${item.id}`)
        }
      }
      // 桌面传了记忆配置却没能注入扩展进程时，扩展会退回系统 Python；此处保守拒绝建立会话。
      if (input.memory !== null
        && process.env[MEMORY_CONFIGURATION_ENV] !== serializeMemoryConfiguration(input.memory)) {
        console.error('[product-resources] 桌面记忆配置未注入扩展进程')
        throw new Error('桌面记忆配置未注入扩展进程')
      }
      const skills = loader.getSkills().skills
      for (const item of bundle.skills) {
        // 子代理专用规范不在主会话技能列表里，不能要求它被会话加载。
        if (item.subAgentOnly) continue
        const path = agentResourcePath(bundle.root, item.entry)
        if (!skills.some(skill => skill.name === item.id && realpathSync(skill.filePath) === path)) {
          console.error(`[product-resources] 产品必要 Skill 未加载：${item.id}`)
          throw new Error(`产品必要 Skill 未加载：${item.id}`)
        }
      }
    }
  }
}

/** SDK 内置／内联来源不是文件；不能为来源确认把它们当成磁盘路径。 */
function realpathOrSynthetic(path: string): string {
  return path.startsWith('builtin:') || path.startsWith('<') ? path : realpathSync(path)
}

/** 诊断条目里的路径可能已经不存在；只用于归类比对，读不到就保留原值。 */
function safeRealpath(path: string): string {
  try {
    return realpathOrSynthetic(path)
  } catch { return path }
}

/**
 * 副本偏离的说明：只列前三个差异文件，既不把整份清单搬进界面，也保留可定位信息。
 * 措辞保持中性：本机可能构建较旧、副本可能较新，运行期无法判断方向。
 */
function describeCopy(item: AgentResource, copy: AgentResourceCopyClassification, path: string): string {
  const files = copy.changedFiles.slice(0, 3).join('、')
  const rest = copy.changedFiles.length > 3 ? ` 等 ${copy.changedFiles.length} 个文件` : ''
  const detail = files === '' ? '' : `（${files}${rest}）`
  if (copy.kind === 'modified') {
    return `部署副本 ${item.id} 在部署后被本地修改或上次同步未完成${detail}；`
      + `桌面使用产品内置版本，副本仍留给终端 CLI：${path}`
  }
  return `部署副本 ${item.id} 与本机产品版本不同${detail}；桌面使用产品内置版本，副本仍留给终端 CLI：${path}`
}

/** 只有实质偏离才产诊断：内容与产品一致的副本静默排除，登记过期单独记一条。 */
function copyIssue(item: AgentResource, copy: AgentResourceCopyClassification, path: string): ResourceIssue | null {
  if (copy.kind === 'modified') {
    return { kind: 'copy-modified', componentId: item.id, tool: null, productPath: null, otherPath: path }
  }
  if (copy.kind === 'outdated') {
    return { kind: 'copy-outdated', componentId: item.id, tool: null, productPath: null, otherPath: path }
  }
  if (copy.marker === 'inconsistent') {
    return { kind: 'copy-marker-stale', componentId: item.id, tool: null, productPath: null, otherPath: path }
  }
  return null
}
