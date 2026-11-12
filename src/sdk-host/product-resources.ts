/**
 * 桌面产品资源装配：产品件来自随包产物，用户级 Agent 资产从终端 CLI 的目录只读加载。
 *
 * 不修改用户 settings、不移除用户文件，也不用加载后的 extensionsOverride 掩盖重复注册。
 * 共享目录只贡献 `AGENTS.md` 与 `skills/`：同名 Skill 由产品版本优先；技能可见集随后按专家许可集收窄（`skillPermit`），
 * 核验只针对本次会装载的那部分，不把被排除的技能当成加载失败。
 * 技能来源全部显式给出（`noSkills` 关掉 SDK 自身的目录发现）：全局来源受专家许可集约束，项目来源属于工作区、
 * 专家无法表达，因此始终装配。
 * 只有产品件自身损坏或非产品扩展争用产品工具名才拒绝建立会话，其余问题作为结构化诊断交给页面。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type {
  CreateAgentSessionServicesOptions, EventBus, InlineExtension, ResourceDiagnostic, ResourceLoader, SettingsManager, Skill
} from '@earendil-works/pi-coding-agent'
import { RESOURCE_ISSUE_LIMIT, isResourceIssue } from '../shared/runtime-api'
import type { ResourceIssue } from '../shared/runtime-api'
// 快速模式剔除名单与设置页解释同源，避免两处各写一份技能名。
import { FAST_MODE_BLOCKED_SKILLS } from '../shared/execution-mode-skills'
import { collectSkillSources, isUnderSkillDirectory } from '../shared-process/skill-sources'
import {
  agentResourcePath, readAgentResourceBundle
} from '../shared-process/agent-resources'
import type { AgentResource } from '../shared-process/agent-resources'
import { judgeLoadedExtensions } from './conflicts'
import {
  MEMORY_CONFIGURATION_ENV, serializeMemoryConfiguration
} from '../shared-process/memory-runtime'
import type { MemoryHostConfiguration } from '../shared-process/memory-runtime'
import type { ExecutionMode } from '../shared/preferences-api'

/** 只读注入的用户级 AGENTS.md 读取上限；超出时跳过并保持会话可用。 */
const SHARED_AGENTS_MAX_BYTES = 262_144

type Sdk = typeof import('@earendil-works/pi-coding-agent')
type ResourceOptions = NonNullable<CreateAgentSessionServicesOptions['resourceLoaderOptions']>

