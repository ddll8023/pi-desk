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

test('主次动作指向同一落点判为不合规', () => {
  assert.equal(parsePresentCardView(draft({ secondaryAction: { id: 'expert.save', label: '再保存' } })), null)
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
