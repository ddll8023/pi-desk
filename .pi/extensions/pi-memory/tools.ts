/** 按需检索与受控保存工具；Memory Skill 决定何时用记忆，主动定向读取自动记独立统计，权威内容保存须审批。 */
import { createHash } from 'node:crypto'
import { Type } from '@earendil-works/pi-ai'
import type { JsonValue } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { approve, approvalLimit, approvalText } from './approval.ts'
import { CONTROL_TYPE, applicableProfiles } from './context.ts'
import type { Identity, Lease, MemoryRuntime } from './context.ts'
import { DOMAINS, array, domain, errorText, object, text } from './engine.ts'
import type { JsonObject } from './engine.ts'
import { listTopics, readProject } from './project.ts'

const DomainSchema = Type.Union(DOMAINS.map(value => Type.Literal(value)))
const Ids = Type.Array(Type.String({ pattern: '^m_[0-9A-HJKMNP-TV-Z]{26}$' }), { maxItems: 50 })
const ProjectId = Type.Optional(Type.String({ minLength: 1, pattern: '^[a-z][a-z0-9-]*$' }))
const Offset = Type.Optional(Type.Integer({ minimum: 0 }))
const Limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 200 }))
const Output = Type.Object({ ok: Type.Literal(true), data: Type.Unknown(), error: Type.Null() })
const ReadHints = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const ACCESS_NOTE = '自动技术统计仅表示主动定向读取结果已准备，不代表模型已接收、理解或采纳；不参与检索排序。'

function result(data: JsonObject) {
  const value = { ok: true as const, data, error: null }
  const json = JSON.stringify(value, null, 2)
  if (json.length > 180_000) throw new Error('结果超过单次完整输出上限；请缩小 limit 或查询范围，未截断正文')
  return { content: [{ type: 'text' as const, text: json }], details: data, structuredContent: JSON.parse(json) as JsonValue }
}
function keys(data: JsonObject, allowed: string[]): void {
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new Error('候选包含未允许字段；不接受 approved、plan_id 或模型授权声明')
}
function boundedPage(offset: number | undefined, limit: number | undefined): [number, number] {
  const start = offset ?? 0
  const count = limit ?? 20
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 1 || count > 200) throw new Error('分页范围无效')
  return [start, count]
}
/** Pi 会话使用 UUID，引擎要求 s_ULID；稳定编码，不能换 ID 绕过重复保存。 */
function diarySessionId(sessionId: string, projectId: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let value = BigInt(`0x${createHash('sha256').update(`pi-memory\0${sessionId}\0${projectId}`).digest('hex').slice(0, 32)}`)
  let encoded = ''
  for (let index = 0; index < 26; index++) { encoded = alphabet[Number(value & 31n)] + encoded; value >>= 5n }
  return `s_${encoded}`
}

