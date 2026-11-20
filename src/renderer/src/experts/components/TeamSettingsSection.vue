<!-- 设置页「专家团」分节：列出内置与自定义团队、可开团判定与加载诊断。
     本阶段只读：页面不提供团队的新建、编辑与开团入口（开团在会话侧完成）；
     可开团与否同时用文字与颜色表达，诊断只读展示、不提供自动修复。 -->
<script setup lang="ts">
import { onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import type { TeamIssueView, TeamView } from '../../../../shared/teams-api'
import { useTeamStore } from '../stores/team'
import AppButton from '../../ui/AppButton.vue'

const store = useTeamStore()
const { builtinTeams, userTeams, issues, loadError, loaded, hasTeams } = storeToRefs(store)

/** 诊断类型到可读文本；未列出的类型只显示原文键名，避免静默丢诊断。 */
const ISSUE_LABELS = {
  'definition-invalid': '定义无效',
  'id-conflict': '标识冲突',
  'lead-reference-missing': '引用的团长不存在',
  'member-reference-missing': '引用的成员不存在',
  'no-usable-member': '没有可用成员'
} as const satisfies Record<TeamIssueView['kind'], string>

function issueLabel(issue: TeamIssueView): string {
  return ISSUE_LABELS[issue.kind] ?? issue.kind
}

/** 诊断行只带标识与路径，正文里拼成一行人话。 */
function issueText(issue: TeamIssueView): string {
  const who = issue.teamId ?? '（无标识）'
  return issue.expertId === null ? who : `${who}：${issue.expertId}`
}

/** 成员只取前三个，再多用「等 N 个」收住：列表行不是清单页。 */
function memberSummary(team: TeamView): string {
  const ids = team.memberExpertIds
  if (ids.length === 0) return '未配置成员'
  return ids.length <= 3 ? ids.join('、') : `${ids.slice(0, 3).join('、')} 等 ${ids.length} 个`
}

async function refresh(): Promise<void> {
  await store.load()
}

onMounted(() => { void store.load() })
</script>

<template>
  <div class="settings-section-stack">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">专家团</h1>
      <p class="mt-1 text-sm text-desk-muted">
        团长拆解任务、分配成员、整合交付；成员由独立会话执行。当前版本只展示团队定义与加载诊断。
      </p>
    </header>

    <section class="settings-section" aria-labelledby="settings-teams-list-title" :aria-busy="!loaded">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-teams-list-title" class="settings-section-title">可用团队</h2>
          <p class="mt-1 text-xs text-desk-muted">
            内置团队只读；自定义团队放在产品 agent 目录的 teams/&lt;标识&gt;/team.md。
          </p>
        </div>
        <div class="flex items-center gap-2">
          <AppButton variant="ghost" :disabled="!loaded" @click="refresh">重新读取</AppButton>
        </div>
      </div>

      <p v-if="loadError !== null" role="alert" class="status-notice status-notice-error mt-3">
        读取团队清单失败：{{ loadError }}
      </p>

      <p v-else-if="loaded && !hasTeams" role="status" class="mt-3 text-xs text-desk-muted">
        还没有团队定义；创建团队与开团将在后续版本提供。
      </p>

      <template v-if="builtinTeams.length > 0">
        <p class="mt-4 text-2xs font-medium tracking-wide text-desk-muted">内置</p>
        <ul class="mt-2 space-y-2">
          <li
            v-for="team in builtinTeams"
            :key="team.id"
            class="rounded-lg border border-desk-line px-3 py-2.5"
          >
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="text-sm font-medium">{{ team.displayName }}</span>
              <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">内置</span>
              <span class="font-mono text-2xs text-desk-muted">{{ team.id }}</span>
              <span class="text-2xs" :class="team.ready ? 'text-desk-muted' : 'text-desk-warning'">
                {{ team.ready ? '可开团' : '不可开团' }}
              </span>
            </div>
            <p class="mt-1 text-xs text-desk-muted">{{ team.summary }}</p>
            <p class="mt-1 text-2xs text-desk-muted">团长：{{ team.leadExpertId }}</p>
            <p class="mt-1 text-2xs text-desk-muted">成员：{{ memberSummary(team) }}</p>
          </li>
        </ul>
      </template>

      <template v-if="userTeams.length > 0">
        <p class="mt-4 text-2xs font-medium tracking-wide text-desk-muted">自定义</p>
        <ul class="mt-2 space-y-2">
          <li
            v-for="team in userTeams"
            :key="team.id"
            class="rounded-lg border border-desk-line px-3 py-2.5"
          >
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="text-sm font-medium">{{ team.displayName }}</span>
              <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">自定义</span>
              <span class="font-mono text-2xs text-desk-muted">{{ team.id }}</span>
              <span class="text-2xs" :class="team.ready ? 'text-desk-muted' : 'text-desk-warning'">
                {{ team.ready ? '可开团' : '不可开团' }}
              </span>
            </div>
            <p class="mt-1 text-xs text-desk-muted">{{ team.summary }}</p>
            <p class="mt-1 text-2xs text-desk-muted">团长：{{ team.leadExpertId }}</p>
            <p class="mt-1 text-2xs text-desk-muted">成员：{{ memberSummary(team) }}</p>
          </li>
        </ul>
      </template>
    </section>

    <section v-if="issues.length > 0" class="settings-section" aria-labelledby="settings-teams-issues-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-teams-issues-title" class="settings-section-title">加载诊断</h2>
        </div>
      </div>
      <ul class="mt-3 space-y-1.5">
        <li v-for="(issue, index) in issues" :key="`${issue.kind}-${index}`" class="text-xs">
          <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">
            {{ issueLabel(issue) }}
          </span>
          <span class="ml-2">{{ issueText(issue) }}</span>
          <span class="ml-2 block truncate font-mono text-2xs text-desk-muted" :title="issue.path">
            {{ issue.path }}
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>
