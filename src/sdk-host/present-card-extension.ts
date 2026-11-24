/**
 * 会话内卡片工具：模型提交一份结构化卡片载荷，由渲染层按随包枚举渲染固定外壳。
 *
 * 模型只能选卡片类型与动作白名单里的 ID，不能描述布局、样式或可执行内容；载荷在这里先过
 * 一遍共享契约的解析器，形状或枚举不符就直接拒绝，不产出半成品卡片。工具只负责递交，
 * 不写盘也不改清单——按钮的落点由渲染层转发到既有业务通道（如 `desktop:expert-save`）。
 * 更新模式只带目标标识：定义本体由页面按既有读通道回填，模型给的是建议修改后的内容，
 * 所以更新模式下简介与正文可缺省，缺省字段由页面按当前定义补齐。
 *
 * 交给模型的只有一句结论，正文与字段只放进 `details.card` 供界面展示，
 * 因此长正文不会在上下文里重复出现（边界见 docs/modules/sessions-chat.md）。
 *
 * 快速模式整组下线记忆工具，本工具也随之拒绝 memory.candidates：卡片按钮写记忆走的是
 * 主进程通道，放开它等于给模式裁剪留出第二条写入路径。
 */
import { Type } from '@earendil-works/pi-ai'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { MAX_EXPERT_WRITE_SCOPE_ENTRY, MAX_EXPERT_WRITE_SCOPE_ITEMS } from '../shared/experts-api'
import { MEMORY_RECORD_TYPES } from '../shared/memory-api'
import {
  PRESENT_CARD_ACTIONS, PRESENT_CARD_LIMITS, parsePresentCardView
} from '../shared/present-card-view'
import type { PresentCardActionId, PresentCardType, PresentCardView } from '../shared/present-card-view'
import type { MemorySaveCandidate } from '../shared/memory-api'
import type { ExecutionMode } from '../shared/preferences-api'

const TOOL_NAME = 'present_card'

/** 引擎引用名单的参数形状：真实记录 ID，一次最多 50 条。 */
/** 记录标识的形状；候选来源与替代目标共用同一份，避免两处正则漂移。 */
const RECORD_ID_PATTERN = '^m_[0-9A-HJKMNP-TV-Z]{26}$'
const CANDIDATE_IDS = Type.Array(Type.String({ pattern: RECORD_ID_PATTERN }), { maxItems: 50 })

/** 可选记录 ID 列表：`Type.Optional` 只接受一个参数，描述必须写在数组 schema 上。 */
function optionalCandidateIds(description: string) {
  return Type.Optional(Type.Array(Type.String({ pattern: RECORD_ID_PATTERN }), { maxItems: 50, description }))
}

/** 一次工具调用的参数形状；与注册时给模型的 schema 一一对应。 */
interface CardParams {
  readonly card_type: PresentCardType
  readonly title: string
  readonly subtitle?: string
  readonly fields?: readonly { readonly label: string; readonly value: string }[]
  readonly body?: string
  /** 技能范围：模式 + 建议勾选名单；省略时按继承默认基线处理。 */
  readonly skills_mode?: 'inherit' | 'only'
  readonly skill_ids?: readonly string[]
  /** MCP 范围：同上。 */
  readonly mcp_mode?: 'inherit' | 'only'
  readonly mcp_server_ids?: readonly string[]
  /** 工具范围：同上；受保护工具不会被排除，名单里有没有都一样。 */
  readonly tools_mode?: 'inherit' | 'only'
  readonly tool_ids?: readonly string[]
  /** 写入范围：项目内相对路径，目录以 `/` 结尾；省略时保存为只读。更新模式下页面按当前定义回填，此项不参与更新。 */
  readonly write_scope?: readonly string[]
  /** 更新模式的目标专家：给了即更新该专家的定义而不是新建；内置专家写成同标识的覆盖定义。 */
  readonly expert_id?: string
  /** 团队草案的团长：专家候选段里的标识；更新团队时由 team_id 携带目标，团长仍必填。 */
  readonly lead_expert_id?: string
  /** 团队草案的成员：专家候选段里的标识，至少一名，不得包含团长。 */
  readonly member_expert_ids?: readonly string[]
  /** 更新模式的目标团队：给了即更新该自定义团队而不是新建；内置团队只读，页面会拒绝。 */
  readonly team_id?: string
  /** 交付汇总文件段：三组项目内相对路径；只用于 session.summary，其余类型带这些参数直接拒绝。 */
  readonly changed_files?: readonly string[]
  readonly deleted_files?: readonly string[]
  readonly affected_files?: readonly string[]
  /** 记忆候选段：待保存候选清单；只用于 memory.candidates，用户会勾选并编辑后再保存。 */
  readonly candidates?: readonly MemorySaveCandidate[]
  readonly primary_action_id: PresentCardActionId
  readonly primary_action_label: string
  readonly secondary_action_id?: PresentCardActionId
  readonly secondary_action_label?: string
}