export function registerMemoryTools(pi: ExtensionAPI, runtime: MemoryRuntime): void {
  const engine = runtime.engine
  // 全局检索不探测项目目录；停用、取消和会话换代仍使用同一租约边界。
  const globalRead = async (ctx: ExtensionToolContext, signal: AbortSignal | undefined,
    work: (lease: Lease) => Promise<JsonObject>) => {
    const lease = runtime.lease(ctx, signal)
    const data = await work(lease)
    lease.assert()
    return result(data)
  }
  const read = async (ctx: ExtensionToolContext, signal: AbortSignal | undefined,
    work: (lease: Lease, identity: Identity) => Promise<JsonObject>) => {
    const lease = runtime.lease(ctx, signal)
    const identity = await runtime.identity(ctx, lease)
    const data = await work(lease, identity)
    lease.assert()
    return result(data)
  }
  const save = async (ctx: ExtensionToolContext, signal: AbortSignal | undefined, operation: 'save' | 'profile',
    prepare: (lease: Lease, identity: Identity) => Promise<JsonObject>) => {
    // 无完整交互能力时，连计划技术缓存也不生成。
    approvalLimit(ctx)
    const lease = runtime.lease(ctx, signal)
    const finishSave = runtime.beginSave(lease)
    try {
      const identity = await runtime.identity(ctx, lease)
      const input = await prepare(lease, identity)
      lease.assert()
      const leaf = ctx.sessionManager.getLeafId()
      const stillCurrent = (): void => {
        lease.assert()
        if (ctx.sessionManager.getLeafId() !== leaf) throw new Error('审批期间当前分支已改变，旧确认失效')
        approvalLimit(ctx)
      }
      const plan = await engine.plan(operation, input, lease.signal)
      stillCurrent()
      const message = approvalText(engine, plan, { sessionId: lease.state.sessionId,
        cwd: lease.state.cwd, projectRoot: identity.root })
      const accepted = await approve(ctx, message, lease.signal)
      if (!accepted) return result({ committed: false, cancelled: true, plan_id: plan.id,
        message: '未提交权威记忆；短期候选仍由既有引擎管理' })
      stillCurrent()
      const refreshed = await runtime.identity(ctx, lease)
      if (refreshed.root !== identity.root || refreshed.configuredProjectId !== identity.configuredProjectId) {
        throw new Error('审批期间项目身份已改变，未提交旧计划')
      }
      const data = await engine.commit(plan, stillCurrent)
      // commit 一旦开始不强杀；如在提交期间换代，返回真实结果而不是宣称撤销。
      return result({ ...data, committed: true, plan_id: plan.id,
        source_pi_session_id: lease.state.sessionId, source_cwd: lease.state.cwd,
        note: '仅此具体计划已提交；没有其他文件沙箱或跨域事务保证' })
    } finally { finishSave() }
  }

  pi.registerTool({
    name: 'memory_status', label: '读取记忆库状态',
    description: '按需读取既有库状态与真实项目 ID 表。不初始化、登记、检查或修复。项目 ID 未确认时先查本工具，不把目录名当 ID。',
    parameters: Type.Object({}, { additionalProperties: false }), outputSchema: Output, annotations: ReadHints,
    async execute(_id, _params, signal, _onUpdate, ctx) {
      return read(ctx, signal, async lease => ({ runtime: runtime.status(ctx), store: await engine.status(lease.signal) }))
    }
  })
  pi.registerTool({
    name: 'memory_control', label: '控制记忆召回', exposure: 'model-only', executionMode: 'sequential',
    description: '遵从用户要求停用、恢复或刷新记忆。off/on 只记录当前分支控制选项，不保存记忆正文或批准；refresh 使旧缓存和待确认计划失效。',
    parameters: Type.Object({ action: Type.Union([Type.Literal('off'), Type.Literal('on'), Type.Literal('refresh')]) }, { additionalProperties: false }),
    outputSchema: Output, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return result(runtime.control(ctx, params.action, data => pi.appendEntry(CONTROL_TYPE, data)))
    }
  })
  pi.registerTool({
    name: 'memory_profiles', label: '按领域读取适用画像',
    description: '按需读取一个明确领域，返回当前适用作用域的完整画像与来源，支持分页；不把 current_profile 视为正文事实已验证。项目默认仅使用已配置真实 ID，不确认时只返回非项目作用域。',
    parameters: Type.Object({ domain: DomainSchema, project_id: ProjectId, offset: Offset, limit: Limit }, { additionalProperties: false }),
    outputSchema: Output, annotations: ReadHints,
    async execute(_id, params, signal, _onUpdate, ctx) {
      return read(ctx, signal, async (lease, identity) => {
        let projectId: string | null = null
        if (params.project_id !== undefined) projectId = (await runtime.requireProject(identity, params.project_id)).id
        else if (identity.configuredProjectId !== null) {
          const projects = await engine.projects()
          if (projects.some(project => project.id === identity.configuredProjectId)) projectId = identity.configuredProjectId
        }
        const selected = domain(params.domain)
        const data = applicableProfiles(await engine.profiles(selected, lease.signal), selected,
          [...new Set([...identity.domains, selected])], projectId)
        const profiles = array(data.profiles)
        const [offset, limit] = boundedPage(params.offset, params.limit)
        return { ...data, store: engine.store, total_profiles: profiles.length, offset,
          profiles: profiles.slice(offset, offset + limit), has_more: offset + limit < profiles.length,
          next_offset: offset + limit < profiles.length ? offset + limit : null }
      })
    }
  })
  pi.registerTool({
    name: 'memory_rules', label: '读取当前有效规则',
    description: '默认读取全局当前有效决定/约束，不要求当前目录绑定项目；project_id 仅作明确过滤，不受近期窗口限制。完整清单不加 query，并按 has_more 翻页；有主题时用中文词法相关度。返回规则摘要，完整正文需显式调用 memory_read 二次读取。各项目规则保留归属，不能自动当作当前任务约束。索引失效不自动修复。',
    parameters: Type.Object({ project_id: ProjectId, query: Type.Optional(Type.String()), offset: Offset, limit: Limit }, { additionalProperties: false }),
    outputSchema: Output, annotations: ReadHints,
    async execute(_id, params, signal, _onUpdate, ctx) {
      return globalRead(ctx, signal, async lease => {
        const [offset, limit] = boundedPage(params.offset, params.limit)
        const data = await engine.rules(params.project_id, params.query ?? '', offset, limit, lease.signal)
        if (data.project_id !== (params.project_id ?? null)) throw new Error('规则返回的检索范围不一致，未展示')
        return { ...data, rules: array(data.rules).map(value => {
          const row = object(value)
          const project = text(row.project_id, '规则来源项目')
          if (row.status !== 'active' || (params.project_id !== undefined && project !== params.project_id)) {
            throw new Error('规则生命周期或明确限定的项目不一致，未展示')
          }
          return { ...row, status_basis: '仅投影当前有效版本；不证明事实已核实或适用于当前任务',
            source: { store: engine.store, command: 'rules', file: row.file_path,
              project_id: project, id: row.id, date: row.date } }
        }) }
      })
    }
  })
  pi.registerTool({
    name: 'memory_search', label: '按任务检索全局记忆',
    description: '默认 records：从全局索引检索全部已保存日记，不要求目录或项目绑定。project_id 仅作明确过滤；recent 限近期，historical/month 查询已有月摘要。返回记录摘要，完整正文需显式调用 memory_read 二次读取。中文词法相关度排序，可用 offset/limit 分页；跨页核对 index_version。保留来源、历史状态与命中词，不把项目经验自动泛化。索引失效不自动修复或扫描历史。',
    parameters: Type.Object({ project_id: ProjectId, query: Type.String({ minLength: 1 }),
      mode: Type.Optional(Type.Union([Type.Literal('records'), Type.Literal('recent'), Type.Literal('historical'), Type.Literal('month')])),
      month: Type.Optional(Type.String({ pattern: '^\\d{4}-(0[1-9]|1[0-2])$' })), offset: Offset, limit: Limit }, { additionalProperties: false }),
    outputSchema: Output, annotations: ReadHints,
    async execute(_id, params, signal, _onUpdate, ctx) {
      return globalRead(ctx, signal, async lease => {
        const [offset, limit] = boundedPage(params.offset, params.limit)
        const mode = params.mode ?? 'records'
        const data = await engine.search(params.project_id, params.query, mode, params.month, offset, limit, lease.signal)
        if (data.project_id !== (params.project_id ?? null) || data.mode !== mode) throw new Error('搜索返回的范围不一致，未展示')
        const summary = mode === 'historical' || mode === 'month'
        const matches = array(data.matches).map(value => {
          const row = object(value)
          const project = text(row.project_id, '搜索来源项目')
          if (row.kind !== (summary ? 'summary' : 'record')
            || (params.project_id !== undefined && project !== params.project_id)) throw new Error('搜索来源或明确限定的项目不一致，未展示')
          return { ...row, source: { store: engine.store, command: 'recall', file: row.file_path, project_id: project,
            ...(summary ? { month: row.month, source_record_ids: row.source_record_ids } : { id: row.id, date: row.date }) } }
        })
        return { ...data, matches,
          requested_scope: { project_id: params.project_id ?? null, mode, month: params.month ?? null, query: params.query },
          has_more_matches: data.has_more === true }
      })
    }
  })
  pi.registerTool({
    name: 'memory_read', label: '读取指定日记原文',
    description: '按 1..50 个真实日记 ID 定向读取完整原文；project_id 仅作明确过滤，不要求目录绑定。核对来源并保留历史状态，不扫描全部日记或修复索引。成功准备结果后默认自动写入独立访问统计，因此不是纯只读；统计失败仍返回原文并说明状态，不代表模型实际使用记忆。',
    parameters: Type.Object({ project_id: ProjectId, ids: Type.Array(Type.String({ pattern: '^m_[0-9A-HJKMNP-TV-Z]{26}$' }), { minItems: 1, maxItems: 50 }) }, { additionalProperties: false }),
    outputSchema: Output, annotations: { ...ReadHints, readOnlyHint: false, idempotentHint: false },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const lease = runtime.lease(ctx, signal)
      const data = await engine.read(params.ids, params.project_id, lease.signal)
      lease.assert()
      if (data.project_id !== (params.project_id ?? null)) throw new Error('原文返回的范围不一致，未展示')
      const values = array(data.records)
      if (values.length !== params.ids.length) throw new Error('原文返回的记录数量不一致，未展示')
      const records = values.map((value, index) => {
        const row = object(value)
        const project = text(row.project_id, '原文来源项目')
        if (row.id !== params.ids[index] || (params.project_id !== undefined && project !== params.project_id)) {
          throw new Error('原文身份或明确限定的项目不一致，未展示')
        }
        return { ...row, status: row.status ?? 'active',
          source: { store: engine.store, file: row.file_path, project_id: project, id: row.id, date: row.date } }
      })
      const payload = { ...data, records }
      // 先确认完整输出可返回，并预留最坏的统计错误文本；超限或旧租约不产生统计。
      result({ ...payload, access_statistics: { status: 'unconfirmed', new_records: null,
        duplicate_records: null, error: '\u0000'.repeat(1024), note: ACCESS_NOTE } })
      let statistics: JsonObject
      try {
        const version = text(data.index_version, '原文来源版本')
        const recorded = await engine.recordAccess(params.ids, lease.state.sessionId, toolCallId, version, lease.assert)
        const added = recorded.new_records
        const duplicate = recorded.duplicate_records
        if (typeof added !== 'number' || !Number.isInteger(added) || added < 0
          || typeof duplicate !== 'number' || !Number.isInteger(duplicate) || duplicate < 0
          || added + duplicate !== new Set(params.ids).size
          || recorded.status !== (added > 0 ? 'recorded' : 'duplicate')) throw new Error('统计返回的计数或状态不一致')
        statistics = { status: recorded.status, new_records: added, duplicate_records: duplicate, note: ACCESS_NOTE }
      } catch (error) {
        // 写入后通信失败不能冒充“未写入”；不重试，也不使成功原文变成统计错误。
        statistics = { status: 'unconfirmed', new_records: null, duplicate_records: null,
          error: errorText(error).slice(0, 1024), note: ACCESS_NOTE }
      }
      lease.assert()
      return result({ ...payload, access_statistics: statistics })
    }
  })
  pi.registerTool({
    name: 'memory_access_stats', label: '查询记忆访问统计',
    description: '按 1..50 个真实日记 ID 只读查询主动定向读取次数、去重会话数和最近读取时间，不产生访问计数。统计默认自动采集，无需配置；零次或尚未采集不表示历史上从未使用，统计不代表有用性或事实正确，也不参与排名。不初始化、修复或扫描历史。',
    parameters: Type.Object({ ids: Type.Array(Type.String({ pattern: '^m_[0-9A-HJKMNP-TV-Z]{26}$' }), { minItems: 1, maxItems: 50 }) }, { additionalProperties: false }),
    outputSchema: Output, annotations: ReadHints,
    async execute(_id, params, signal, _onUpdate, ctx) {
      return globalRead(ctx, signal, async lease => {
        const ids = [...new Set(params.ids)]
        const data = await engine.accessStats(ids, lease.signal)
        const rows = array(data.records)
        if (data.coverage !== 'recorded_accesses_only' || data.automatic !== true || rows.length !== ids.length) {
          throw new Error('访问统计返回的范围或数量不一致，未展示')
        }
        const records = rows.map((value, index) => {
          const row = object(value)
          if (row.id !== ids[index]) throw new Error('访问统计返回的记录身份不一致，未展示')
          return { ...row, source: { store: engine.store, command: 'access-stats',
            id: row.id, project_id: row.project_id, date: row.date } }
        })
        return { ...data, records }
      })
    }
  })
  pi.registerTool({
    name: 'memory_project_read', label: '按需读取项目知识',
    description: '读取当前项目 INDEX.md 或指定主题完整分页；列表模式只列一层规范主题路径。拒绝绝对路径、越界链接和任意根目录；不创建或修复文件。',
    parameters: Type.Object({ action: Type.Optional(Type.Union([Type.Literal('read'), Type.Literal('list')])),
      path: Type.Optional(Type.String()), offset: Offset, limit: Limit }, { additionalProperties: false }),
    outputSchema: Output, annotations: ReadHints,
    async execute(_id, params, signal, _onUpdate, ctx) {
      return read(ctx, signal, async (_lease, identity) => {
        if (!identity.root) throw new Error('当前未激活项目，不把主目录或全局 Agent 目录当成项目')
        if (params.action === 'list') {
          if (params.path !== undefined || params.offset !== undefined || params.limit !== undefined) throw new Error('列表模式不接受原文路径或分页参数')
          return { root: identity.root, ...await listTopics(identity.root) }
        }
        const [offset, limit] = boundedPage(params.offset, params.limit)
        return { ...await readProject(identity.root, params.path ?? 'INDEX.md', offset, limit) }
      })
    }
  })

  const RecordSchema = Type.Object({
    type: Type.Union(['decision', 'constraint', 'progress', 'issue', 'fact', 'preference_evidence'].map(value => Type.Literal(value))),
    topic: Type.String({ minLength: 1, maxLength: 200 }), content: Type.String({ minLength: 1, maxLength: 20_000 }),
    rule_key: Type.Optional(Type.String({ minLength: 1 })), source_record_ids: Type.Optional(Ids),
    supersede_record_ids: Type.Optional(Ids), supersession_reason: Type.Optional(Type.String({ minLength: 1 }))
  }, { additionalProperties: false })
  pi.registerTool({
    name: 'memory_save', label: '审批并保存工作日记', exposure: 'model-only', executionMode: 'sequential',
    description: '仅在用户明确要求保存日记时，传入具体完整候选。按 memory Skill 先核实事实与现行规则。工具生成短期计划、完整展示并等待真实用户批准后才提交；取消/变化/无交互不提交。会写计划技术缓存，可清理过期计划；不是只读操作。不接受 approved 或外部 plan_id。',
    parameters: Type.Object({ project_id: ProjectId, records: Type.Array(RecordSchema, { minItems: 1, maxItems: 50 }) }, { additionalProperties: false }),
    outputSchema: Output, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async execute(_id, params, signal, _onUpdate, ctx) {
      keys(params, ['project_id', 'records'])
      // 固化候选，后续交互不复用可被另一处理器修改的参数引用。
      const candidate = object(JSON.parse(JSON.stringify(params)))
      return save(ctx, signal, 'save', async (_lease, identity) => {
        const { id } = await runtime.requireProject(identity, candidate.project_id as string | undefined)
        const records = array(candidate.records).map(value => {
          const row = object(value)
          keys(row, ['type', 'topic', 'content', 'rule_key', 'source_record_ids', 'supersede_record_ids', 'supersession_reason'])
          return row
        })
        return { project_id: id, agent: ctx.mode === 'tui' ? 'pi' : 'pi-desk',
          session_id: diarySessionId(ctx.sessionManager.getSessionId(), id), records }
      })
    }
  })
  pi.registerTool({
    name: 'memory_profile_save', label: '审批并保存个人画像', exposure: 'model-only', executionMode: 'sequential',
    description: '仅在用户明确要求维护画像/长期偏好时使用，不因保存日记或一次行为顺带更新。先读取相关画像，再提供完整正文、依据、作用域及替换 ID。生成具体计划、展示全部新旧内容后由真实用户批准；不接受模型批准标志。',
    parameters: Type.Object({ domain: DomainSchema, scope: Type.String({ pattern: '^(global|(?:domain|project):[a-z0-9-]+)$' }),
      basis: Type.Union([Type.Literal('explicit'), Type.Literal('inferred_confirmed')]),
      title: Type.String({ minLength: 1, maxLength: 200 }), content: Type.String({ minLength: 1, maxLength: 20_000 }),
      source_record_ids: Type.Optional(Ids), replace_profile_ids: Type.Optional(Type.Array(Type.String({ pattern: '^p_[0-9A-HJKMNP-TV-Z]{26}$' }), { maxItems: 50 }))
    }, { additionalProperties: false }),
    outputSchema: Output, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async execute(_id, params, signal, _onUpdate, ctx) {
      keys(params, ['domain', 'scope', 'basis', 'title', 'content', 'source_record_ids', 'replace_profile_ids'])
      const candidate = object(JSON.parse(JSON.stringify(params)))
      return save(ctx, signal, 'profile', async (_lease, identity) => {
        domain(candidate.domain)
        const scope = text(candidate.scope)
        if (scope.startsWith('project:')) await runtime.requireProject(identity, scope.slice('project:'.length))
        return candidate
      })
    }
  })
}
