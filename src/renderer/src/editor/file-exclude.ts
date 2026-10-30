/**
 * 文件树条目的排除/隐藏规则匹配工具：根据偏好设置里的排除模式列表，
 * 判断指定文件或文件夹是否应当被排除。
 *
 * 支持三类匹配规则：
 * 1. 纯文件名/文件夹名匹配：模式中无斜杠且无通配符，如「node_modules」「.DS_Store」，精确比对条目自身名称；
 * 2. 相对路径匹配：模式包含斜杠但无通配符，如「dist/」「src/temp/cache」，比对条目相对项目根的路径；
 * 3. 通配符模式匹配：支持「*」（匹配单层内非斜杠字符）与「**」（跨层任意匹配），如「*.log」「**\/*.map」。
 */

/** 正则缓存：避免同一批渲染时对相同 pattern 重复编译正则表达式。 */
const regexCache = new Map<string, RegExp>()

/** 将简单通配符模式转换为正则表达式；模式不含通配符时回 null。 */
function compileGlob(pattern: string): RegExp | null {
  if (!pattern.includes('*') && !pattern.includes('?')) return null
  const cached = regexCache.get(pattern)
  if (cached !== undefined) return cached

  // 转义正则保留字，并将 * 与 ** 替换为正则捕获
  let regexStr = ''
  let i = 0
  while (i < pattern.length) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // ** 匹配任意字符包含 /
        regexStr += '.*'
        i += 2
        // 跳过紧随的斜杠，避免 /.*//
        if (pattern[i] === '/') i += 1
      } else {
        // 单个 * 匹配非 / 字符
        regexStr += '[^/]*'
        i += 1
      }
    } else if (char === '?') {
      regexStr += '[^/]'
      i += 1
    } else if (['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'].includes(char)) {
      regexStr += `\\${char}`
      i += 1
    } else {
      regexStr += char
      i += 1
    }
  }

  const regex = new RegExp(`^${regexStr}$`, 'i')
  if (regexCache.size > 500) regexCache.clear()
  regexCache.set(pattern, regex)
  return regex
}

/**
 * 判断条目是否命中给定的排除规则之一。
 *
 * @param relativePath 条目相对项目根的规范路径（正斜杠分隔，如「dist」或「src/index.ts」）
 * @param name 条目自身的名称（如「node_modules」或「index.ts」）
 * @param isDirectory 该条目是否为目录
 * @param patterns 当前生效的排除规则列表
 */
export function isFileExcluded(
  relativePath: string,
  name: string,
  isDirectory: boolean,
  patterns: readonly string[]
): boolean {
  if (patterns.length === 0) return false

  for (const raw of patterns) {
    const pattern = raw.trim()
    if (pattern === '') continue

    // 1. 通配符模式
    const glob = compileGlob(pattern)
    if (glob !== null) {
      // 模式中不含斜杠时（如 *.log），直接对条目名测试
      if (!pattern.includes('/')) {
        if (glob.test(name)) return true
      } else {
        // 模式含斜杠时对相对路径测试
        if (glob.test(relativePath)) return true
      }
      continue
    }

    // 2. 目录限定规则（如以 / 结尾或以 / 开头）
    const cleanPattern = pattern.replace(/^\/+/u, '').replace(/\/+$/u, '')
    if (cleanPattern === '') continue

    // 模式不含斜杠时，只匹配名字（无论文件还是目录）
    if (!pattern.includes('/')) {
      if (name.toLowerCase() === cleanPattern.toLowerCase()) return true
      continue
    }

    // 模式包含斜杠时，按项目相对路径比对
    const normalizedRelative = relativePath.toLowerCase()
    const targetPattern = cleanPattern.toLowerCase()
    if (normalizedRelative === targetPattern) return true
    if (normalizedRelative.startsWith(`${targetPattern}/`)) return true
  }

  return false
}
