/** 设置页「专家团」分节的受限桥接：只读取团队清单与诊断；开团在会话侧完成，本桥接不暴露开团或编辑。 */
import { isTeamsListResult } from '../../../../shared/teams-api'
import type { TeamApi, TeamsListResult } from '../../../../shared/teams-api'

/** 桥接是页面唯一入口；缺失说明预加载脚本没挂上，不能当成「没有团队」处理。 */
interface TeamBridge {
  readonly listTeams: TeamApi['listTeams']
}

function bridge(): TeamBridge | null {
  const value = window.desktop as Partial<TeamBridge> | undefined
  if (value === undefined || typeof value.listTeams !== 'function') return null
  return value as TeamBridge
}

/** 桥接缺失或响应不合契约时的固定失败结果；先声明类型，避免对象字面量的 code 被拓成 string。 */
const LIST_FALLBACK: TeamsListResult = {
  ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '无法读取团队清单。' }
}

/** 统一调用包装：桥接缺失、调用抛错与响应不合契约都收敛为同一份失败结果，页面只处理一种形状。 */
export async function listTeams(): Promise<TeamsListResult> {
  const target = bridge()
  if (target === null) return LIST_FALLBACK
  try {
    const response = await target.listTeams()
    return isTeamsListResult(response) ? response : LIST_FALLBACK
  } catch {
    return LIST_FALLBACK
  }
}
