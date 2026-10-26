/**
 * 目录监听纯逻辑的单元测试：监听集合的归一与截断、集合差异，以及合并窗口与 overflow 降级。
 *
 * 只测不碰磁盘的部分：真实 `fs.watch` 的时序依赖平台，留在运行期观察。时钟与定时器按虚拟时间注入，
 * 因此合并窗口（150ms）与最大等待（500ms）可以在毫秒级内断言完。
 *
 * 运行：`npm test`（Node 内置测试运行器，直接跑 TypeScript，无需额外依赖）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROJECT_DIRECTORY_WATCH_LIMIT } from '../../shared/project-file-api.ts'
import {
  createDirectoryBatcher,
  normalizeWatchDirectories,
  planWatchDirectories
} from './project-directory-watcher.ts'
import type { DirectoryBatch } from './project-directory-watcher.ts'

/** 虚拟时钟与定时器：`advance` 按到期顺序执行回调，用于断言合并窗口。 */
function createFakeTimers(): {
  readonly now: () => number
  readonly schedule: (run: () => void, delayMs: number) => unknown
  readonly cancel: (handle: unknown) => void
  readonly advance: (delayMs: number) => void
} {
  let current = 0
  let nextId = 1
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>()

  return {
    now: () => current,
    schedule: (run, delayMs) => {
      const id = nextId
      nextId += 1
      timers.set(id, { at: current + delayMs, run })
      return id
    },
    cancel: (handle) => {
      if (typeof handle === 'number') timers.delete(handle)
    },
    advance: (delayMs) => {
      const target = current + delayMs
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)
        const first = due[0]
        if (first === undefined) break
        timers.delete(first[0])
        current = first[1].at
        first[1].run()
      }
      current = target
    }
  }
}

test('归一监听集合：去重、丢弃越界与绝对路径、按上限截断', () => {
  const directories = ['', 'src', './src/', 'src/components', '../escape', '/etc', 'C:\\Windows', '.git']
  assert.deepEqual(normalizeWatchDirectories(directories), ['', 'src', 'src/components', '.git'])

  const many = Array.from({ length: PROJECT_DIRECTORY_WATCH_LIMIT + 20 }, (_, index) => `dir-${index}`)
  assert.equal(normalizeWatchDirectories(many).length, PROJECT_DIRECTORY_WATCH_LIMIT)
})

test('监听集合差异：只报新增与移除，保留项不动', () => {
  const plan = planWatchDirectories(['', 'src', 'docs'], ['', 'src', 'test'])
  assert.deepEqual(plan.added, ['test'])
  assert.deepEqual(plan.removed, ['docs'])
})

test('合并窗口：窗口内的连续事件收成一批', () => {
  const timers = createFakeTimers()
  const batches: DirectoryBatch[] = []
  const batcher = createDirectoryBatcher({
    trailingMs: 150,
    maxWaitMs: 500,
    limit: 200,
    flush: (batch) => batches.push(batch),
    now: timers.now,
    schedule: timers.schedule,
    cancel: timers.cancel
  })

  batcher.request('src')
  timers.advance(100)
  batcher.request('src/components')
  assert.equal(batches.length, 0)

  timers.advance(150)
  assert.deepEqual(batches, [{ directories: ['src', 'src/components'], overflow: false }])
})

test('最大等待：持续事件也必须在首个事件后 500ms 内发一批', () => {
  const timers = createFakeTimers()
  const batches: DirectoryBatch[] = []
  const batcher = createDirectoryBatcher({
    trailingMs: 150,
    maxWaitMs: 500,
    limit: 200,
    flush: (batch) => batches.push(batch),
    now: timers.now,
    schedule: timers.schedule,
    cancel: timers.cancel
  })

  batcher.request('a')
  for (let elapsed = 100; elapsed <= 400; elapsed += 100) {
    timers.advance(100)
    batcher.request(`dir-${elapsed}`)
  }
  // 首个事件之后 500ms 到期：此时即使还在持续变化也必须发出去。
  timers.advance(100)
  assert.equal(batches.length, 1)
  assert.equal(batches[0]?.overflow, false)
  assert.equal(batches[0]?.directories.length, 5)
})

test('批内目录触顶：降级成一条 overflow，不带目录', () => {
  const timers = createFakeTimers()
  const batches: DirectoryBatch[] = []
  const batcher = createDirectoryBatcher({
    trailingMs: 150,
    maxWaitMs: 500,
    limit: 3,
    flush: (batch) => batches.push(batch),
    now: timers.now,
    schedule: timers.schedule,
    cancel: timers.cancel
  })

  batcher.request('a')
  batcher.request('b')
  batcher.request('c')
  assert.deepEqual(batches, [{ directories: [], overflow: true }])
  timers.advance(500)
  assert.equal(batches.length, 1)
})

test('清空待发批次后仍可继续登记并发送', () => {
  const timers = createFakeTimers()
  const batches: DirectoryBatch[] = []
  const batcher = createDirectoryBatcher({
    trailingMs: 150,
    maxWaitMs: 500,
    limit: 200,
    flush: (batch) => batches.push(batch),
    now: timers.now,
    schedule: timers.schedule,
    cancel: timers.cancel
  })

  batcher.request('src')
  batcher.clear()
  timers.advance(200)
  assert.deepEqual(batches, [])

  batcher.request('docs')
  timers.advance(150)
  assert.deepEqual(batches, [{ directories: ['docs'], overflow: false }])
})
