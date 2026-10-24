/**
 * 会话活动派生：从官方当前分支累计文件、Skill、MCP、扩展工具与界面交付事实，
 * 并以实时工具状态补充对话页顶部的活动摘要。
 *
 * 不读项目文件、不解析 Pi 配置、不持有会话所有权；稳定事实直接从官方分支补种，
 * 恢复会话后沿用同一统计口径：
 *
 * 1. 文件：内置 `read` 算读取，`write` / `edit`（含 `multiedit`、`apply_patch`）算修改；路径取参数摘要里的 path 一类键，
 *    摘要只给规模（路径超长）时回退到参数原文解析。失败的工具不计数——没读到、也没写成；
 *    累计器只收录成功完成的调用，不把进行中或未知结果冒充完成。
 * 2. Skill：用户消息里 Pi 展开的 `/skill:<名称>` 块（显式调用），以及模型读取技能文件 `SKILL.md`
 *    的完整上下文证据，以及宿主注入的审计证据。三者分别标注，不把读取请求冒充加载。
 * 3. MCP：`mcp__<服务器>__<工具>` 形式的工具名按服务器归并；三个 MCP 资源工具不属于任何具体服务器，
 *    单独归到一行，不猜测它们连的是哪个服务器。
 * 4. 插件：既不是内置工具、也不是 MCP 工具的工具名按扩展工具统计。投影里没有「工具属于哪个扩展文件」
 *    的信息，因此只报工具名与次数，不编造来源扩展。
 * 5. 界面：`ui_render` / `ui_patch` 的 `toolResult` 里带 `details.ui` 时记一份交付事实，
 *    按 `documentId` 合并：版本取最大、标题取后出现的非空值、`versions` 累加。
 *    只读头部字段，不解析节点树；嵌套调用（`nestedCalls`）不带 `details`，因此其中的界面不计入。
 *
 * 日志累计与实时工具状态分别维护：实时状态只补充展示，检查点只导出已进入官方分支的轻量事实。
 * 同一 SDK manager 内确认连续追加后只折叠新增条目；跨来源恢复核对完整前缀摘要，不能只比较末条 ID。
 * 无事实变化时复用展示结果；检查点不携带消息正文、工具输出、SDK 对象或实时执行状态。
 */
import { createHash } from 'node:crypto'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { ToolArgSummaryEntry, ToolExecution, SkillActivitySource, SessionActivity,
  SessionFileActivity, SessionSkillActivity, SessionMcpActivity, SessionPluginActivity,
  SessionGenuiActivity } from '../../shared/runtime-api'
import { GENUI_RENDER_TOOL_NAMES, readGenuiPayloadHeader } from '../../shared/genui-api'
import { parseSkillBlock } from '../../shared/user-message-text'

/** 只读取文件内容的工具；其他工具即使读到文件（如 bash）也不猜测它碰了哪个路径。 */
const READ_TOOLS: ReadonlySet<string> = new Set(['read'])

/** 写入与就地编辑的工具；两者都算「修改」。 */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'multiedit', 'apply_patch'])

/**
 * Pi 的内置工具与内置扩展工具（codemode / tool_search 随宿主固定注册，
 * 生成式 UI 的 ui_render / ui_patch / ui_catalog / ui_inspect 由 Desktop 以 builtin factory 注册）：
 * 其余既非内置、也非 MCP 的工具按扩展（插件）工具统计。
 */
const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'read', 'write', 'edit', 'multiedit', 'apply_patch',
  'bash', 'powershell', 'grep', 'find', 'ls', 'codemode', 'tool_search',
  'ui_render', 'ui_patch', 'ui_catalog', 'ui_inspect', 'ffgrep', 'fffind'
])

/** MCP 资源工具：属于 MCP 能力，但不属于任何具体服务器。 */
const MCP_RESOURCE_TOOLS: ReadonlySet<string> = new Set([
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'
])

/** MCP 资源工具在界面上的分组名；它们没有服务器名可用。 */
const MCP_RESOURCE_LABEL = '资源工具'

/** Pi 给 MCP 工具加的固定前缀；工具名形如 `mcp__<服务器>__<工具>`。 */
const MCP_PREFIX = 'mcp__'

