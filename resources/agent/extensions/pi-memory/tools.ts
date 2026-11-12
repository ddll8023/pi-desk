/** 按需检索与受控保存工具；Memory Skill 决定何时用记忆，主动定向读取自动记独立统计，权威内容保存经写入闸门后直接提交。 */
import { createHash } from 'node:crypto'
import { Type } from '@earendil-works/pi-ai'
import type { JsonValue } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { CONTROL_TYPE, applicableProfiles, resolveProjectTarget } from './context.ts'
import type { Lease, MemoryRuntime } from './context.ts'
import { DOMAINS, array, domain, errorText, object, text } from './engine.ts'
import type { GeneratedPlan, JsonObject } from './engine.ts'
import { assertWritableHost } from './write-gate.ts'

const DomainSchema = Type.Union(DOMAINS.map(value => Type.Literal(value)))
const Ids = Type.Array(Type.String({ pattern: '^m_[0-9A-HJKMNP-TV-Z]{26}$' }), { maxItems: 50 })
const Offset = Type.Optional(Type.Integer({ minimum: 0 }))
const Limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 200 }))
const Output = Type.Object({ ok: Type.Literal(true), data: Type.Unknown(), error: Type.Null() })
const ReadHints = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const ACCESS_NOTE = '自动技术统计仅表示主动定向读取结果已准备，不代表模型已接收、理解或采纳；不参与检索排序。'
/** 检索范围：默认全库；非全库档在引擎侧总连同无归属的通用记录一起返回。 */
const Scope = Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('current-project'), Type.Literal('project')]))
const ProjectArg = Type.Optional(Type.String({ minLength: 1, maxLength: 200 }))

/**
 * 解析本次检索的项目范围：`all` 返回 null（全库），其他档返回注册表内唯一匹配的项目。
 * 未登记、重名、条件矛盾或注册表不可读都直接报错，不静默降级成全库。
 */
function projectScope(runtime: MemoryRuntime, cwd: string, scope: string | undefined, project: string | undefined):
{ id: string; name: string } | null {
  const selected = scope ?? 'all'
  if (selected !== 'current-project' && selected !== 'project') {
    if (project !== undefined) throw new Error('scope 不是 project 时不接受 project 参数，未扩大检索范围')
    return null
  }
  if (runtime.config.projectsUnavailable) throw new Error('项目注册表不可读，无法按项目收窄检索；去掉 scope 可按全库检索')
  if (selected === 'current-project') {
    if (project !== undefined) throw new Error('scope=current-project 不接受 project 参数')
    const id = runtime.projectId(cwd)
    if (id === null) throw new Error('当前工作目录未登记为项目，无法按当前项目收窄；可改用 scope=project 并指定项目名')
    const target = resolveProjectTarget(runtime.config.projects, id)
    if (target === null) throw new Error('当前项目不在项目注册表内，未按项目收窄')
    return target
  }
  if (project === undefined || project.trim() === '') throw new Error('scope=project 必须同时给出 project（项目名称或 ID）')
  const target = resolveProjectTarget(runtime.config.projects, project)
  if (target !== null) return target
  const names = runtime.config.projects.map(item => item.name).slice(0, 20)
  throw new Error(`未找到唯一匹配的项目「${project}」；可选：${names.join('、') || '（注册表为空）'}。重名时请改用项目 ID`)
}

/** 引擎回显的项目范围必须与请求一致，否则不展示已经越界的结果。 */
function assertScoped(data: JsonObject, project: { id: string; name: string } | null): void {
  const returned = data.project === undefined || data.project === null ? null : text(data.project, '项目范围')
  if (returned !== (project?.id ?? null)) throw new Error('检索返回的项目范围与请求不一致，未展示')
}

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
function diarySessionId(sessionId: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let value = BigInt(`0x${createHash('sha256').update(`pi-memory.global\0${sessionId}`).digest('hex').slice(0, 32)}`)
  let encoded = ''
  for (let index = 0; index < 26; index++) { encoded = alphabet[Number(value & 31n)] + encoded; value >>= 5n }
  return `s_${encoded}`
}
/** 回执只列本次提交的内容摘要；记录 ID 以提交返回的 new_record_ids 为准。 */
function receipt(operation: 'save' | 'profile', plan: GeneratedPlan): JsonObject {
  const preview = plan.preview
  if (operation === 'profile') {
    return { profile: preview.new_profile ?? null, replace_profile_ids: preview.replace_profile_ids ?? null }
  }
  const records = Array.isArray(preview.new_records) ? preview.new_records : []
  return { date: preview.date ?? null,
    records: records.map(value => {
      const row = object(value)
      return { type: row.type ?? null, topic: row.topic ?? null, rule_key: row.rule_key ?? null }
    }) }
}

