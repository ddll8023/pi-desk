/** 工具操作的统一身份与分类；显式名称映射优先，未知工具不靠名称子串猜行为。 */
export type ToolOperationKind =
  | 'code-search' | 'file-search' | 'memory-search' | 'web-search'
  | 'read' | 'edit' | 'write' | 'terminal' | 'browser' | 'control' | 'tool'
export type ToolOperationTone = 'search' | 'read' | 'edit' | 'write' | 'terminal' | 'control' | 'default'
export interface ToolOperation {
  readonly kind: ToolOperationKind
  readonly label: string
  readonly tone: ToolOperationTone
  readonly transport: 'MCP' | null
}
interface Definition { readonly kind: ToolOperationKind; readonly label: string }
const DEFINITIONS: Readonly<Record<string, Definition>> = {
  ffgrep: { kind: 'code-search', label: '代码检索' },
  grep: { kind: 'code-search', label: '内容检索' },
  rg: { kind: 'code-search', label: '内容检索' },
  fffind: { kind: 'file-search', label: '文件查找' },
  find: { kind: 'file-search', label: '文件查找' },
  glob: { kind: 'file-search', label: '文件查找' },
  memory_search: { kind: 'memory-search', label: '记忆检索' },
  memory_rules: { kind: 'memory-search', label: '查询记忆规则' },
  web_search: { kind: 'web-search', label: '网络检索' },
  source_check: { kind: 'web-search', label: '核查来源' },
  read: { kind: 'read', label: '读取文件' },
  ls: { kind: 'read', label: '列出目录' },
  memory_read: { kind: 'read', label: '读取记忆' },
  memory_profiles: { kind: 'read', label: '读取偏好' },
  memory_project_read: { kind: 'read', label: '读取项目知识' },
  get_search_content: { kind: 'read', label: '读取检索结果' },
  fetch_content: { kind: 'read', label: '抓取内容' },
  edit: { kind: 'edit', label: '编辑文件' },
  patch: { kind: 'edit', label: '修改文件' },
  apply_patch: { kind: 'edit', label: '应用补丁' },
  write: { kind: 'write', label: '写入文件' },
  memory_save: { kind: 'write', label: '保存日记' },
  memory_profile_save: { kind: 'write', label: '保存偏好' },
  bash: { kind: 'terminal', label: '执行命令' },
  shell: { kind: 'terminal', label: '执行命令' },
  terminal: { kind: 'terminal', label: '执行命令' },
  browser_snapshot: { kind: 'browser', label: '读取网页结构' },
  browser_get_content: { kind: 'browser', label: '读取网页正文' },
  browser_navigate: { kind: 'browser', label: '打开网页' },
  browser_click: { kind: 'browser', label: '点击网页元素' },
  browser_fill: { kind: 'browser', label: '填写网页内容' },
  browser_press_key: { kind: 'browser', label: '网页按键' },
  browser_scroll: { kind: 'browser', label: '滚动网页' },
  skill_guard_select: { kind: 'control', label: '选择规范' },
  memory_status: { kind: 'control', label: '查询记忆状态' },
  memory_control: { kind: 'control', label: '控制记忆' },
  mcp_status: { kind: 'control', label: '查询 MCP 状态' },
  mcp_connect: { kind: 'control', label: '连接 MCP' },
  web_enable: { kind: 'control', label: '启用网络工具' },
  ask_user_question: { kind: 'control', label: '请求用户确认' }
}

/** 只剥离明确的工具命名空间，不把普通下划线名称误拆成内置工具。 */
export function toolLocalName(name: string): string {
  const local = name.trim().split('.').at(-1) ?? name
  return (local.startsWith('mcp__') ? local.split('__').at(-1) ?? local : local).toLowerCase()
}

export function getToolOperation(name: string): ToolOperation {
  const key = toolLocalName(name)
  const definition: Definition = (Object.hasOwn(DEFINITIONS, key) ? DEFINITIONS[key] : undefined)
    ?? { kind: 'tool', label: '工具调用' }
  const kind = definition.kind
  const tone: ToolOperationTone = kind.endsWith('-search') ? 'search'
    : kind === 'read' || kind === 'browser' ? 'read'
      : kind === 'edit' || kind === 'write' || kind === 'terminal' || kind === 'control' ? kind : 'default'
  return { ...definition, tone, transport: /(^|[.])mcp[_]/i.test(name) ? 'MCP' : null }
}

/** 卡片组与执行抽屉共用顺序；修改与写入合并为一项，不按颜色承担语义。 */
export function toolOperationGroups(names: readonly string[]): readonly { readonly label: string; readonly count: number }[] {
  const counts = new Map<string, number>()
  for (const name of names) {
    const kind = getToolOperation(name).kind
    const label = kind === 'code-search' ? '代码检索' : kind === 'file-search' ? '文件查找'
      : kind === 'memory-search' ? '记忆检索' : kind === 'web-search' ? '网络检索'
        : kind === 'read' ? '读取' : kind === 'edit' || kind === 'write' ? '修改'
          : kind === 'terminal' ? '终端' : kind === 'browser' ? '浏览器'
            : kind === 'control' ? '控制' : '其他工具'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return ['代码检索', '文件查找', '记忆检索', '网络检索', '读取', '修改', '终端', '浏览器', '控制', '其他工具']
    .flatMap(label => { const count = counts.get(label); return count === undefined ? [] : [{ label, count }] })
}
