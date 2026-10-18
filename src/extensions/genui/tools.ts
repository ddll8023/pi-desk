/**
 * 生成式 UI 的工具定义：一个渲染入口、一个按需字段目录与一个查看入口。
 *
 * 边界：只做参数归一化、校验与结果组装，不持有会话内容、不读写文件。`revision` 是唯一的
 * 跨调用状态，它不落盘：每次调用都从当前会话分支上的工具结果重建（见 `session-scan.ts`），
 * 因此 rewind / fork 之后版本语义自然跟着分支走。
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
import type { GenuiParam, GenuiPayload } from '../../shared/genui-api'
import { GENUI_CATALOG_TOPICS, genuiCatalog } from './catalog'
import type { GenuiCatalogTopic } from './catalog'
import { collectDeliveryWarnings, createDiagnosticsState, formatValidationError } from './diagnostics'
import type { DiagnosticsState } from './diagnostics'
import { formatDocumentList, formatDocumentOutline } from './outline'
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

const CATALOG_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    topic: {
      type: 'string',
      enum: [...GENUI_CATALOG_TOPICS],
      description: 'overview=协议总览（默认）；nodes=全部节点字段与上限；params=可调参数与控件组；'
        + 'diagram=机制图解（装配拆解、齿轮传动、曲柄连杆）；chart=柱状图与折线图；'
        + 'update=修改既有界面；examples=五个完整示例。'
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
function normalizeDocumentInput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('ui_render: document 不是合法 JSON，也没有提供对象。请直接传对象，字段见 ui_catalog({topic:"nodes"})。')
  }
}

/** 摘要里的默认值：文本参数默认空串时写明未填写，避免输出「备注=」这种半截内容。 */
function defaultText(param: GenuiParam): string {
  if (param.type === 'text' && param.default === '') return '（未填写）'
  return String(param.default)
}

/** 组装模型可见摘要：只给标题、替代文本、文档标识与可调参数，不回灌整份文档。 */
function summaryText(payload: GenuiPayload): string {
  const { document, documentId, revision } = payload
  const params = document.params ?? []
  const paramNote = params.length === 0
    ? ''
    : `\n\n可调参数 ${params.length} 项：${params.map((param) => `${param.label}=${defaultText(param)}`).join('、')}。`
      + `用户调整参数不会请求模型；用户点提交后会收到一条以 ${GENUI_SUBMIT_PREFIX} 开头的用户消息，回填当时的取值。`
  const versionNote = revision === 0
    ? ''
    : `\n这是同一界面的第 ${revision} 版；之前的版本已折叠为只读记录，只有本版可交互。`
  return `已生成界面《${document.title}》。\n${document.fallback}\n`
    + `UI documentId=${documentId}; revision=${revision}. `
    + '需要修改时重新调用 ui_render 生成新版本，或按 documentId 引用本界面。'
    + versionNote
    + paramNote
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
  const normalized = normalizeDocumentInput(rawDocument)
  if (normalized === undefined || normalized === null) {
    throw new Error('ui_render: 缺少 document。请传入完整界面文档，字段见 ui_catalog({topic:"overview"})。')
  }
  let size = Number.POSITIVE_INFINITY
  try {
    size = JSON.stringify(normalized)?.length ?? Number.POSITIVE_INFINITY
  } catch {
    // 循环引用等无法序列化的输入按校验失败处理，不把原始异常抛给模型。
    throw new Error('ui_render: document 无法序列化（可能存在循环引用），请检查结构后重试。')
  }
  if (size > GENUI_MAX_DOCUMENT_CHARS) {
    throw new Error(
      `ui_render: document 序列化后约 ${size} 字符，超过上限 ${GENUI_MAX_DOCUMENT_CHARS}。`
      + '请拆成多份界面或精简表格行数后重试。'
    )
  }

  const result = explainGenuiDocument(normalized)
  if (!result.ok) throw new Error(formatValidationError(result.issues, diagnostics))

  if (documentId === undefined) {
    return { version: GENUI_VERSION, documentId: randomUUID(), revision: 0, document: result.document }
  }
  const revision = nextRevision(entries, documentId)
  if (revision === null) {
    throw new Error(
      `ui_render: documentId=${documentId} 不在当前会话分支上，无法作为修改。`
      + '先用 ui_inspect 确认既有界面的 documentId；要新建界面就去掉 documentId。'
    )
  }
  return { version: GENUI_VERSION, documentId, revision, document: result.document }
}

