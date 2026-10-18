/**
 * 生成式 UI 的交付诊断：把校验失败翻译成模型能直接执行的修正方向，并在成功时给出非阻断的
 * 交付检查提示。
 *
 * 失败文案会进入模型上下文，因此要短、要具体、要不重复：第一次失败给完整排查路径，
 * 之后收敛成一行；同一处错误连续重复时直接指向 `ui_catalog`，避免模型在同一个坑里反复重试。
 *
 * 状态按会话持有（由扩展工厂的闭包提供），不落盘、不进 details。
 */
import { GENUI_MAX_ISSUES } from '../../shared/genui-api'
import type { GenuiDocument, GenuiIssue, GenuiNode } from '../../shared/genui-api'

/** 完整排查指引只在前面这几次失败里附带；之后模型已经看过，再附只会挤占上下文。 */
const VERBOSE_FAILURES = 2

/** 同一错误签名连续出现这么多次后，改为直接指向字段目录。 */
const REPEAT_THRESHOLD = 3

/** 每会话的失败统计；由扩展工厂创建一次，跨调用累积。 */
export interface DiagnosticsState {
  failures: number
  lastSignature: string
  repeated: number
}

export function createDiagnosticsState(): DiagnosticsState {
  return { failures: 0, lastSignature: '', repeated: 0 }
}

/** 错误签名：只看路径与原因，用来判断「是不是同一个错又犯了一次」。 */
function signatureOf(issues: readonly GenuiIssue[]): string {
  return issues.map((issue) => `${issue.path}\u0000${issue.reason}`).join('\u0001')
}

/**
 * 组装校验失败的工具错误文本。
 * `issues` 来自 `explainGenuiDocument`，已带路径与可执行原因，这里只负责排版与去重。
 */
export function formatValidationError(issues: readonly GenuiIssue[], state: DiagnosticsState): string {
  state.failures += 1
  const shown = issues.slice(0, GENUI_MAX_ISSUES)
  const lines = ['ui_render: document 未通过校验，界面未生成。具体问题：']
  for (const issue of shown) lines.push(`- ${issue.path}：${issue.reason}`)
  if (issues.length > shown.length) lines.push(`（另有 ${issues.length - shown.length} 处问题未列出，先修上面这些。）`)

  const signature = signatureOf(shown)
  if (signature === state.lastSignature) state.repeated += 1
  else {
    state.lastSignature = signature
    state.repeated = 1
  }

  if (state.repeated >= REPEAT_THRESHOLD) {
    lines.push(
      `同样的错误已连续出现 ${state.repeated} 次。先调用 ui_catalog({topic:"examples"}) 取一份可直接照抄的完整示例，`
      + '按示例结构改写后再重试，不要凭记忆补字段。'
    )
    return lines.join('\n')
  }
  if (state.failures <= VERBOSE_FAILURES) {
    lines.push(
      '字段与上限见 ui_catalog({topic:"nodes"})，可调参数见 ui_catalog({topic:"params"})，'
      + '完整示例见 ui_catalog({topic:"examples"})。'
    )
  }
  return lines.join('\n')
}

/** 统计一份文档里的节点：是否只有文本、空表格个数。 */
interface DocumentShape {
  readonly textOnly: boolean
  readonly emptyTables: number
}

function measureDocument(document: GenuiDocument): DocumentShape {
  let textOnly = true
  let emptyTables = 0
  const walk = (nodes: readonly GenuiNode[]): void => {
    for (const node of nodes) {
      if (node.type !== 'text') textOnly = false
      if (node.type === 'table' && node.rows.length === 0) emptyTables += 1
      if (node.type === 'card' || node.type === 'row') walk(node.children)
    }
  }
  walk(document.nodes)
  return { textOnly, emptyTables }
}

/** `fallback` 过短时说明它没写清结论；这是交付质量提示，不是校验失败。 */
const MIN_FALLBACK_CHARS = 12

/**
 * 非阻断的交付检查：只返回给模型看的提示，不改变工具结果的成功状态，也不进 details。
 * 目标是拦住「用界面包装一句正文」这类负价值用法，而不是限制模型的表达。
 */
export function collectDeliveryWarnings(document: GenuiDocument): readonly string[] {
  const shape = measureDocument(document)
  const warnings: string[] = []
  if (shape.textOnly) {
    warnings.push('这份界面只有文本节点，正文即可表达；界面适合承载对比、指标、表格与步骤。')
  }
  if (shape.emptyTables > 0) {
    warnings.push(`有 ${shape.emptyTables} 个表格没有任何数据行，界面会显示空表头。`)
  }
  if (document.fallback.trim().length < MIN_FALLBACK_CHARS) {
    warnings.push('fallback 过短，纯文本客户端只能看到它；请写成能独立读懂的结论。')
  }
  if (document.fallback.trim() === document.title.trim()) {
    warnings.push('fallback 与 title 相同，没有提供替代内容。')
  }
  return warnings
}
