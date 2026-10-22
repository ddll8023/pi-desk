/** 富文本图片与数学节点：本地图片沿用项目读取边界，公式复用现有定界符与 KaTeX，不引入不兼容的数学扩展。 */
import { Node } from '@tiptap/core'
import { Image } from '@tiptap/extension-image'
import { loadMarkdownImage } from './file-images'
import { renderMathInto, tokenizeBlock, tokenizeInline } from './ui/markdown-math'

export interface MathEditRequest { readonly position: number; readonly latex: string; readonly type: 'inlineMath' | 'blockMath' }
export interface RichMediaContext {
  projectPath: () => string
  path: () => string
  editMath: (request: MathEditRequest) => void
}

function mathNode(block: boolean, context: RichMediaContext) {
  const name = block ? 'blockMath' : 'inlineMath'
  return Node.create({
    name, inline: !block, group: block ? 'block' : 'inline', atom: true, selectable: true,
    addAttributes: () => ({ latex: { default: '' }, display: { default: block }, original: { default: '', rendered: false } }),
    markdownTokenName: name,
    markdownTokenizer: {
      name, level: block ? 'block' : 'inline',
      start: block ? source => source.search(/^ {0,3}(?:\$\$|\\\[)/m) : source => source.search(/\$|\\[([]/),
      tokenize(source) {
        const token = block ? tokenizeBlock(source) : tokenizeInline(source)
        return token ? { ...token, type: name } : undefined
      }
    },
    parseMarkdown: (token, helpers) => helpers.createNode(name, { latex: typeof token.text === 'string' ? token.text : '', display: block || token.display === true, original: token.raw ?? '' }),
    renderMarkdown(node) {
      if (typeof node.attrs?.original === 'string' && node.attrs.original) return node.attrs.original.trimEnd()
      const latex = String(node.attrs?.latex ?? '')
      return block ? `$$\n${latex}\n$$` : node.attrs?.display ? `\\[${latex}\\]` : `\\(${latex}\\)`
    },
    renderText: ({ node }) => String(node.attrs.original || node.attrs.latex || ''),
    parseHTML: () => [{ tag: `${block ? 'div' : 'span'}[data-file-math]`, getAttrs: element => ({ latex: element.getAttribute('data-latex') ?? '', display: block || element.getAttribute('data-display') === 'true' }) }],
    renderHTML: ({ node }) => [block ? 'div' : 'span', { 'data-file-math': name, 'data-latex': String(node.attrs.latex ?? ''), 'data-display': node.attrs.display ? 'true' : 'false' }, String(node.attrs.latex ?? '')],
    addNodeView() {
      return ({ node, getPos }) => {
        let current = node
        const dom = document.createElement(block ? 'div' : 'span')
        dom.className = 'file-rich-math'
        dom.contentEditable = 'false'
        dom.title = '双击修改公式'
        const render = (): void => {
          const placeholder = document.createElement('span')
          placeholder.className = current.attrs.display ? 'markdown-math-block' : 'markdown-math-inline'
          placeholder.textContent = String(current.attrs.latex ?? '')
          dom.replaceChildren(placeholder)
          renderMathInto(dom)
        }
        dom.addEventListener('dblclick', event => {
          event.preventDefault()
          event.stopPropagation()
          const position = getPos()
          if (typeof position === 'number') context.editMath({ position, latex: String(current.attrs.latex ?? ''), type: name })
        })
        render()
        return {
          dom,
          update(next) { if (next.type !== current.type) return false; current = next; render(); return true },
          ignoreMutation: mutation => mutation.type !== 'selection'
        }
      }
    }
  })
}

export function createRichMedia(context: RichMediaContext) {
  let inFlight = 0
  let imageCount = 0
  let imageChars = 0
  const waiting = new Set<() => void>()
  let wakeQueued = false
  const wake = (): void => {
    if (wakeQueued) return
    wakeQueued = true
    queueMicrotask(() => { wakeQueued = false; const pending = [...waiting]; waiting.clear(); for (const retry of pending) retry() })
  }
  const queue: (() => Promise<void>)[] = []
  const drain = (): void => {
    while (inFlight < 4 && queue.length) {
      const work = queue.shift()
      if (!work) return
      inFlight += 1
      void work().finally(() => { inFlight -= 1; drain() })
    }
  }
  const RichImage = Image.extend({
    // 剪贴板 HTML 也不创建带原始 src 的 img，防止序列化过程触发资源读取。
    renderHTML({ node }) {
      return ['span', { 'data-file-image': '', 'data-image-reference': String(node.attrs.src ?? ''), 'data-alt': String(node.attrs.alt ?? ''), 'data-title': String(node.attrs.title ?? '') }, String(node.attrs.alt || '图片')]
    },
    parseHTML() {
      return [{ tag: 'span[data-file-image]', getAttrs: element => ({ src: element.getAttribute('data-image-reference') ?? '', alt: element.getAttribute('data-alt') ?? '', title: element.getAttribute('data-title') || null }) }, ...(this.parent?.() ?? [])]
    },
    addNodeView() {
      return ({ node }) => {
        let current = node
        let disposed = false
        let generation = 0
        let bytes = 0
        let admitted = false
        const dom = document.createElement('span')
        dom.className = 'file-markdown-image-frame'
        dom.contentEditable = 'false'
        dom.draggable = false
        const load = (): void => {
          if (disposed) return
          waiting.delete(load)
          const request = ++generation
          const released = bytes > 0
          imageChars -= bytes
          bytes = 0
          dom.className = 'file-markdown-image-frame'
          dom.textContent = `图片：${String(current.attrs.alt || '图片')}（加载中…）`
          const reference = String(current.attrs.src ?? '')
          const project = context.projectPath()
          const path = context.path()
          queue.push(async () => {
            if (disposed || request !== generation) return
            let budgetBlocked = false
            try {
              if ((!admitted && imageCount >= 40) || imageChars >= 32 * 1024 * 1024) { budgetBlocked = true; throw new Error('图片数量或总量超出显示上限，释放额度后重试') }
              if (!admitted) { admitted = true; imageCount += 1 }
              const result = await loadMarkdownImage(project, path, reference)
              if (disposed || request !== generation) return
              if (!result.url) throw new Error(result.error ?? '图片未加载')
              if (imageChars + result.url.length > 32 * 1024 * 1024) { budgetBlocked = true; throw new Error('图片总量超出显示上限，释放额度后重试') }
              const image = document.createElement('img')
              image.alt = String(current.attrs.alt ?? '')
              image.src = result.url
              image.draggable = false
              image.loading = 'lazy'
              image.decoding = 'async'
              bytes = result.url.length
              imageChars += bytes
              dom.replaceChildren(image)
              dom.classList.add('is-ready')
              dom.title = '双击放大图片'
            } catch (error) {
              if (disposed || request !== generation) return
              dom.textContent = `${String(current.attrs.alt || '图片')}（${error instanceof Error ? error.message : '图片未加载'}）`
              dom.classList.add('is-error')
              if (admitted) { admitted = false; imageCount -= 1 }
              if (budgetBlocked) waiting.add(load)
              else wake()
            }
          })
          drain()
          if (released) wake()
        }
        load()
        return {
          dom,
          update(next) {
            if (next.type !== current.type) return false
            const changed = next.attrs.src !== current.attrs.src || next.attrs.alt !== current.attrs.alt
            current = next
            if (changed) load()
            return true
          },
          ignoreMutation: mutation => mutation.type !== 'selection',
          destroy() { disposed = true; generation += 1; waiting.delete(load); if (admitted) imageCount -= 1; imageChars -= bytes; wake() }
        }
      }
    }
  }).configure({ inline: true, allowBase64: false })
  return [RichImage, mathNode(false, context), mathNode(true, context)]
}
