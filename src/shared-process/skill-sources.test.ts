/**
 * 技能来源目录清单的单元测试。
 *
 * 运行：`npm test`（Node 内置测试运行器，直接跑 TypeScript，无需额外依赖）。
 * 全部夹具建在系统临时目录内：不读也不写用户的 agent 目录或共享技能目录。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  collectSkillSources,
  globalSkillDirectories,
  isUnderSkillDirectory,
  projectSkillDirectories
} from './skill-sources.ts'

interface TempRoot {
  readonly dir: string
  readonly cleanup: () => void
}

function createTempRoot(prefix: string): TempRoot {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 建目录并放一份最小技能入口；只用于验证目录被枚举，不验证技能内容。 */
function createSkill(directory: string, id: string): void {
  mkdirSync(join(directory, id), { recursive: true })
  writeFileSync(join(directory, id, 'SKILL.md'), `---\nname: ${id}\n---\n`, 'utf8')
}

test('全局来源按 agent 目录、共享目录顺序给出，缺失的跳过', () => {
  const root = createTempRoot('pi-desk-skill-sources-global-')
  try {
    const agentDir = join(root.dir, 'agent')
    const sharedDir = join(root.dir, 'shared')
    createSkill(join(agentDir, 'skills'), 'product-skill')
    createSkill(join(sharedDir, 'skills'), 'shared-skill')
    assert.deepEqual(globalSkillDirectories({ agentDir, sharedAgentDir: sharedDir }), [
      join(agentDir, 'skills'),
      join(sharedDir, 'skills')
    ])
    assert.deepEqual(globalSkillDirectories({ agentDir, sharedAgentDir: join(root.dir, 'missing') }), [
      join(agentDir, 'skills')
    ])
  } finally {
    root.cleanup()
  }
})

test('共享目录与 agent 目录相同时只算一份', () => {
  const root = createTempRoot('pi-desk-skill-sources-same-')
  try {
    const agentDir = join(root.dir, 'agent')
    createSkill(join(agentDir, 'skills'), 'only-skill')
    assert.deepEqual(globalSkillDirectories({ agentDir, sharedAgentDir: agentDir }), [join(agentDir, 'skills')])
  } finally {
    root.cleanup()
  }
})

test('项目来源收 .pi/skills 与逐级 .agents/skills，遇到 .git 停止', () => {
  const root = createTempRoot('pi-desk-skill-sources-project-')
  try {
    const repo = join(root.dir, 'repo')
    const cwd = join(repo, 'packages', 'app')
    createSkill(join(cwd, '.pi', 'skills'), 'project-pi')
    createSkill(join(cwd, '.agents', 'skills'), 'project-agents')
    createSkill(join(repo, '.agents', 'skills'), 'repo-agents')
    // 仓库根之外的祖先目录不应被收集。
    createSkill(join(root.dir, '.agents', 'skills'), 'outside-agents')
    mkdirSync(join(repo, '.git'), { recursive: true })

    assert.deepEqual(projectSkillDirectories({ cwd, sharedAgentDir: join(root.dir, 'shared') }), [
      join(cwd, '.pi', 'skills'),
      join(cwd, '.agents', 'skills'),
      join(repo, '.agents', 'skills')
    ])
  } finally {
    root.cleanup()
  }
})

test('与共享用户级目录同路径的 .agents/skills 被排除', () => {
  const root = createTempRoot('pi-desk-skill-sources-shared-')
  try {
    const home = join(root.dir, 'home')
    const cwd = join(home, 'project')
    createSkill(join(home, '.agents', 'skills'), 'user-skill')
    createSkill(join(cwd, '.agents', 'skills'), 'project-skill')
    mkdirSync(join(home, '.git'), { recursive: true })

    // 共享目录就指在 home，home/.agents/skills 已在全局来源里，项目侧不再重复。
    assert.deepEqual(projectSkillDirectories({ cwd, sharedAgentDir: home }), [
      join(cwd, '.agents', 'skills')
    ])
  } finally {
    root.cleanup()
  }
})

test('项目未受信时不给出任何项目来源', () => {
  const root = createTempRoot('pi-desk-skill-sources-trust-')
  try {
    const agentDir = join(root.dir, 'agent')
    const sharedDir = join(root.dir, 'shared')
    const cwd = join(root.dir, 'project')
    createSkill(join(sharedDir, 'skills'), 'shared-skill')
    createSkill(join(cwd, '.pi', 'skills'), 'project-skill')

    const untrusted = collectSkillSources({ agentDir, sharedAgentDir: sharedDir, cwd, projectTrusted: false })
    assert.deepEqual(untrusted.project, [])
    assert.deepEqual(untrusted.global, [join(sharedDir, 'skills')])

    const trusted = collectSkillSources({ agentDir, sharedAgentDir: sharedDir, cwd, projectTrusted: true })
    assert.deepEqual(trusted.project, [join(cwd, '.pi', 'skills')])
  } finally {
    root.cleanup()
  }
})

test('技能文件归属判断按路径前缀，不误认同名前缀的兄弟目录', () => {
  const root = createTempRoot('pi-desk-skill-sources-under-')
  try {
    const projectDir = join(root.dir, 'project', '.pi', 'skills')
    const sibling = join(root.dir, 'project', '.pi', 'skills-extra')
    assert.equal(isUnderSkillDirectory(join(projectDir, 'demo', 'SKILL.md'), [projectDir]), true)
    assert.equal(isUnderSkillDirectory(projectDir, [projectDir]), true)
    assert.equal(isUnderSkillDirectory(join(sibling, 'demo', 'SKILL.md'), [projectDir]), false)
    assert.equal(isUnderSkillDirectory(join(projectDir, 'demo', 'SKILL.md'), []), false)
  } finally {
    root.cleanup()
  }
})