/** 文件工具参数里可能承载路径的键；顺序即优先级。 */
const PATH_ARG_KEYS: readonly string[] = ['path', 'file_path', 'filePath', 'notebook_path', 'target_file']

/** 活动折叠语义变化时递增；不与 SDK 版本或绑定代际混用。 */
export const ACTIVITY_STATE_VERSION = 1

export interface ActivityCommandState {
  readonly id: string
  readonly name: string
  readonly location: string | null
}

export interface ActivityToolState {
  readonly toolCallId: string
  readonly toolName: string
  readonly phase: ToolExecution['phase']
  /** 仅保存路径字段的 JSON，不保存完整工具参数。 */
  readonly argsText: string | null
}

/** 已处理日志前缀的独立轻量快照，不含实时补充或原始条目引用。 */
export interface ActivityCheckpointState {
  readonly version: number
  readonly prefixLength: number
  readonly tailEntryId: string | null
  readonly prefixHash: string
  readonly tools: readonly ActivityToolState[]
  readonly commands: readonly ActivityCommandState[]
  readonly skills: readonly SessionSkillActivity[]
  readonly genui: readonly SessionGenuiActivity[]
  readonly evidence: readonly string[]
  readonly incomplete: boolean
}

export interface SessionActivityCache {
  /** 将已提取的技能命令与轻量工具条目归纳为活动，工具贡献按对象身份复用。 */
  derive(
    commands: readonly ActivityCommandState[],
    tools: readonly ToolExecution[],
    projectPath: string | null
  ): SessionActivity
}

/** 文件工具的一次归属：路径与读取/修改语义。 */
interface FileFact {
  readonly path: string
  readonly mode: 'read' | 'write'
}

/** 一条工具条目的贡献；`skill` 与文件事实并列，因为读 `SKILL.md` 同时是读文件与加载技能。 */
interface ToolFacts {
  readonly file: FileFact | null
  readonly skill: { readonly name: string; readonly location: string | null } | null
  readonly mcp: { readonly server: string; readonly tool: string } | null
  readonly plugin: boolean
}

const NO_FACTS: ToolFacts = { file: null, skill: null, mcp: null, plugin: false }

interface FileBucket {
  readonly key: string
  readonly label: string
  reads: number
  writes: number
}

interface McpBucket {
  readonly server: string
  readonly tools: Map<string, number>
  count: number
}

