/** Mermaid 安全预览：按需加载、串行渲染，输出仅在隔离的 Shadow DOM 内展示，不开放外部资源。 */
import DOMPurify from 'dompurify'
let tail: Promise<unknown> = Promise.resolve()
export function renderRichDiagram(source: string, dark: boolean, valid: () => boolean): Promise<string> {
  const task = tail.catch(() => {}).then(async () => {
    if (!valid()) return ''
    if (source.length > 30000) throw new Error('图表源码过长，未生成预览。')
    if (/%%\s*\{|^\s*---/.test(source)) throw new Error('安全预览不接受内嵌配置指令。')
    // Mermaid 会先在文档内量算 SVG；资源指令必须在调用渲染器前拦截，不能仅靠事后清洗。
    if (/url\s*\(|@import|(?:style|classDef)[^;\n]*\\|@\s*\{[\s\S]*?(?:\b(?:img|image)\b|\\)|<\s*(?:img|image|iframe|object|embed|link|style|script|video|audio|source|svg)\b/i.test(source)) throw new Error('安全图表预览不允许图片资源、HTML 资源标签或 CSS URL。')
    const { default: mermaid } = await import('mermaid')
    if (!valid()) return ''
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', suppressErrorRendering: true, flowchart: { htmlLabels: false }, maxTextSize: 30000, maxEdges: 500 })
    const id = `file-diagram-${crypto.randomUUID()}`
    const result = await mermaid.render(id, source)
    const clean = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['script','foreignObject','image','feImage','a','use'], FORBID_ATTR: ['href','xlink:href','src'] })
    const holder = document.createElement('div')
    holder.innerHTML = clean
    for (const style of holder.querySelectorAll('style')) {
      const css = style.textContent ?? ''
      if (/\\/.test(css)) style.remove()
      else style.textContent = css.replace(/@import\s+[^;]+;?/gi, '').replace(/@font-face\s*\{[^}]*\}/gi, '').replace(/url\s*\([^)]*\)/gi, 'none')
    }
    for (const element of holder.querySelectorAll('*')) for (const attr of Array.from(element.attributes)) {
      if (/^on/i.test(attr.name) || /[@\\]/.test(attr.value) || (/url\s*\(/i.test(attr.value) && !/^url\(["']?#[\w-]+["']?\)$/i.test(attr.value))) element.removeAttribute(attr.name)
    }
    return holder.innerHTML
  })
  tail = task
  return task
}
