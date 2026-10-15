/**
 * Pi agent 运行时的布局与加载：版本化发布目录、当前版本指针、发布目录内的 SDK 入口解析，
 * 四个受管入口共用的 SDK 加载方式，以及随应用发布的基线版本。
 *
 * 边界：只做路径拼装、指针读写与只读解析；不下载、不安装，也不校验发布内容的完整性（由安装入口负责）。
 * 不感知 Electron，主进程与一次性安装入口共用同一份布局约定，避免两处各写一份。
 * 运行时根目录由调用方给出：主进程用应用自有数据区，安装入口用主进程传入的绝对路径；
 * 本模块不引用 `import.meta`，因为主进程也会打包它（主进程产物不是 ESM）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 运行时根目录下的固定布局名；改动其一会同时影响主进程解析与安装入口。 */
export const RUNTIME_RELEASES_DIR = 'releases'
export const RUNTIME_STAGING_DIR = 'staging'
export const RUNTIME_POINTER_FILE = 'current-version'
/** 本应用加载的 SDK 包名；发布目录内按 npm 布局放在 node_modules 下。 */
export const RUNTIME_SDK_PACKAGE = '@earendil-works/pi-coding-agent'
/** 运行时入口的注入变量：值是入口文件 URL，缺失时受管入口回退到应用自带的版本。 */
export const SDK_ENTRY_ENV = 'PI_DESK_SDK_ENTRY'

/** 与官方受管安装一致：只接受 `x.y.z` 形式（可带预发布与构建后缀）的版本目录名。 */
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** 受管入口加载的 SDK 模块形状；编译期类型来自依赖声明，运行期可能是运行时目录里的另一个版本。 */
export type SdkModule = typeof import('@earendil-works/pi-coding-agent')

export function isValidReleaseVersion(value: string): boolean {
  return RELEASE_VERSION_PATTERN.test(value)
}

/** 只取主版本号用于兼容判断；不是 `x.y.z` 形式时返回 null，由调用方按「无法判定」处理。 */
export function majorVersion(value: string): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim())
  return match?.[1] ?? null
}

/**
 * 随应用发布的 SDK 版本：从 `entryUrl`（受管入口自己的 `import.meta.url`）向上两级找 node_modules。
 * 产物固定放在 `<应用根>/out/sdk-host/`，因此开发态与打包态指向同一相对位置；读不到时返回 null。
 */
export function readBundledSdkVersion(entryUrl: string): string | null {
  const manifestUrl = new URL(`../../node_modules/${RUNTIME_SDK_PACKAGE}/package.json`, entryUrl)
  try {
    const manifest: unknown = JSON.parse(readFileSync(fileURLToPath(manifestUrl), 'utf8'))
    if (!isRecord(manifest)) return null
    const version = manifest.version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

export function releasesRoot(runtimeRoot: string): string {
  return join(runtimeRoot, RUNTIME_RELEASES_DIR)
}

export function releaseDir(runtimeRoot: string, version: string): string {
  return join(releasesRoot(runtimeRoot), version)
}

export function stagingRoot(runtimeRoot: string): string {
  return join(runtimeRoot, RUNTIME_STAGING_DIR)
}

export function pointerPath(runtimeRoot: string): string {
  return join(runtimeRoot, RUNTIME_POINTER_FILE)
}

/** 读当前版本指针；缺失、非法或读不到时返回 null，不推断也不回退到某个目录名。 */
export function readCurrentVersion(runtimeRoot: string): string | null {
  let raw: string
  try {
    raw = readFileSync(pointerPath(runtimeRoot), 'utf8')
  } catch {
    return null
  }
  const version = raw.trim()
  return isValidReleaseVersion(version) ? version : null
}

/** 写当前版本指针：先写同目录临时文件再改名，避免读到写了一半的内容。 */
export function writeCurrentVersion(runtimeRoot: string, version: string): void {
  if (!isValidReleaseVersion(version)) throw new Error(`当前版本指针只接受合法版本号：${version}`)
  mkdirSync(runtimeRoot, { recursive: true })
  const target = pointerPath(runtimeRoot)
  const temporary = `${target}.tmp.${process.pid}-${Date.now()}`
  try {
    writeFileSync(temporary, `${version}\n`)
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取包声明里的入口相对路径：优先条件导出的 import，其次 default，最后回退 main。 */
function declaredEntry(manifest: Record<string, unknown>): string | null {
  const exportsField = manifest.exports
  if (isRecord(exportsField)) {
    const rootExport = exportsField['.']
    if (typeof rootExport === 'string' && rootExport !== '') return rootExport
    if (isRecord(rootExport)) {
      const conditions = rootExport
      for (const key of ['import', 'default']) {
        const candidate = conditions[key]
        if (typeof candidate === 'string' && candidate !== '') return candidate
      }
    }
  } else if (typeof exportsField === 'string' && exportsField !== '') {
    return exportsField
  }
  return typeof manifest.main === 'string' && manifest.main !== '' ? manifest.main : null
}

/**
 * 解析一个发布目录里的 SDK 入口绝对路径。
 * 目录不存在、包声明读不到、声明的版本与期望不符或入口文件缺失时返回 null，由调用方按「不可用」处理。
 */
export function resolveSdkEntryInRelease(releaseDirPath: string, expectedVersion?: string): string | null {
  const packageDir = join(releaseDirPath, 'node_modules', ...RUNTIME_SDK_PACKAGE.split('/'))
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  if (!isRecord(manifest)) return null
  const version = manifest.version
  if (typeof version !== 'string' || version === '') return null
  if (expectedVersion !== undefined && version !== expectedVersion) return null
  const relative = declaredEntry(manifest)
  if (relative === null) return null
  const entryPath = resolve(packageDir, relative)
  return existsSync(entryPath) ? entryPath : null
}

/** 当前指针指向且自检通过的运行时；任一环节不成立即返回 null。 */
export function resolveActiveRuntime(runtimeRoot: string): { readonly version: string; readonly entryPath: string } | null {
  const version = readCurrentVersion(runtimeRoot)
  if (version === null) return null
  const entryPath = resolveSdkEntryInRelease(releaseDir(runtimeRoot, version), version)
  if (entryPath === null) return null
  return { version, entryPath }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 受管入口的 SDK 加载：主进程给出运行时入口时加载它，否则回退到应用自带的版本。
 *
 * 运行时目录加载失败时同样回退到自带版本：宁可暂时少用一个新版本，也不要让应用起不来。
 * 降级原因只写 stderr（不进入协议输出），由调用方在失败诊断里保留尾部。
 *
 * 运行期版本可能不是编译期依赖声明的那个版本，因此这里只能断言成依赖声明的类型；
 * 兼容性由安装阶段的版本策略与指针回滚保证，不在加载处做版本判断。
 */
export async function loadSdkModule(): Promise<SdkModule> {
  const entryUrl = process.env[SDK_ENTRY_ENV]
  if (entryUrl === undefined || entryUrl === '') {
    return await import('@earendil-works/pi-coding-agent')
  }
  try {
    return await import(/* @vite-ignore */ entryUrl) as SdkModule
  } catch (error) {
    process.stderr.write(`内置 Pi agent 运行时加载失败，回退到应用自带版本：${describeError(error)}\n`)
    return await import('@earendil-works/pi-coding-agent')
  }
}
