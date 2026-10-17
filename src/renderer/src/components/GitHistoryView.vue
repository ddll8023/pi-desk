<!--
  提交历史视图：提交列表 → 单个提交的改动文件 → 提交内文件差异，三层都在这一个面板里完成。

  为什么要标「未推送」：用户最常问的是「我改了这么多，哪些还没推上去」。上游存在时逐个提交标出未推送的，
  没有上游时整支分支都还没推过，只在页头提示一次，避免每行都挂一个角标。

  列表按需翻页：先读 50 条，底部按钮继续读更早的；过滤路径（某个文件的历史）由调用方设置，
  这里只负责展示与清除。层级由 store 的状态表达，本组件不额外维护「当前在哪一层」。
-->
<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import type { GitChangeStatus, GitCommitFile, GitCommitSummary } from '../../../shared/git-api'
import { formatRelativeTime } from '../sidebar-tree'
import { useGitHistoryStore } from '../stores/git-history'
import AppButton from './ui/AppButton.vue'
import GitDiffView from './GitDiffView.vue'

/** 改动类型到单字符标记：与改动列表保持同一套。 */
const STATUS_LETTERS: Readonly<Record<GitChangeStatus, string>> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U'
}

const historyStore = useGitHistoryStore()
const {
  commits,
  upstreamName,
  aheadCount,
  filterPath,
  phase,
  error,
  loadingMore,
  detail,
  detailPhase,
  detailError,
  fileSelection,
  diff,
  diffPhase,
  diffError,
  canLoadMore,
  unpushedCount
} = storeToRefs(historyStore)

/** 相对时间的参照点：历史是用户主动打开的视图，用打开时的时刻即可，不需要跳动的时钟。 */
const now = Date.now()

const hasUpstream = computed(() => upstreamName.value !== null)

/**
 * 视图自己负责首次读取：切到历史时组件挂载，若还没读过就拉第一页。
 * 这样「切换视图」只表达意图，不依赖调用方记得触发读取；离开再回来时列表与层级都还在。
 */
onMounted(() => {
  if (phase.value === 'idle') void historyStore.open(filterPath.value)
})

function showUnpushed(commit: GitCommitSummary): boolean {
  return hasUpstream.value && !commit.pushed
}

/** 引用名去掉 `HEAD -> ` 前缀：页头已经说明当前分支，行里只留分支/标签名。 */
function refLabel(ref: string): string {
  return ref.startsWith('HEAD -> ') ? ref.slice('HEAD -> '.length) : ref
}

/** 指向 HEAD 的引用（当前检出的分支）：唯一用强调色标出的角标。 */
function isCurrentRef(ref: string): boolean {
  return ref.startsWith('HEAD -> ')
}

/**
 * 过滤掉 `origin/HEAD` 这类符号引用：它只是远端默认分支的别名，与旁边的 `origin/main` 重复，
 * 留着只会让每张卡片的角标行变长。
 */
function visibleRefs(refs: readonly string[]): readonly string[] {
  return refs.filter((ref) => !ref.endsWith('/HEAD'))
}

function splitPath(path: string): { readonly name: string; readonly directory: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0
    ? { name: path, directory: '' }
    : { name: path.slice(slash + 1), directory: path.slice(0, slash) }
}

function fileDelta(file: GitCommitFile): string | null {
  if (file.added === undefined && file.removed === undefined) return null
  return `+${file.added ?? 0} −${file.removed ?? 0}`
}

function openCommit(commit: GitCommitSummary): void {
  void historyStore.selectCommit(commit)
}

function openFile(file: GitCommitFile): void {
  void historyStore.selectFile(file)
}
</script>

