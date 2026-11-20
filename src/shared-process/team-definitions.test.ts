/**
 * 团队定义的解析、双来源合并与诊断的单元测试。
 *
 * 运行：`npm test`（Node 内置测试运行器，直接跑 TypeScript，无需额外依赖）。
 * 全部夹具建在系统临时目录内：不读也不写用户 agent 目录，不需要 Electron 或 SDK。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { loadTeamCatalog } from './team-definitions.ts'
import type { BuiltinTeam } from './team-definitions.ts'

interface TempRoot {
  readonly dir: string
  readonly cleanup: () => void
}

/** 每个用例一个临时目录，结束时统一清理。 */
function createTempRoot(prefix: string): TempRoot {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function writeFile(root: string, name: string, text: string): void {
  const path = join(root, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

/** 一份形状合法的团队定义；字段按需覆盖来制造无效定义。 */
function teamDocument(overrides: Readonly<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    name: 'delivery',
    displayName: '交付小组',
    summary: '团长拆解、成员分工执行',
    lead: 'expert-author',
    // 团长不进成员：写了也会被剔除并记诊断，夹具按合法形态给。
    members: '[reviewer]',
    ...overrides
  }
  const head = Object.entries(fields)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  return `---\n${head}\n---\n\n协作约定正文。\n`
}

test('内置与自定义团队合并，可开团判定按专家清单求值', () => {
  const temp = createTempRoot('pi-desk-team-')
  try {
    writeFile(temp.dir, 'builtin/delivery/team.md', teamDocument({ lead: 'ghost', members: '[ghost-member]' }))
    writeFile(temp.dir, 'custom/delivery/team.md', teamDocument())
    const builtin: BuiltinTeam[] = [{ id: 'delivery', filePath: join(temp.dir, 'builtin/delivery/team.md') }]
    const catalog = loadTeamCatalog({
      builtin,
      userDirectory: join(temp.dir, 'custom'),
      availableExpertIds: ['expert-author', 'reviewer']
    })
    // 内置与自定义同 id 时自定义不覆盖，内置那一份按引用失效标为不可开团。
    assert.equal(catalog.teams.length, 1)
    const team = catalog.teams[0]
    assert.equal(team?.id, 'delivery')
    assert.equal(team?.source, 'builtin')
    assert.equal(team?.ready, false)
    assert.deepEqual(catalog.issues.map(issue => issue.kind).sort(),
      ['id-conflict', 'lead-reference-missing', 'member-reference-missing'])
  } finally {
    temp.cleanup()
  }
})

test('自定义团队按目录名合并，可开团判定为真', () => {
  const temp = createTempRoot('pi-desk-team-')
  try {
    writeFile(temp.dir, 'custom/delivery/team.md', teamDocument())
    const catalog = loadTeamCatalog({
      builtin: [],
      userDirectory: join(temp.dir, 'custom'),
      availableExpertIds: ['expert-author', 'reviewer']
    })
    assert.equal(catalog.teams.length, 1)
    assert.equal(catalog.teams[0]?.source, 'user')
    assert.equal(catalog.teams[0]?.ready, true)
    assert.deepEqual(catalog.teams[0]?.memberExpertIds, ['reviewer'])
    assert.deepEqual(catalog.issues, [])
  } finally {
    temp.cleanup()
  }
})

test('目录名与声明不一致、缺团长、成员写法非法都判为无效定义', () => {
  const temp = createTempRoot('pi-desk-team-')
  try {
    writeFile(temp.dir, 'custom/renamed/team.md', teamDocument())
    writeFile(temp.dir, 'custom/no-lead/team.md', teamDocument({ name: 'no-lead', lead: '' }))
    writeFile(temp.dir, 'custom/bad-member/team.md', teamDocument({ name: 'bad-member', members: '[Member_A]' }))
    const catalog = loadTeamCatalog({
      builtin: [], userDirectory: join(temp.dir, 'custom'),
      availableExpertIds: ['expert-author', 'reviewer']
    })
    assert.deepEqual(catalog.teams, [])
    assert.deepEqual(catalog.issues.map(issue => issue.kind), [
      'definition-invalid', 'definition-invalid', 'definition-invalid'
    ])
    assert.deepEqual(catalog.issues.map(issue => issue.teamId), ['bad-member', 'no-lead', 'renamed'])
  } finally {
    temp.cleanup()
  }
})

test('团长引用失效时团队保留但不可开团，成员部分失效仍可开团', () => {
  const temp = createTempRoot('pi-desk-team-')
  try {
    writeFile(temp.dir, 'custom/lost-lead/team.md', teamDocument({ name: 'lost-lead', lead: 'ghost' }))
    writeFile(temp.dir, 'custom/partial/team.md', teamDocument({ name: 'partial', members: '[reviewer, ghost]' }))
    const catalog = loadTeamCatalog({
      builtin: [], userDirectory: join(temp.dir, 'custom'),
      availableExpertIds: ['expert-author', 'reviewer']
    })
    const lostLead = catalog.teams.find(item => item.id === 'lost-lead')
    const partial = catalog.teams.find(item => item.id === 'partial')
    assert.equal(lostLead?.ready, false)
    assert.equal(partial?.ready, true)
    assert.deepEqual(partial?.memberExpertIds, ['reviewer', 'ghost'])
    const kinds = catalog.issues.map(issue => `${issue.kind}:${issue.teamId}:${issue.expertId}`).sort()
    assert.deepEqual(kinds, ['lead-reference-missing:lost-lead:ghost', 'member-reference-missing:partial:ghost'])
  } finally {
    temp.cleanup()
  }
})

test('团长被写进成员时按团长处理，并记一条诊断', () => {
  const temp = createTempRoot('pi-desk-team-')
  try {
    writeFile(temp.dir, 'custom/delivery/team.md', teamDocument({ members: '[expert-author, reviewer]' }))
    const catalog = loadTeamCatalog({
      builtin: [], userDirectory: join(temp.dir, 'custom'),
      availableExpertIds: ['expert-author', 'reviewer']
    })
    const team = catalog.teams[0]
    assert.deepEqual(team?.memberExpertIds, ['reviewer'])
    assert.equal(team?.ready, true)
    assert.deepEqual(catalog.issues.map(issue => `${issue.kind}:${issue.teamId}:${issue.expertId}`),
      ['lead-in-members:delivery:expert-author'])
  } finally {
    temp.cleanup()
  }
})

test('没有任何可用成员时团队仍在清单里，但标为不可开团', () => {
  const temp = createTempRoot('pi-desk-team-')
  try {
    writeFile(temp.dir, 'custom/solo/team.md', teamDocument({ name: 'solo', members: '[ghost]' }))
    const catalog = loadTeamCatalog({
      builtin: [], userDirectory: join(temp.dir, 'custom'),
      availableExpertIds: ['expert-author']
    })
    assert.equal(catalog.teams[0]?.id, 'solo')
    assert.equal(catalog.teams[0]?.ready, false)
    assert.deepEqual(catalog.issues.map(issue => issue.kind).sort(),
      ['member-reference-missing', 'no-usable-member'])
  } finally {
    temp.cleanup()
  }
})
