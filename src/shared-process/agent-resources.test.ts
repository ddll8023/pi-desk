/**
 * 产品 Agent 资源的清单、组件摘要、部署登记与副本身份判定的单元测试。
 *
 * 运行：`npm test`（Node 内置测试运行器，直接跑 TypeScript，无需额外依赖）。
 * 全部夹具建在系统临时目录内：不读也不写用户 agent 目录，不需要 Electron 或 SDK。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  classifyAgentResourceCopy, componentDigestOf, readAgentDeploymentManifest, readAgentResourceBundle
} from './agent-resources.ts'
import type { AgentResource, AgentResourceBundle } from './agent-resources.ts'

/** 与运行期指纹同规则：只归一化 BOM 与换行，再对文本取 sha256。 */
function digest(text: string): string {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  return createHash('sha256').update(normalized).digest('hex')
}

interface TempRoot {
  readonly dir: string
  readonly cleanup: () => void
}

/** 每个用例一个临时目录，结束时统一清理。 */
function createTempRoot(prefix: string): TempRoot {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function writeFile(root: string, name: string, text: string): void {
  const path = join(root, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

const DEMO_FILES = ['extensions/demo/index.ts', 'extensions/demo/helper.ts'] as const
const DEMO_CONTENT: Readonly<Record<string, string>> = {
  'extensions/demo/index.ts': "export const entry = 'v1'\n",
  'extensions/demo/helper.ts': "export const helper = 'v1'\n"
}

function demoResource(): AgentResource {
  return {
    id: 'demo', entry: 'extensions/demo/index.ts', files: DEMO_FILES,
    requiredTools: ['demo_tool'], subAgentOnly: false
  }
}

/** 只含一个组件的产品根：目录内是真源，测试据此换算指纹与摘要。 */
function createDemoBundle(): TempRoot & { readonly bundle: AgentResourceBundle } {
  const temp = createTempRoot('pi-desk-product-')
  const fingerprints: Record<string, string> = {}
  for (const name of DEMO_FILES) {
    writeFile(temp.dir, name, DEMO_CONTENT[name] ?? '')
    fingerprints[name] = digest(DEMO_CONTENT[name] ?? '')
  }
  const bundle: AgentResourceBundle = {
    root: temp.dir,
    extensions: [demoResource()],
    skills: [],
    memoryEngine: DEMO_FILES[0],
    fingerprints,
    componentDigests: { demo: componentDigestOf(fingerprints, DEMO_FILES) }
  }
  return { dir: temp.dir, cleanup: temp.cleanup, bundle }
}

/** 在副本根写出 demo 组件；`override` 覆盖指定文件内容，用来制造内容偏离。 */
function writeDemoCopy(root: string, override: Readonly<Record<string, string>> = {}): string {
  for (const name of DEMO_FILES) writeFile(root, name, override[name] ?? DEMO_CONTENT[name] ?? '')
  return join(root, DEMO_FILES[0])
}

/** 写部署登记；字段由调用方给出，便于构造无效证据。 */
function writeDeployments(agentDir: string, deployments: readonly unknown[], schema: unknown = 1): void {
  writeFile(agentDir, '.pi-desk-deployments.json', `${JSON.stringify({ schema, deployments }, null, 2)}\n`)
}

const BUNDLE_FILES: Readonly<Record<string, string>> = {
  'extensions/skill-guard/index.ts': 'export const guard = 1\n',
  'extensions/pi-memory/index.ts': 'export const memory = 1\n',
  'skills/memory/SKILL.md': '# memory\n',
  'skills/memory/engine.py': 'print(1)\n'
}

const BUNDLE_COMPONENTS = [
  { id: 'skill-guard', entry: 'extensions/skill-guard/index.ts', files: ['extensions/skill-guard/index.ts'], requiredTools: ['skill_guard_select'] },
  { id: 'pi-memory', entry: 'extensions/pi-memory/index.ts', files: ['extensions/pi-memory/index.ts'], requiredTools: ['memory_read'] },
  { id: 'memory', entry: 'skills/memory/SKILL.md', files: ['skills/memory/SKILL.md'] }
] as const

/** 写一份形状合法的产物清单；`mutate` 用来制造不一致。 */
function writeProductBundle(root: string, mutate?: (manifest: Record<string, unknown>) => void): Record<string, string> {
  const fingerprints: Record<string, string> = {}
  for (const [name, text] of Object.entries(BUNDLE_FILES)) {
    writeFile(root, name, text)
    fingerprints[name] = digest(text)
  }
  const componentDigests: Record<string, string> = {}
  for (const item of BUNDLE_COMPONENTS) componentDigests[item.id] = componentDigestOf(fingerprints, item.files)
  const manifest: Record<string, unknown> = {
    version: 1,
    extensions: BUNDLE_COMPONENTS.slice(0, 2),
    skills: BUNDLE_COMPONENTS.slice(2),
    memoryEngine: 'skills/memory/engine.py',
    fingerprints,
    componentDigests
  }
  mutate?.(manifest)
  writeFile(root, 'bundle.json', JSON.stringify(manifest))
  return fingerprints
}

test('组件摘要与文件顺序无关，但随指纹变化', () => {
  const first = componentDigestOf({ a: 'x', b: 'y' }, ['a', 'b'])
  assert.equal(first, componentDigestOf({ b: 'y', a: 'x' }, ['b', 'a']))
  assert.notEqual(first, componentDigestOf({ a: 'x', b: 'z' }, ['a', 'b']))
})

test('清单必须自带可复核的组件摘要', () => {
  const temp = createTempRoot('pi-desk-bundle-')
  try {
    const fingerprints = writeProductBundle(temp.dir)
    assert.equal(readAgentResourceBundle(temp.dir).componentDigests.memory,
      componentDigestOf(fingerprints, ['skills/memory/SKILL.md']))

    writeProductBundle(temp.dir, manifest => { delete manifest.componentDigests })
    assert.throws(() => readAgentResourceBundle(temp.dir), /组件摘要缺失/u)

    writeProductBundle(temp.dir, manifest => {
      manifest.componentDigests = { 'skill-guard': 'a'.repeat(64), 'pi-memory': 'b'.repeat(64), memory: 'c'.repeat(64) }
    })
    assert.throws(() => readAgentResourceBundle(temp.dir), /组件摘要与内容不一致/u)

    // 只给部分组件摘要同样视为不一致，不能挑存在的用。
    writeProductBundle(temp.dir, manifest => {
      const digests = manifest.componentDigests
      if (typeof digests === 'object' && digests !== null) {
        manifest.componentDigests = { 'skill-guard': (digests as Record<string, string>)['skill-guard'] ?? '' }
      }
    })
    assert.throws(() => readAgentResourceBundle(temp.dir), /组件摘要与内容不一致/u)
  } finally {
    temp.cleanup()
  }
})

test('产物文件被改动后清单校验失败，混合版本不会进入身份判定', () => {
  const temp = createTempRoot('pi-desk-bundle-')
  try {
    writeProductBundle(temp.dir)
    writeFile(temp.dir, 'extensions/pi-memory/index.ts', 'export const memory = 2\n')
    assert.throws(() => readAgentResourceBundle(temp.dir), /内容与清单不一致/u)
  } finally {
    temp.cleanup()
  }
})

test('部署登记：缺失、损坏、越界、重复或字段非法都降级为空证据，不抛错', () => {
  const temp = createTempRoot('pi-desk-agentdir-')
  try {
    assert.equal(readAgentDeploymentManifest(temp.dir).size, 0)
    writeFile(temp.dir, '.pi-desk-deployments.json', '{ not json')
    assert.equal(readAgentDeploymentManifest(temp.dir).size, 0)

    // 越出 agent 目录与指向 agent 目录自身的条目都不可用；合法条目保留。
    writeDeployments(temp.dir, [
      { componentId: 'demo', target: '../outside', contentDigest: 'a'.repeat(64) },
      { componentId: 'root', target: '.', contentDigest: 'd'.repeat(64) },
      { componentId: 'memory', target: 'skills/memory', contentDigest: 'b'.repeat(64) }
    ])
    const entries = readAgentDeploymentManifest(temp.dir)
    assert.equal(entries.size, 1)
    assert.equal(entries.get('demo'), undefined)
    assert.equal(entries.get('root'), undefined)
    assert.equal(entries.get('memory')?.contentDigest, 'b'.repeat(64))

    // 同一组件登记两次时两条都不可信。
    writeDeployments(temp.dir, [
      { componentId: 'demo', target: 'extensions/demo', contentDigest: 'a'.repeat(64) },
      { componentId: 'demo', target: 'extensions/demo', contentDigest: 'c'.repeat(64) }
    ])
    assert.equal(readAgentDeploymentManifest(temp.dir).size, 0)

    writeDeployments(temp.dir, [{ componentId: 'demo', target: 'extensions/demo', contentDigest: 'not-a-digest' }])
    assert.equal(readAgentDeploymentManifest(temp.dir).size, 0)
    writeDeployments(temp.dir, [{ componentId: 'demo', target: 'extensions/demo', contentDigest: 'a'.repeat(64) }], 2)
    assert.equal(readAgentDeploymentManifest(temp.dir).size, 0)
  } finally {
    temp.cleanup()
  }
})

test('副本身份：产品自身入口判为 product', () => {
  const product = createDemoBundle()
  try {
    assert.equal(classifyAgentResourceCopy(product.bundle, demoResource(),
      join(product.dir, DEMO_FILES[0]), new Map()).kind, 'product')
  } finally {
    product.cleanup()
  }
})

test('副本身份：内容一致且无标记时静默排除', () => {
  const product = createDemoBundle()
  const copy = createTempRoot('pi-desk-copy-')
  try {
    const entry = writeDemoCopy(copy.dir)
    assert.deepEqual(classifyAgentResourceCopy(product.bundle, demoResource(), entry, new Map()),
      { kind: 'identical', changedFiles: [], marker: 'none' })
  } finally {
    copy.cleanup()
    product.cleanup()
  }
})

test('副本身份：BOM 与 CRLF 只影响字节，不改变身份', () => {
  const product = createDemoBundle()
  const copy = createTempRoot('pi-desk-copy-')
  try {
    const entry = writeDemoCopy(copy.dir, {
      [DEMO_FILES[0]]: `\uFEFF${(DEMO_CONTENT[DEMO_FILES[0]] ?? '').replace(/\n/g, '\r\n')}`
    })
    assert.deepEqual(classifyAgentResourceCopy(product.bundle, demoResource(), entry, new Map()),
      { kind: 'identical', changedFiles: [], marker: 'none' })
  } finally {
    copy.cleanup()
    product.cleanup()
  }
})

test('副本身份：登记摘要等于产品摘要时记为 consistent', () => {
  const product = createDemoBundle()
  const copy = createTempRoot('pi-desk-copy-')
  try {
    const entry = writeDemoCopy(copy.dir)
    writeDeployments(copy.dir, [{ componentId: 'demo', target: 'extensions/demo',
      contentDigest: componentDigestOf(product.bundle.fingerprints, DEMO_FILES) }])
    assert.deepEqual(
      classifyAgentResourceCopy(product.bundle, demoResource(), entry, readAgentDeploymentManifest(copy.dir)),
      { kind: 'identical', changedFiles: [], marker: 'consistent' })
  } finally {
    copy.cleanup()
    product.cleanup()
  }
})

test('副本身份：内容一致但登记摘要不同时按标记过期处理', () => {
  const product = createDemoBundle()
  const copy = createTempRoot('pi-desk-copy-')
  try {
    const entry = writeDemoCopy(copy.dir)
    writeDeployments(copy.dir, [{ componentId: 'demo', target: 'extensions/demo', contentDigest: 'f'.repeat(64) }])
    assert.deepEqual(
      classifyAgentResourceCopy(product.bundle, demoResource(), entry, readAgentDeploymentManifest(copy.dir)),
      { kind: 'identical', changedFiles: [], marker: 'inconsistent' })
  } finally {
    copy.cleanup()
    product.cleanup()
  }
})

test('副本身份：无标记且内容不同时按版本不同处理', () => {
  const product = createDemoBundle()
  const copy = createTempRoot('pi-desk-copy-')
  try {
    const entry = writeDemoCopy(copy.dir, { [DEMO_FILES[1]]: "export const helper = 'v2'\n" })
    assert.deepEqual(classifyAgentResourceCopy(product.bundle, demoResource(), entry, new Map()),
      { kind: 'outdated', changedFiles: [DEMO_FILES[1]], marker: 'none' })
  } finally {
    copy.cleanup()
    product.cleanup()
  }
})

test('副本身份：登记与磁盘一致时按原样同步的版本不同处理', () => {
  const product = createDemoBundle()
  const copy = createTempRoot('pi-desk-copy-')
  try {
    const entry = writeDemoCopy(copy.dir, { [DEMO_FILES[1]]: "export const helper = 'v2'\n" })
    const diskDigest = componentDigestOf({
      [DEMO_FILES[0]]: digest(DEMO_CONTENT[DEMO_FILES[0]] ?? ''),
      [DEMO_FILES[1]]: digest("export const helper = 'v2'\n")
    }, DEMO_FILES)
    writeDeployments(copy.dir, [{ componentId: 'demo', target: 'extensions/demo', contentDigest: diskDigest }])
    assert.deepEqual(
      classifyAgentResourceCopy(product.bundle, demoResource(), entry, readAgentDeploymentManifest(copy.dir)),
      { kind: 'outdated', changedFiles: [DEMO_FILES[1]], marker: 'consistent' })
  } finally {
    copy.cleanup()
    product.cleanup()
  }
})

test('副本身份：登记与磁盘不一致时按部署后被修改处理', () => {
  const product = createDemoBundle()
  const copy = createTempRoot('pi-desk-copy-')
  try {
    const entry = writeDemoCopy(copy.dir, { [DEMO_FILES[1]]: "export const helper = 'v2'\n" })
    writeDeployments(copy.dir, [{ componentId: 'demo', target: 'extensions/demo', contentDigest: 'e'.repeat(64) }])
    assert.deepEqual(
      classifyAgentResourceCopy(product.bundle, demoResource(), entry, readAgentDeploymentManifest(copy.dir)),
      { kind: 'modified', changedFiles: [DEMO_FILES[1]], marker: 'inconsistent' })
  } finally {
    copy.cleanup()
    product.cleanup()
  }
})

test('副本身份：组成文件不齐、入口形状不符或相对路径判为 foreign', () => {
  const product = createDemoBundle()
  const partial = createTempRoot('pi-desk-partial-')
  try {
    writeFile(partial.dir, DEMO_FILES[0], DEMO_CONTENT[DEMO_FILES[0]] ?? '')
    assert.equal(classifyAgentResourceCopy(product.bundle, demoResource(),
      join(partial.dir, DEMO_FILES[0]), new Map()).kind, 'foreign')
    assert.equal(classifyAgentResourceCopy(product.bundle, demoResource(),
      join(partial.dir, 'missing', 'index.ts'), new Map()).kind, 'foreign')
    assert.equal(classifyAgentResourceCopy(product.bundle, demoResource(), DEMO_FILES[0], new Map()).kind, 'foreign')
  } finally {
    partial.cleanup()
    product.cleanup()
  }
})
