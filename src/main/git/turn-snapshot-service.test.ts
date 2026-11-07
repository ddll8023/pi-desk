/** 轮次快照纯逻辑的单元测试：从提交标题提取 messageId，以及在提交链上定位回退目标。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findRevertTargetCommit, parseTurnMessageIdFromSubject } from './turn-snapshot-service.ts'

describe('parseTurnMessageIdFromSubject', () => {
  it('正确从快照前缀中提取 messageId', () => {
    assert.equal(parseTurnMessageIdFromSubject('pi-desk: turn-msg_123456'), 'msg_123456')
    assert.equal(parseTurnMessageIdFromSubject('  pi-desk: turn-turn-abc-def  '), 'turn-abc-def')
  })

  it('非快照前缀或空串返回 null', () => {
    assert.equal(parseTurnMessageIdFromSubject('feat: normal commit'), null)
    assert.equal(parseTurnMessageIdFromSubject('pi-desk: turn-'), null)
    assert.equal(parseTurnMessageIdFromSubject(''), null)
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
    assert.deepEqual(findRevertTargetCommit(commits, 'msg_3'), {
      targetHash: 'commit_2',
      matchedCommitHash: 'commit_3'
    })
  })

  it('回退到中间轮次（msg_2）时，目标为它的父提交（commit_1）', () => {
    assert.deepEqual(findRevertTargetCommit(commits, 'msg_2'), {
      targetHash: 'commit_1',
      matchedCommitHash: 'commit_2'
    })
  })

  it('回退到第一轮次（msg_1）时，目标为基准提交（base_commit）', () => {
    assert.deepEqual(findRevertTargetCommit(commits, 'msg_1'), {
      targetHash: 'base_commit',
      matchedCommitHash: 'commit_1'
    })
  })

  it('未匹配到目标 messageId 时返回 null', () => {
    assert.equal(findRevertTargetCommit(commits, 'non_existent_msg'), null)
  })
})
