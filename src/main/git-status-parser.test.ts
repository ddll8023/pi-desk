/**
 * porcelain v2 解析器的单元测试：覆盖分块到达、CRLF、重命名、冲突、中文与转义路径、上限截断。
 *
 * 运行：`npm test`（Node 内置测试运行器，直接跑 TypeScript，无需额外依赖）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGitStatusParser, decodeGitPath, parseGitStatusOutput } from './git-status-parser.ts'

const BRANCH_HEADERS = [
  '# branch.oid 1234567890abcdef1234567890abcdef12345678',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +1 -2'
].join('\n')

test('解析分支头与工作区改动', () => {
  const snapshot = parseGitStatusOutput([
    BRANCH_HEADERS,
    '1 .M N... 100644 100644 100644 aaaa bbbb src/app.ts',
    '? notes.txt',
    ''
  ].join('\n'))

  assert.equal(snapshot.head, '1234567890abcdef1234567890abcdef12345678')
  assert.equal(snapshot.branch, 'main')
  assert.equal(snapshot.detached, false)
  assert.deepEqual(snapshot.upstream, { name: 'origin/main', ahead: 1, behind: 2 })
  assert.deepEqual(snapshot.entries, [
    { path: 'src/app.ts', area: 'unstaged', status: 'modified' },
    { path: 'notes.txt', area: 'untracked', status: 'untracked' }
  ])
  assert.equal(snapshot.totalCount, 2)
  assert.equal(snapshot.truncated, false)
})

test('索引与工作区同时改动会拆成两条条目', () => {
  const snapshot = parseGitStatusOutput('1 MM N... 100644 100644 100644 aaaa bbbb both.txt\n')
  assert.deepEqual(snapshot.entries, [
    { path: 'both.txt', area: 'staged', status: 'modified' },
    { path: 'both.txt', area: 'unstaged', status: 'modified' }
  ])
})

test('重命名记录带原路径，且只在索引侧产出条目', () => {
  const snapshot = parseGitStatusOutput('2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.txt\told name.txt\n')
  assert.deepEqual(snapshot.entries, [
    { path: 'new name.txt', area: 'staged', status: 'renamed', oldPath: 'old name.txt' }
  ])
})

test('冲突记录给出冲突类型，且不进已暂存区域', () => {
  const snapshot = parseGitStatusOutput([
    'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.txt',
    'u DD N... 100644 100644 100644 100644 aaaa bbbb cccc gone.txt',
    'u DU N... 100644 100644 100644 100644 aaaa bbbb cccc ours-deleted.txt',
    'u AA N... 100644 100644 100644 100644 aaaa bbbb cccc added.txt',
    ''
  ].join('\n'))

  assert.deepEqual(snapshot.entries, [
    { path: 'conflict.txt', area: 'unstaged', status: 'modified', conflictKind: 'both_modified' },
    { path: 'gone.txt', area: 'unstaged', status: 'deleted', conflictKind: 'both_deleted' },
    // 只有「双方都删除」能确定文件不在工作区，其余不对称冲突按修改展示（真实含义由冲突角标承担）。
    { path: 'ours-deleted.txt', area: 'unstaged', status: 'modified', conflictKind: 'deleted_by_us' },
    { path: 'added.txt', area: 'unstaged', status: 'modified', conflictKind: 'both_added' }
  ])
})

test('未跟踪与忽略的记录分别进入条目与忽略清单', () => {
  const snapshot = parseGitStatusOutput('? 新 文件.md\n! dist/\n')
  assert.deepEqual(snapshot.entries, [{ path: '新 文件.md', area: 'untracked', status: 'untracked' }])
  assert.deepEqual(snapshot.ignoredPaths, ['dist/'])
})

test('C 风格转义的路径按 UTF-8 字节还原', () => {
  assert.equal(decodeGitPath('"caf\\303\\251.txt"'), 'café.txt')
  assert.equal(decodeGitPath('"tab\\there.txt"'), 'tab\there.txt')
  assert.equal(decodeGitPath('"quote\\"inside.txt"'), 'quote"inside.txt')
  // 未加引号的路径原样返回。
  assert.equal(decodeGitPath('plain/path.txt'), 'plain/path.txt')
})

test('CRLF 输出不会在路径末尾留下回车', () => {
  const snapshot = parseGitStatusOutput('1 .M N... 100644 100644 100644 aaaa bbbb crlf.txt\r\n? new.txt\r\n')
  assert.deepEqual(snapshot.entries.map((entry) => entry.path), ['crlf.txt', 'new.txt'])
})

test('分块到达时跨块的行仍然被正确拼接', () => {
  const parser = createGitStatusParser(0)
  const output = `${BRANCH_HEADERS}\n1 .M N... 100644 100644 100644 aaaa bbbb split.txt\n`
  // 故意在一块中间切断路径。
  parser.update(output.slice(0, output.length - 6))
  assert.equal(parser.update(output.slice(output.length - 6)), false)
  const snapshot = parser.finish()
  assert.deepEqual(snapshot.entries, [{ path: 'split.txt', area: 'unstaged', status: 'modified' }])
})

test('条目数超过上限时截断并报告总量下界', () => {
  const parser = createGitStatusParser(2)
  const stopped = parser.update([
    '1 .M N... 100644 100644 100644 aaaa bbbb a.txt',
    '1 .M N... 100644 100644 100644 aaaa bbbb b.txt',
    '1 .M N... 100644 100644 100644 aaaa bbbb c.txt',
    '1 .M N... 100644 100644 100644 aaaa bbbb d.txt',
    ''
  ].join('\n'))

  assert.equal(stopped, true)
  const snapshot = parser.finish()
  assert.equal(snapshot.entries.length, 2)
  assert.equal(snapshot.truncated, true)
  // 停掉 git 之后不再继续读，所以 totalCount 是「至少这么多」。
  assert.ok(snapshot.totalCount >= 3)
})

test('空仓库与分离 HEAD 都不编造分支名', () => {
  const empty = parseGitStatusOutput('# branch.oid (initial)\n# branch.head main\n')
  assert.equal(empty.head, null)
  assert.equal(empty.branch, 'main')

  const detached = parseGitStatusOutput('# branch.oid abcdef\n# branch.head (detached)\n')
  assert.equal(detached.branch, null)
  assert.equal(detached.detached, true)
})
