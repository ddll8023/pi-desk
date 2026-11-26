/**
 * 运行记录的落盘与收敛：`<agentDir>/workflow-runs/<runId>/run.json`，节点会话在同目录的 `sessions/<nodeId>/`。
 *
 * 运行由主进程持有，记录只是它的可恢复快照：每次状态变化写一次整份 JSON（一份运行只有几百 KB），
 * 不做增量日志。启动时按记录收敛——上次退出时仍是 `running` 的运行一律标为中断，
 * 否则界面会长期显示一个没有进程在推进的「运行中」。
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseWorkflowRun } from '../../shared/workflow-api'
import type { WorkflowRun, WorkflowRunSummary } from '../../shared/workflow-api'
import { MAX_WORKFLOW_RUN_LIST } from '../../shared/workflow-api'

/** 保留的运行份数：超出时丢最早结束的，避免运行目录无界增长。 */
const MAX_KEPT_RUNS = 50

/** 临时文件序号：同层并发 publish 会同时写 run.json，共用一个临时名会互相截断。 */
let tmpSequence = 0
function temporaryPath(target: string): string {
  tmpSequence += 1
  return `${target}.${process.pid}.${tmpSequence}.tmp`
}

function runsRoot(agentDir: string): string {
  return join(agentDir, 'workflow-runs')
}

function runDirectory(agentDir: string, runId: string): string {
  return join(runsRoot(agentDir), runId)
}

/** 节点会话目录：一轮运行里每个节点一个子目录，节点之间不共享上下文。 */
export function workflowNodeSessionDir(agentDir: string, runId: string, nodeId: string): string {
  return join(runDirectory(agentDir, runId), 'sessions', nodeId)
}

async function writeRunFile(agentDir: string, run: WorkflowRun): Promise<void> {
  const directory = runDirectory(agentDir, run.runId)
  await mkdir(directory, { recursive: true })
  const target = join(directory, 'run.json')
  const temporary = temporaryPath(target)
  await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, 'utf-8')
  await rename(temporary, target)
}

/** 写入快照：失败不抛出，运行不因记录写不进去而中断。 */
export async function saveWorkflowRun(agentDir: string, run: WorkflowRun): Promise<void> {
  try {
    await writeRunFile(agentDir, run)
  } catch {
    // 记录是观测面：磁盘满或权限异常时让运行继续，界面仍能收到内存里的快照。
  }
}

/** 读取一份运行记录；不存在或不合契约时返回 null。 */
export async function readWorkflowRunFile(agentDir: string, runId: string): Promise<WorkflowRun | null> {
  try {
    const text = await readFile(join(runDirectory(agentDir, runId), 'run.json'), 'utf-8')
    return parseWorkflowRun(JSON.parse(text))
  } catch {
    return null
  }
}

/**
 * 启动收敛：把所有仍是 `running` 的记录改成 `cancelled`，并追加一条说明。
 * 只改状态与结束时间，不动节点明细——节点停在 `running` 也是事实，界面据此显示「已中断」。
 */
export async function settleInterruptedRuns(agentDir: string): Promise<void> {
  let entries: string[]
  try {
    const listing = await readdir(runsRoot(agentDir), { withFileTypes: true })
    entries = listing.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return
  }
  for (const runId of entries) {
    const run = await readWorkflowRunFile(agentDir, runId)
    if (run === null || run.status !== 'running') continue
    const settledAt = Date.now()
    await saveWorkflowRun(agentDir, {
      ...run,
      status: 'cancelled',
      finishedAt: settledAt,
      nodes: run.nodes.map(node => node.status === 'running' || node.status === 'queued'
        ? { ...node, status: 'cancelled', finishedAt: settledAt, failure: 'aborted' }
        : node),
      events: [...run.events, {
        at: settledAt,
        nodeId: null,
        level: 'warn' as const,
        message: '上次退出时这次运行仍在进行，已按中断收敛。'
      }].slice(-400)
    })
  }
}

/**
 * 按工作流列出运行摘要：回放面板只需要选择与排序，不加载节点明细。
 * 倒序按开始时间，最多返回上限份；单份读不出来就跳过。
 */
export async function listWorkflowRunFiles(
  agentDir: string,
  workflowId: string
): Promise<WorkflowRunSummary[]> {
  let entries: string[]
  try {
    const listing = await readdir(runsRoot(agentDir), { withFileTypes: true })
    entries = listing.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
  const summaries: WorkflowRunSummary[] = []
  for (const runId of entries) {
    const run = await readWorkflowRunFile(agentDir, runId)
    if (run === null || run.workflowId !== workflowId) continue
    summaries.push({
      runId: run.runId,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      nodeCount: run.nodes.length
    })
  }
  return summaries.sort((left, right) => right.startedAt - left.startedAt).slice(0, MAX_WORKFLOW_RUN_LIST)
}

/**
 * 清空已结束的运行记录：仍在跑的不动（记录文件会被它自己继续写）。
 * 返回本轮删掉的份数；删除失败只跳过那一份。
 */
export async function clearFinishedRuns(agentDir: string, liveRunIds: ReadonlySet<string>): Promise<number> {
  let entries: string[]
  try {
    const listing = await readdir(runsRoot(agentDir), { withFileTypes: true })
    entries = listing.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return 0
  }
  let removed = 0
  for (const runId of entries) {
    if (liveRunIds.has(runId)) continue
    try {
      await rm(runDirectory(agentDir, runId), { recursive: true, force: true })
      removed += 1
    } catch {
      // 单份删不掉不影响其他份。
    }
  }
  return removed
}

/** 保留最近的若干份运行；结束时间缺失的按开始时间排序，删除是硬删除（运行记录不是用户资产）。 */
export async function pruneWorkflowRuns(agentDir: string): Promise<void> {
  let entries: string[]
  try {
    const listing = await readdir(runsRoot(agentDir), { withFileTypes: true })
    entries = listing.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return
  }
  if (entries.length <= MAX_KEPT_RUNS) return
  const runs: WorkflowRun[] = []
  for (const runId of entries) {
    const run = await readWorkflowRunFile(agentDir, runId)
    if (run !== null) runs.push(run)
  }
  runs.sort((left, right) => (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt))
  for (const run of runs.slice(MAX_KEPT_RUNS)) {
    try {
      await rm(runDirectory(agentDir, run.runId), { recursive: true, force: true })
    } catch {
      // 删除失败不影响后续运行；下次启动会再尝试。
    }
  }
}
