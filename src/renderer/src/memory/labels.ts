/** 记忆画像的领域与依据标签：设置页列表、编辑对话框与会话注入卡片共用同一份文案，避免多处副本漂移。 */
import type { MemoryProfileBasis } from '../../../shared/memory-api'

/** 画像领域的中文名；键与引擎的 `DOMAINS` 一致。 */
export const MEMORY_DOMAIN_LABELS: Record<string, string> = {
  communication: '沟通', coding: '编码', learning: '学习', workflow: '流程'
}

/** 画像依据：`explicit` 是用户明确表达，`inferred_confirmed` 是已展示依据并确认的推测。 */
export const MEMORY_BASIS_LABELS: Record<string, string> = {
  explicit: '用户明确表达', inferred_confirmed: '已确认的推测'
}

/** 画像作用范围的中文说法：`global` 是全库生效，`domain:<领域>` 只在对应领域生效。 */
export function memoryScopeLabel(scope: string): string {
  return scope.startsWith('domain:') ? '仅本领域' : '全库'
}

/** 编辑对话框的依据选项：顺序固定，值为引擎枚举。 */
export const MEMORY_BASIS_OPTIONS = [
  { value: 'explicit', label: MEMORY_BASIS_LABELS.explicit ?? '用户明确表达' },
  { value: 'inferred_confirmed', label: MEMORY_BASIS_LABELS.inferred_confirmed ?? '已确认的推测' }
] satisfies readonly { readonly value: MemoryProfileBasis; readonly label: string }[]
