/**
 * 生成式 UI 的工具定义：两个渲染入口（整份交付、局部补丁）、一个按需字段目录与一个查看入口。
 *
 * 边界：只做参数归一化、校验与结果组装，不持有会话内容、不读写文件。`revision` 是唯一的
 * 跨调用状态，它不落盘：每次调用都从当前会话分支上的工具结果重建（见 `session-scan.ts`），
 * 因此 rewind / fork 之后版本语义自然跟着分支走。两个入口产出的 `details.ui` 形状完全一致，
 * 渲染端与投影层不区分工具名。
 *
 * 富载荷放在工具结果的 `details` 里，不进入模型上下文；`content` 只给可读摘要，
 * 保证 TUI、纯文本模式与导出场景都有可用的替代文本。
 *
 * 参数 schema 声明为纯 JSON Schema：Pi 只把 `parameters` 原样交给 provider 作为 JSON Schema，
 * 不做 TypeBox 运行时校验，因此这里不为一次类型断言引入 typebox 依赖。
 */
import { randomUUID } from 'node:crypto'
import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  GENUI_MAX_DOCUMENT_CHARS,
  GENUI_MAX_PARAMS,
  GENUI_MAX_SUBMIT_LABEL_CHARS,
  GENUI_SUBMIT_PREFIX,
  GENUI_VERSION,
  explainGenuiDocument
} from '../../shared/genui-api'
import type { GenuiDocument, GenuiParam, GenuiPayload } from '../../shared/genui-api'
import { GENUI_CATALOG_TOPICS, genuiCatalog } from './catalog'
import type { GenuiCatalogTopic } from './catalog'
import { collectDeliveryWarnings, createDiagnosticsState, formatValidationError } from './diagnostics'
import type { DiagnosticsState } from './diagnostics'
import { formatDocumentList, formatDocumentOutline } from './outline'
import { GenuiPatchError, applyGenuiPatch } from './patch'
import type { GenuiDocumentPatch, GenuiPatchOp } from './patch'
import { findLatestPayload, listDocuments, nextRevision } from './session-scan'

/** 工具结果的 details：渲染端只认这一个键，不认工具名，因此改名不影响渲染。 */
export interface GenuiToolDetails {
  readonly ui: GenuiPayload
}

/** 工具定义里 parameters 的断言目标；Pi 的类型要求 TypeBox 的 TSchema，运行期并不校验。 */
type ToolParameters = Parameters<ExtensionAPI['registerTool']>[0]['parameters']

const RENDER_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['document'],
  properties: {
    documentId: {
      type: 'string',
      description: '修改既有界面时填它的 documentId（见 ui_inspect）；省略表示新建一份界面。'
    },
    document: {
      type: 'object',
      description: `完整界面文档 {version:${GENUI_VERSION}, title, fallback, params?, submitLabel?, nodes:[...]}。字段与上限见 ui_catalog。`,
      additionalProperties: true,
      required: ['version', 'title', 'fallback', 'nodes'],
      properties: {
        version: { type: 'number', description: `固定为 ${GENUI_VERSION}` },
        title: { type: 'string', description: '界面标题，不超过 200 字符' },
        fallback: { type: 'string', description: '界面无法渲染时的替代文本，必须能独立读懂' },
        params: {
          type: 'array',
          description: `界面内可调参数，1..${GENUI_MAX_PARAMS} 项；声明后必须被 controls 节点引用，`
            + '否则整份被拒绝。字段见 ui_catalog({topic:"params"})。',
          items: { type: 'object' }
        },
        submitLabel: {
          type: 'string',
          description: `提交按钮文案，不超过 ${GENUI_MAX_SUBMIT_LABEL_CHARS} 字符；省略时叫「提交参数」`
        },
        nodes: { type: 'array', description: '节点数组，至少一个', items: { type: 'object' } }
      }
    }
  }
} as unknown as ToolParameters

