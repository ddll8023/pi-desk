/**
 * 外链打开的唯一入口。
 *
 * 只接受 `https:` 地址，拒绝其他 scheme、带用户信息的 URL 与超长地址；调用方只能把来自当前认证
 * 流程的地址交给这里，页面无法通过本模块打开任意 URL。打开失败按可展示错误返回，不静默忽略。
 */
import { shell } from 'electron'

/** 授权地址长度上限；超过一律拒绝，不做截断。 */
const MAX_URL_CHARS = 2_048

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