/** 一份界面的累计：`versions` 是分支上出现过的次数，`revision` 取最大值。 */
interface GenuiBucket {
  readonly documentId: string
  title: string
  revision: number
  versions: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 统一分隔符并去掉结尾多余的斜杠；不做 trim，避免改写真实文件名。 */
function unifyPath(path: string): string {
  const unified = path.replace(/\\/gu, '/')
  const trimmed = unified.length > 1 ? unified.replace(/\/+$/u, '') : unified
  return trimmed
}

/** 绝对路径判定：POSIX 根或 Windows 盘符开头。 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//u.test(path)
}

/**
 * 展示路径：项目内的绝对路径折成相对路径，模型给的相对路径原样使用；
 * 含 `..` 的相对路径与项目外的绝对路径仍然原样展示。
 */
function describePath(raw: string, projectPath: string | null): {
  readonly key: string
  readonly label: string
} {
  const unified = unifyPath(raw)
  const root = projectPath === null ? null : unifyPath(projectPath)

  if (isAbsolutePath(unified)) {
    if (root !== null) {
      const prefix = root.endsWith('/') ? root : `${root}/`
      if (unified.startsWith(prefix)) {
        const relative = unified.slice(prefix.length)
        return { key: relative, label: relative }
      }
    }
    return { key: unified, label: unified }
  }

  const relative = unified.startsWith('./') ? unified.slice(2) : unified
  if (relative === '' || relative.split('/').includes('..')) {
    return { key: unified, label: unified }
  }
  return { key: relative, label: relative }
}

/** 参数摘要里该键的短值；值不是可直接显示的单行文本时为 null（长路径只给了规模）。 */
function inlineArg(summary: readonly ToolArgSummaryEntry[], key: string): string | null {
  for (const entry of summary) {
    if (entry.key !== key) continue
    if (entry.value.kind !== 'inline') return null
    const text = entry.value.text.trim()
    return text === '' ? null : text
  }
  return null
}

/** 摘要里取不到可直接显示的短值时的回退：只在参数原文里取路径字段，不做任何结构推断。 */
function pathFromArgsText(argsText: string | null): string | null {
  if (argsText === null) return null
  let args: unknown
  try {
    args = JSON.parse(argsText)
  } catch {
    return null
  }
  if (!isRecord(args)) return null
  for (const key of PATH_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/** 文件工具的目标路径：先看摘要里的短值，再回退到参数原文。 */
function filePathOf(tool: ToolExecution): string | null {
  const summary = tool.argsSummary
  if (summary !== null) {
    for (const key of PATH_ARG_KEYS) {
      const value = inlineArg(summary, key)
      if (value !== null) return value
    }
  }
  return pathFromArgsText(tool.argsText)
}

/** `mcp__<服务器>__<工具>` 的拆分：按第一个 `__` 断开；没有分隔符时整段按服务器名处理、工具名留空。 */
function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith(MCP_PREFIX)) return null
  const rest = toolName.slice(MCP_PREFIX.length)
  if (rest === '') return { server: '未知服务器', tool: '' }
  const separator = rest.indexOf('__')
  if (separator <= 0) return { server: rest, tool: '' }
  const server = rest.slice(0, separator)
  const tool = rest.slice(separator + 2)
  return { server, tool }
}

/**
 * 一条工具条目的贡献：只按工具名与参数判定，不读结果内容。
 * 失败的工具没有任何贡献——没有读到、也没有写成。
 */
function factsOf(tool: ToolExecution): ToolFacts {
  if (tool.phase === 'failed') return NO_FACTS
  const name = tool.toolName

  if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
    const path = filePathOf(tool)
    if (path === null) return NO_FACTS
    const mode = READ_TOOLS.has(name) ? 'read' : 'write'
    return {
      file: { path, mode },
      // 读取请求不证明正文完整加载；加载事实只由后面的有效上下文审计补入。
      skill: null,
      mcp: null,
      plugin: false
    }
  }

  const mcp = parseMcpToolName(name)
  if (mcp !== null) return { file: null, skill: null, mcp, plugin: false }
  if (MCP_RESOURCE_TOOLS.has(name)) {
    return { file: null, skill: null, mcp: { server: MCP_RESOURCE_LABEL, tool: name }, plugin: false }
  }
  if (BUILTIN_TOOLS.has(name)) return NO_FACTS
  // 既非内置也非 MCP：按扩展（插件）工具统计，只报工具名。
  return { file: null, skill: null, mcp: null, plugin: true }
}

/** 按次数与名称排序，次数相同按名称排，保证同一份投影每次给出相同顺序。 */
function byCountThenName<T extends { readonly count: number }>(nameOf: (item: T) => string) {
  return (left: T, right: T): number => (
    right.count - left.count || nameOf(left).localeCompare(nameOf(right), 'zh-Hans-CN')
  )
}