interface ProductResourceInput {
  readonly directory: string
  readonly cwd: string
  readonly agentDir: string
  /** 终端 CLI 的目录：只读加载用户级 `AGENTS.md` 与 `skills/`，不写入。 */
  readonly sharedAgentDir: string
  readonly settingsManager: SettingsManager
  readonly extensionFactories: InlineExtension[]
  /** 宿主唯一的扩展事件总线；记忆配置变更与扩展订阅走同一条通道。 */
  readonly eventBus: EventBus
  /** 桌面受管记忆配置；非空时扩展必须能同步读到同一份配置，不允许静默退回 CLI 探测。 */
  readonly memory: MemoryHostConfiguration | null
  /** 主进程给出的执行模式；决定用户级 Skill 裁剪，以及记忆被派生为关闭时是否留诊断。 */
  readonly mode: ExecutionMode
  /**
   * 本会话允许装载的技能标识；`null` 表示不限制。
   * 来自专家能力范围：范围外的技能既不装配也不列在技能诊断里，试模型看不到也调不到。
   */
  readonly skillPermit: readonly string[] | null
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
  const issues: ResourceIssue[] = []
  /** 诊断条目有界：超限或字段不合规的条目直接丢弃，避免整帧被状态校验拒收。 */
  const pushIssue = (issue: ResourceIssue): void => {
    if (issues.length >= RESOURCE_ISSUE_LIMIT || !isResourceIssue(issue)) return
    issues.push(issue)
  }
  for (const resource of resolved.extensions) {
    if (!resource.enabled) continue
    // 产品件与内联例子不在发现结果里；其余都是用户自装的扩展与包，按原样显式加载。
    externalExtensions.push(resource.path)
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
  // 来源与预读、设置页候选同一套规则；项目来源只在已受信项目里出现。
  const skillSources = collectSkillSources({
    agentDir: input.agentDir,
    sharedAgentDir: input.sharedAgentDir,
    cwd: input.cwd,
    projectTrusted: input.settingsManager.isProjectTrusted()
  })

  function skillsOverride(base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }): typeof base {
    /** 本次替换给出的说明；用户副本路径必须留在技能诊断里，不能只出现在宿主日志。 */
    const skillNotes: ResourceDiagnostic[] = []

    /**
     * 同名 Skill 由产品版本提供：与产品入口内容一致时是同一份规范的副本，静默采用产品版本；
     * 内容不同才留一条诊断，说明用户副本没有被加载。
     */
    function reportSharedSkill(item: AgentResource, path: string): void {
      const productEntry = agentResourcePath(bundle.root, item.entry)
      if (samePath(path, productEntry) || sameFileContent(path, productEntry)) return
      const message = `同名 Skill ${item.id} 与产品配套规范内容不一致，已改用产品版本：${path}`
      console.warn(`[product-resources] ${message}`)
      diagnostics.push(message)
      skillNotes.push({ type: 'warning', message, path })
    }

    for (const item of bundle.skills) {
      for (const skill of base.skills) {
        if (skill.name === item.id) reportSharedSkill(item, skill.filePath)
      }
      // SDK 已经按名字去重，仍须核对被去重的候选，不能只看胜出的那份。
      for (const diagnostic of base.diagnostics) {
        const collision = diagnostic.collision
        if (collision?.resourceType === 'skill' && collision.name === item.id) {
          reportSharedSkill(item, collision.winnerPath)
          reportSharedSkill(item, collision.loserPath)
        }
      }
    }
    const reserved = new Set(bundle.skills.map(item => item.id))
    const userSkills = base.skills.filter(item => !reserved.has(item.name))
    const blocked = new Set(input.mode === 'fast' ? FAST_MODE_BLOCKED_SKILLS : [])
    // 专家许可集只减不增：先按模式剔一遍，再按许可集把范围外的技能拿掉。
    const permitted = input.skillPermit === null ? null : new Set(input.skillPermit)
    // 项目技能不受许可集约束：专家定义是全局的，写不出「当前项目才有的技能」。
    const inScope = (skill: Skill): boolean => permitted === null || permitted.has(skill.name)
      || isUnderSkillDirectory(skill.filePath, skillSources.project)
    if (blocked.size > 0) {
      // 留诊断：会话里看不到这些 Skill 是模式导致的，不是安装或加载出了问题。
      for (const skill of userSkills) {
        if (blocked.has(skill.name)) {
          skillNotes.push({ type: 'warning', message: `快速模式未加载 Skill ${skill.name}`, path: skill.filePath })
        }
      }
    }
    return {
      skills: [...sessionSkills, ...userSkills.filter(item => !blocked.has(item.name))]
        .filter(item => inScope(item)),
      // 只丢掉 SDK 的同名 collision 条目；本层给出的说明保留，冲突双方路径因此仍可见。
      diagnostics: [...skillNotes, ...base.diagnostics.filter(item => !item.collision
        || item.collision.resourceType !== 'skill' || !reserved.has(item.collision.name))]
    }
  }

  return {
    diagnostics,
    issues,
    options: {
      // 关闭默认扩展求值，只显式加载已筛选来源；技能同样关掉 SDK 自动发现，来源只由下面的清单决定。
      noExtensions: true,
      // 技能只认产品给出的来源：随包、全局（agent 目录与共享目录）、项目（受信时的工作区技能目录）。
      noSkills: true,
      additionalExtensionPaths: [
        ...bundle.extensions.map(item => agentResourcePath(bundle.root, item.entry)), ...externalExtensions
      ],
      // 显式给出总线：扩展从这里订阅，宿主推送也走同一实例，不依赖加载结果反取。
      eventBus: input.eventBus,
      additionalSkillPaths: [
        ...bundle.skills.filter(item => !item.subAgentOnly)
          .map(item => agentResourcePath(bundle.root, item.entry)),
        ...skillSources.global,
        ...skillSources.project
      ],
      // 用户级全局指令从共享目录只读注入，不改写、不复制。
      agentsFilesOverride: base => withSharedAgentsFile(base, input.sharedAgentDir),
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
        // 被专家许可集排除的技能本来就不进会话可见集，不能当成加载失败；
        // 它是否损坏由装配前对每个产品 Skill 的严格校验负责。
        if (input.skillPermit !== null && !input.skillPermit.includes(item.id)) continue
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

/** 用户级全局指令：共享目录根下的 `AGENTS.md` 排在项目文件之前；读不到时跳过，不阻断会话。 */
function withSharedAgentsFile(
  base: { agentsFiles: Array<{ path: string; content: string }> },
  sharedAgentDir: string
): { agentsFiles: Array<{ path: string; content: string }> } {
  const path = join(sharedAgentDir, 'AGENTS.md')
  if (base.agentsFiles.some(entry => samePath(entry.path, path))) return base
  try {
    if (!existsSync(path) || statSync(path).size > SHARED_AGENTS_MAX_BYTES) return base
    const content = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    return { agentsFiles: [{ path, content }, ...base.agentsFiles] }
  } catch { return base }
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** 同名 Skill 内容比对；读不到就按不同处理，只多一条诊断。 */
function sameFileContent(left: string, right: string): boolean {
  try { return readFileSync(left).equals(readFileSync(right)) } catch { return false }
}
