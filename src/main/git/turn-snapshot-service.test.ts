import { describe, expect, it } from 'vitest'
import {
  findRevertTargetCommit,
  parseTurnMessageIdFromSubject
} from './turn-snapshot-service'

describe('parseTurnMessageIdFromSubject', () => {
  it('正确从快照前缀中提取 messageId', () => {
    expect(parseTurnMessageIdFromSubject('pi-desk: turn-msg_123456')).toBe('msg_123456')
    expect(parseTurnMessageIdFromSubject('  pi-desk: turn-turn-abc-def  ')).toBe('turn-abc-def')
  })

  it('非快照前缀或空串返回 null', () => {
    expect(parseTurnMessageIdFromSubject('feat: normal commit')).toBeNull()
    expect(parseTurnMessageIdFromSubject('pi-desk: turn-')).toBeNull()
    expect(parseTurnMessageIdFromSubject('')).toBeNull()
  })
})

describe('findRevertTargetCommit', () => {
  const commits = [
    { hash: 'commit_3', subject: 'pi-desk: turn-msg_3' },
    { hash: 'commit_2', subject: 'pi-desk: turn-msg_2' },
    { hash: 'commit_1', subject: 'pi-desk: turn-msg_1' },
    { hash: 'base_commit', subject: 'feat: initial worktree base' }
  ]

  it('回退到最新轮次（msg_3）时，目标为它的父提交（commit_2）', () => {
    const res = findRevertTargetCommit(commits, 'msg_3')
    expect(res).toEqual({
      targetHash: 'commit_2',
      matchedCommitHash: 'commit_3'
    })
  })

  it('回退到中间轮次（msg_2）时，目标为它的父提交（commit_1）', () => {
    const res = findRevertTargetCommit(commits, 'msg_2')
    expect(res).toEqual({
      targetHash: 'commit_1',
      matchedCommitHash: 'commit_2'
    })
  })

  it('回退到第一轮次（msg_1）时，目标为基准提交（base_commit）', () => {
    const res = findRevertTargetCommit(commits, 'msg_1')
    expect(res).toEqual({
      targetHash: 'base_commit',
      matchedCommitHash: 'commit_1'
    })
  })

  it('未匹配到目标 messageId 时返回 null', () => {
    expect(findRevertTargetCommit(commits, 'non_existent_msg')).toBeNull()
  })
})
