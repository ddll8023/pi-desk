/**
 * 聊天消息与文件预览共用的 Markdown 片段生成：文本转义、代码块外壳与表格滚动外壳。
 *
 * 两个场景的白名单不同（文件预览额外允许折叠块，以及指向图片与链接目标的 `data-*` 属性），
 * 但代码块与表格的结构必须一致，因此只把「与安全策略无关的结构片段」放在这里；各自的 marked 实例与清洗白名单仍留在
 * markdown.ts（聊天）与 file-markdown.ts（文件预览），避免一处放宽影响另一处。
 */
import { Renderer } from 'marked'
import type { Tokens } from 'marked'

/** 所有进入自定义 HTML 的文本与属性统一转义，清洗仍在完整输出的最后一道边界执行。 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** 围栏未闭合时也沿用解析器当前的代码内容；语言只作标签，不作为 HTML 或 CSS 类插入。 */
export function renderCodeBlock(text: string, language?: string): string {
  const label = language?.trim().split(/\s+/, 1)[0] || '纯文本'
  return `<div class="markdown-code-block"><div class="markdown-code-header"><span class="markdown-code-language">${escapeHtml(label)}</span><button type="button" class="markdown-code-copy" aria-label="复制代码">复制</button></div><pre class="scroll-area" tabindex="0" role="region" aria-label="代码，可横向滚动"><code>${escapeHtml(text)}</code></pre></div>\n`
}

/** 表格外壳：窄面板下表格可横向滚动，不压缩列宽；调用方传入 marked 的 renderer 实例以复用其行内解析。 */
export function renderTable(renderer: Renderer, token: Tokens.Table): string {
  return `<div class="markdown-table-scroll scroll-area" tabindex="0" role="region" aria-label="表格，可横向滚动">${Renderer.prototype.table.call(renderer, token)}</div>`
}
