/** 作为渲染端源代码管理的入口，收敛桥接缺失与通信异常；失败一律回契约里的错误结构。 */
import type { DesktopError } from '../../../shared/desktop-api'
import type {
  GitArea,
  GitCommitDetailResult,
  GitCommitDiffResult,
  GitDiffResult,
  GitHistoryResult,
  GitOperationResult,
  GitStatusResult
} from '../../../shared/git-api'

function unavailable(): { ok: false; error: DesktopError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailed(error: unknown): { ok: false; error: DesktopError } {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `桌面桥接调用失败，可以重试：${detail}` }
  }
}

/** 读取当前项目的 Git 状态；未选择项目与不是仓库都由主进程在结果里表达。 */
export async function getGitStatus(): Promise<GitStatusResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getGitStatus !== 'function') return unavailable()
  try {
    return await bridge.getGitStatus()
  } catch (error) {
    return callFailed(error)
  }
}

/** 读取一个条目的两侧内容；路径由页面给出，越界与不存在由主进程判定。 */
export async function getGitDiff(path: string, area: GitArea): Promise<GitDiffResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getGitDiff !== 'function') return unavailable()
  try {
    return await bridge.getGitDiff({ path, area })
  } catch (error) {
    return callFailed(error)
  }
}

/** 暂存一个条目；成功后返回新的状态快照。 */
export async function stageGitPath(path: string): Promise<GitOperationResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.stageGitPaths !== 'function') return unavailable()
  try {
    return await bridge.stageGitPaths({ path })
  } catch (error) {
    return callFailed(error)
  }
}

/** 取消暂存一个条目；成功后返回新的状态快照。 */
export async function unstageGitPath(path: string): Promise<GitOperationResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.unstageGitPaths !== 'function') return unavailable()
  try {
    return await bridge.unstageGitPaths({ path })
  } catch (error) {
    return callFailed(error)
  }
}

/** 丢弃一个条目的改动；已跟踪文件恢复工作区，未跟踪文件被删除。 */
export async function discardGitPath(path: string): Promise<GitOperationResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.discardGitPath !== 'function') return unavailable()
  try {
    return await bridge.discardGitPath({ path })
  } catch (error) {
    return callFailed(error)
  }
}

/** 提交已暂存的改动；作者、签名与 hook 全部沿用用户自己的 git 配置。 */
export async function commitGitStaged(message: string): Promise<GitOperationResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.commitGitStaged !== 'function') return unavailable()
  try {
    return await bridge.commitGitStaged({ message })
  } catch (error) {
    return callFailed(error)
  }
}

/** 拉取当前分支的上游；远端与合并策略全部沿用仓库与用户自己的 git 配置。 */
export async function pullGit(): Promise<GitOperationResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.pullGit !== 'function') return unavailable()
  try {
    return await bridge.pullGit()
  } catch (error) {
    return callFailed(error)
  }
}

/** 推送当前分支；没有上游且只有一个远端时由主进程自动发布分支。 */
export async function pushGit(): Promise<GitOperationResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.pushGit !== 'function') return unavailable()
  try {
    return await bridge.pushGit()
  } catch (error) {
    return callFailed(error)
  }
}

/** 读取提交历史；`path` 非空时只看该文件的提交。 */
export async function getGitHistory(path?: string, limit?: number): Promise<GitHistoryResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getGitHistory !== 'function') return unavailable()
  try {
    return await bridge.getGitHistory({
      ...(path === undefined ? {} : { path }),
      ...(limit === undefined ? {} : { limit })
    })
  } catch (error) {
    return callFailed(error)
  }
}

/** 翻页：跳过前 `skip` 个提交继续读。 */
export async function getGitHistoryPage(skip: number, path: string | null): Promise<GitHistoryResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getGitHistory !== 'function') return unavailable()
  try {
    return await bridge.getGitHistory({
      skip,
      ...(path === null ? {} : { path })
    })
  } catch (error) {
    return callFailed(error)
  }
}

/** 读取一个提交的元信息与改动文件清单。 */
export async function getGitCommitDetail(oid: string): Promise<GitCommitDetailResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getGitCommitDetail !== 'function') return unavailable()
  try {
    return await bridge.getGitCommitDetail({ oid })
  } catch (error) {
    return callFailed(error)
  }
}

/** 读取提交内某个文件的差异；重命名条目要带上原路径。 */
export async function getGitCommitDiff(oid: string, path: string, oldPath?: string): Promise<GitCommitDiffResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getGitCommitDiff !== 'function') return unavailable()
  try {
    return await bridge.getGitCommitDiff({
      oid,
      path,
      ...(oldPath === undefined ? {} : { oldPath })
    })
  } catch (error) {
    return callFailed(error)
  }
}
