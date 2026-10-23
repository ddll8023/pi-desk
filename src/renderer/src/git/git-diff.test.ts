/** 行级差异计算器的单元测试：单行改动、纯新增/删除、尾部追加、大文件退化。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDiffRows } from './git-diff.ts'

test('单行修改产出上下文 + 删除 + 新增', () => {
  const result = buildDiffRows('a\nb\nc\n', 'a\nB\nc\n')
  assert.deepEqual(result.rows, [
    { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
    { kind: 'remove', text: 'b', oldLine: 2, newLine: null },
    { kind: 'add', text: 'B', oldLine: null, newLine: 2 },
    { kind: 'context', text: 'c', oldLine: 3, newLine: 3 }
  ])
  assert.equal(result.added, 1)
  assert.equal(result.removed, 1)
  assert.equal(result.truncated, false)
})

test('新增文件全部按新增行处理', () => {
  const result = buildDiffRows(null, 'x\ny\n')
  assert.deepEqual(result.rows.map((row) => [row.kind, row.text, row.newLine]), [
    ['add', 'x', 1],
    ['add', 'y', 2]
  ])
  assert.equal(result.added, 2)
  assert.equal(result.removed, 0)
})

test('删除文件全部按删除行处理', () => {
  const result = buildDiffRows('x\ny\n', null)
  assert.deepEqual(result.rows.map((row) => [row.kind, row.oldLine]), [
    ['remove', 1],
    ['remove', 2]
  ])
  assert.equal(result.removed, 2)
})

test('尾部追加只产生新增行，前面的行保持上下文', () => {
  const result = buildDiffRows('a\nb\n', 'a\nb\nc\n')
  assert.deepEqual(result.rows, [
    { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
    { kind: 'context', text: 'b', oldLine: 2, newLine: 2 },
    { kind: 'add', text: 'c', oldLine: null, newLine: 3 }
  ])
  assert.equal(result.added, 1)
  assert.equal(result.removed, 0)
})

test('两侧相同时只有上下文行', () => {
  const result = buildDiffRows('a\nb\n', 'a\nb\n')
  assert.equal(result.added, 0)
  assert.equal(result.removed, 0)
  assert.equal(result.rows.length, 2)
})

test('中间区域过大时退化为整段替换并标记截断', () => {
  const before = Array.from({ length: 2500 }, (_, index) => `old-${index}`).join('\n')
  const after = Array.from({ length: 2500 }, (_, index) => `new-${index}`).join('\n')
  const result = buildDiffRows(before, after)

  assert.equal(result.truncated, true)
  assert.equal(result.removed, 2500)
  assert.equal(result.added, 2500)
})

test('空文件之间没有差异', () => {
  const result = buildDiffRows('', '')
  assert.deepEqual(result.rows, [])
  assert.equal(result.added, 0)
  assert.equal(result.removed, 0)
})