/** 仅供宿主归纳已确认事实，不依赖渲染窗口或最近工具条数。 */
export function createSessionActivityCache(): SessionActivityCache {
  /** 工具条目贡献缓存：键是 toolCallId，值同时记住来源对象，投影替换对象时重新解析。 */
  let toolEntries = new Map<string, { readonly source: ToolExecution; readonly facts: ToolFacts }>()

  return {
    derive(commands, tools, projectPath) {
      const files = new Map<string, FileBucket>()
      const skills = new Map<string, { readonly name: string; readonly source: SkillActivitySource; readonly location: string | null; count: number }>()
      const servers = new Map<string, McpBucket>()
      const plugins = new Map<string, number>()

      const addSkill = (name: string, source: SkillActivitySource, location: string | null): void => {
        if (name === '') return
        const key = `${source}:${name}`
        const existing = skills.get(key)
        if (existing === undefined) {
          skills.set(key, { name, source, location, count: 1 })
          return
        }
        existing.count += 1
      }

      // 命令事实只在原始用户条目进入分支时提取，不再反复构造并解析合成消息。
      for (const command of commands) addSkill(command.name, 'command', command.location)

      const keptTools = new Map<string, { readonly source: ToolExecution; readonly facts: ToolFacts }>()
      for (const tool of tools) {
        const cached = toolEntries.get(tool.toolCallId)
        const entry = cached !== undefined && cached.source === tool
          ? cached
          : { source: tool, facts: factsOf(tool) }
        keptTools.set(tool.toolCallId, entry)
        const { facts } = entry

        if (facts.file !== null) {
          const described = describePath(facts.file.path, projectPath)
          const bucket = files.get(described.key) ?? {
            key: described.key,
            label: described.label,
            reads: 0,
            writes: 0
          }
          if (facts.file.mode === 'read') bucket.reads += 1
          else bucket.writes += 1
          files.set(described.key, bucket)
        }
        if (facts.skill !== null) addSkill(facts.skill.name, 'file', facts.skill.location)
        if (facts.mcp !== null) {
          const bucket = servers.get(facts.mcp.server) ?? { server: facts.mcp.server, tools: new Map(), count: 0 }
          bucket.count += 1
          if (facts.mcp.tool !== '') bucket.tools.set(facts.mcp.tool, (bucket.tools.get(facts.mcp.tool) ?? 0) + 1)
          servers.set(facts.mcp.server, bucket)
        }
        if (facts.plugin) plugins.set(tool.toolName, (plugins.get(tool.toolName) ?? 0) + 1)
      }
      toolEntries = keptTools

      // 改过的文件排在只读文件之前：先看本次会话动过什么，再看读过什么。
      const fileRows: SessionFileActivity[] = [...files.values()]
        .sort((left, right) => (
          Number(right.writes > 0) - Number(left.writes > 0)
          || (right.reads + right.writes) - (left.reads + left.writes)
          || left.label.localeCompare(right.label, 'zh-Hans-CN')
        ))
        .map(bucket => ({
          key: bucket.key,
          label: bucket.label,
          reads: bucket.reads,
          writes: bucket.writes
        }))

      const skillRows: SessionSkillActivity[] = [...skills.values()]
        .sort(byCountThenName(item => item.name))
        .map(item => ({ name: item.name, source: item.source, location: item.location, count: item.count }))

      const mcpRows: SessionMcpActivity[] = [...servers.values()]
        .sort(byCountThenName(item => item.server))
        .map(bucket => ({
          server: bucket.server,
          count: bucket.count,
          tools: [...bucket.tools.entries()]
            .map(([name, count]) => ({ name, count }))
            .sort(byCountThenName(item => item.name))
        }))

      const pluginRows: SessionPluginActivity[] = [...plugins.entries()]
        .map(([toolName, count]) => ({ toolName, count }))
        .sort(byCountThenName(item => item.toolName))

      return {
        files: fileRows,
        skills: skillRows,
        mcp: mcpRows,
        plugins: pluginRows,
        // 界面交付不来自工具条目本身（投影的轻量条目不带载荷），由 `ActivityProjection` 另计。
        genui: [],
        fileCount: fileRows.length,
        skillCount: skillRows.length,
        mcpCount: mcpRows.length,
        pluginCount: pluginRows.length,
        genuiCount: 0,
        empty: fileRows.length === 0 && skillRows.length === 0
          && mcpRows.length === 0 && pluginRows.length === 0
      }
    }
  }
}

/** 摘要串联每条日志的完整内容与顺序，只保留摘要，不保留原文。 */
const EMPTY_ACTIVITY_PREFIX = createHash('sha256').update(`pi-desk/activity/${ACTIVITY_STATE_VERSION}`).digest('hex')

function advanceActivityPrefix(previous: string | null, entry: SessionEntry): string | null {
  if (previous === null) return null
  try {
    const text = JSON.stringify(entry)
    return text === undefined ? null : createHash('sha256').update(previous).update('\n').update(text).digest('hex')
  } catch {
    // 内存中的非 JSON 扩展数据不能成为恢复证据；仅放弃检查点，不阻止正常展示。
    return null
  }
}

