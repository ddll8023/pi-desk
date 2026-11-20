/**
 * 成员会话目录与会话 id 的唯一定义：主进程的只读通道与 SDK 宿主的派活共用同一份拼法。
 *
 * 会话 id 由「根会话 + 成员专家」确定性推出，不落任何登记：
 * 派活始终传 `--session-id`，缺失时新建、存在时精确复用，因此同一成员在同一个根会话里
 * 永远对应同一个会话文件。少一份需要同步的状态，也就不会出现登记为空而文件已存在的情况。
 */
import { join } from 'node:path'

/** 成员会话目录：按根会话分目录，同一根会话的成员放在一起，删除时按目录一次清理。 */
export function teamSessionDirectory(rootSessionId: string, agentDir: string): string {
  return join(agentDir, 'team-sessions', rootSessionId)
}

/**
 * 成员会话 id：长度稳定、只含字母数字与连字符以外的安全字符，可直接作为文件名一部分。
 * Pi 的会话文件名是 `<时间>_<会话 id>.jsonl`，因此这个 id 必须能反查。
 */
export function teamMemberSessionId(rootSessionId: string, memberExpertId: string): string {
  return `${rootSessionId}-${memberExpertId}`
}