const PATCH_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['documentId'],
  properties: {
    documentId: {
      type: 'string',
      description: '要修改的界面标识（见 ui_inspect）；补丁总是应用到当前分支上的最新版。'
    },
    ops: {
      type: 'array',
      description: '节点补丁，按顺序应用。路径与 ui_inspect 的大纲一致（"0"、"0.1"）；空字符串表示文档顶层 nodes。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['replace', 'insert', 'remove'], description: 'replace=整节点替换；insert=插入到容器；remove=删除节点' },
          path: { type: 'string', description: 'replace/remove 指向被改的节点；insert 指向要插入的容器；省略或空串表示顶层 nodes' },
          index: { type: 'number', description: '仅 insert：插入位置，省略表示追加到末尾' },
          node: { type: 'object', description: 'replace 与 insert 必填：节点对象，字段见 ui_catalog({topic:"nodes"})' }
        }
      }
    },
    title: { type: 'string', description: '改标题；省略则不变' },
    fallback: { type: 'string', description: '改替代文本；省略则不变' },
    submitLabel: { type: 'string', description: '改提交按钮文案；省略则不变' },
    params: {
      type: ['array', 'null'],
      description: '改参数声明：给数组则整体替换，给 null 则清空全部参数（同时要删掉对应的 controls 节点）；省略则不变',
      items: { type: 'object' }
    }
  }
} as unknown as ToolParameters

const CATALOG_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    topic: {
      type: 'string',
      enum: [...GENUI_CATALOG_TOPICS],
      description: 'overview=协议总览（默认）；nodes=全部节点字段与上限；params=可调参数与控件组；'
        + 'diagram=机制图解（装配拆解、齿轮传动、曲柄连杆）；chart=柱状图、折线图、饼图与环形图；'
        + 'update=修改既有界面；examples=八个完整示例。'
    }
  }
} as unknown as ToolParameters

const INSPECT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    documentId: {
      type: 'string',
      description: '要查看的界面标识；省略时列出当前会话分支上的全部界面。'
    }
  }
} as unknown as ToolParameters

/**
 * 归一化模型传来的 document：部分模型会把整个对象编码成 JSON 字符串。
 * 只做一次无损解码，不做字段级修补——修补会把错误藏起来，让模型无法从诊断中学习。
 */
function normalizeDocumentInput(raw: unknown, toolName: string): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error(`${toolName}: document 不是合法 JSON，也没有提供对象。请直接传对象，字段见 ui_catalog({topic:"nodes"})。`)
  }
}

/** 摘要里的默认值：文本参数默认空串时写明未填写，避免输出「备注=」这种半截内容。 */
function defaultText(param: GenuiParam): string {
  if (param.type === 'text' && param.default === '') return '（未填写）'
  return String(param.default)
}

/** 组装模型可见摘要：只给标题、替代文本、文档标识与可调参数，不回灌整份文档。 */
function summaryText(payload: GenuiPayload, updateNote?: string): string {
  const { document, documentId, revision } = payload
  const params = document.params ?? []
  const paramNote = params.length === 0
    ? ''
    : `\n\n可调参数 ${params.length} 项：${params.map((param) => `${param.label}=${defaultText(param)}`).join('、')}。`
      + `用户调整参数不会请求模型；用户点提交后会收到一条以 ${GENUI_SUBMIT_PREFIX} 开头的用户消息，回填当时的取值。`
  const versionNote = revision === 0
    ? ''
    : `\n这是同一界面的第 ${revision} 版；之前的版本已折叠为只读记录，只有本版可交互。`
  const actionNote = updateNote === undefined
    ? '需要修改时优先用 ui_patch 只发改动部分，结构大改时用 ui_render 重发整份。'
    : `本次改动 ${updateNote}；要再改可继续用 ui_patch，结构大改时用 ui_render 重发整份。`
  const head = updateNote === undefined ? '已生成界面' : '已更新界面'
  return `${head}《${document.title}》。\n${document.fallback}\n`
    + `UI documentId=${documentId}; revision=${revision}. `
    + actionNote
    + versionNote
    + paramNote
}

/**
 * 校验一份文档并返回归一化结果。两个渲染入口共用：序列化上限、整份解析与诊断文案完全一致，
 * 补丁合并出来的文档不能因为走了另一条路径而放宽校验。
 */
