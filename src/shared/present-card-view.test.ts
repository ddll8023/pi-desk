/**
 * 会话内卡片载荷的解析与校验单元测试。
 *
 * 运行：`npm test`（Node 内置测试运行器，直接跑 TypeScript，无需额外依赖）。
 * 只覆盖契约本身：枚举外取值必须判为不合规，界面据此降级，不猜造字段。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePresentCardView, PRESENT_CARD_LIMITS } from './present-card-view.ts'

/** 一份合法的专家定义草案卡片；各用例在它之上做单点改动。 */
function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cardType: 'expert.draft',
    title: '把日报整理成清单',
    subtitle: '按日期汇总当日要点并标出来源',
    fields: [{ label: '能力范围', value: '继承默认，排除不相关技能' }],
    body: '# 日报专家\n\n## 输入\n\n用户给出日期。',
    capability: {
      skillsMode: 'inherit',
      skillIds: ['memory'],
      mcpMode: 'only',
      mcpServerIds: ['database']
    },
    primaryAction: { id: 'expert.save', label: '保存专家' },
    secondaryAction: { id: 'copy.text', label: '复制正文' },
    ...overrides
  }
}

test('合法草案通过并归一化空段', () => {
  const parsed = parsePresentCardView(draft({ subtitle: '', body: '' }))
  assert.notEqual(parsed, null)
  assert.equal(parsed?.subtitle, null)
  assert.equal(parsed?.body, null)
  assert.equal(parsed?.fields.length, 1)
  assert.equal(parsed?.primaryAction.id, 'expert.save')
  assert.equal(parsed?.capability?.skillsMode, 'inherit')
  assert.deepEqual(parsed?.capability?.mcpServerIds, ['database'])
})

test('没有能力段时按 null 返回，由卡片回落到默认基线', () => {
  assert.equal(parsePresentCardView(draft({ capability: null }))?.capability, null)
  assert.equal(parsePresentCardView(draft({ capability: undefined }))?.capability, null)
})

test('能力段的模式未知或名单写法非法时整份判不合规', () => {
  const capability = { skillsMode: 'inherit', skillIds: [], mcpMode: 'inherit', mcpServerIds: [] }
  assert.equal(parsePresentCardView(draft({ capability: { ...capability, skillsMode: 'partial' } })), null)
  assert.equal(parsePresentCardView(draft({ capability: { ...capability, skillIds: ['bad id'] } })), null)
  assert.equal(parsePresentCardView(draft({ capability: { ...capability, mcpServerIds: 'memory' } })), null)
  assert.equal(parsePresentCardView(draft({ capability: { skillsMode: 'only', skillIds: [] } }))?.capability?.skillsMode, 'only')
})

test('能力名单去重且保持顺序', () => {
  const parsed = parsePresentCardView(draft({
    capability: { skillsMode: 'only', skillIds: ['b', 'a', 'b'], mcpMode: 'inherit', mcpServerIds: [] }
  }))
  assert.deepEqual(parsed?.capability?.skillIds, ['b', 'a'])
})

test('没有次要动作时按 null 处理', () => {
  const parsed = parsePresentCardView(draft({ secondaryAction: null }))
  assert.equal(parsed?.secondaryAction, null)
})

test('枚举外的卡片类型判为不合规', () => {
  assert.equal(parsePresentCardView(draft({ cardType: 'draft' })), null)
  assert.equal(parsePresentCardView(draft({ cardType: 'table' })), null)
  assert.equal(parsePresentCardView(draft({ cardType: '' })), null)
})

test('枚举外的动作 ID 判为不合规', () => {
  assert.equal(parsePresentCardView(draft({ primaryAction: { id: 'shell.run', label: '执行' } })), null)
})

/** 一份合法的会话交付汇总卡片；各用例在它之上做单点改动。 */
function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cardType: 'session.summary',
    title: '本轮交付汇总',
    subtitle: null,
    fields: [{ label: '涉及模块', value: '会话内卡片' }],
    body: '以上文件已完成修改。',
    files: {
      changed: ['src/shared/present-card-view.ts'],
      deleted: ['src/legacy/old.ts'],
      affected: ['docs/会话内卡片设计.md']
    },
    primaryAction: { id: 'copy.text', label: '复制清单' },
    secondaryAction: null,
    ...overrides
  }
}

test('合法交付汇总通过且组内去重保序', () => {
  const parsed = parsePresentCardView(summary({
    files: { changed: ['b.ts', 'a.ts', 'b.ts'], deleted: [], affected: ['docs/x.md'] }
  }))
  assert.notEqual(parsed, null)
  assert.equal(parsed?.cardType, 'session.summary')
  assert.deepEqual(parsed?.files?.changed, ['b.ts', 'a.ts'])
  assert.deepEqual(parsed?.files?.deleted, [])
})

test('交付汇总缺文件段时按 null 处理，由界面按无清单降级', () => {
  assert.equal(parsePresentCardView(summary({ files: undefined }))?.files, null)
})

test('文件段缺组、非数组或不是对象判为不合规', () => {
  assert.equal(parsePresentCardView(summary({ files: { changed: ['a.ts'] } })), null)
  assert.equal(parsePresentCardView(summary({ files: { changed: 'a.ts', deleted: [], affected: [] } })), null)
  assert.equal(parsePresentCardView(summary({ files: 'a.ts' })), null)
})

