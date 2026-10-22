/**
 * 外链打开的唯一入口。
 *
 * 认证地址只接受 `https:`；文件预览里的文档链接额外允许 `http:`，两者都拒绝其他 scheme、带用户信息的
 * URL 与超长地址。打开失败按可展示错误返回，不静默忽略。
 */
import { shell } from 'electron'
import { OPEN_EXTERNAL_URL_MAX_CHARS } from '../../shared/desktop-api'

/** 授权地址长度上限；与页面契约使用同一个常量，避免两处各自定义后漂移。 */
const MAX_URL_CHARS = OPEN_EXTERNAL_URL_MAX_CHARS

export class ExternalUrlError extends Error {}

/**
 * 判断是否为可交给系统浏览器打开的授权地址。
 * 认证供应商的授权页与设备码验证页都是 https；http、file、自定义 scheme 与内嵌凭据一律拒绝。
 */
export function isOpenableAuthUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_URL_CHARS) return false

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.hostname === '') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  return true
}

/** 交给系统浏览器打开；失败时抛出可展示错误。 */
export async function openAuthUrl(value: unknown): Promise<void> {
  if (!isOpenableAuthUrl(value)) {
    throw new ExternalUrlError('拒绝打开不是 https 的地址。')
  }
  try {
    await shell.openExternal(value)
  } catch {
    throw new ExternalUrlError('无法在系统浏览器中打开授权地址。')
  }
}

/**
 * 判断是否为可交给系统浏览器打开的文档链接。
 * 文件预览里的链接来自项目文件本身，因此额外允许 `http:`，其余限制与认证地址一致。
 */
export function isOpenableDocumentUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > OPEN_EXTERNAL_URL_MAX_CHARS) return false

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (parsed.hostname === '') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  return true
}

/** 打开文件预览里的文档链接；失败时抛出可展示错误。 */
export async function openDocumentUrl(value: unknown): Promise<void> {
  if (!isOpenableDocumentUrl(value)) {
    throw new ExternalUrlError('只能打开 http 或 https 地址。')
  }
  try {
    await shell.openExternal(value)
  } catch {
    throw new ExternalUrlError('无法在系统浏览器中打开该地址。')
  }
}
