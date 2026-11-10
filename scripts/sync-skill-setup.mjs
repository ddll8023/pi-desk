/**
 * 同步 pi-skill-setup 的随包规则模板：按维护电脑全局规则的实际平台口吻，派生另一平台的模板
 * （维护源是 macOS 就生成 Windows 模板，反之亦然），并删除 assets 下不再携带的文件。
 *
 * 只写目标技能目录：不读项目配置、不运行宿主、不部署到任何 agentDir，也不触碰记忆库或凭据。
 * `--check` 只比对并报告差异，不写文件也不删除；默认模式才写入与清理。
 * 目标目录由 `PI_SKILL_SETUP_DIR` 覆盖，源文件由 `PI_AGENTS_SOURCE` 覆盖，默认分别为
 * `~/.agents/skills/pi-skill-setup` 与 `~/.agents/AGENTS.md`。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const check = process.argv.includes('--check')
const skillDir = resolve(process.env.PI_SKILL_SETUP_DIR ?? join(homedir(), '.agents/skills/pi-skill-setup'))
const sourcePath = resolve(process.env.PI_AGENTS_SOURCE ?? join(homedir(), '.agents/AGENTS.md'))
const assets = join(skillDir, 'assets')
/** 随包只允许两份模板；其余条目在同步时删除，避免旧资源继续被当作部署材料。 */
const ALLOWED = new Set(['mac-AGENTS.md', 'Windows-AGENTS.md'])

// 平台差异只有第 14 条：首句、解释器路径与编码环境变量说明。改动全局规则时若这些文本不再唯一出现，脚本直接报错。
const MAC_FIRST = '14. 当前环境为 macOS、zsh，命令、路径和脚本须与之适配。'
const WINDOWS_FIRST = '14. 当前环境为 Windows；命令和路径按实际使用的终端适配，不预设为 zsh 或 PowerShell。'
const MAC_PYTHON = '<后端目录>/.venv/bin/python <script>'
const WINDOWS_PYTHON = '<后端目录>/.venv/Scripts/python.exe <script>'
const MAC_ENCODING = '仅遇到实际编码异常时添加 `PYTHONIOENCODING=utf-8`。'
const WINDOWS_ENCODING = '仅遇到实际编码异常时，才按当前终端语法设置 `PYTHONIOENCODING=utf-8`。'
/** 三条差异成对维护，换向与单点替换共用同一份定义，避免两个方向各自漂移。 */
const PLATFORM_PAIRS = [
  { mac: MAC_FIRST, windows: WINDOWS_FIRST, label: '第 14 条首句' },
  { mac: MAC_PYTHON, windows: WINDOWS_PYTHON, label: 'Python 解释器路径' },
  { mac: MAC_ENCODING, windows: WINDOWS_ENCODING, label: '编码环境变量说明' }
]

function fail(message) {
  console.error(`[skill-setup] ${message}`)
  process.exit(1)
}

/** 只在文本中唯一出现时替换；出现次数异常说明全局规则被改写，不能静默生成错误模板。 */
function replaceOnce(text, from, to, label) {
  const count = text.split(from).length - 1
  if (count !== 1) fail(`全局规则中「${label}」出现 ${count} 次，无法生成平台模板；先核对第 14 条`)
  return text.replace(from, to)
}

function buildTemplates(source) {
  const isMac = source.includes(MAC_FIRST)
  const isWindows = source.includes(WINDOWS_FIRST)
  // 维护电脑本身可能是任一平台：源文件就是同平台模板，只需向另一方向派生。
  if (isMac === isWindows) {
    fail(`全局规则第 14 条平台首句无法判定：macOS 标记 ${isMac}、Windows 标记 ${isWindows}，应恰好出现一处`)
  }
  return isMac
    ? { mac: source, windows: retarget(source, 'mac', 'windows') }
    : { mac: retarget(source, 'windows', 'mac'), windows: source }
}

/** 按三条固定平台差异整体换向；任一文本不唯一出现即报错，不静默产出错误模板。 */
function retarget(text, from, to) {
  return PLATFORM_PAIRS.reduce((current, pair) =>
    replaceOnce(current, pair[from], pair[to], pair.label), text)
}

function writeIfChanged(name, content) {
  const path = join(assets, name)
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (current === content) {
    console.log(`unchanged assets/${name}`)
    return
  }
  if (check) {
    console.log(`drift assets/${name}`)
    return
  }
  mkdirSync(assets, { recursive: true })
  writeFileSync(path, content, 'utf8')
  console.log(`wrote assets/${name}`)
}

/** 只清理 assets 名单外条目，并拒绝越过技能目录的写入。 */
function pruneAssets() {
  if (!existsSync(assets)) return
  for (const entry of readdirSync(assets, { withFileTypes: true })) {
    if (ALLOWED.has(entry.name)) continue
    const path = join(assets, entry.name)
    if (!resolve(path).startsWith(`${assets}${sep}`)) fail(`拒绝清理技能目录之外的路径：${path}`)
    if (check) {
      console.log(`would remove assets/${entry.name}`)
      continue
    }
    rmSync(path, { recursive: true, force: true })
    console.log(`removed assets/${entry.name}`)
  }
}

/** 技能目录根只保留正文与 assets；macOS 的目录元数据不随包分发。 */
function pruneSkillRoot() {
  const path = join(skillDir, '.DS_Store')
  if (!existsSync(path)) return
  if (check) {
    console.log('would remove .DS_Store')
    return
  }
  rmSync(path, { force: true })
  console.log('removed .DS_Store')
}

if (!existsSync(sourcePath)) fail(`找不到维护电脑的全局规则：${sourcePath}`)
const sourceText = readFileSync(sourcePath, 'utf8').replace(/\r\n?/g, '\n')
const { mac: macTemplate, windows: windowsTemplate } = buildTemplates(sourceText)

writeIfChanged('mac-AGENTS.md', macTemplate)
writeIfChanged('Windows-AGENTS.md', windowsTemplate)
pruneAssets()
pruneSkillRoot()