<template>
  <!-- 第三层：提交内单文件差异。旧版本文件可能已经不存在，因此不给「在编辑器中打开」。 -->
  <GitDiffView
    v-if="fileSelection !== null"
    :path="fileSelection.path"
    :label="detail?.shortOid ?? ''"
    :phase="diffPhase"
    :diff="diff"
    :error="diffError"
    :openable="false"
    @back="historyStore.backToDetail()"
  />

  <!-- 第二层：提交详情（元信息 + 改动文件）。 -->
  <div v-else-if="detail !== null || detailPhase === 'loading' || detailPhase === 'error'" class="git-history-detail">
    <header class="git-diff-header">
      <AppButton variant="unstyled" class="git-diff-back" aria-label="返回提交列表" title="返回提交列表" @click="historyStore.backToList()">
        <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
      </AppButton>
      <span class="git-history-subject" :title="detail?.subject ?? ''">{{ detail?.subject ?? '提交详情' }}</span>
    </header>

    <div class="git-history-scroll scroll-area">
      <p v-if="detailPhase === 'loading'" class="git-notice">正在读取提交详情…</p>
      <p v-else-if="detailPhase === 'error'" class="git-notice is-error">{{ detailError?.message ?? '读取提交详情失败。' }}</p>

      <template v-else-if="detail !== null">
        <dl class="git-commit-meta">
          <div class="git-commit-meta-row">
            <dt>提交</dt>
            <dd class="is-mono">{{ detail.shortOid }}</dd>
          </div>
          <div class="git-commit-meta-row">
            <dt>作者</dt>
            <dd>{{ detail.authorName }} &lt;{{ detail.authorEmail }}&gt;</dd>
          </div>
          <div class="git-commit-meta-row">
            <dt>时间</dt>
            <dd>{{ formatRelativeTime(detail.authoredAt, now) }}</dd>
          </div>
          <div v-if="detail.parents.length > 1" class="git-commit-meta-row">
            <dt>合并</dt>
            <dd>{{ detail.parents.length }} 个父提交</dd>
          </div>
          <div v-if="visibleRefs(detail.refs).length > 0" class="git-commit-meta-row">
            <dt>引用</dt>
            <dd>{{ visibleRefs(detail.refs).map(refLabel).join('、') }}</dd>
          </div>
        </dl>

        <p v-if="detail.body !== ''" class="git-commit-body">{{ detail.body }}</p>

        <p class="git-history-group-title">
          改动的文件 <span class="git-group-count">{{ detail.files.length }}</span>
        </p>
        <p v-if="detail.files.length === 0" class="git-notice">这个提交没有改动文件（可能是空提交）。</p>
        <p v-if="detail.truncated" class="git-notice">文件过多，仅显示前 500 个。</p>

        <ul class="git-list">
          <li v-for="file in detail.files" :key="`${file.status}:${file.path}`">
            <button type="button" class="git-row git-row-open" :title="file.path" @click="openFile(file)">
              <span class="git-row-badge" :class="`is-${file.status}`">{{ STATUS_LETTERS[file.status] }}</span>
              <span class="git-row-text">
                <span class="git-row-name">{{ splitPath(file.path).name }}</span>
                <span v-if="splitPath(file.path).directory !== ''" class="git-row-dir">{{ splitPath(file.path).directory }}</span>
              </span>
              <span v-if="fileDelta(file) !== null" class="git-row-delta">{{ fileDelta(file) }}</span>
            </button>
          </li>
        </ul>
      </template>
    </div>
  </div>

  <!-- 第一层：提交列表。 -->
  <div v-else class="git-history">
    <div class="git-history-head">
      <span v-if="filterPath !== null" class="git-history-filter" :title="filterPath">
        <span class="git-history-filter-label">只看 {{ filterPath }}</span>
        <AppButton variant="unstyled" class="file-tree-clear" aria-label="查看全部历史" title="查看全部历史" @click="historyStore.open(null)">
          <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </AppButton>
      </span>
      <span v-else-if="phase === 'ready'" class="git-history-head-note">
        {{ hasUpstream ? `上游 ${upstreamName}，领先 ${aheadCount} 个提交` : '此分支还没有上游，提交都还没推送' }}
      </span>
      <span v-else class="git-history-head-note"></span>
      <span v-if="hasUpstream && unpushedCount > 0" class="git-history-unpushed">↑{{ unpushedCount }} 未推送</span>
    </div>

    <div class="git-history-scroll scroll-area">
      <p v-if="phase === 'idle' || phase === 'loading'" class="git-notice">正在读取提交历史…</p>
      <template v-else-if="phase === 'error'">
        <p class="git-notice is-error">{{ error?.message ?? '读取提交历史失败。' }}</p>
        <AppButton variant="compact" class="git-retry" @click="historyStore.open(filterPath)">重试</AppButton>
      </template>
      <p v-else-if="commits.length === 0" class="git-notice">
        {{ filterPath === null ? '这个仓库还没有提交。' : '这个文件还没有提交记录。' }}
      </p>

      <ul v-else class="git-list git-commit-list">
        <li v-for="commit in commits" :key="commit.oid">
          <button type="button" class="git-commit-row" :title="`${commit.shortOid} ${commit.subject}`" @click="openCommit(commit)">
            <span class="git-commit-row-subject">{{ commit.subject === '' ? '（无提交信息）' : commit.subject }}</span>
            <span class="git-commit-row-meta">
              <span class="git-commit-row-oid">{{ commit.shortOid }}</span>
              <span class="git-commit-row-author">{{ commit.authorName }}</span>
              <span class="git-commit-row-time">{{ formatRelativeTime(commit.authoredAt, now) }}</span>
            </span>
            <span
              v-if="visibleRefs(commit.refs).length > 0 || showUnpushed(commit)"
              class="git-commit-row-badges"
            >
              <span
                v-for="ref in visibleRefs(commit.refs)"
                :key="ref"
                class="git-commit-ref"
                :class="{ 'is-current': isCurrentRef(ref) }"
              >{{ refLabel(ref) }}</span>
              <span v-if="showUnpushed(commit)" class="git-commit-unpushed">未推送</span>
            </span>
          </button>
        </li>
      </ul>

      <div v-if="canLoadMore" class="git-history-more">
        <AppButton variant="compact" :disabled="loadingMore" @click="historyStore.loadMore()">
          {{ loadingMore ? '正在读取…' : '加载更早的提交' }}
        </AppButton>
      </div>
    </div>
  </div>
</template>
