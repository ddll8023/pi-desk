<!-- 设置页「专家」分节：列出内置与自定义专家、加载诊断，并提供派生副本与删除自定义专家两个写操作。
     派生只复制正文到产品 agent 目录并写入 derivedFrom，此后副本自行演进、不跟随内置升级，
     因此列表要给派生来源与「改文件下一轮生效」的说明；诊断只读展示，界面上不提供自动修复。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { SessionExpertIssue, SessionExpertView } from '../../../../shared/session-api'
import { useExpertStore } from '../stores/expert'
import AppButton from '../../ui/AppButton.vue'
import ConfirmDialog from '../../ui/ConfirmDialog.vue'

const store = useExpertStore()
const { experts, issues, busyId, loadError, actionError, notice, loaded } = storeToRefs(store)

const pendingDelete = ref<SessionExpertView | null>(null)

/** 诊断类型到可读文本；未列出的类型只显示原文键名，避免静默丢诊断。 */
const ISSUE_LABELS = {
  'definition-invalid': '定义无效',
  'id-conflict': '标识冲突',
  'skill-reference-missing': '引用的技能不存在',
  'skill-reference-sub-agent': '引用了子代理专用技能'
} as const satisfies Record<SessionExpertIssue['kind'], string>

const deleteOpen = computed(() => pendingDelete.value !== null)

function issueLabel(issue: SessionExpertIssue): string {
  return ISSUE_LABELS[issue.kind] ?? issue.kind
}

/** 诊断行只带标识与路径，正文里拼成一行人话。 */
function issueText(issue: SessionExpertIssue): string {
  const who = issue.expertId ?? '（无标识）'
  const skill = issue.skillId === null ? '' : `：${issue.skillId}`
  return `${who}${skill}`
}

function isBusy(expert: SessionExpertView): boolean {
  return busyId.value === expert.id
}

async function refresh(): Promise<void> {
  store.clearNotice()
  await store.load()
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value
  pendingDelete.value = null
  if (target === null) return
  await store.remove(target.id)
}

onMounted(() => { void store.load() })
</script>

<template>
  <div class="settings-section-stack">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">专家</h1>
      <p class="mt-1 text-sm text-desk-muted">
        专家是一段会话级角色说明：新建会话时在输入坞选择，之后每一轮都作为独立系统提示段注入。
        专家不增删工具、不改预算，也不派子代理；这里只管定义文件，不改调用方式。
      </p>
    </header>

    <section class="settings-section" aria-labelledby="settings-experts-list-title" :aria-busy="!loaded">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-experts-list-title" class="settings-section-title">可用专家</h2>
          <p class="mt-1 text-xs text-desk-muted">
            内置专家随应用发布，只能派生副本；自定义专家在应用数据目录下，可以删除。
          </p>
        </div>
        <AppButton variant="ghost" :disabled="!loaded" @click="refresh">重新读取</AppButton>
      </div>

      <p v-if="loadError !== null" role="alert" class="status-notice status-notice-error mt-3">
        读取专家清单失败：{{ loadError }}
      </p>

      <p v-else-if="loaded && experts.length === 0" role="status" class="mt-3 text-xs text-desk-muted">
        还没有可用的专家。内置专家需要重新构建随包资源后才会出现；自定义专家放在应用数据目录的 experts/&lt;id&gt;/expert.md。
      </p>

      <p v-if="notice !== null" role="status" class="status-notice mt-3">{{ notice }}</p>
      <p v-if="actionError !== null" role="alert" class="status-notice status-notice-error mt-3">
        {{ actionError }}
      </p>

      <ul v-if="experts.length > 0" class="mt-4 space-y-2">
        <li
          v-for="expert in experts"
          :key="expert.id"
          class="rounded-lg border border-desk-line px-3 py-2.5"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-sm font-medium">{{ expert.displayName }}</span>
                <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">
                  {{ expert.source === 'builtin' ? '内置' : '自定义' }}
                </span>
                <span
                  v-if="expert.derivedFrom !== null"
                  class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted"
                >
                  派生自 {{ expert.derivedFrom }}
                </span>
                <span class="font-mono text-2xs text-desk-muted">{{ expert.id }}</span>
              </div>
              <p class="mt-1 text-xs text-desk-muted">{{ expert.summary }}</p>
              <p class="mt-1 text-2xs text-desk-muted">
                引用技能：{{ expert.skillIds.length > 0 ? expert.skillIds.join('、') : '未声明' }}
              </p>
              <p v-if="expert.unavailableSkillIds.length > 0" class="mt-1 text-2xs text-desk-warning">
                不可用：{{ expert.unavailableSkillIds.join('、') }}（定义仍可用，这些引用不生效）
              </p>
            </div>
            <div class="shrink-0">
              <AppButton
                v-if="expert.source === 'builtin'"
                variant="ghost"
                :disabled="busyId !== null"
                @click="store.derive(expert.id)"
              >
                {{ isBusy(expert) ? '派生中…' : '派生副本' }}
              </AppButton>
              <AppButton
                v-else
                variant="ghost"
                :disabled="busyId !== null"
                @click="pendingDelete = expert"
              >
                删除
              </AppButton>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <section v-if="issues.length > 0" class="settings-section" aria-labelledby="settings-experts-issues-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-experts-issues-title" class="settings-section-title">加载诊断</h2>
          <p class="mt-1 text-xs text-desk-muted">
            这里只报告问题，不改动任何文件；修好定义后重新读取即可。
          </p>
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

    <ConfirmDialog
      :open="deleteOpen"
      title="删除自定义专家"
      :description="`将删除 ${pendingDelete?.displayName ?? ''} 的定义文件，已绑定该专家的会话下次打开时不再注入角色段。`"
      detail="只会删除该专家目录下的 expert.md；目录里还有别的文件时不会执行删除。"
      confirm-label="删除"
      :confirm-disabled="busyId !== null"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>
