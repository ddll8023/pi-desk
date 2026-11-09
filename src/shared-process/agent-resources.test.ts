/**
 * 产品 Agent 资源的清单、内容指纹与组件摘要的单元测试。
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
  componentDigestOf, readAgentResourceBundle
} from './agent-resources.ts'

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

