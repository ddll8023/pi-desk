/** 将消息文本解析为受限 Markdown HTML；原始 HTML 只作文本展示，图片不加载，链接只提供复制动作。 */
import DOMPurify from 'dompurify'
import { Marked, Renderer } from 'marked'
import type { Config } from 'dompurify'

/** 只开放正文语义和本地复制控件；不允许样式、资源地址、事件、ID 或任意 data 属性。 */
const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
    'blockquote', 'ul', 'ol', 'li', 'hr', 'pre', 'code', 'table', 'thead',
    'tbody', 'tr', 'th', 'td', 'div', 'span', 'button', 'input'
  ],
  ALLOWED_ATTR: [
    'class', 'type', 'disabled', 'checked', 'start', 'align', 'title',
    'tabindex', 'role', 'aria-label', 'data-markdown-link'
  ],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  RETURN_TRUSTED_TYPE: false
}

// 独立实例不更改 marked 的全局配置；同步计算只随各内容块的文本更新。
const parser = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    code({ text, lang }) {
      return renderCodeBlock(text, lang)
    },
    html({ text, block }) {
      return block ? renderCodeBlock(text, 'html') : escapeHtml(text)
    },
    text(token) {
      // marked 的 raw HTML 内部文本会标为 escaped；关闭原始 HTML 后不能继续信任该标记。
      if ('escaped' in token && token.escaped && !token.tokens) return escapeHtml(token.text)
      return false
    },
    image({ text }) {
      const label = text === '' ? '图片' : `图片：${text}`
      return `<span class="markdown-image-placeholder">${escapeHtml(label)}（未加载）</span>`
    },
    link({ href, tokens }) {
      // 地址保存在惰性文本属性中，而不是 href；相对路径与自定义协议也不能触发导航或资源请求。
      return `<button type="button" class="markdown-link" data-markdown-link="${escapeHtml(href)}" title="${escapeHtml(`复制链接地址：${href}`)}">${this.parser.parseInline(tokens)}</button>`
    },
    table(token) {
      return `<div class="markdown-table-scroll scroll-area" tabindex="0" role="region" aria-label="表格，可横向滚动">${Renderer.prototype.table.call(this, token)}</div>`
    },
    checkbox({ checked }) {
      return `<input type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${checked ? '已完成任务' : '未完成任务'}"> `
    }
  }
})

/** 解析或清洗失败时返回 null，由组件用 Vue 文本插值保留原文，不输出错误堆栈。 */
export function renderMarkdown(text: string): string | null {
  try {
    return DOMPurify.sanitize(parser.parse(text, { async: false }), SANITIZE_CONFIG)
  } catch {
    return null
  }
}

/** 围栏未闭合时也沿用解析器当前的代码内容；语言只作标签，不作为 HTML 或 CSS 类插入。 */
function renderCodeBlock(text: string, language?: string): string {
  const label = language?.trim().split(/\s+/, 1)[0] || '纯文本'
  return `<div class="markdown-code-block"><div class="markdown-code-header"><span class="markdown-code-language">${escapeHtml(label)}</span><button type="button" class="markdown-code-copy" aria-label="复制代码">复制</button></div><pre class="scroll-area" tabindex="0" role="region" aria-label="代码，可横向滚动"><code>${escapeHtml(text)}</code></pre></div>\n`
}

/** 所有进入自定义 HTML 的文本与属性统一转义，清洗仍在完整输出的最后一道边界执行。 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