/** 换 manager 或从检查点恢复时核对整个已处理前缀，条目 ID 相同不代表内容没有被重写。 */
export function matchesActivityPrefix(state: ActivityCheckpointState, branch: readonly SessionEntry[]): boolean {
  if (state.version !== ACTIVITY_STATE_VERSION || !Number.isSafeInteger(state.prefixLength)
    || state.prefixLength < 0 || state.prefixLength > branch.length
    || (branch[state.prefixLength - 1]?.id ?? null) !== state.tailEntryId) return false
  let hash: string | null = EMPTY_ACTIVITY_PREFIX
  for (let index = 0; index < state.prefixLength; index += 1) {
    const entry = branch[index]
    if (entry === undefined) return false
    hash = advanceActivityPrefix(hash, entry)
  }
  return hash !== null && hash === state.prefixHash
}

/** 补齐展示聚合所需的空字段；实际保存的参数只有路径，没有正文、输出或完整参数。 */
function activityTool(state: ActivityToolState): ToolExecution {
  return { ...state, startedAt: null, endedAt: null, argsTruncated: false, argsSummary: null,
    outputPath: null, text: '', textKind: 'none', textTruncated: false,
    nonTextBlocks: 0, nonTextParts: [], diff: null, ui: null }
}

/** 活动累计器：稳定分支与实时补充分离；快照仅复制轻量稳定事实。 */
export class ActivityProjection {
  private source: object | null = null
  private projectPath: string | null = null
  private sessionId: string | null = null
  private prefixLength = 0
  private prefixHash: string | null = EMPTY_ACTIVITY_PREFIX
  /** 仅在当前 manager 内判断连续追加，不导出这个原始条目引用。 */
  private lastEntry: SessionEntry | null = null
  private tools = new Map<string, ToolExecution>()
  private liveTools = new Map<string, ToolExecution>()
  private commands: ActivityCommandState[] = []
  private skills = new Map<string, SessionSkillActivity>()
  private genui = new Map<string, GenuiBucket>()
  private evidence = new Set<string>()
  private cache = createSessionActivityCache()
  private incomplete = false
  private dirty = true
  private view: SessionActivity | null = null
  private savedState: ActivityCheckpointState | null = null

  constructor(state?: ActivityCheckpointState) {
    if (state === undefined || state.version !== ACTIVITY_STATE_VERSION) return
    try {
      this.prefixLength = state.prefixLength
      this.prefixHash = state.prefixHash
      this.tools = new Map(state.tools.map(tool => [tool.toolCallId, activityTool({ ...tool })]))
      this.commands = state.commands.map(command => ({ ...command }))
      this.skills = new Map(state.skills.map(skill => [`${skill.source}:${skill.name}:${skill.location}`, { ...skill }]))
      this.genui = new Map(state.genui.map(item => [item.documentId, { ...item }]))
      this.evidence = new Set(state.evidence)
      this.incomplete = state.incomplete
      this.savedState = state
    } catch {
      this.reset()
    }
  }

  /** 实时完成事实仍可展示，但不进入稳定工具集合；日志确认后按调用身份移除补充。 */
  observe(event: Record<string, unknown>): void {
    if ((event.type !== 'tool_execution_start' && event.type !== 'tool_execution_end')
      || typeof event.toolCallId !== 'string' || typeof event.toolName !== 'string') return
    this.call(this.liveTools, event.toolCallId, event.toolName, event.args,
      event.type === 'tool_execution_start' ? 'running' : event.isError === true ? 'failed' : 'succeeded')
  }

  /** 只在轻量事实改变时替换对象，保留贡献缓存的命中能力。 */
  private call(tools: Map<string, ToolExecution>, id: string, name: string, input: unknown, phase: ToolExecution['phase']): void {
    const previous = tools.get(id)
    const args = isRecord(input) ? input : {}
    const path = PATH_ARG_KEYS.map(key => args[key]).find(value => typeof value === 'string')
    const argsText = typeof path === 'string' ? JSON.stringify({ path }) : previous?.argsText ?? null
    const nextPhase = phase === 'unknown' ? previous?.phase ?? phase : phase
    if (previous?.toolName === name && previous.phase === nextPhase && previous.argsText === argsText) return
    tools.set(id, activityTool({ toolCallId: id, toolName: name, phase: nextPhase, argsText }))
    this.dirty = true
  }

