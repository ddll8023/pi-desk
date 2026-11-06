/**
 * 桌面产品资源装配：先解析和筛选来源，再让 SDK 求值扩展。
 * 不修改用户 settings、不移除用户文件，不用加载后的 extensionsOverride 掩盖重复注册。
 * 未识别的外部扩展保留 SDK 的冲突诊断；本层不是任意第三方代码的副作用隔离器。
 */
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  CreateAgentSessionServicesOptions, EventBus, InlineExtension, ResourceDiagnostic, ResourceLoader, SettingsManager, Skill
} from '@earendil-works/pi-coding-agent'
import {
  agentResourcePath, matchesAgentResource, readAgentResourceBundle
} from '../shared-process/agent-resources'
import type { AgentResource } from '../shared-process/agent-resources'
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
  /** 主进程给出的执行模式；只用于裁剪用户级 Skill 集合。 */
  readonly mode: ExecutionMode
}

interface ProductResourceAssembly {
  readonly options: ResourceOptions
  readonly diagnostics: readonly string[]
  /** 必要组件的来源与工具注册均确认之后，宿主才允许绑定会话。 */
  assertLoaded(loader: ResourceLoader): void
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
  const externalExtensions: string[] = []
  for (const resource of resolved.extensions) {
    if (!resource.enabled) continue
    const product = resource.path.startsWith('builtin:') ? undefined
      : bundle.extensions.find(item => matchesAgentResource(bundle, item, resource.path))
    if (product) {
      diagnostics.push(`已在执行前排除同源 ${product.id} 部署副本：${resource.path}`)
    } else externalExtensions.push(resource.path)
  }

  const productSkills = bundle.skills.flatMap(item => {
    const path = agentResourcePath(bundle.root, item.entry)
    const loaded = sdk.loadSkillsFromDir({ dir: dirname(path), source: 'pi-desk-product' })
    if (loaded.skills.length !== 1 || loaded.skills[0]?.name !== item.id
      || loaded.diagnostics.some(entry => entry.type === 'error')) throw new Error(`产品 Skill 不可用：${item.id}`)
    return loaded.skills
  })

  function skillsOverride(base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }): typeof base {
    /** 本次替换给出的说明；用户副本路径必须留在技能诊断里，不能只出现在宿主日志。 */
    const skillNotes: ResourceDiagnostic[] = []

    /**
     * 同名 Skill 只核对身份并留诊断：Skill 是纯文本指令，产品版本仍按 `reserved` 优先。
     * 内容不同的用户副本不采用，也不静默覆盖；同源核对失败的扩展（可能覆盖工具）仍按冲突拒绝建立会话。
     */
    function reportForeignSkill(item: AgentResource, path: string): void {
      if (matchesAgentResource(bundle, item, path)) return
      const message = `同名 Skill ${item.id} 与产品配套规范内容不一致，已改用产品版本：${path}`
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
      skills: [...productSkills, ...userSkills.filter(item => !blocked.has(item.name))],
      // 只丢掉 SDK 的同名 collision 条目；本层给出的说明保留，冲突双方路径因此仍可见。
      diagnostics: [...skillNotes, ...base.diagnostics.filter(item => !item.collision
        || item.collision.resourceType !== 'skill' || !reserved.has(item.collision.name))]
    }
  }

  return {
    diagnostics,
    options: {
      // 关闭默认扩展求值，只显式加载已筛选来源；不关闭技能、模板、上下文或其他 SDK 发现能力。
      noExtensions: true,
      additionalExtensionPaths: [
        ...bundle.extensions.map(item => agentResourcePath(bundle.root, item.entry)), ...externalExtensions
      ],
      // 显式给出总线：扩展从这里订阅，宿主推送也走同一实例，不依赖加载结果反取。
      eventBus: input.eventBus,
      additionalSkillPaths: bundle.skills.map(item => agentResourcePath(bundle.root, item.entry)),
      extensionFactories: input.extensionFactories,
      skillsOverride
    },
    assertLoaded(loader) {
      const extensions = loader.getExtensions()
      if (extensions.errors.length > 0) {
        // 只输出冲突的来源路径，不把第三方异常正文或配置内容复制到页面和日志。
        for (const entry of extensions.errors) console.error(`[product-resources] 扩展加载失败或冲突：${entry.path}`)
        throw new Error('扩展加载存在错误，未建立产品会话')
      }
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