/**
 * 由参数组装卡片并复用共享解析器校验；返回字符串表示拒绝原因。
 * 草案类型额外要求简介与正文：新建的「专家定义」缺任一项在主进程保存时也会被拒，提前拦下更省一轮往返；
 * 更新模式（带 `expert_id`）缺省的字段由页面按当前定义回填，因此放行缺省。
 * 交付汇总要求至少一个文件且按钮只允许复制：它是只读卡片，没有写入落点可绑定。
 * 记忆候选要求至少一条候选且主按钮只能保存：写入记忆库是它的唯一落点，用户在卡片上勾选并编辑后才提交。
 * 团队草案要求团长与成员齐全：成员为空或包含团长的团队开不了团，主进程保存时同样会拒。
 */
function buildCard(params: CardParams, mode: ExecutionMode): PresentCardView | string {
  const subtitle = params.subtitle?.trim() === '' ? undefined : params.subtitle
  const body = params.body?.trim() === '' ? undefined : params.body
  const fileParamsGiven = params.changed_files !== undefined || params.deleted_files !== undefined
    || params.affected_files !== undefined
  // 快速模式不写记忆：记忆工具已整组下线，卡片按钮不能再当成绕过裁剪的写入路径。
  if (params.card_type === 'memory.candidates' && mode === 'fast') {
    return '快速模式不写记忆：记忆工具整组下线，候选卡片同样被拒。需要保存时先切到标准模式，或直接用文本说明。'
  }
  // 更新目标互斥且必须挂在对应类型上：一张卡片只落一个业务通道，挂错类型等于让页面猜落点。
  if (params.expert_id !== undefined && params.team_id !== undefined) {
    return 'expert_id 与 team_id 不能同时给：一张卡片要么更新专家，要么更新团队。'
  }
  if (params.expert_id !== undefined && params.card_type !== 'expert.draft') {
    return 'expert_id 只用于 expert.draft（专家草案）卡片；其他类型没有专家更新落点。'
  }
  if (params.team_id !== undefined && params.card_type !== 'team.draft') {
    return 'team_id 只用于 team.draft（团队草案）卡片；其他类型没有团队更新落点。'
  }
  const teamParamsGiven = params.lead_expert_id !== undefined || params.member_expert_ids !== undefined
  if (teamParamsGiven && params.card_type !== 'team.draft') {
    return '团长与成员名单只用于 team.draft（团队草案）卡片；其他类型不引用专家标识。'
  }
  if (params.card_type === 'expert.draft') {
    if (fileParamsGiven) return '文件清单参数只用于 session.summary（交付汇总）卡片；专家草案不带文件段。'
    // 更新模式缺省简介或正文时由页面按当前定义回填；新建仍要求两样齐全。
    const updating = params.expert_id !== undefined
    if (subtitle === undefined && !updating) return '草案卡片需要 subtitle（一句话简介）。'
    if (body === undefined && !updating) return '草案卡片需要 body（正文）。'
    // 仅用选中却一个技能都不留，等于把专家退化成只会说话的角色，主进程保存时也会拒。
    if (params.skills_mode === 'only' && (params.skill_ids ?? []).length === 0) {
      return '技能选择「仅用选中」时至少要留一个技能；要继承默认基线就去掉 skills_mode。'
    }
  }
  if (params.card_type === 'team.draft') {
    if (fileParamsGiven) return '文件清单参数只用于 session.summary（交付汇总）卡片；团队草案不带文件段。'
    // 团队不声明能力范围：能力取自成员各自的专家定义，这些参数带上也不会生效，拒绝比静默忽略更早指因。
    if (params.skills_mode !== undefined || params.mcp_mode !== undefined || params.tools_mode !== undefined
      || params.skill_ids !== undefined || params.mcp_server_ids !== undefined || params.tool_ids !== undefined
      || params.write_scope !== undefined) {
      return '团队草案不声明能力范围（能力取自成员各自的专家定义）；能力范围参数只用于 expert.draft（专家草案）。'
    }
    if (subtitle === undefined) return '团队草案需要 subtitle（一句话简介）。'
    if (params.lead_expert_id === undefined) return '团队草案需要 lead_expert_id（团长，取专家候选段里的标识）。'
    if ((params.member_expert_ids ?? []).length === 0) return '团队草案需要 member_expert_ids（成员，至少一名）。'
    if ((params.member_expert_ids ?? []).includes(params.lead_expert_id)) {
      return '团长不能同时出现在成员名单：团长不生产，开团后它只验收与派活；从成员里去掉它。'
    }
    if (params.primary_action_id !== 'team.save'
      || (params.secondary_action_id !== undefined && params.secondary_action_id !== 'copy.text')) {
      return '团队草案卡片的主按钮只能是保存（team.save），次按钮只能是复制（copy.text）。'
    }
  }
  if (params.card_type === 'session.summary') {
    const fileCount = (params.changed_files ?? []).length + (params.deleted_files ?? []).length
      + (params.affected_files ?? []).length
    if (fileCount === 0) return '交付汇总卡片至少要给一个文件；没有文件产出时不要用卡片，直接用文本说明。'
    if (params.primary_action_id !== 'copy.text'
      || (params.secondary_action_id !== undefined && params.secondary_action_id !== 'copy.text')) {
      return '交付汇总卡片是只读的，主次按钮只能用 copy.text。'
    }
  }
  if (params.card_type === 'memory.candidates') {
    if ((params.candidates ?? []).length === 0) {
      return '记忆候选卡片至少要给一条候选；没有值得保存的内容时不要用卡片，直接用文本说明。'
    }
    if (params.primary_action_id !== 'memory.save'
      || (params.secondary_action_id !== undefined && params.secondary_action_id !== 'copy.text')) {
      return '记忆候选卡片的主按钮只能是保存（memory.save），次按钮只能是复制（copy.text）。'
    }
  } else if (params.candidates !== undefined) {
    return '候选清单参数只用于 memory.candidates（记忆候选）卡片。'
  }
  if (params.secondary_action_id !== undefined && params.secondary_action_label === undefined) {
    return '给了次要动作 ID 时也要给次要动作文案。'
  }
  const candidate = {
    cardType: params.card_type,
    title: params.title,
    subtitle: subtitle ?? null,
    fields: params.fields ?? [],
    body: body ?? null,
    capability: params.skills_mode === undefined && params.mcp_mode === undefined && params.tools_mode === undefined
      && params.write_scope === undefined
      ? null
      : {
          skillsMode: params.skills_mode ?? 'inherit',
          skillIds: params.skill_ids ?? [],
          mcpMode: params.mcp_mode ?? 'inherit',
          mcpServerIds: params.mcp_server_ids ?? [],
          toolsMode: params.tools_mode ?? 'inherit',
          toolIds: params.tool_ids ?? [],
          writeScope: params.write_scope ?? []
        },
    files: params.changed_files === undefined && params.deleted_files === undefined && params.affected_files === undefined
      ? null
      : {
          changed: params.changed_files ?? [],
          deleted: params.deleted_files ?? [],
          affected: params.affected_files ?? []
        },
    candidates: params.candidates === undefined ? null : params.candidates,
    team: params.lead_expert_id === undefined
      ? null
      : {
          leadExpertId: params.lead_expert_id,
          memberExpertIds: params.member_expert_ids ?? []
        },
    targetExpertId: params.expert_id ?? null,
    targetTeamId: params.team_id ?? null,
    primaryAction: { id: params.primary_action_id, label: params.primary_action_label },
    secondaryAction: params.secondary_action_id === undefined
      ? null
      : {
          id: params.secondary_action_id,
          label: params.secondary_action_label ?? ''
        }
  }
  const parsed = parsePresentCardView(candidate)
  if (parsed === null) {
    return '载荷不符合卡片契约：检查类型与动作 ID 是否在枚举内、主次动作是否重复、文件路径写法与候选条目是否合规，以及各字段是否超长。'
  }
  return parsed
}

