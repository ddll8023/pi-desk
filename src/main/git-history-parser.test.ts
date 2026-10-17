/** 提交历史与提交内文件清单解析器的单元测试：字段分隔、标题含分隔符、重命名、二进制、行数关联。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDiffTreeFiles, parseGitLog } from './git-history-parser.ts'

const FIELD = '\u001f'

function logRecord(fields: {
  oid: string
  short: string
  author?: string
  email?: string
  at?: number
  parents?: string
  refs?: string
  subject: string
}): string {
  return [
    fields.oid,
    fields.short,
    fields.author ?? '张三',
    fields.email ?? 'zhang@example.com',
    String(fields.at ?? 1_700_000_000),
    fields.parents ?? '',
    fields.refs ?? '',
    fields.subject
  ].join(FIELD)
}

test('解析提交记录：字段、父提交、引用与毫秒时间', () => {
  const output = [
    logRecord({
      oid: 'a'.repeat(40),
      short: 'aaaaaaa',
      parents: `${'b'.repeat(40)} ${'c'.repeat(40)}`,
      refs: 'HEAD -> main, origin/main, tag: v1.0',
      subject: 'feat: 支持历史视图'
    }),
    logRecord({ oid: 'b'.repeat(40), short: 'bbbbbbb', subject: 'first' }),
    ''
  ].join('\0')

  const commits = parseGitLog(output)
  assert.equal(commits.length, 2)
  assert.deepEqual(commits[0], {
    oid: 'a'.repeat(40),
    shortOid: 'aaaaaaa',
    authorName: '张三',
    authorEmail: 'zhang@example.com',
    authoredAt: 1_700_000_000_000,
    parents: ['b'.repeat(40), 'c'.repeat(40)],
    refs: ['HEAD -> main', 'origin/main', 'tag: v1.0'],
    subject: 'feat: 支持历史视图'
  })
  assert.deepEqual(commits[1]?.parents, [])
  assert.deepEqual(commits[1]?.refs, [])
})

test('标题里出现字段分隔符时仍完整保留', () => {
  const subject = `weird${FIELD}title`
  const commits = parseGitLog(`${logRecord({ oid: 'c'.repeat(40), short: 'ccccccc', subject })}\0`)
  assert.equal(commits[0]?.subject, subject)
})

test('字段不足的记录被丢弃，不编造提交', () => {
  const commits = parseGitLog(['broken', `${'d'.repeat(40)}${FIELD}ddddddd\0`, ''].join('\0'))
  assert.deepEqual(commits, [])
})

test('解析提交内文件：修改、新增、重命名与行数', () => {
  const output = [
    // --raw 段
    `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\0a.txt\0`,
    `:000000 100644 ${'0'.repeat(40)} ${'3'.repeat(40)} A\0new.txt\0`,
    `:100644 100644 ${'4'.repeat(40)} ${'5'.repeat(40)} R100\0old.txt\0renamed.txt\0`,
    // --numstat 段（重命名记录的空路径后面跟原路径与新路径）
    '1\t0\ta.txt\0',
    '3\t0\tnew.txt\0',
    '0\t0\t\0old.txt\0renamed.txt\0',
    '-\t-\timage.png\0',
    ''
  ].join('')

  const files = parseDiffTreeFiles(output)
  assert.deepEqual(files, [
    { path: 'a.txt', status: 'modified', added: 1, removed: 0 },
    { path: 'new.txt', status: 'added', added: 3, removed: 0 },
    { path: 'renamed.txt', status: 'renamed', oldPath: 'old.txt', added: 0, removed: 0 }
  ])
})

test('二进制文件没有行数，条目仍然保留', () => {
  const output = [
    `:000000 100644 ${'0'.repeat(40)} ${'6'.repeat(40)} A\0image.png\0`,
    '-\t-\timage.png\0',
    ''
  ].join('')

  const files = parseDiffTreeFiles(output)
  assert.deepEqual(files, [{ path: 'image.png', status: 'added' }])
})

test('空提交（没有文件）返回空数组', () => {
  assert.deepEqual(parseDiffTreeFiles(''), [])
})
