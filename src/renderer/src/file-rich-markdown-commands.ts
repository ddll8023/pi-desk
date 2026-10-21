/** 编辑动作目录：工具栏与斜杠入口共用真实事务，分组与插入行为参考 ORCA。 */
import type { Editor } from '@tiptap/core'
export type RichCommandId = 'paragraph' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'bold' | 'italic' | 'strike' | 'bullet' | 'ordered' | 'task' | 'quote' | 'link' | 'image' | 'toggle' | 'code' | 'divider' | 'table' | 'mermaid' | 'inline-math' | 'block-math' | 'emoji'
export interface RichCommand { id: RichCommandId; label: string; icon: string; group: string; description: string; aliases: string }
export const richCommands: readonly RichCommand[] = [
  ...([1,2,3,4,5] as const).map(level => ({ id: `h${level}` as const, label: `标题 ${level}`, icon: `H${level}`, group: '基础块', description: `转换为 ${level} 级标题`, aliases: `heading h${level}` })),
  { id: 'quote', label: '引用', icon: '❞', group: '基础块', description: '插入引用块', aliases: 'quote blockquote' },
  { id: 'ordered', label: '有序列表', icon: '1.', group: '基础块', description: '创建编号列表', aliases: 'ordered ol numbered' },
  { id: 'bullet', label: '无序列表', icon: '☷', group: '基础块', description: '创建无序列表', aliases: 'bullet ul list' },
  { id: 'task', label: '任务清单', icon: '☑', group: '基础块', description: '创建可勾选的清单', aliases: 'todo task checkbox' },
  { id: 'paragraph', label: '正文', icon: '¶', group: '基础块', description: '转换为普通段落', aliases: 'text paragraph plain' },
  { id: 'toggle', label: '折叠段落', icon: '▸', group: '基础块', description: '创建可折叠的标题与正文', aliases: 'toggle details collapse' },
  { id: 'code', label: '代码块', icon: '</>', group: '基础块', description: '插入可选择语言的代码块', aliases: 'code snippet' },
  { id: 'divider', label: '分隔线', icon: '—', group: '基础块', description: '插入水平分隔线', aliases: 'divider rule hr' },
  { id: 'table', label: '表格', icon: '▦', group: '高级', description: '插入带表头的表格', aliases: 'table grid columns rows' },
  { id: 'mermaid', label: 'Mermaid 图表', icon: '◇', group: '高级', description: '插入可实时预览的图表代码', aliases: 'mermaid diagram flowchart graph' },
  { id: 'inline-math', label: '行内公式', icon: 'Σ', group: '高级', description: '插入行内 LaTeX 公式', aliases: 'inline math latex equation formula' },
  { id: 'block-math', label: '公式块', icon: '∑', group: '高级', description: '插入独立 LaTeX 公式', aliases: 'block display math latex' },
  { id: 'image', label: '图片', icon: '▧', group: '媒体', description: '从本机选择并导入图片', aliases: 'image img' },
  { id: 'emoji', label: '表情', icon: '☺', group: '其他', description: '搜索并插入 Unicode 表情', aliases: 'emoji smile reaction icon' }
]
export interface RichCommandHooks { link: () => void; image: () => void; emoji: () => void }
export function runRichCommand(editor: Editor, id: RichCommandId, hooks: RichCommandHooks): boolean {
  if (!editor.isEditable || editor.isDestroyed) return false
  const chain = editor.chain().focus()
  switch (id) {
    case 'paragraph': return chain.setParagraph().run()
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': return chain.toggleHeading({ level: id === 'h1' ? 1 : id === 'h2' ? 2 : id === 'h3' ? 3 : id === 'h4' ? 4 : 5 }).run()
    case 'bold': return chain.toggleBold().run()
    case 'italic': return chain.toggleItalic().run()
    case 'strike': return chain.toggleStrike().run()
    case 'quote': return chain.toggleBlockquote().run()
    case 'bullet': return chain.toggleBulletList().run()
    case 'ordered': return chain.toggleOrderedList().run()
    case 'task': return chain.toggleTaskList().run()
    case 'code': return chain.toggleCodeBlock().run()
    case 'divider': return chain.setHorizontalRule().run()
    case 'table': return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    case 'mermaid': return chain.insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: 'graph TD\n  A[开始] --> B[结束]' }] }).run()
    case 'inline-math': case 'block-math': return chain.insertContent({ type: id === 'inline-math' ? 'inlineMath' : 'blockMath', attrs: { latex: 'x', display: id === 'block-math', original: '' } }).run()
    case 'toggle': return chain.insertContent({ type: 'details', attrs: { open: true }, content: [{ type: 'detailsSummary', content: [{ type: 'text', text: '折叠标题' }] }, { type: 'detailsContent', content: [{ type: 'paragraph' }] }] }).run()
    case 'link': hooks.link(); return true
    case 'image': hooks.image(); return true
    case 'emoji': hooks.emoji(); return true
  }
}