function validateDocument(rawDocument: unknown, toolName: string, diagnostics: DiagnosticsState): GenuiDocument {
  const normalized = normalizeDocumentInput(rawDocument, toolName)
  if (normalized === undefined || normalized === null) {
    throw new Error(`${toolName}: 缺少 document。请传入完整界面文档，字段见 ui_catalog({topic:"overview"})。`)
  }
  let size = Number.POSITIVE_INFINITY
  try {
    size = JSON.stringify(normalized)?.length ?? Number.POSITIVE_INFINITY
  } catch {
    // 循环引用等无法序列化的输入按校验失败处理，不把原始异常抛给模型。
    throw new Error(`${toolName}: document 无法序列化（可能存在循环引用），请检查结构后重试。`)
  }
  if (size > GENUI_MAX_DOCUMENT_CHARS) {
    throw new Error(
      `${toolName}: document 序列化后约 ${size} 字符，超过上限 ${GENUI_MAX_DOCUMENT_CHARS}。`
      + '请拆成多份界面或精简表格行数后重试。'
    )
  }
  const result = explainGenuiDocument(normalized)
  if (!result.ok) throw new Error(formatValidationError(result.issues, diagnostics, toolName))
  return result.document
}

/**
 * 校验并构造载荷。长度上限在解析前先做，避免对超大载荷做完整遍历。
 *
 * `documentId` 是「修改既有界面」的唯一入口：命中当前分支时版本号递增，未命中直接报错。
 * 静默当成新界面会让「修改」变成重复交付，模型与用户都看不出差别，因此这里不兜底。
 */
function buildPayload(
  rawDocument: unknown,
  documentId: string | undefined,
  entries: readonly SessionEntry[],
  diagnostics: DiagnosticsState
): GenuiPayload {
  const document = validateDocument(rawDocument, 'ui_render', diagnostics)
  if (documentId === undefined) {
    return { version: GENUI_VERSION, documentId: randomUUID(), revision: 0, document }
  }
  const revision = nextRevision(entries, documentId)
  if (revision === null) {
    throw new Error(
      `ui_render: documentId=${documentId} 不在当前会话分支上，无法作为修改。`
      + '先用 ui_inspect 确认既有界面的 documentId；要新建界面就去掉 documentId。'
    )
  }
  return { version: GENUI_VERSION, documentId, revision, document }
}

/**
 * 把补丁应用到分支上的最新版并构造载荷。
 * 补丁总是作用于当前分支的最新版：没有「期望版本」校验，因为版本号本身就由分支推出，
 * 模型拿旧大纲改字段时应当先重新 ui_inspect。
 */
function buildPatchedPayload(
  documentId: string,
  ops: readonly GenuiPatchOp[],
  fields: GenuiDocumentPatch,
  entries: readonly SessionEntry[],
  diagnostics: DiagnosticsState
): { payload: GenuiPayload; opCount: number; fieldCount: number } {
  const latest = findLatestPayload(entries, documentId)
  if (latest === null) {
    throw new Error(
      `ui_patch: documentId=${documentId} 不在当前会话分支上，或历史版本已损坏。`
      + '先用 ui_inspect 确认既有界面的 documentId；要新建界面用 ui_render。'
    )
  }
  const revision = nextRevision(entries, documentId)
  if (revision === null) {
    throw new Error(`ui_patch: documentId=${documentId} 无法推导下一版版本号，请重新 ui_inspect 后重试。`)
  }
  let merged: Record<string, unknown>
  try {
    merged = applyGenuiPatch(latest.document, ops, fields)
  } catch (error) {
    // 路径类错误带具体层级与可用范围，直接交给模型，不再包一层。
    if (error instanceof GenuiPatchError) throw new Error(`ui_patch: ${error.message}`)
    throw error
  }
  const document = validateDocument(merged, 'ui_patch', diagnostics)
  return {
    payload: { version: GENUI_VERSION, documentId, revision, document },
    opCount: ops.length,
    fieldCount: Object.keys(fields).length
  }
}

/**
 * 注册四个工具（整份交付、局部补丁、字段目录、查看）。任何异常都在调用方（扩展工厂）收敛，
 * 这里不吞异常：工具执行期抛出会变成失败的工具结果，模型能看到并据此修正。
 *
 * 诊断状态按会话持有（工厂每次建会话调用一次注册），跨调用累积失败次数与重复签名。
 */