  /** 同一 manager 的追加条目只处理一次；换源核对前缀，回退、改写或项目变化则重建。 */
  refresh(branch: readonly SessionEntry[], projectPath: string, sessionId: string, source: object): SessionActivity {
    if (this.source !== source || this.projectPath !== projectPath || this.sessionId !== sessionId) {
      const state = this.snapshot()
      if ((this.projectPath !== null && this.projectPath !== projectPath)
        || (this.sessionId !== null && this.sessionId !== sessionId)
        || state === null || !matchesActivityPrefix(state, branch)) this.reset()
      else if (this.liveTools.size > 0) { this.liveTools.clear(); this.dirty = true }
    } else if (this.prefixLength > branch.length
      || (this.prefixLength > 0 && branch[this.prefixLength - 1] !== this.lastEntry)) {
      this.reset()
    }
    this.source = source
    this.projectPath = projectPath
    this.sessionId = sessionId
    for (const entry of branch.slice(this.prefixLength)) {
      if (entry.type === 'message') this.message(entry.id, entry.message)
      if (entry.type === 'custom' && entry.customType === 'skill-guard') this.audit(entry.data)
      this.prefixHash = advanceActivityPrefix(this.prefixHash, entry)
      this.prefixLength += 1
      this.savedState = null
    }
    this.lastEntry = branch.at(-1) ?? null
    if (!this.dirty && this.view !== null) return this.view
    const tools = new Map(this.tools)
    for (const [id, live] of this.liveTools) {
      const stable = tools.get(id)
      if (stable?.phase === 'succeeded' || stable?.phase === 'failed') continue
      tools.set(id, live.argsText === null && stable?.argsText !== undefined
        ? { ...live, argsText: stable.argsText } : live)
    }
    const derived = this.cache.derive(this.commands, [...tools.values()].filter(tool => tool.phase === 'succeeded'), projectPath)
    const skills = [...derived.skills, ...this.skills.values()].sort(byCountThenName(item => item.name))
    const genui = [...this.genui.values()].map(bucket => ({ ...bucket }))
    this.view = { ...derived, skills, skillCount: skills.length, genui, genuiCount: genui.length,
      incomplete: this.incomplete,
      empty: derived.files.length === 0 && skills.length === 0 && derived.mcp.length === 0
        && derived.plugins.length === 0 && genui.length === 0 }
    this.dirty = false
    return this.view
  }

  /** 独立复制稳定集合；未变化的前缀复用同一只读快照，不携带实时工具或原文。 */
  snapshot(): ActivityCheckpointState | null {
    if (this.prefixHash === null) return null
    if (this.savedState !== null) return this.savedState
    this.savedState = {
      version: ACTIVITY_STATE_VERSION, prefixLength: this.prefixLength,
      tailEntryId: this.lastEntry?.id ?? null, prefixHash: this.prefixHash,
      tools: [...this.tools.values()].map(tool => ({ toolCallId: tool.toolCallId,
        toolName: tool.toolName, phase: tool.phase, argsText: tool.argsText })),
      commands: this.commands.map(command => ({ ...command })),
      skills: [...this.skills.values()].map(skill => ({ ...skill })),
      genui: [...this.genui.values()].map(item => ({ ...item })),
      evidence: [...this.evidence], incomplete: this.incomplete
    }
    return this.savedState
  }

  /** 清除分支事实与瞬态展示，不让已离开的分支贡献继续累加。 */
  private reset(): void {
    this.prefixLength = 0
    this.prefixHash = EMPTY_ACTIVITY_PREFIX
    this.lastEntry = null
    this.tools.clear(); this.liveTools.clear(); this.commands = []; this.skills.clear()
    this.genui.clear(); this.evidence.clear()
    this.cache = createSessionActivityCache()
    this.incomplete = false
    this.savedState = null
    this.view = null
    this.dirty = true
  }