/**
 * 注册三个工具。任何异常都在调用方（扩展工厂）收敛，这里不吞异常：
 * 工具执行期抛出会变成失败的工具结果，模型能看到并据此修正。
 *
 * 诊断状态按会话持有（工厂每次建会话调用一次注册），跨调用累积失败次数与重复签名。
 */
export function registerGenuiTools(pi: ExtensionAPI): void {
  const diagnostics = createDiagnosticsState()

  pi.registerTool({
    name: 'ui_render',
    label: '生成式界面',
    description:
      '把结构化内容渲染成对话内的原生界面（卡片、指标、表格、步骤、列表、分栏、'
      + '可调参数控件、机制图解与图表），而不是让模型写 HTML。只用于值得用界面表达的内容：方案对比、数据摘要、'
      + '流程说明、多指标并列。修改既有界面时带同一个 documentId 重新交付。纯文本、代码与简短回答继续用正文。',
    promptSnippet: 'ui_render — 把对比、数据摘要、流程与多指标并列渲染成对话内原生界面',
    promptGuidelines: [
      '真实的方案对比、多指标、数据表、顺序关系或可调参数才使用 ui_render；纯叙述、路径清单和简短结论留在正文，不把整段回答套成卡片。',
      '先按信息关系组织布局：方案用 row 并排比较，指标用 metric，真实先后顺序用 steps，参数用 controls；card 只负责主题分组，不反复嵌套 card。',
      'table 只放可横向比较的同类记录，避免把长段落塞进每个单元格；结论和警告单独用 text 表达，不藏在长表尾部。',
      'ui_render 的 document 必须同时提供 title 与 fallback；fallback 要能独立读懂，不能依赖视觉。',
      '不确定节点字段时先调用 ui_catalog，不要凭猜测提交。',
      `收到以 ${GENUI_SUBMIT_PREFIX} 开头的用户消息时，那是界面参数的显式回填：按其中的 documentId`
        + '认定是同一份界面，直接基于这些取值继续，不要重画同一界面。',
      '要修改已经交付过的界面时，先 ui_inspect 取它的结构与 documentId，再带同一个 documentId 调 ui_render；'
        + '不要用新 documentId 重复交付同一界面。',
      '要表达装配顺序、传动比或运动规律时用 diagram 节点（字段见 ui_catalog({topic:"diagram"})）；'
        + '想让图解随用户调节变化，就声明 number 参数、用 binds 绑定，并用 controls 节点把它渲染出来。',
      '需要展示单序列的数值对比或趋势时用 chart（字段见 ui_catalog({topic:"chart"})）；'
        + '多序列对比用 table，不要往图表里塞第二条序列。'
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
    name: 'ui_catalog',
    label: '生成式界面字段目录',
    description:
      '按主题读取 ui_render 的字段说明：overview=协议总览，nodes=全部节点字段与上限，'
      + 'params=可调参数与控件组，diagram=机制图解，chart=柱状图与折线图，update=修改既有界面，'
      + 'examples=五个可直接照抄的完整示例。仅在需要确认字段时调用。',
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
      + '修改既有界面前先用它确认结构与标识。',
    promptSnippet: 'ui_inspect — 列出会话内的界面，或读取某份界面的结构大纲',
    promptGuidelines: [
      '要修改已交付的界面时先 ui_inspect 取结构，再带同一 documentId 调 ui_render。'
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
