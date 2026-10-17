/**
 * 文件路径到 CodeMirror 语言的映射：只按文件名/扩展名匹配，不做内容嗅探。
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

/** Markdown 文件才提供「源码 / 预览」切换；其余文件只有代码视图。 */
export function isMarkdownPath(path: string): boolean {
  const name = fileNameOf(path).toLowerCase()
  return name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.mdx')
}