  /** 稳定工具结果只使用分支里的调用参数；实时补充不能替缺失日志创造恢复事实。 */
  private message(id: string, message: unknown): void {
    if (!isRecord(message)) return
    const content = Array.isArray(message.content) ? message.content : []
    if (message.role === 'assistant') for (const part of content) {
      if (!isRecord(part) || part.type !== 'toolCall' || typeof part.id !== 'string' || typeof part.name !== 'string') continue
      this.call(this.tools, part.id, part.name, part.arguments, 'unknown')
    }
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const previous = this.tools.get(message.toolCallId)
      if (previous) {
        const phase = message.isError === true ? 'failed' : 'succeeded'
        if (previous.phase !== phase) { this.tools.set(message.toolCallId, { ...previous, phase }); this.dirty = true }
        if (this.liveTools.delete(message.toolCallId)) this.dirty = true
      } else if (message.isError === true && this.liveTools.delete(message.toolCallId)) this.dirty = true
      if (message.isError !== true && typeof message.toolName === 'string') this.recordGenui(message.toolName, message.details)
    }
    if (message.role === 'toolResult' && isRecord(message.nestedCalls)) {
      if (message.nestedCalls.complete === false && !this.incomplete) { this.incomplete = true; this.dirty = true }
      if (Array.isArray(message.nestedCalls.calls)) for (const nested of message.nestedCalls.calls) {
        if (!isRecord(nested) || typeof nested.id !== 'string' || typeof nested.name !== 'string') continue
        this.call(this.tools, nested.id, nested.name, nested.arguments,
          nested.status === 'ok' ? 'succeeded' : nested.status === 'error' ? 'failed' : 'unknown')
        // 日志明确确认结束时才移除实时补充，未知结果不抹掉当前绑定仍持有的完成事实。
        if ((nested.status === 'ok' || nested.status === 'error') && this.liveTools.delete(nested.id)) this.dirty = true
      }
    }
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : content
        .filter(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
        .map(part => (part as { text: string }).text).join('\n')
      const skill = parseSkillBlock(text)
      if (skill === null) return
      this.commands.push({ id, name: skill.name, location: skill.location === '' ? null : skill.location })
      this.dirty = true
    }
  }

  /**
   * 记一份界面交付：只认 `ui_render` / `ui_patch` 的 `details.ui`，且只读头部。
   * 同一 `documentId` 合并成一条：版本取最大、标题取后出现的非空值、`versions` 累加。
   * 标题为空（历史文档缺字段）时不拿空串盖掉已有标题。
   */
  private recordGenui(toolName: string, details: unknown): void {
    if (!GENUI_RENDER_TOOL_NAMES.has(toolName)) return
    if (!isRecord(details)) return
    const header = readGenuiPayloadHeader(details.ui)
    if (header === null) return
    this.dirty = true
    const existing = this.genui.get(header.documentId)
    if (existing === undefined) {
      this.genui.set(header.documentId, {
        documentId: header.documentId,
        title: header.title,
        revision: header.revision,
        versions: 1
      })
      return
    }
    this.genui.set(header.documentId, {
      ...existing,
      title: header.title === '' ? existing.title : header.title,
      revision: Math.max(existing.revision, header.revision),
      versions: existing.versions + 1
    })
  }

  private audit(data: unknown): void {
    if (!isRecord(data) || data.event !== 'context-loaded' || !Array.isArray(data.loaded)) return
    for (const item of data.loaded) {
      if (!isRecord(item) || item.kind === 'reference' || typeof item.name !== 'string' || typeof item.path !== 'string'
        || typeof item.sha256 !== 'string' || !Array.isArray(item.via)) continue
      if (item.source !== 'model-read' && item.source !== 'host-injected') continue
      const source: SkillActivitySource = item.source === 'model-read' ? 'file' : 'host'
      // 同一证据反复出现在context审计中只算一次；宿主注入按该轮运行去重。
      const proof = JSON.stringify([source, item.path, item.sha256, source === 'host' ? data.runId : item.via])
      if (this.evidence.has(proof)) continue
      this.evidence.add(proof)
      this.dirty = true
      const key = `${source}:${item.name}:${item.path}`
      const previous = this.skills.get(key)
      this.skills.set(key, { name: item.name, source, location: item.path, count: (previous?.count ?? 0) + 1 })
    }
  }
}
