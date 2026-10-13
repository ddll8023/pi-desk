/**
 * 用户消息文本里的机器注入内容：Pi 在提交 Prompt 时会往文本里塞两类不是用户输入的内容，
 * 展示、摘要、复制与会话预览都必须把它们和用户实际输入分开。
 *
 * 1. 技能展开块：`/skill:<名称> <参数>` 被展开成 `<skill name="…" location="…">\n…\n</skill>`，
 *    可选再接一段用户追加文本（见 `@earendil-works/pi-coding-agent` 的 agent-session
 *    `_expandSkillCommand` 与 `parseSkillBlock`）。
 * 2. 图片坐标说明行：图片被缩放时追加在文本末尾的 `[Image: original WxH, …]`（见
 *    `_normalizePromptImages` 与 `formatDimensionNote`）。
 *
 * 两类的判定都在本模块集中实现，渲染端与会话预览共用同一份，避免各自写一份正则或前缀漂移；
 * 只识别与剥离，不改写其余内容，也不猜测结构不完整的块。技能判定正则与 Pi 逐字一致。
 */

/** Pi 注入的图片坐标说明行前缀；这类行不是用户输入。 */
const IMAGE_MARKER_PREFIX = '[Image:'

/** 技能调用块的解析结果；`userMessage` 为 null 表示这条消息只有技能调用。 */
export interface ParsedSkillBlock {
  readonly name: string
  readonly location: string
  /** 技能正文；首行是 Pi 注入的相对路径说明，原样保留，不在这里增删。 */
  readonly content: string
  /** 追加在技能块之后的用户文本；没有追加文本时为 null。 */
  readonly userMessage: string | null
}

const SKILL_BLOCK_PATTERN = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/

export function parseSkillBlock(text: string): ParsedSkillBlock | null {
  const match = SKILL_BLOCK_PATTERN.exec(text)
  if (match === null) return null
  const userMessage = match[4]?.trim() ?? ''
  return {
    name: match[1] ?? '',
    location: match[2] ?? '',
    content: match[3] ?? '',
    userMessage: userMessage === '' ? null : userMessage
  }
}

/**
 * 去掉 Pi 注入的图片坐标说明行，并清掉它们留下的尾部空行。
 * 其余行与行内内容原样保留：气泡按纯文本换行展示，折叠空白会改变用户输入。
 */
export function stripImageMarkerLines(text: string): string {
  if (!text.includes(IMAGE_MARKER_PREFIX)) return text
  const lines = text.split('\n').filter((line) => !line.trimStart().startsWith(IMAGE_MARKER_PREFIX))
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()
  return lines.join('\n')
}
