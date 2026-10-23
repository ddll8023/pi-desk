/** 相对时间文案：会话行与提交历史共用同一套刻度，只区分刚刚、分钟、小时、昨天、天数与更早的日期。 */
export function formatRelativeTime(timestamp: number, now: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '时间未知'
  const elapsed = now - timestamp
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  const days = Math.floor(elapsed / 86_400_000)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}
