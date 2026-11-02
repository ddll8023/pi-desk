/**
 * 文件路径到 CodeMirror 语言及排版、页面、表格预览类型的映射：只按文件名/扩展名匹配，不做内容嗅探。
 *
 * 语言包来自 `@codemirror/language-data` 的注册表，由 `LanguageDescription.load()` 按需动态加载，
 * 因此未打开过的语言不会进入首屏包。匹配不到时返回 null，编辑器退化为纯文本。
 */
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

/** 从项目内相对路径里取出文件名；路径统一是 POSIX 风格，只需处理 `/`。 */
export function fileNameOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

/** 按文件名与扩展名匹配语言；匹配不到时为 null。 */
export function languageDescriptionForPath(path: string): LanguageDescription | null {
  const name = fileNameOf(path)
  if (name === '') return null
  return LanguageDescription.matchFilename(languages, name)
}

/** 不根据框架或构建配置猜测页面能否直接运行，所有 HTML 都提供页面视图。 */
export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(fileNameOf(path))
}

/**
 * Markdown 文件提供排版预览；HTML 的独立页面预览另行按扩展名识别。
 * `.mdx` 不在此列：它允许 JSX 与 import，marked 会把它们当普通文本渲染，预览结果与实际不符。
 */
export function isMarkdownPath(path: string): boolean {
  const name = fileNameOf(path).toLowerCase()
  return name.endsWith('.md') || name.endsWith('.markdown')
}

/** 电子表格文件（Excel 等），主进程直接解析出多工作表结构并以表格视图只读呈现。 */
export function isSpreadsheetPath(path: string): boolean {
  const name = fileNameOf(path).toLowerCase()
  return name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.ods')
}

/** 纯文本表格文件（CSV、TSV 等），支持在 CodeMirror 源码与结构化表格视图间双向切换。 */
export function isTextTablePath(path: string): boolean {
  const name = fileNameOf(path).toLowerCase()
  return name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.tab') || name.endsWith('.psv')
}

/** 广义表格文件判定，涵盖电子表格与纯文本表格。 */
export function isTableFilePath(path: string): boolean {
  return isSpreadsheetPath(path) || isTextTablePath(path)
}