test('绝对路径、上跳段、反斜杠与空段判为不合规', () => {
  const files = (changed: readonly string[]): Record<string, unknown> => ({ changed, deleted: [], affected: [] })
  assert.equal(parsePresentCardView(summary({ files: files(['/etc/hosts']) })), null)
  assert.equal(parsePresentCardView(summary({ files: files(['../outside.ts']) })), null)
  assert.equal(parsePresentCardView(summary({ files: files(['src\\a.ts']) })), null)
  assert.equal(parsePresentCardView(summary({ files: files(['src//a.ts']) })), null)
  assert.equal(parsePresentCardView(summary({ files: files(['src/./a.ts']) })), null)
  assert.equal(parsePresentCardView(summary({ files: files(['']) })), null)
})

test('文件条数与单条长度超限判为不合规而不是静默截断', () => {
  const many = Array.from({ length: PRESENT_CARD_LIMITS.summaryFiles + 1 }, (_, index) => `f${index}.ts`)
  assert.equal(parsePresentCardView(summary({ files: { changed: many, deleted: [], affected: [] } })), null)
  const tooLong = `${'a'.repeat(PRESENT_CARD_LIMITS.summaryPath)}.ts`
  assert.equal(parsePresentCardView(summary({ files: { changed: [tooLong], deleted: [], affected: [] } })), null)
})

test('主次动作指向同一落点判为不合规', () => {
  assert.equal(parsePresentCardView(draft({ secondaryAction: { id: 'expert.save', label: '再保存' } })), null)
})

/** 一份合法的记忆候选卡片；各用例在它之上做单点改动。 */
function memory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cardType: 'memory.candidates',
    title: '本轮记忆候选',
    subtitle: null,
    fields: [],
    body: null,
    candidates: [
      { type: 'constraint', topic: '卡片动作只转发既有通道', content: '卡片不自建写盘路径，动作绑定既有业务通道。', rule_key: 'chat.present-card-action-boundary' },
      { type: 'progress', topic: '记忆候选卡片实现中', content: '契约与主进程通道已就绪，渲染层待实现。', status: 'active' }
    ],
    primaryAction: { id: 'memory.save', label: '保存勾选的记忆' },
    secondaryAction: { id: 'copy.text', label: '复制候选' },
    ...overrides
  }
}

test('合法记忆候选通过且保留建议字段', () => {
  const parsed = parsePresentCardView(memory())
  assert.notEqual(parsed, null)
  assert.equal(parsed?.cardType, 'memory.candidates')
  assert.equal(parsed?.candidates?.length, 2)
  assert.equal(parsed?.candidates?.[0]?.rule_key, 'chat.present-card-action-boundary')
  assert.equal(parsed?.candidates?.[1]?.status, 'active')
})

test('记忆候选缺候选段时按 null 处理，由工具层决定类型专属要求', () => {
  assert.equal(parsePresentCardView(memory({ candidates: undefined }))?.candidates, null)
  assert.equal(parsePresentCardView(memory({ candidates: null }))?.candidates, null)
})

test('候选段为空数组、非数组或条目形状非法判为不合规', () => {
  assert.equal(parsePresentCardView(memory({ candidates: [] })), null)
  assert.equal(parsePresentCardView(memory({ candidates: 'decision' })), null)
  assert.equal(parsePresentCardView(memory({ candidates: [{ type: 'decision', topic: 't', content: 'c', extra: 1 }] })), null)
  assert.equal(parsePresentCardView(memory({ candidates: [{ type: 'decision', topic: '', content: 'c' }] })), null)
})

test('候选条数与单条长度超限判为不合规', () => {
  const many = Array.from({ length: PRESENT_CARD_LIMITS.memoryCandidates + 1 }, (_, index) => ({
    type: 'fact', topic: `事实 ${index}`, content: '内容'
  }))
  assert.equal(parsePresentCardView(memory({ candidates: many })), null)
  const tooLong = { type: 'fact', topic: '标题', content: 'a'.repeat(20_001) }
  assert.equal(parsePresentCardView(memory({ candidates: [tooLong] })), null)
})

test('候选引用非法记录 ID 或未知记录类型判为不合规', () => {
  const badRef = { type: 'fact', topic: '标题', content: '内容', source_record_ids: ['not-an-id'] }
  assert.equal(parsePresentCardView(memory({ candidates: [badRef] })), null)
  const badType = { type: 'diary', topic: '标题', content: '内容' }
  assert.equal(parsePresentCardView(memory({ candidates: [badType] })), null)
})

test('记忆候选的主按钮允许 memory.save，动作枚举内新增 ID 可解析', () => {
  const parsed = parsePresentCardView(memory({ secondaryAction: null }))
  assert.equal(parsed?.primaryAction.id, 'memory.save')
  assert.equal(parsed?.secondaryAction, null)
})

test('超出上限的字段判为不合规而不是静默截断', () => {
  const tooLongBody = 'a'.repeat(PRESENT_CARD_LIMITS.body + 1)
  assert.equal(parsePresentCardView(draft({ body: tooLongBody })), null)
  const tooManyFields = Array.from({ length: PRESENT_CARD_LIMITS.fields + 1 },
    () => ({ label: '标签', value: '值' }))
  assert.equal(parsePresentCardView(draft({ fields: tooManyFields })), null)
})

test('空标题、缺少动作与缺字段的行判为不合规', () => {
  assert.equal(parsePresentCardView(draft({ title: '   ' })), null)
  assert.equal(parsePresentCardView(draft({ primaryAction: null })), null)
  assert.equal(parsePresentCardView(draft({ fields: [{ label: '' }], })), null)
})

test('非对象输入不抛异常', () => {
  assert.equal(parsePresentCardView(null), null)
  assert.equal(parsePresentCardView([]), null)
  assert.equal(parsePresentCardView('draft'), null)
})
