/** 文件 Markdown 的纯路径与链接规则：只生成项目相对目标，不执行文件读取或导航副作用。 */
export type FileMarkdownLinkKind = 'anchor' | 'file' | 'external' | 'copy'

/** / 表示项目根；协议、控制字符、反斜杠和越界回退都拒绝。 */
export function resolveProjectPath(reference: string, documentPath: string): string | null {
  const trimmed = reference.trim()
  if (!trimmed || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null
  let decoded: string
  try { decoded = decodeURIComponent(trimmed.split(/[?#]/, 1)[0] ?? '') } catch { return null }
  const segments = decoded.startsWith('/') ? [] : documentPath.split('/').slice(0, -1)
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') { if (!segments.length) return null; segments.pop(); continue }
    if (segment.includes('\\') || /[\u0000-\u001f]/.test(segment)) return null
    segments.push(segment)
  }
  return segments.length ? segments.join('/') : null
}

export function resolveFileMarkdownLink(reference: string, documentPath: string): { readonly path: string; readonly anchor: string | null } | null {
  const path = resolveProjectPath(reference, documentPath)
  if (!path) return null
  const index = reference.indexOf('#')
  let anchor = index < 0 ? '' : reference.slice(index + 1)
  try { anchor = decodeURIComponent(anchor) } catch { /* 无效编码按原文定位。 */ }
  return { path, anchor: anchor || null }
}

export function classifyLinkKind(target: string): FileMarkdownLinkKind {
  if (target.startsWith('#')) return 'anchor'
  if (/^https?:\/\//i.test(target)) return 'external'
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) ? 'copy' : 'file'
}

export function headingSlug(label: string): string {
  return label.toLowerCase().replace(/[`*_~[\]()]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'section'
}
