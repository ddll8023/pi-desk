/**
 * Skill 动态登记门禁：主模型选择技能与必读引用，扩展只核对候选资格和当前上下文加载证据。
 * 不内置业务路由、不调用额外分类模型；同一会话内可沿用既有登记，仅在证据或技术栈变化时要求重新登记。
 * 不是命令沙箱，也不替代方案、文件清单或测试授权。
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Type } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext, Skill } from '@earendil-works/pi-coding-agent'
import { CONTEXT_IMPLEMENTATION, SkillContext, fingerprint, textContent } from './context.ts'
import type { LoadEvidence, MissingSkill } from './context.ts'
import { ROUTING_IMPLEMENTATION, canonicalPath, explicitSkillName, extractFileTargets, stackFamilies, validateSelection } from './routing.ts'
import type { Requirement, SelectionRequest } from './routing.ts'
import { REFERENCES_IMPLEMENTATION, registeredReferences } from './references.ts'
import type { ReferenceRequirement } from './references.ts'

const INDEX_IMPLEMENTATION = Object.freeze({ url: import.meta.url,
  sha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') })
const IMPLEMENTATIONS = Object.freeze({ index: INDEX_IMPLEMENTATION, routing: ROUTING_IMPLEMENTATION,
  context: CONTEXT_IMPLEMENTATION, references: REFERENCES_IMPLEMENTATION })
/** 聚合每个已求值模块的版本，不以当前磁盘读取结果替代加载记录。 */
function implementationVersion(modules: Readonly<Record<string, { readonly sha256: string }>>): string {
  return fingerprint(JSON.stringify(Object.entries(modules).map(([name, module]) => [name, module.sha256])))
}
const LOADED_VERSION = implementationVersion(IMPLEMENTATIONS)
const ENTRY_TYPE = 'skill-guard'
const SECTION = 'skill_guard'
const SELECTION_TOOL = 'skill_guard_select'
/** 只读工具与轻量标注不改变文件状态，也不携带要遵守的规范：先行放行，避免每次新请求都要先登记才能检索代码或读记忆。
 * memory_reinforce 只写库内去重事件，不触达权威正文与文件系统，按同一口径放行。 */
const RECOVERY_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'ffgrep', 'fffind', 'tool_search',
  'memory_status', 'memory_search', 'memory_rules', 'memory_read', 'memory_reinforce', 'memory_profiles'])

interface PendingMutation {
  tool: string
  targets: string[]
  startedAt: number
  generation: number
  required: string[]
  loaded: LoadEvidence[]
}
interface SelectionRegistration {
  generation: number
  toolCallId: string
  evidence: LoadEvidence[]
}
interface GuardState {
  scope: string
  skills: Skill[]
  required: Requirement[]
  references: ReferenceRequirement[]
  subjects: string[]
  explicit: string | undefined
  selection: SelectionRegistration | null
  selectionNotice: string
  /** 本轮登记沿用自上一轮请求，不要求同一批放行规则。 */
  inherited: boolean
  /** 已实际改动过的技术栈族，用于判断沿用的登记是否仍适配。 */
  stacks: string[]
  prompt: string
  taskHash: string
  runId: string
  context: SkillContext
  pending: Map<string, PendingMutation>
  firstMutation: boolean
  lastContextAudit: string
  auditError?: string
}

/** 恢复时只读取当前分支最近的真实用户输入，不用业务关键词猜测任务是否延续。 */
function latestUserPrompt(ctx: ExtensionContext): string {
  const messages = ctx.sessionManager.getBranch().flatMap(entry => entry.type === 'message' ? [entry.message] : [])
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    const text = textContent(message.content).trim()
    if (text && !text.startsWith('The conversation history before this point was compacted into the following summary:')) return text
  }
  return ''
}

/** 阻断只说明加载缺口，不能被解释为文件修改或运行许可。 */
function missingReason(tool: string, missing: readonly MissingSkill[]): string {
  const items = missing.map(item => `- ${item.name}${item.path ? `：${item.path}` : ''}\n  原因：${item.error ?? item.reason}`)
  return `Skill 前置条件未满足，${tool} 未执行。以下已登记正文尚未以当前版本进入生成本次调用的有效模型上下文：\n${items.join('\n')}\n\n请完整读取技能入口与必读引用；分段读取须覆盖正文。新读取结果不能作为同批调用的放行证据，须等待下一次模型请求。登记不代表已读，也不构成修改、测试、构建或运行授权。`
}

