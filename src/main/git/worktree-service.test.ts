import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { parseWorktreeListPorcelain } from './worktree-service'

describe('parseWorktreeListPorcelain', () => {
  const mainRepo = resolve('/test/repo')

  it('空文本输出空数组', () => {
    expect(parseWorktreeListPorcelain('', mainRepo)).toEqual([])
    expect(parseWorktreeListPorcelain('   \n\n  ', mainRepo)).toEqual([])
  })

  it('正确解析单个主工作树', () => {
    const stdout = [
      `worktree ${mainRepo}`,
      'HEAD 0123456789abcdef0123456789abcdef01234567',
      'branch refs/heads/main',
      ''
    ].join('\n')

    const result = parseWorktreeListPorcelain(stdout, mainRepo)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
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
    expect(result).toHaveLength(4)

    // 主工作树
    expect(result[0].path).toBe(wt1)
    expect(result[0].branch).toBe('main')
    expect(result[0].isMain).toBe(true)
    expect(result[0].isLocked).toBe(false)

    // 隔离分支工作树
    expect(result[1].path).toBe(wt2)
    expect(result[1].branch).toBe('feature/feat-1')
    expect(result[1].isMain).toBe(false)
    expect(result[1].isLocked).toBe(false)

    // detached + prunable
    expect(result[2].path).toBe(wt3)
    expect(result[2].branch).toBeNull()
    expect(result[2].isMain).toBe(false)
    expect(result[2].isPrunable).toBe(true)

    // locked + reason
    expect(result[3].path).toBe(wt4)
    expect(result[3].branch).toBe('experiment')
    expect(result[3].isMain).toBe(false)
    expect(result[3].isLocked).toBe(true)
    expect(result[3].lockReason).toBe('Reason for lock in tests')
  })
})
