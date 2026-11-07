/** 工作树 porcelain 解析的单元测试：空输出、单工作树与多工作树的 detached／prunable／locked 状态。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolve } from 'node:path'
import { parseWorktreeListPorcelain } from './worktree-service.ts'

describe('parseWorktreeListPorcelain', () => {
  const mainRepo = resolve('/test/repo')

  it('空文本输出空数组', () => {
    assert.deepEqual(parseWorktreeListPorcelain('', mainRepo), [])
    assert.deepEqual(parseWorktreeListPorcelain('   \n\n  ', mainRepo), [])
  })

  it('正确解析单个主工作树', () => {
    const stdout = [
      `worktree ${mainRepo}`,
      'HEAD 0123456789abcdef0123456789abcdef01234567',
      'branch refs/heads/main',
      ''
    ].join('\n')

    const result = parseWorktreeListPorcelain(stdout, mainRepo)
    assert.equal(result.length, 1)
    assert.deepEqual(result[0], {
      path: mainRepo,
      branch: 'main',
      headCommit: '0123456789abcdef0123456789abcdef01234567',
      isMain: true,
      isLocked: false
    })
  })

  it('正确解析多工作树、detached HEAD、锁定与废弃状态', () => {
    const wt1 = resolve('/test/repo')
    const wt2 = resolve('/test/repo/.pi/worktrees/feat-1')
    const wt3 = resolve('/test/repo/.pi/worktrees/detached-task')
    const wt4 = resolve('/test/repo/.pi/worktrees/locked-task')

    const stdout = [
      `worktree ${wt1}`,
      'HEAD aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa',
      'branch refs/heads/main',
      '',
      `worktree ${wt2}`,
      'HEAD bbbbbbbb22222222bbbbbbbb22222222bbbbbbbb',
      'branch refs/heads/feature/feat-1',
      '',
      `worktree ${wt3}`,
      'HEAD cccccccc33333333cccccccc33333333cccccccc',
      'detached',
      'prunable gitdir points to deleted path',
      '',
      `worktree ${wt4}`,
      'HEAD dddddddd44444444dddddddd44444444dddddddd',
      'branch refs/heads/experiment',
      'locked Reason for lock in tests',
      ''
    ].join('\n')

    const result = parseWorktreeListPorcelain(stdout, mainRepo)
    assert.equal(result.length, 4)
    const [main, feature, detached, locked] = result
    assert.ok(main !== undefined && feature !== undefined && detached !== undefined && locked !== undefined)

    // 主工作树
    assert.equal(main.path, wt1)
    assert.equal(main.branch, 'main')
    assert.equal(main.isMain, true)
    assert.equal(main.isLocked, false)

    // 隔离分支工作树
    assert.equal(feature.path, wt2)
    assert.equal(feature.branch, 'feature/feat-1')
    assert.equal(feature.isMain, false)
    assert.equal(feature.isLocked, false)

    // detached + prunable
    assert.equal(detached.path, wt3)
    assert.equal(detached.branch, null)
    assert.equal(detached.isMain, false)
    assert.equal(detached.isPrunable, true)

    // locked + reason
    assert.equal(locked.path, wt4)
    assert.equal(locked.branch, 'experiment')
    assert.equal(locked.isMain, false)
    assert.equal(locked.isLocked, true)
    assert.equal(locked.lockReason, 'Reason for lock in tests')
  })
})