export function registerGenuiTools(pi: ExtensionAPI): void {
  const diagnostics = createDiagnosticsState()

  pi.registerTool({
    name: 'ui_render',
    label: '生成式界面',
    description:
      '把结构化内容渲染成对话内的原生界面（卡片、指标、表格、步骤、时间线、列表、分栏、'
      + '可调参数控件、机制图解与图表），而不是让模型写 HTML。只用于值得用界面表达的内容：方案对比、数据摘要、'
      + '流程说明、多指标并列。修改既有界面时带同一个 documentId 重新交付。纯文本、代码与简短回答继续用正文。',
    promptSnippet: 'ui_render — 把对比、数据摘要、流程与多指标并列渲染成对话内原生界面',
    promptGuidelines: [
      '真实的方案对比、多指标、数据表、顺序关系或可调参数才使用 ui_render；纯叙述、路径清单和简短结论留在正文，不把整段回答套成卡片。',
      '先按信息关系组织布局：方案用 row 并排比较，指标用 metric，真实先后顺序用 steps，带具体时间点的过程用 timeline，参数用 controls；card 只负责主题分组，不反复嵌套 card。',
      'table 只放可横向比较的同类记录，避免把长段落塞进每个单元格；结论和警告单独用 text 表达，不藏在长表尾部。',
      'ui_render 的 document 必须同时提供 title 与 fallback；fallback 要能独立读懂，不能依赖视觉。',
      '不确定节点字段时先调用 ui_catalog，不要凭猜测提交。',
      `收到以 ${GENUI_SUBMIT_PREFIX} 开头的用户消息时，那是界面参数的显式回填：按其中的 documentId`
        + '认定是同一份界面，直接基于这些取值继续，不要重画同一界面。',
      '要修改已经交付过的界面时，先 ui_inspect 取它的结构与 documentId，再带同一个 documentId 调 ui_render；'
        + '不要用新 documentId 重复交付同一界面。小改动优先用 ui_patch 只发改动部分。',
      '要表达装配顺序、传动比或运动规律时用 diagram 节点（字段见 ui_catalog({topic:"diagram"})）；'
        + '想让图解随用户调节变化，就声明 number 参数、用 binds 绑定，并用 controls 节点把它渲染出来。',
      '需要展示 1~3 条序列的数值对比或趋势时用 chart 的 bar/line（多序列自动出图例，字段见 ui_catalog({topic:"chart"})）；'
        + '超过 3 条、或单位与量级不可比时用 table，不要硬塞进图表。',
      '要表达占比与构成时用 chart 的 pie/donut（单序列、不超过 6 片，环形中间显示总计）；'
        + '不要用柱状图让人硬读比例。'
    ],
    parameters: RENDER_PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted === true) throw new Error('ui_render: 已取消。')
      const input = params as unknown as { document?: unknown; documentId?: unknown }
      const documentId = typeof input.documentId === 'string' && input.documentId !== ''
        ? input.documentId
        : undefined
      const entries = ctx.sessionManager.getBranch()
      const payload = buildPayload(input.document, documentId, entries, diagnostics)
      const warnings = collectDeliveryWarnings(payload.document)
      const warningNote = warnings.length === 0
        ? ''
        : `\n\n交付检查：\n${warnings.map((warning) => `- ${warning}`).join('\n')}`
      const details: GenuiToolDetails = { ui: payload }
      return { content: [{ type: 'text', text: summaryText(payload) + warningNote }], details }
    }
  })

  pi.registerTool({
    name: 'ui_patch',
    label: '局部修改生成式界面',
    description:
      '按 documentId 只发改动部分来更新已交付的界面，不重发整份文档：ops 里用 replace / insert / remove '
      + '改节点，或直接给 title / fallback / submitLabel / params。路径与 ui_inspect 大纲一致（"0"、"0.1"）。'
      + '结构大改、或改动超过文档一半时改用 ui_render 重发整份。',
    promptSnippet: 'ui_patch — 按 documentId 只发改动部分，不重发整份界面文档',
    promptGuidelines: [
      '改已交付界面的文案、数据或增删节点时优先用 ui_patch；只有结构大改（重排大部分节点）才用 ui_render 重发整份。',
      '用 ui_patch 前先 ui_inspect 取结构：路径就是大纲里的 0、0.1 这类节点位置，不要自己推测。',
      'ui_patch 的粒度是节点：改表格里的一行也要 replace 整个 table 节点，没有行级、项级补丁。',
      '补丁合并后仍要过整份校验：改 params 时要同步改 controls 节点，删参数时一起删掉引用它的 controls。'
    ],
    parameters: PATCH_PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted === true) throw new Error('ui_patch: 已取消。')
      const input = params as unknown as {
        documentId?: unknown
        ops?: unknown
        title?: unknown
        fallback?: unknown
        submitLabel?: unknown
        params?: unknown
      }
      const documentId = typeof input.documentId === 'string' ? input.documentId : ''
      if (documentId === '') throw new Error('ui_patch: 缺少 documentId。先 ui_inspect 取界面标识；新建界面用 ui_render。')
      if (input.ops !== undefined && !Array.isArray(input.ops)) {
        throw new Error('ui_patch: ops 必须是数组，每项带 op 字段（replace / insert / remove）。')
      }
      const ops = (input.ops ?? []) as readonly GenuiPatchOp[]
      // 只把真实给出的字段传给合并层：四个键全部写 undefined 会让「空补丁」检查失效。
      const fields: GenuiDocumentPatch = {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
        ...(input.submitLabel === undefined ? {} : { submitLabel: input.submitLabel }),
        ...(input.params === undefined ? {} : { params: input.params })
      }
      const entries = ctx.sessionManager.getBranch()
      const { payload, opCount, fieldCount } = buildPatchedPayload(documentId, ops, fields, entries, diagnostics)
      const warnings = collectDeliveryWarnings(payload.document)
      const warningNote = warnings.length === 0
        ? ''
        : `\n\n交付检查：\n${warnings.map((warning) => `- ${warning}`).join('\n')}`
      // 摘要按实际改了什报告：只改文档级字段时不能写成「0 处节点」。
      const parts = [
        ...(opCount === 0 ? [] : [`${opCount} 处节点`]),
        ...(fieldCount === 0 ? [] : [`${fieldCount} 处文档级字段`])
      ]
      const details: GenuiToolDetails = { ui: payload }
      return { content: [{ type: 'text', text: summaryText(payload, parts.join('、')) + warningNote }], details }
    }
  })

  pi.registerTool({
    name: 'ui_catalog',
    label: '生成式界面字段目录',
    description:
      '按主题读取 ui_render 的字段说明：overview=协议总览，nodes=全部节点字段与上限，'
      + 'params=可调参数与控件组，diagram=机制图解，chart=柱状图、折线图、饼图与环形图，update=修改既有界面，'
      + 'examples=八个可直接照抄的完整示例。仅在需要确认字段时调用。',
    promptSnippet: 'ui_catalog — 按需读取 ui_render 的节点字段、可调参数、机制图解、图表与示例',
    parameters: CATALOG_PARAMETERS,
    async execute(_toolCallId, params) {
      const topic = (params as unknown as { topic?: unknown }).topic
      const resolved: GenuiCatalogTopic = topic === undefined
        ? 'overview'
        : (GENUI_CATALOG_TOPICS as readonly string[]).includes(topic as string)
          ? (topic as GenuiCatalogTopic)
          : 'overview'
      return {
        content: [{ type: 'text', text: genuiCatalog(resolved) }],
        details: undefined
      }
    }
  })

  pi.registerTool({
    name: 'ui_inspect',
    label: '查看生成式界面',
    description:
      '查看当前会话分支上已交付的界面：省略 documentId 时列出全部界面（标识、标题、当前版本）；'
      + '给出 documentId 时返回该界面的结构大纲（节点路径、类型、短预览与参数声明）。'
      + '修改既有界面前先用它确认结构与标识：大纲里的节点路径就是 ui_patch 的 path。',
    promptSnippet: 'ui_inspect — 列出会话内的界面，或读取某份界面的结构大纲',
    promptGuidelines: [
      '要修改已交付的界面时先 ui_inspect 取结构：小改用 ui_patch，结构大改用 ui_render 带同一 documentId 重发整份。'
    ],
    parameters: INSPECT_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const documentId = (params as unknown as { documentId?: unknown }).documentId
      const entries = ctx.sessionManager.getBranch()
      if (typeof documentId !== 'string' || documentId === '') {
        return {
          content: [{ type: 'text', text: formatDocumentList(listDocuments(entries)) }],
          details: undefined
        }
      }
      const payload = findLatestPayload(entries, documentId)
      if (payload === null) {
        return {
          content: [{
            type: 'text',
            text: `当前会话分支上没有可用界面 documentId=${documentId}。`
              + '用 ui_inspect 不带参数可以看到全部可用标识；历史版本损坏或版本过旧时也会查不到。'
          }],
          details: undefined
        }
      }
      return {
        content: [{ type: 'text', text: formatDocumentOutline(payload) }],
        details: undefined
      }
    }
  })
}
