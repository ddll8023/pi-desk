/**
 * 技能候选来源的展示文案：设置页默认能力卡片与专家编辑对话框共用。
 *
 * 与主进程 `ExpertSkillCandidate.source` 一一对应，避免同一来源在不同位置叫不同名字；
 * 只做文案映射，不判断来源是否可用。
 */
import type { ExpertSkillCandidate } from '../../../shared/experts-api'

export function skillSourceLabel(source: ExpertSkillCandidate['source']): string {
  if (source === 'builtin') return '随包'
  if (source === 'product') return '产品目录'
  return '共享目录'
}
