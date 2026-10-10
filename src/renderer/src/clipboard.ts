/**
 * 复制纯文本到系统剪贴板。
 *
 * 优先使用异步剪贴板 API；它在窗口未聚焦或权限受限时会拒绝，因此回退到临时 textarea 加
 * `document.execCommand('copy')`。两条路径都不写入任何其他状态，调用方据返回值给出反馈。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return copyViaSelection(text)
  }
}

/** 回退路径：临时选中一个不可见 textarea 后执行复制命令，无论成败都移除它。 */
function copyViaSelection(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  // 只读且不可见，避免移动焦点或触发输入法。
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '0'
  area.style.width = '1px'
  area.style.height = '1px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}
