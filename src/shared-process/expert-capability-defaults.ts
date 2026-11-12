/**
 * 专家能力默认基线的读写：一份放在产品 agent 目录下的小 JSON，主进程与 SDK 宿主进程共用。
 *
 * 放文件而不是桌面配置中心，是因为会话装配发生在另一个进程里，它拿不到主进程的配置对象；
 * 文件随产品 agent 目录一起迁移，与专家定义同处一处，也不承载长文本。
 * 读取一律容错：文件缺失、损坏或字段不合法都按「不限制」处理，不因为一份可选配置让会话起不来；
 * 写入走临时文件加改名，避免中断时留下半份基线。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_EXPERT_DEFAULTS_ENTRIES, isSkillReference } from '../shared/experts-api'
import type { ExpertCapabilityDefaults } from './expert-definitions'

/** 基线文件名；与专家定义同在产品 agent 目录根下。 */
export const EXPERT_CAPABILITY_DEFAULTS_FILE = 'capability-defaults.json'
/** 单个基线文件的读取上限：只装两串标识，超出说明被写坏了。 */
const MAX_DEFAULTS_BYTES = 64 * 1024

/** 不做任何限制的基线：等于「全部可用」，与没有这份文件时行为一致。 */
export const UNRESTRICTED_CAPABILITY_DEFAULTS: ExpertCapabilityDefaults = { skills: null, mcpServers: null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 去重并保留原顺序；写法不合法的条目直接丢弃，不让一份手写文件把整个基线作废。 */
function normalizeList(value: unknown): readonly string[] | null {
  if (value === null) return null
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  for (const item of value) {
    if (!isSkillReference(item)) continue
    if (seen.size >= MAX_EXPERT_DEFAULTS_ENTRIES) break
    seen.add(item)
  }
  return [...seen]
}

/** 任意形状归一化成可用的基线；两个维度各自独立回退，不互相拖累。 */
export function normalizeCapabilityDefaults(value: unknown): ExpertCapabilityDefaults {
  if (!isRecord(value)) return UNRESTRICTED_CAPABILITY_DEFAULTS
  return { skills: normalizeList(value.skills), mcpServers: normalizeList(value.mcpServers) }
}

/** 读取基线；文件不存在、超限或解析失败都按「不限制」处理，由调用方决定是否提示。 */
export function readExpertCapabilityDefaults(agentDir: string): ExpertCapabilityDefaults {
  const filePath = join(agentDir, EXPERT_CAPABILITY_DEFAULTS_FILE)
  let text: string
  try {
    const info = statSync(filePath)
    if (!info.isFile() || info.size > MAX_DEFAULTS_BYTES) return UNRESTRICTED_CAPABILITY_DEFAULTS
    text = readFileSync(filePath, 'utf8')
  } catch {
    return UNRESTRICTED_CAPABILITY_DEFAULTS
  }
  try {
    return normalizeCapabilityDefaults(JSON.parse(text))
  } catch {
    return UNRESTRICTED_CAPABILITY_DEFAULTS
  }
}

/**
 * 写入基线；返回归一化后实际落盘的值，页面据此确认自己看到的与生效的一致。
 * 目录不存在时新建，写入中断不会留下半份文件。
 */
export function writeExpertCapabilityDefaults(agentDir: string, value: unknown): ExpertCapabilityDefaults {
  const defaults = normalizeCapabilityDefaults(value)
  const filePath = join(agentDir, EXPERT_CAPABILITY_DEFAULTS_FILE)
  const tempPath = `${filePath}.tmp`
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(tempPath, `${JSON.stringify(defaults, null, 2)}\n`, 'utf8')
  try {
    renameSync(tempPath, filePath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
  return defaults
}
