/**
 * 项目身份的确定性派生：项目名 → UUID。
 *
 * 记忆记录的 `project_id` 需要跨机器、跨 userData 位置保持一致，因此项目 ID 不能随机生成。
 * 同一项目名在任何机器上派生出同一个 UUID；改名即换身份，历史记录要用记忆引擎的 reassign 迁移。
 * 名称先做 NFKC、去首尾空白与小写归一，避免全半角或大小写差异让同一项目产生两个身份。
 */
import { createHash } from 'node:crypto'

/** 固定命名空间：改动它会让所有项目换身份，等同于一次全量迁移。 */
const PROJECT_NAMESPACE = '7f3c1d52-9a44-4e2b-8c11-6d5b9f0a2c33'

/** 与 scripts/align-project-identity.mjs 保持同一口径；改这里必须同步脚本。 */
function normalizeProjectName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase()
}

/** 按项目名派生 UUIDv5；输出形状与随机 UUID 一致，记忆侧无需区分来源。 */
export function projectIdForName(name: string): string {
  const namespace = Buffer.from(PROJECT_NAMESPACE.replace(/-/g, ''), 'hex')
  const digest = createHash('sha1')
    .update(namespace)
    .update(Buffer.from(normalizeProjectName(name), 'utf8'))
    .digest()
  // RFC 4122：哈希前 16 字节标记为版本 5 与 RFC 变体，其余位保留。
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