/** 工具结果：文本只给一句结论，卡片数据只走 `details.card`。 */
function result(text: string, card: PresentCardView | null): {
  content: Array<{ type: 'text'; text: string }>
  details: { card: PresentCardView | null }
} {
  return { content: [{ type: 'text', text }], details: { card } }
}

/**
 * 卡片工具工厂：无外部依赖，装配时直接注册。
 *
 * `capabilityCandidates` 与 `expertCandidates` 由会话装配按与设置页同源的口径生成
 * （见 `expert-capability.ts`）：模型自己可见的技能已被专家许可集裁剪，不可见不等于不存在，
 * 候选全集必须随工具一起给它；专家标识是主进程分配的，团队引用与更新定位同样靠注入的候选段。
 * `mode` 只用于记忆候选的类型级门控，其余三类卡片与执行模式无关。
 */
export function createPresentCardExtension(
  capabilityCandidates: string, expertCandidates: string, mode: ExecutionMode
): ExtensionFactory {
  return pi => {
    pi.registerTool({
      name: TOOL_NAME,
      label: '会话内卡片',
      description: '把需要用户点一下才落地或需要一键操作的成果做成一张固定外壳卡片：只提交卡片类型、纯文本字段与动作 ID，界面按随包枚举渲染，不接受布局与样式描述。'
        + '卡片上的按钮由产品已登记的动作执行：专家定义草案保存或更新专家定义（内置专家保存为覆盖定义），团队草案保存或更新自定义团队，交付汇总是只读文件清单（复制与逐行定位），记忆候选由用户勾选并编辑后写入记忆库。',
      promptSnippet: '把成果做成带按钮的卡片（保存、复制或定位）',
      promptGuidelines: [
        '只在成果需要用户点一下才落地或需要一键操作时使用（专家定义草案、团队草案、会话交付汇总、记忆候选）：普通说明、进度汇报与追问继续用文本。',
        'card_type 目前有 expert.draft（专家定义草案）、team.draft（团队草案）、session.summary（会话交付汇总）与 memory.candidates（记忆候选）。专家草案必须有 title、subtitle 与 body；fields 只放需要展示的说明行，不放正文。',
        '更新已有专家时仍在 expert.draft 里带 expert_id（取专家候选段里的标识）：卡片会回填当前定义，你只给要改的字段，缺省的 subtitle／body 由回填补齐；内置专家也可以作为更新目标——保存会生成一份同标识的覆盖定义，随包文件不变，用户要退回内置版本时提示他在设置页点「恢复默认」。新建时不要带 expert_id。',
        'team.draft 用在用户要把几位专家组成一个团时：title 为团队显示名称、subtitle 为一句话简介、body 为协作约定正文（不进入系统提示，只供查看与编辑）；lead_expert_id 与 member_expert_ids 只能引用专家候选段里的标识，成员至少一名且不得包含团长——团长不生产，开团后只验收与派活；更新团队带 team_id，主按钮只能 team.save。',
        expertCandidates,
        'session.summary 用在一轮有文件产出之后：changed_files／deleted_files／affected_files 只给项目内相对路径（用 / 分隔，不用绝对路径，不写目录），三组至少一个文件；删除的文件照实提交，定位时会提示已不存在。',
        '交付汇总卡片是只读的：主次按钮只能用 copy.text；文件三组合计上限 40 条，超限整张卡片会被拒绝而不是截断。',
        'memory.candidates 用在本轮产出了值得长期保留的结论、约束或未决状态时——用户要求保存记忆时它就是默认落点：先给候选卡片让用户在卡片上勾选与编辑，只有用户已在本轮逐条给定要存的内容、没有挑选空间时才直接用 memory_save。用户明确认可的非显然做法与取舍同样要给候选，只存纠正会让后续越来越保守，认可的理由写进 content：candidates 每条给 type、topic（单行标题）与 content，规则类（decision／constraint）必须带 rule_key，progress 必须显式 status（active 只表示仍待推进的未决状态）。用户会直接编辑候选再保存，按最终入库口径写，不要放过程流水。',
        '不要先用 memory_save 保存同一批内容再发候选卡片：与库内完全重复的候选会被引擎拒绝，部分重复会被跳过；需要用户确认或可能想改时用卡片，用户已在指令里逐条给定内容的才直接保存。',
        ...(mode === 'fast'
          ? ['本轮是快速模式：记忆工具整组下线，memory.candidates 卡片会被拒绝；需要保存记忆时说明要先切到标准模式。']
          : []),
        '技能、MCP 与工具范围由你给出建议：skills_mode／mcp_mode／tools_mode 省略即继承默认基线，对应名单是建议启用的项；收窄时说明理由。',
        capabilityCandidates,
        '只能引用当前候选里存在的技能，不得引用 sub-agent- 开头的子代理专用技能；仅用选中时技能名单不能为空。',
        '工具范围里技能门禁、待办清单与记忆工具属于必需项，不得建议排除；要授予委派能力就勾上 delegate_subagent。',
        '动作只能取白名单 ID：expert.save 保存或更新专家定义（内置专家保存为覆盖定义），team.save 保存或更新自定义团队，copy.text 复制正文到剪贴板，memory.save 写入勾选的记忆候选；不要按文案自行发明动作，也不要声称按钮会执行未登记的操作。',
        'body 不进入工具结果文本，长正文不受上下文成本影响，但仍受长度上限约束；超过上限整张卡片会被拒绝而不是截断。',
        '不要用它提交代码、命令、凭据或链接：卡片只承载纯文本与已登记动作。',
        '卡片放出去后等用户点击即可，不要再把同一份正文重复输出成对话文本。'
      ],
      exposure: 'model-only',
      parameters: Type.Object({
        card_type: Type.Union([
          Type.Literal('expert.draft', { description: '专家定义草案：保存为自定义专家；带 expert_id 即更新' }),
          Type.Literal('team.draft', { description: '团队草案：保存为自定义团队；带 team_id 即更新' }),
          Type.Literal('session.summary', { description: '会话交付汇总：只读文件清单，按钮只能复制' }),
          Type.Literal('memory.candidates', { description: '记忆候选：用户勾选并编辑后写入记忆库' })
        ], { description: '卡片类型；类型即场景契约，按成果选择' }),
        title: Type.String({ minLength: 1, maxLength: PRESENT_CARD_LIMITS.title,
          description: '卡片标题；expert.draft 下即专家显示名称，team.draft 下即团队显示名称' }),
        subtitle: Type.Optional(Type.String({ maxLength: PRESENT_CARD_LIMITS.subtitle,
          description: '一句话说明；专家草案下即专家简介（必填），团队草案下即团队简介（必填），更新模式下缺省由页面回填' })),
        fields: Type.Optional(Type.Array(Type.Object({
          label: Type.String({ minLength: 1, maxLength: PRESENT_CARD_LIMITS.fieldLabel }),
          value: Type.String({ maxLength: PRESENT_CARD_LIMITS.fieldValue })
        }), { maxItems: PRESENT_CARD_LIMITS.fields, description: '字段行，只放说明，不放正文' })),
        body: Type.Optional(Type.String({ maxLength: PRESENT_CARD_LIMITS.body,
          description: '卡片正文；expert.draft 下即专家定义正文，team.draft 下即协作约定正文（不进系统提示）；新建的专家草案必填，更新模式与团队草案缺省时由页面回填或留空' })),
        skills_mode: Type.Optional(Type.Union([Type.Literal('inherit'), Type.Literal('only')],
          { description: '技能范围口径：inherit=继承默认基线后加减，only=名单即白名单；省略按继承处理' })),
        skill_ids: Type.Optional(Type.Array(Type.String({ maxLength: 64 }),
          { maxItems: PRESENT_CARD_LIMITS.capabilityIds, description: '建议启用的技能标识；只能取能力候选段里列出的技能' })),
        mcp_mode: Type.Optional(Type.Union([Type.Literal('inherit'), Type.Literal('only')],
          { description: 'MCP 范围口径，同上；省略按继承处理' })),
        mcp_server_ids: Type.Optional(Type.Array(Type.String({ maxLength: 64 }),
          { maxItems: PRESENT_CARD_LIMITS.capabilityIds, description: '建议启用的 MCP 服务器名；只能取能力候选段里列出的服务器' })),
        tools_mode: Type.Optional(Type.Union([Type.Literal('inherit'), Type.Literal('only')],
          { description: '工具范围口径，同上；省略按继承处理' })),
        tool_ids: Type.Optional(Type.Array(Type.String({ maxLength: 64 }),
          { maxItems: PRESENT_CARD_LIMITS.capabilityIds,
            description: '建议启用的工具名；只能取能力候选段里列出的工具，带 * 的必需项不写也在范围内' })),
        write_scope: Type.Optional(Type.Array(Type.String({ maxLength: MAX_EXPERT_WRITE_SCOPE_ENTRY }),
          { maxItems: PRESENT_CARD_LIMITS.writeScopeEntries,
            description: `项目内相对路径，目录以 / 结尾，最多 ${MAX_EXPERT_WRITE_SCOPE_ITEMS} 项；`
              + '省略时保存为只读（不许写入）；更新模式下页面按当前定义回填，此项不参与更新。不要写绝对路径、盘符或 ..' })),
        expert_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64,
          description: '更新模式的目标专家标识（取专家候选段）：给了即更新该专家的定义而不是新建，内置专家写成同标识的覆盖定义，缺省的 subtitle／body 由页面回填；仅 expert.draft 使用' })),
        lead_expert_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64,
          description: '团队草案的团长标识（取专家候选段）；仅 team.draft 使用' })),
        member_expert_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }),
          { maxItems: PRESENT_CARD_LIMITS.teamMembers,
            description: '团队草案的成员标识清单（取专家候选段），至少一名且不得包含团长；仅 team.draft 使用' })),
        team_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64,
          description: '更新模式的目标团队标识：给了即更新该自定义团队而不是新建；仅 team.draft 使用' })),
        changed_files: Type.Optional(Type.Array(Type.String({ maxLength: PRESENT_CARD_LIMITS.summaryPath }),
          { maxItems: PRESENT_CARD_LIMITS.summaryFiles,
            description: '本轮改动文件的相对路径；仅 session.summary 使用，`/` 分隔，不用绝对路径' })),
        deleted_files: Type.Optional(Type.Array(Type.String({ maxLength: PRESENT_CARD_LIMITS.summaryPath }),
          { maxItems: PRESENT_CARD_LIMITS.summaryFiles,
            description: '本轮删除文件的相对路径；仅 session.summary 使用，照实提交，定位时会提示已不存在' })),
        affected_files: Type.Optional(Type.Array(Type.String({ maxLength: PRESENT_CARD_LIMITS.summaryPath }),
          { maxItems: PRESENT_CARD_LIMITS.summaryFiles,
            description: '受本轮影响但未直接修改的文件相对路径；仅 session.summary 使用' })),
        candidates: Type.Optional(Type.Array(Type.Object({
          type: Type.Union(MEMORY_RECORD_TYPES.map(value => Type.Literal(value)),
            { description: '记忆类型；decision／constraint 是规则类，须带 rule_key' }),
          topic: Type.String({ minLength: 1, maxLength: 200, description: '候选标题，单行' }),
          content: Type.String({ minLength: 1, maxLength: 20_000, description: '候选正文' }),
          rule_key: Type.Optional(Type.String({ minLength: 1, maxLength: 200,
            description: '规则键；规则类（decision／constraint）必填' })),
          status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('resolved'), Type.Literal('archived')],
            { description: '非规则类状态；progress 必须显式给出' })),
          source_record_ids: optionalCandidateIds('引用的来源记录 ID'),
          supersede_record_ids: optionalCandidateIds('本候选替代的有效规则记录 ID'),
          supersession_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000, description: '替代理由' }))
        }, { additionalProperties: false }),
          { maxItems: PRESENT_CARD_LIMITS.memoryCandidates,
            description: '待保存候选清单；仅 memory.candidates 使用，用户会勾选并编辑后再保存' })),
        primary_action_id: Type.Union(PRESENT_CARD_ACTIONS.map(action => Type.Literal(action)),
          { description: '主按钮动作 ID' }),
        primary_action_label: Type.String({ minLength: 1, maxLength: PRESENT_CARD_LIMITS.actionLabel,
          description: '主按钮文案' }),
        secondary_action_id: Type.Optional(Type.Union(PRESENT_CARD_ACTIONS.map(action => Type.Literal(action)),
          { description: '次按钮动作 ID；省略即没有次按钮' })),
        secondary_action_label: Type.Optional(Type.String({ maxLength: PRESENT_CARD_LIMITS.actionLabel,
          description: '次按钮文案；给了次按钮动作 ID 时必填' }))
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const card = buildCard(params, mode)
        if (typeof card === 'string') return result(`卡片未生成：${card}`, null)
        return result(`已在对话中放置卡片「${card.title}」；等用户点击卡片上的按钮，不要重复输出卡片正文。`, card)
      }
    })
  }
}