/** 无有效登记时的阻断说明，供首次请求与技术栈变更共用。 */
function selectionRequiredReason(notice: string, tool: string): string {
  return `${notice}。${tool} 未执行；先按实际技能目录完成判断、完整加载执行技能入口，再调用 ${SELECTION_TOOL}。读取与搜索仍可用于补齐资料；登记不构成任何业务操作或运行授权。`
}

/** 默认沿用同一会话内已登记的技能与引用，仅在登记本身失效时才要求重新判断。 */
export default function skillGuard(pi: ExtensionAPI): void {
  const states = new WeakMap<ExtensionContext['sessionManager'], GuardState>()
  const stateFor = (ctx: ExtensionContext): GuardState => {
    const scope = `${ctx.sessionManager.getSessionId()}\0${canonicalPath(ctx.cwd, ctx.cwd)}`
    let state = states.get(ctx.sessionManager)
    if (!state || state.scope !== scope) {
      state = { scope, skills: [], required: [], references: [], subjects: [], explicit: undefined,
        selection: null, selectionNotice: '本轮尚未登记技能选择', inherited: false, stacks: [], prompt: '', taskHash: '', runId: randomUUID(),
        context: new SkillContext(), pending: new Map(), firstMutation: false, lastContextAudit: '' }
      states.set(ctx.sessionManager, state)
    }
    return state
  }
  /** 审计只保存身份、版本、来源与状态，不复制选择工具参数、理由或正文。 */
  const audit = (state: GuardState, ctx: ExtensionContext, event: string, data: Record<string, unknown>): void => {
    try {
      pi.appendEntry(ENTRY_TYPE, { version: 2, implementation: LOADED_VERSION, event, runId: state.runId, taskHash: state.taskHash,
        sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, branchLeaf: ctx.sessionManager.getLeafId(), at: Date.now(), ...data })
      state.auditError = undefined
    } catch (error) { state.auditError = `Skill 加载审计无法保存：${error instanceof Error ? error.message : String(error)}` }
  }
  const invalidateSelection = (state: GuardState, notice: string): void => {
    state.selection = null
    state.inherited = false
    state.selectionNotice = notice
  }
  /** 登记之后技能发生改动，必须重新判断引用，不能只补读新正文后沿用旧清单。 */
  const changedSelection = (state: GuardState, ctx: ExtensionContext): MissingSkill[] => {
    if (!state.selection) return []
    const changed = state.context.changedSelection(state.selection.evidence, state.skills, ctx.cwd)
    if (changed.length) {
      invalidateSelection(state, '已登记技能的版本或候选资格发生变化，请读取当前正文后重新登记')
      audit(state, ctx, 'selection-invalidated', { names: changed.map(item => item.name) })
    }
    return changed
  }

  pi.registerCommand('skill-guard', { description: '查看已加载门禁版本与磁盘差异（不重载）',
    handler: async (_args, ctx) => {
      const disk: Record<string, { sha256: string }> = {}
      const lines: string[] = []
      for (const [name, module] of Object.entries(IMPLEMENTATIONS)) {
        try {
          const sha256 = createHash('sha256').update(readFileSync(fileURLToPath(module.url))).digest('hex')
          disk[name] = { sha256 }
          lines.push(`${name}：加载 ${module.sha256.slice(0, 12)} / 磁盘 ${sha256.slice(0, 12)}`)
        } catch { lines.push(`${name}：磁盘版本不可读取`) }
      }
      const current = Object.keys(disk).length === Object.keys(IMPLEMENTATIONS).length ? implementationVersion(disk) : null
      const status = current === null ? '磁盘版本未知' : current === LOADED_VERSION ? '加载版本与磁盘一致' : '加载版本与磁盘不同，未自动重载'
      if (ctx.hasUI) ctx.ui.notify(`门禁加载版本：${LOADED_VERSION}\n${status}\n${lines.join('\n')}`, 'info')
    } })

  const choiceSchema = Type.Object({
    name: Type.String({ minLength: 1, description: '当前宿主技能目录中的准确名称' }),
    reason: Type.String({ minLength: 1, description: '该技能在本轮承担此角色的理由' })
  })
  pi.registerTool({
    name: SELECTION_TOOL,
    label: '登记 Skill 选择',
    description: '首次修改文件前选择并登记执行规范与必读引用；同一会话内后续请求默认沿用该登记，仅在技术栈、技能版本、分支或上下文变化时重新登记。此工具不证明选择完整，也不自动加载正文。',
    promptSnippet: '登记主模型根据任务和技能描述选择的规范及必读引用',
    promptGuidelines: ['首次修改文件前须完成 Skill 适用性判断和登记；同一会话内延续任务沿用原登记，不机械重复登记。登记不是执行授权。'],
    exposure: 'model-only',
    executionMode: 'sequential',
    parameters: Type.Object({
      skills: Type.Array(choiceSchema, { description: '本轮要遵循的全部执行技能；无适用技能时填空数组并说明理由' }),
      subjects: Type.Array(choiceSchema, { description: '仅作为阅读、审查或修改对象的技能，不自动把其正文作为执行规范' }),
      references: Type.Array(Type.Object({
        skill: Type.String({ minLength: 1, description: '所属执行技能的准确名称' }),
        path: Type.String({ minLength: 1, description: '技能目录内的引用路径，优先使用相对所属技能根目录的路径' }),
        reason: Type.String({ minLength: 1, description: '依据当前技能正文和任务条件判定必读的理由' })
      }), { description: '全部已判定必读的引用；不要求把不适用的附件全部加载' }),
      reason: Type.String({ minLength: 1, description: '结合本轮目标和对话上下文说明整体选择；空选择也必须说明' })
    }),
    async execute(toolCallId, params: SelectionRequest, _signal, _onUpdate, ctx) {
      const state = stateFor(ctx)
      // 无效的新登记也不能继续沿用旧的放行状态。
      invalidateSelection(state, '技能选择正在重新登记')
      state.pending.clear()
      const explicitLoads = new Set([...state.context.loaded.values()]
        .filter(item => item.kind !== 'reference' && item.source === 'explicit').map(item => item.name))
      const decision = validateSelection(params, state.skills, state.explicit, explicitLoads)
      const references = registeredReferences(params.references, decision.required, state.skills, ctx.cwd)
      const evidence = state.context.selectionEvidence(decision.required, state.skills, ctx.cwd)
      state.required = decision.required
      state.subjects = decision.subjects
      state.references = references
      state.selection = { generation: state.context.generation, toolCallId, evidence }
      state.selectionNotice = ''
      state.inherited = false
      state.stacks = []
      const missing = state.context.missingReferences(references)
      audit(state, ctx, 'selection-registered', { toolCallId, generation: state.context.generation,
        required: state.required.map(item => item.name), subjects: state.subjects,
        references: references.map(item => ({ name: item.name, path: item.path })), loaded: evidence })
      if (state.auditError) throw new Error(state.auditError)
      const status = missing.length ? '选择已登记；下列必读引用仍需完整读取' : '选择已登记；已选技能与引用均有当前版本加载证据'
      return {
        content: [{ type: 'text', text: `${status}。登记不构成业务操作授权，新登记须进入下一次模型请求后才可用于门禁放行。\n${JSON.stringify({
          skills: state.required.map(item => item.name), subjects: state.subjects,
          references: references.map(item => ({ skill: item.skillName, path: item.path })),
          missing: missing.map(item => ({ name: item.name, path: item.path, error: item.error ?? '正文尚未完整进入有效上下文' }))
        }, null, 2)}` }],
        details: { registered: true, generation: state.context.generation, missing: missing.map(item => item.name) }
      }
    }
  })

  pi.on('before_agent_start', (event, ctx) => {
    const state = stateFor(ctx)
    state.skills = [...event.systemPromptOptions.skills]
    if (event.messageType === 'user') {
      state.prompt = event.prompt
      state.explicit = explicitSkillName(event.prompt)
      if (state.explicit) {
        state.required = [{ name: state.explicit, reason: '用户显式加载该技能', origin: 'explicit' }]
        state.references = []
        state.subjects = []
        state.stacks = []
        invalidateSelection(state, '用户显式加载技能，请核对必读引用后重新登记')
      } else if (state.selection) {
        // 同一会话的新请求默认沿用上一次登记；证据、版本与技术栈仍由后续核对决定是否撤销。
        state.inherited = true
        state.selectionNotice = ''
        audit(state, ctx, 'selection-inherited', { generation: state.context.generation, toolCallId: state.selection.toolCallId,
          required: state.required.map(item => item.name), subjects: state.subjects,
          references: state.references.map(item => item.path), stacks: state.stacks })
      } else {
        state.required = []
        state.references = []
        state.subjects = []
        state.stacks = []
        invalidateSelection(state, '本轮用户请求尚未登记技能选择')
      }
    } else if (!state.prompt) {
      state.prompt = latestUserPrompt(ctx)
    }
    state.taskHash = fingerprint(state.prompt)
    state.runId = randomUUID()
    state.context.reset()
    state.pending.clear()
    state.firstMutation = false
    state.lastContextAudit = ''
    const registeredLine = state.selection
      ? `当前沿用的登记：${state.required.map(item => item.name).join('、') || '（空清单，无适用技能）'}${state.subjects.length ? `；仅审查：${state.subjects.join('、')}` : ''}${state.references.length ? `；必读引用：${state.references.map(item => item.path).join('、')}` : ''}。若本轮任务需要不同规范，调用 ${SELECTION_TOOL} 替换清单；改动技术栈不同或正文已离开上下文时门禁会要求重新登记。`
      : `本轮尚未登记技能选择：${state.selectionNotice}。`
    const guidance = `本扩展不替你选择具体技能。每轮用户请求先结合当前目标、对话上下文、已确认技术栈和宿主实际提供的 Skill 名称与 description 判断适用性；可先读取与搜索确认事实。首次修改文件前须完整加载执行技能入口，并调用 ${SELECTION_TOOL} 登记完整清单、仅审查对象及依据技能正文判定的必读引用；引用可在登记后补读。同一会话内后续请求默认沿用该登记，仅在改动技术栈不同、已登记正文离开上下文、技能版本变化、会话分支切换或上下文压缩后重新判断并重新登记；不机械重复登记。无适用技能也须提交空清单和理由。\n\n目录、登记和自我声明不证明正文已读。门禁只认当前有效模型上下文中的全文证据，支持用户显式加载、模型读取及带版本的完整宿主注入；读取与新登记都不能作为同批其他调用的放行证据。沿用的登记在正文离开上下文后自动失效。被审查的技能不自动成为执行规范。禁止自动调用的技能只在用户显式加载后允许登记为执行规范。\n\n必读条件由 Skill 自身声明并由模型转为结构化登记，扩展不维护技能名称、业务关键词或引用文件名映射，也不据扩展名判断适用技能。门禁保证已登记内容的加载核对，不保证模型没有漏选、漏登记，也不证明遵守了正文。不得把选择登记或加载核对视为文件修改、测试、构建、启动、重载或其他运行授权；仍须遵守原有人工确认边界。`
    event.systemPromptOptions.sections[SECTION] = `${guidance}\n\n${registeredLine}\n\n门禁已加载实现：${LOADED_VERSION}（不是磁盘同步状态，也不是 Skill 已读证明）。`
    audit(state, ctx, 'selection-required', { generation: state.context.generation,
      explicit: state.explicit ?? null, registered: state.selection !== null })
  })

  pi.on('context_with_system', (event, ctx) => {
    const state = stateFor(ctx)
    const loaded = state.context.observe(event.messages, state.skills, state.required, ctx.cwd, state.references)
    changedSelection(state, ctx)
    const evidence = [...loaded.values()].sort((left, right) => left.name.localeCompare(right.name))
    const signature = fingerprint(JSON.stringify({ required: state.required.map(item => item.name).sort(),
      subjects: state.subjects, references: state.references.map(item => item.path), evidence,
      selection: state.selection?.toolCallId ?? null }))
    if (signature === state.lastContextAudit && !state.auditError) return
    audit(state, ctx, 'context-loaded', { generation: state.context.generation,
      required: state.required.map(item => item.name), subjects: state.subjects,
      references: state.references.map(item => item.path), loaded: evidence,
      registered: state.selection !== null })
    if (!state.auditError) state.lastContextAudit = signature
  })

  pi.on('tool_call', (event, ctx) => {
    const state = stateFor(ctx)
    if (RECOVERY_TOOLS.has(event.toolName) || event.toolName === SELECTION_TOOL) return undefined
    const changed = changedSelection(state, ctx)
    const missing = [...state.context.missing(state.required, state.skills, ctx.cwd), ...state.context.missingReferences(state.references)]
    let reason = state.auditError
    if (!reason && !state.selection) reason = selectionRequiredReason(state.selectionNotice, event.toolName)
    if (!reason && state.selection && !state.inherited && state.context.generation <= state.selection.generation) {
      reason = `新登记尚未进入下一次有效模型请求，${event.toolName} 未执行。不能用同批登记为其他调用放行。`
    }
    if (!reason && (changed.length || missing.length)) {
      // 沿用的登记在正文离开上下文后不能只补读，须重新加载后重新登记。
      if (state.inherited && missing.length) {
        invalidateSelection(state, '沿用的技能正文已不在当前上下文，请重新加载并登记')
        audit(state, ctx, 'inheritance-revoked', { tool: event.toolName, toolCallId: event.toolCallId,
          missing: missing.map(item => item.name) })
        reason = selectionRequiredReason(state.selectionNotice, event.toolName)
      } else reason = missingReason(event.toolName, [...changed, ...missing])
    }
    const targets = event.toolName === 'edit' || event.toolName === 'write'
      ? extractFileTargets(event.input).map(target => canonicalPath(target.path, ctx.cwd)) : []
    if (!reason && targets.length) {
      const families = stackFamilies(targets)
      if (state.stacks.length && families.length && !families.some(family => state.stacks.includes(family))) {
        invalidateSelection(state, `改动目标的技术栈（${families.join('/')}）与上次登记（${state.stacks.join('/')}）不同，请重新判断并登记`)
        audit(state, ctx, 'inheritance-revoked', { tool: event.toolName, toolCallId: event.toolCallId,
          families, stacks: state.stacks, cause: 'stack-changed' })
        reason = selectionRequiredReason(state.selectionNotice, event.toolName)
      } else if (!state.stacks.length) state.stacks = families
    }
    if (reason) {
      audit(state, ctx, 'blocked', { tool: event.toolName, toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId,
        generation: state.context.generation,
        missing: [...changed, ...missing].map(item => ({ name: item.name, path: item.path, error: item.error ?? '正文加载证据缺失' })),
        registered: state.selection !== null })
      return { block: true, reason }
    }
    if (event.toolName === 'edit' || event.toolName === 'write') state.pending.set(event.toolCallId, {
      tool: event.toolName, targets, startedAt: Date.now(), generation: state.context.generation,
      required: state.required.map(item => item.name), loaded: [...state.context.loaded.values()] })
    return undefined
  })

  pi.on('tool_result', (event, ctx) => {
    const state = stateFor(ctx)
    if (event.toolName === 'read' && typeof event.input.path === 'string') {
      const path = canonicalPath(event.input.path, ctx.cwd)
      const skill = state.skills.find(candidate => canonicalPath(candidate.filePath, ctx.cwd) === path)
      if (skill) audit(state, ctx, 'read-result', { name: skill.name, path, toolCallId: event.toolCallId,
        parentToolCallId: event.parentToolCallId, success: !event.isError, eligibleForRelease: false,
        note: '工具完成不是放行证据，需等待下一次有效模型上下文' })
    }
    const mutation = state.pending.get(event.toolCallId)
    state.pending.delete(event.toolCallId)
    if (!mutation || event.isError || state.firstMutation) return
    state.firstMutation = true
    audit(state, ctx, 'first-confirmed-file-mutation', { ...mutation, toolCallId: event.toolCallId,
      parentToolCallId: event.parentToolCallId, completedAt: Date.now() })
  })

  pi.on('session_start', (_event, ctx) => {
    states.delete(ctx.sessionManager)
    audit(stateFor(ctx), ctx, 'implementation-loaded', { modules: IMPLEMENTATIONS })
  })
  pi.on('session_tree', (_event, ctx) => {
    const state = stateFor(ctx)
    state.context.reset()
    state.pending.clear()
    state.required = []
    state.references = []
    state.subjects = []
    state.explicit = undefined
    state.stacks = []
    state.inherited = false
    state.prompt = ''
    state.taskHash = ''
    state.lastContextAudit = ''
    invalidateSelection(state, '会话分支已切换，请结合当前分支重新登记技能选择')
  })
  pi.on('session_compact', (_event, ctx) => {
    const state = stateFor(ctx)
    state.context.reset()
    state.pending.clear()
    state.lastContextAudit = ''
    state.stacks = []
    state.inherited = false
    invalidateSelection(state, '上下文已压缩，请核对保留的正文并重新登记技能与必读引用')
  })
  pi.on('session_shutdown', (_event, ctx) => { states.delete(ctx.sessionManager) })
}