export function registerMemoryTools(pi: ExtensionAPI, runtime: MemoryRuntime): void {
  // 全局检索不探测项目目录；停用、取消和会话换代仍使用同一租约边界。
  const globalRead = async (ctx: ExtensionToolContext, signal: AbortSignal | undefined,
    work: (lease: Lease) => Promise<JsonObject>) => {
    const lease = runtime.lease(ctx, signal)
    const data = await work(lease)
    lease.assert()
    return result(data)
  }
  /** 控制与状态在停用、全局关闭或受管环境不可用时仍可读，以便说明真实原因。 */
  const controlRead = async (ctx: ExtensionToolContext, signal: AbortSignal | undefined,
    work: (lease: Lease) => Promise<JsonObject>) => {
    const lease = runtime.lease(ctx, signal, true)
    const data = await work(lease)
    lease.assert()
    return result(data)
  }
  const save = async (ctx: ExtensionToolContext, signal: AbortSignal | undefined, operation: 'save' | 'profile',
    prepare: (lease: Lease) => Promise<JsonObject>) => {
    // 无可用交互桥时，连计划技术缓存也不生成。
    assertWritableHost(ctx)
    const lease = runtime.lease(ctx, signal)
    const finishSave = runtime.beginSave(lease)
    try {
      const input = await prepare(lease)
      lease.assert()
      const leaf = ctx.sessionManager.getLeafId()
      const stillCurrent = (): void => {
        lease.assert()
        if (ctx.sessionManager.getLeafId() !== leaf) throw new Error('生成计划期间当前分支已改变，未提交')
        assertWritableHost(ctx)
      }
      const plan = await runtime.engine.plan(operation, input, lease.signal)
      stillCurrent()
      // 用户已明确要求保存，计划生成后直接提交；取消与分支变化仍使本次写入失效。
      if (lease.signal.aborted) throw new Error('保存已取消，未提交权威记忆')
      const data = await runtime.engine.commit(plan, stillCurrent)
      // commit 一旦开始不强杀；如在提交期间换代，返回真实结果而不是宣称撤销。
      return result({ ...data, committed: true, plan_id: plan.id, receipt: receipt(operation, plan),
        source_pi_session_id: lease.state.sessionId, source_cwd: lease.state.cwd,
        note: '仅此具体计划已提交；没有其他文件沙箱或跨域事务保证' })
    } finally { finishSave() }
  }

  pi.registerTool({
    name: 'memory_status', label: '读取记忆库状态',
    description: '读取用户级全局记忆库、受管运行时、启停与可用状态；不初始化、不重建词项或迁移。运行环境不可用时也返回真实原因。',
    parameters: Type.Object({}), outputSchema: Output, annotations: ReadHints,
    async execute(_id, _params, signal, _onUpdate, ctx) {
      return controlRead(ctx, signal, async lease => {
        let store: JsonObject
        try { store = await runtime.engine.status(lease.signal) }
        catch (error) { store = { status: 'unavailable', error: errorText(error) } }
        return { memory_scope: 'global', runtime: runtime.status(ctx), store }
      })
    }
  })
  pi.registerTool({
    name: 'memory_control', label: '控制记忆召回', exposure: 'model-only', executionMode: 'sequential',
    description: '遵从用户要求停用、恢复或刷新记忆。off/on 只记录当前分支控制选项，不保存记忆正文或写入授权；refresh 使旧缓存和待提交计划失效。',
    parameters: Type.Object({ action: Type.Union([Type.Literal('off'), Type.Literal('on'), Type.Literal('refresh')]) }, { additionalProperties: false }),
    outputSchema: Output, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return result(runtime.control(ctx, params.action, data => pi.appendEntry(CONTROL_TYPE, data)))
    }
  })
  pi.registerTool({
    name: 'memory_profiles', label: '按领域读取适用画像',
    description: '按领域读取全局或领域适用的画像及来源，支持分页。历史项目画像不自动升格为全局偏好；current_profile 不代表事实已核实。',
    parameters: Type.Object({ domain: DomainSchema, offset: Offset, limit: Limit }, { additionalProperties: false }),
    outputSchema: Output, annotations: ReadHints,
    async execute(_id, params, signal, _onUpdate, ctx) {
      return globalRead(ctx, signal, async lease => {
        const selected = domain(params.domain)
        const data = applicableProfiles(await runtime.engine.profiles(selected, lease.signal), selected,
          [...new Set([...runtime.config.profileDomains, selected])])
        const profiles = array(data.profiles)
        const [offset, limit] = boundedPage(params.offset, params.limit)
        return { ...data, store: runtime.engine.store, total_profiles: profiles.length, offset,
          profiles: profiles.slice(offset, offset + limit), has_more: offset + limit < profiles.length,
          next_offset: offset + limit < profiles.length ? offset + limit : null }
      })
    }
  })
  pi.registerTool({
    name: 'memory_rules', label: '读取当前有效规则',
    description: '起草或修改文档、清单、索引、规范，或调整既有约定、判断某项要求是否仍然有效时先查询。读取用户级全局库当前有效决定和约束，支持按 rule_key 主题查询与分页。默认检索全库；scope 可收窄到当前项目或指定项目，收窄时仍包含无项目归属的通用约定。历史来源与适用条件不变；摘要需 memory_read 读取全文，不自动重建词项。',
    parameters: Type.Object({ query: Type.Optional(Type.String()), offset: Offset, limit: Limit,
      scope: Scope, project: ProjectArg }, { additionalProperties: false }),
    outputSchema: Output, annotations: ReadHints,
    async execute(_id, params, signal, _onUpdate, ctx) {
      return globalRead(ctx, signal, async lease => {
        const [offset, limit] = boundedPage(params.offset, params.limit)
        const target = projectScope(runtime, lease.state.cwd, params.scope, params.project)
        const data = await runtime.engine.rules(params.query ?? '', offset, limit, target?.id ?? null, lease.signal)
        if (data.memory_scope !== 'global') throw new Error('规则返回的检索范围不一致，未展示')
        assertScoped(data, target)
        return { ...data, requested_scope: { memory_scope: 'global', scope: params.scope ?? 'all', project: target },
          rules: array(data.rules).map(value => {
          const row = object(value)
          if (row.status !== 'active') {
            throw new Error('规则生命周期无效，未展示')
          }
          return { ...row, status_basis: '仅投影当前有效版本；不证明事实已核实或适用于当前任务',
            source: { store: runtime.engine.store, command: 'rules', date: row.date,
              source_project: row.source_project ?? row.project_id ?? null, id: row.id } }
        }) }
      })
    }
  })
  pi.registerTool({
    name: 'memory_search', label: '按任务检索全局记忆',
    description: '开始新任务、需沿用先前决定或偏好、或同一错误反复出现时先检索。从用户级全局库按任务关键词查询日记。默认 mode=auto 按时间分层：近窗口内的日记参与检索，更早的月份优先用月摘要代表，缺摘要时回退该月最多两条日记；每条结果带 layer，返回体带 missing_summaries 列出尚未归档的月份。records 才是全历史检索。scope 可收窄到当前项目或指定项目，收窄时仍包含无项目归属的通用约定。recent 限近期日记，historical/month 查询月摘要。支持分页；摘要需 memory_read 读取全文，不自动重建词项或扩大明确时间范围。',
    parameters: Type.Object({ query: Type.String({ minLength: 1 }),
      mode: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('records'), Type.Literal('recent'), Type.Literal('historical'), Type.Literal('month')])),
      month: Type.Optional(Type.String({ pattern: '^\\d{4}-(0[1-9]|1[0-2])$' })), offset: Offset, limit: Limit,
      scope: Scope, project: ProjectArg }, { additionalProperties: false }),
    outputSchema: Output, annotations: ReadHints,
    async execute(_id, params, signal, _onUpdate, ctx) {
      return globalRead(ctx, signal, async lease => {
        const [offset, limit] = boundedPage(params.offset, params.limit)
        const mode = params.mode ?? 'auto'
        const target = projectScope(runtime, lease.state.cwd, params.scope, params.project)
        const data = await runtime.engine.search(params.query, mode, params.month, offset, limit, target?.id ?? null, lease.signal)
        if (data.memory_scope !== 'global' || data.mode !== mode) throw new Error('搜索返回的范围不一致，未展示')
        assertScoped(data, target)
        const summaryOnly = mode === 'historical' || mode === 'month'
        const matches = array(data.matches).map(value => {
          const row = object(value)
          const isSummary = row.kind === 'summary'
          // auto 模式会同时命中日记与月摘要，其余模式仍要求单一记录类型。
          if (row.kind !== 'record' && row.kind !== 'summary') throw new Error('搜索返回的记录类型不一致，未展示')
          if (summaryOnly !== isSummary && mode !== 'auto') throw new Error('搜索返回的记录类型不一致，未展示')
          return { ...row, source: { store: runtime.engine.store, command: 'recall', source_project: row.project_id ?? null,
            ...(isSummary ? { month: row.month, source_record_ids: row.source_record_ids } : { id: row.id, date: row.date }) } }
        })
        return { ...data, matches,
          requested_scope: { memory_scope: 'global', mode, month: params.month ?? null, query: params.query,
            scope: params.scope ?? 'all', project: target },
          has_more_matches: data.has_more === true }
      })
    }
  })
  pi.registerTool({
    name: 'memory_read', label: '读取指定日记原文',
    description: '按 1..50 个真实日记 ID 读取全局库原文，保留历史来源、状态和适用条件，不要求项目登记。成功准备结果后默认记录独立访问统计；统计失败仍返回原文及未确认状态，不代表模型实际采纳。',
    parameters: Type.Object({ ids: Type.Array(Type.String({ pattern: '^m_[0-9A-HJKMNP-TV-Z]{26}$' }), { minItems: 1, maxItems: 50 }) }, { additionalProperties: false }),
    outputSchema: Output, annotations: { ...ReadHints, readOnlyHint: false, idempotentHint: false },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const lease = runtime.lease(ctx, signal)
      const data = await runtime.engine.read(params.ids, lease.signal)
      lease.assert()
      if (data.memory_scope !== 'global') throw new Error('原文返回的范围不一致，未展示')
      const values = array(data.records)
      if (values.length !== params.ids.length) throw new Error('原文返回的记录数量不一致，未展示')
      const records = values.map((value, index) => {
        const row = object(value)
        if (row.id !== params.ids[index]) {
          throw new Error('原文身份不一致，未展示')
        }
        return { ...row, status: row.status ?? 'active',
          source: { store: runtime.engine.store, date: row.date, source_project: row.project_id ?? null, id: row.id } }
      })
      const payload = { ...data, records }
      // 先确认完整输出可返回，并预留最坏的统计错误文本；超限或旧租约不产生统计。
      result({ ...payload, access_statistics: { status: 'unconfirmed', new_records: null,
        duplicate_records: null, error: '\u0000'.repeat(1024), note: ACCESS_NOTE } })
      let statistics: JsonObject
      try {
        const version = data.store_version
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) throw new Error('原文来源版本无效')
        const recorded = await runtime.engine.recordAccess(params.ids, lease.state.sessionId, toolCallId, String(version), lease.assert)
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
        const data = await runtime.engine.accessStats(ids, lease.signal)
        const rows = array(data.records)
        if (data.coverage !== 'recorded_accesses_only' || data.automatic !== true || rows.length !== ids.length) {
          throw new Error('访问统计返回的范围或数量不一致，未展示')
        }
        const records = rows.map((value, index) => {
          const row = object(value)
          if (row.id !== ids[index]) throw new Error('访问统计返回的记录身份不一致，未展示')
          return { ...row, source: { store: runtime.engine.store, command: 'access-stats',
            id: row.id, source_project: row.source_project ?? row.project_id ?? null, date: row.date } }
        })
        return { ...data, records }
      })
    }
  })
  const RecordStatus = Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('resolved'), Type.Literal('archived')]))
  const StatusUpdateSchema = Type.Object({
    id: Type.String({ pattern: '^m_[0-9A-HJKMNP-TV-Z]{26}$' }),
    status: Type.Union([Type.Literal('resolved'), Type.Literal('archived')]),
    reason: Type.String({ minLength: 1, maxLength: 2000 })
  }, { additionalProperties: false })
  const RecordSchema = Type.Object({
    type: Type.Union(['decision', 'constraint', 'progress', 'issue', 'fact', 'preference_evidence'].map(value => Type.Literal(value))),
    topic: Type.String({ minLength: 1, maxLength: 200 }), content: Type.String({ minLength: 1, maxLength: 20_000 }),
    status: RecordStatus,
    rule_key: Type.Optional(Type.String({ minLength: 1 })), source_record_ids: Type.Optional(Ids),
    supersede_record_ids: Type.Optional(Ids), supersession_reason: Type.Optional(Type.String({ minLength: 1 }))
  }, { additionalProperties: false })
  pi.registerTool({
    name: 'memory_save', label: '保存工作日记', exposure: 'model-only', executionMode: 'sequential',
    description: '仅在用户明确要求保存日记时，传入具体完整候选。按 memory Skill 先核实事实与现行规则，只保存后续仍会使用的结论、约束与未决状态，历史流水归历史层。工具生成计划后直接提交并返回提交结果与回执，不再逐次等待确认；取消、分支变化或无写入能力宿主不提交。会写计划技术缓存，可清理过期计划；不是只读操作。不接受 approved 或外部 plan_id。',
    parameters: Type.Object({
      records: Type.Array(RecordSchema, { minItems: 0, maxItems: 50 }),
      status_updates: Type.Optional(Type.Array(StatusUpdateSchema, { maxItems: 50 }))
    }, { additionalProperties: false }),
    outputSchema: Output, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async execute(_id, params, signal, _onUpdate, ctx) {
      keys(params, ['records', 'status_updates'])
      // 固化候选，后续交互不复用可被另一处理器修改的参数引用。
      const candidate = object(JSON.parse(JSON.stringify(params)))
      return save(ctx, signal, 'save', async lease => {
        const records = array(candidate.records).map(value => {
          const row = object(value)
          keys(row, ['type', 'topic', 'content', 'status', 'rule_key', 'source_record_ids', 'supersede_record_ids', 'supersession_reason'])
          return row
        })
        const statusUpdates = candidate.status_updates === undefined ? [] : array(candidate.status_updates).map(value => {
          const row = object(value)
          keys(row, ['id', 'status', 'reason'])
          return row
        })
        // 归属由宿主按项目注册表解析；未登记项目或独立 CLI 留空，不根据目录名推测。
        const project = runtime.projectId(lease.state.cwd)
        return { agent: ctx.mode === 'tui' ? 'pi' : 'pi-desk',
          session_id: diarySessionId(ctx.sessionManager.getSessionId()), records, status_updates: statusUpdates,
          ...(project === null ? {} : { project_id: project }) }
      })
    }
  })
  pi.registerTool({
    name: 'memory_profile_save', label: '保存个人画像', exposure: 'model-only', executionMode: 'sequential',
    description: '仅在用户明确要求维护画像/长期偏好时使用，不因保存日记或一次行为顺带更新。先读取相关画像，再提供完整正文、依据、作用域及替换 ID。生成具体计划后直接提交并返回回执；不接受模型批准标志。',
    parameters: Type.Object({ domain: DomainSchema, scope: Type.String({ pattern: '^(global|domain:[a-z0-9-]+)$' }),
      basis: Type.Union([Type.Literal('explicit'), Type.Literal('inferred_confirmed')]),
      title: Type.String({ minLength: 1, maxLength: 200 }), content: Type.String({ minLength: 1, maxLength: 20_000 }),
      source_record_ids: Type.Optional(Ids), replace_profile_ids: Type.Optional(Type.Array(Type.String({ pattern: '^p_[0-9A-HJKMNP-TV-Z]{26}$' }), { maxItems: 50 }))
    }, { additionalProperties: false }),
    outputSchema: Output, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async execute(_id, params, signal, _onUpdate, ctx) {
      keys(params, ['domain', 'scope', 'basis', 'title', 'content', 'source_record_ids', 'replace_profile_ids'])
      const candidate = object(JSON.parse(JSON.stringify(params)))
      return save(ctx, signal, 'profile', async () => {
        domain(candidate.domain)
        const scope = text(candidate.scope)
        if (scope !== 'global' && scope !== `domain:${candidate.domain}`) throw new Error('画像作用域须为 global 或所选领域')
        return candidate
      })
    }
  })
}
