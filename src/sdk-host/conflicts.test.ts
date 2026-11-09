/**
 * 扩展加载结果分级判定的单元测试：只验证结构与归属，不加载 SDK、不执行任何扩展。
 *
 * 运行：`npm test`（Node 内置测试运行器，直接跑 TypeScript）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectToolConflicts, judgeLoadedExtensions } from './conflicts.ts'
import type { LoadedExtensionLike, ProductToolOwner } from './conflicts.ts'

function extension(path: string, tools: readonly string[]): LoadedExtensionLike {
  return { path, tools: new Map(tools.map(tool => [tool, { name: tool }] as const)) }
}

const PRODUCT_PATH = '/agent-resources/extensions/pi-memory/index.ts'
const PRODUCT_PATHS = new Map([[PRODUCT_PATH, 'pi-memory']])
const PRODUCT_TOOLS: readonly ProductToolOwner[] = [
  { componentId: 'pi-memory', tool: 'memory_read', path: PRODUCT_PATH }
]

test('同名工具归首个注册者，同一路径重复列举不算冲突', () => {
  const conflicts = collectToolConflicts([
    extension('/a/index.ts', ['memory_read', 'other']),
    extension('/b/index.ts', ['memory_read']),
    extension('/b/index.ts', ['memory_read'])
  ])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0]?.tool, 'memory_read')
  assert.equal(conflicts[0]?.ownerPath, '/a/index.ts')
  assert.equal(conflicts[0]?.otherPath, '/b/index.ts')
})

test('外来路径争用产品工具名是致命项，并给出双方路径与组件标识', () => {
  const judgement = judgeLoadedExtensions({
    extensions: [extension(PRODUCT_PATH, ['memory_read']), extension('/user/extensions/pi-memory/index.ts', ['memory_read'])],
    loadErrors: [],
    productPaths: PRODUCT_PATHS,
    productTools: PRODUCT_TOOLS
  })
  assert.equal(judgement.fatal.length, 1)
  assert.equal(judgement.warnings.length, 0)
  const issue = judgement.fatal[0]
  assert.equal(issue?.kind, 'tool-conflict')
  assert.equal(issue?.componentId, 'pi-memory')
  assert.equal(issue?.tool, 'memory_read')
  assert.equal(issue?.productPath, PRODUCT_PATH)
  assert.equal(issue?.otherPath, '/user/extensions/pi-memory/index.ts')
})

test('两个外来扩展争用同一工具名只作提示，不阻断会话', () => {
  const judgement = judgeLoadedExtensions({
    extensions: [extension('/user/a/index.ts', ['shared_tool']), extension('/user/b/index.ts', ['shared_tool'])],
    loadErrors: [],
    productPaths: PRODUCT_PATHS,
    productTools: PRODUCT_TOOLS
  })
  assert.equal(judgement.fatal.length, 0)
  assert.equal(judgement.warnings.length, 1)
  assert.equal(judgement.warnings[0]?.kind, 'tool-duplicate')
  assert.equal(judgement.warnings[0]?.tool, 'shared_tool')
})

test('两个外来扩展争用产品的非必需工具名时仍带产品组件标识', () => {
  // 产品工具清单里存在、但争用双方都不是产品路径：只作提示，标识用于定位到相关组件。
  const judgement = judgeLoadedExtensions({
    extensions: [extension('/user/a/index.ts', ['memory_extra']), extension('/user/b/index.ts', ['memory_extra'])],
    loadErrors: [],
    productPaths: PRODUCT_PATHS,
    productTools: [...PRODUCT_TOOLS, { componentId: 'pi-memory', tool: 'memory_extra', path: PRODUCT_PATH }]
  })
  assert.equal(judgement.fatal.length, 0)
  assert.equal(judgement.warnings.length, 1)
  assert.equal(judgement.warnings[0]?.kind, 'tool-duplicate')
  assert.equal(judgement.warnings[0]?.componentId, 'pi-memory')
  assert.equal(judgement.warnings[0]?.productPath, null)
  assert.equal(judgement.warnings[0]?.otherPath, '/user/b/index.ts')
})

test('加载失败按路径归属：产品件致命，外来扩展只作提示', () => {
  const productFailure = judgeLoadedExtensions({
    extensions: [extension(PRODUCT_PATH, ['memory_read'])],
    loadErrors: [{ path: PRODUCT_PATH, error: 'SyntaxError: unexpected token' }],
    productPaths: PRODUCT_PATHS,
    productTools: PRODUCT_TOOLS
  })
  assert.equal(productFailure.fatal.length, 1)
  assert.equal(productFailure.fatal[0]?.kind, 'extension-load-failed')
  assert.equal(productFailure.fatal[0]?.componentId, 'pi-memory')

  const foreignFailure = judgeLoadedExtensions({
    extensions: [extension(PRODUCT_PATH, ['memory_read'])],
    loadErrors: [{ path: '/user/extensions/broken.ts', error: 'SyntaxError: unexpected token' }],
    productPaths: PRODUCT_PATHS,
    productTools: PRODUCT_TOOLS
  })
  assert.equal(foreignFailure.fatal.length, 0)
  assert.equal(foreignFailure.warnings.length, 1)
  assert.equal(foreignFailure.warnings[0]?.kind, 'extension-load-failed')
  assert.equal(foreignFailure.warnings[0]?.otherPath, '/user/extensions/broken.ts')
})

test('SDK 的冲突报告不会被重复算成加载失败', () => {
  const judgement = judgeLoadedExtensions({
    extensions: [extension(PRODUCT_PATH, ['memory_read']), extension('/user/extensions/pi-memory/index.ts', ['memory_read'])],
    loadErrors: [{ path: '/user/extensions/pi-memory/index.ts', error: `Tool "memory_read" conflicts with ${PRODUCT_PATH}` }],
    productPaths: PRODUCT_PATHS,
    productTools: PRODUCT_TOOLS
  })
  assert.equal(judgement.fatal.length, 1)
  assert.equal(judgement.fatal[0]?.kind, 'tool-conflict')
  assert.equal(judgement.warnings.length, 0)
})

test('产品件未加载时由必需工具检查兜底，不产生假的冲突结论', () => {
  const judgement = judgeLoadedExtensions({
    extensions: [extension('/user/extensions/pi-memory/index.ts', ['memory_read'])],
    loadErrors: [],
    productPaths: PRODUCT_PATHS,
    productTools: PRODUCT_TOOLS
  })
  assert.equal(judgement.fatal.length, 0)
})
