/**
 * 专家定义解析、双来源合并与结构化诊断的单元测试。
 *
 * 运行：`npm test`（Node 内置测试运行器，直接跑 TypeScript，无需额外依赖）。
 * 全部夹具建在系统临时目录内：不读也不写用户 agent 目录，不需要 Electron 或 SDK。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadExpertCatalog } from './expert-definitions.ts'
import type { ExpertCatalog } from './expert-definitions.ts'

interface TempRoot {
  readonly dir: string
  readonly cleanup: () => void
}

/** 每个用例一个临时目录，结束时统一清理。 */
function createTempRoot(prefix: string): TempRoot {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function writeFile(root: string, name: string, text: string): string {
  const path = join(root, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

/** 一份形状合法的定义；`mutate` 用于制造结构问题。 */
function definition(input: {
  readonly id: string
  readonly displayName?: string
  readonly summary?: string
  readonly skills?: string
  readonly body?: string
  readonly name?: string
}): string {
  return [
    '---',
    `name: ${input.name ?? input.id}`,
    `displayName: ${input.displayName ?? '新闻调研专家'}`,
    `summary: ${input.summary ?? '按日期检索当日热点。'}`,
    `skills: ${input.skills ?? '[]'}`,
    '---',
    '',
    input.body ?? '# 正文\n\n## 工作流程\n\n1. 检索。'
  ].join('\n')
}

/** 内置与自定义两来源各放一份合法专家，技能上下文默认只有 memory 可见。 */
function createCatalog(temp: TempRoot, userFiles: Readonly<Record<string, string>> = {}): ExpertCatalog {
  const builtinPath = writeFile(temp.dir, 'builtin/experts/news-research/expert.md', definition({ id: 'news-research' }))
  for (const [name, text] of Object.entries(userFiles)) writeFile(temp.dir, `user/experts/${name}`, text)
  return loadExpertCatalog({
    builtin: [{ id: 'news-research', filePath: builtinPath }],
    userDirectory: join(temp.dir, 'user', 'experts'),
    availableSkillIds: ['memory'],
    subAgentOnlySkillIds: ['sub-agent-review']
  })
}

test('内置与自定义专家合并，正文与技能引用按声明解析', () => {
  const temp = createTempRoot('pi-desk-expert-')
  try {
    const catalog = createCatalog(temp, {
      'my-expert/expert.md': definition({ id: 'my-expert', skills: '[memory]', body: '# 我的专家\n\n## 输出规范\n\n用表格。' })
    })
    assert.deepEqual(catalog.issues, [])
    assert.deepEqual(catalog.experts.map(item => [item.id, item.source]),
      [['news-research', 'builtin'], ['my-expert', 'user']])
    const user = catalog.experts[1]
    assert.deepEqual(user?.skillIds, ['memory'])
    assert.match(user?.body ?? '', /^# 我的专家/u)
    assert.deepEqual(user?.unavailableSkillIds, [])
  } finally {
    temp.cleanup()
  }
})

test('声明标识与目录名不一致、正文为空都按无效定义处理', () => {
  const temp = createTempRoot('pi-desk-expert-')
  try {
    const catalog = createCatalog(temp, {
      'wrong-name/expert.md': definition({ id: 'wrong-name', name: 'my-expert' }),
      'empty-body/expert.md': definition({ id: 'empty-body', body: '' })
    })
    assert.deepEqual(catalog.experts.map(item => item.id), ['news-research'])
    assert.deepEqual(catalog.issues.map(item => [item.kind, item.expertId]),
      [['definition-invalid', 'empty-body'], ['definition-invalid', 'wrong-name']])
  } finally {
    temp.cleanup()
  }
})

test('自定义与内置同标识时冲突，内置不被覆盖', () => {
  const temp = createTempRoot('pi-desk-expert-')
  try {
    const catalog = createCatalog(temp, {
      'news-research/expert.md': definition({ id: 'news-research', displayName: '同名自定义' })
    })
    assert.deepEqual(catalog.experts.map(item => [item.id, item.source]), [['news-research', 'builtin']])
    assert.deepEqual(catalog.issues.map(item => item.kind), ['id-conflict'])
  } finally {
    temp.cleanup()
  }
})

test('引用子代理专用技能与不存在的技能都只标注，专家仍保留', () => {
  const temp = createTempRoot('pi-desk-expert-')
  try {
    const catalog = createCatalog(temp, {
      'my-expert/expert.md': definition({ id: 'my-expert', skills: '[memory, sub-agent-review, missing-skill]' })
    })
    const user = catalog.experts.find(item => item.id === 'my-expert')
    assert.deepEqual(user?.unavailableSkillIds, ['sub-agent-review', 'missing-skill'])
    assert.deepEqual(catalog.issues.map(item => [item.kind, item.skillId]), [
      ['skill-reference-sub-agent', 'sub-agent-review'],
      ['skill-reference-missing', 'missing-skill']
    ])
  } finally {
    temp.cleanup()
  }
})

test('自定义目录不存在时只有内置专家，且不产生诊断', () => {
  const temp = createTempRoot('pi-desk-expert-')
  try {
    const builtinPath = writeFile(temp.dir, 'builtin/experts/news-research/expert.md', definition({ id: 'news-research' }))
    const catalog = loadExpertCatalog({
      builtin: [{ id: 'news-research', filePath: builtinPath }],
      userDirectory: join(temp.dir, 'missing'),
      availableSkillIds: [],
      subAgentOnlySkillIds: []
    })
    assert.deepEqual(catalog.experts.map(item => item.id), ['news-research'])
    assert.deepEqual(catalog.issues, [])
  } finally {
    temp.cleanup()
  }
})
