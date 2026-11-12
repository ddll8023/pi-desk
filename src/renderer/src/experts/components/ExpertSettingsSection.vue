<!-- 设置页「专家」分节：列出内置与自定义专家、加载诊断，并提供新建、编辑、派生副本与删除四个操作。
     顶部另有「默认能力」卡片：专家继承的技能与 MCP 范围在那一处统一调整，专家定义只在它之上做增减。
     新建与编辑走同一个对话框（ExpertEditorDialog）；派生只复制正文到产品 agent 目录并写入 derivedFrom，
     此后副本自行演进、不跟随内置升级，因此列表要给派生来源与「新建会话才生效」的说明；诊断只读展示，
     界面上不提供自动修复。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { SessionExpertIssue, SessionExpertView } from '../../../../shared/session-api'
import { useExpertStore } from '../stores/expert'
import AppButton from '../../ui/AppButton.vue'
import ConfirmDialog from '../../ui/ConfirmDialog.vue'
import ExpertCapabilityDefaultsCard from './ExpertCapabilityDefaultsCard.vue'
import ExpertEditorDialog from './ExpertEditorDialog.vue'

const store = useExpertStore()
const {
  experts, issues, busyId, loadError, actionError, notice, loaded, editorOpen, editingId,
  capabilities, capabilitiesError, defaultsSaving
} = storeToRefs(store)

const pendingDelete = ref<SessionExpertView | null>(null)

/** 诊断类型到可读文本；未列出的类型只显示原文键名，避免静默丢诊断。 */
const ISSUE_LABELS = {
  'definition-invalid': '定义无效',
  'id-conflict': '标识冲突',
  'skill-reference-missing': '引用的技能不存在',
  'skill-reference-sub-agent': '引用了子代理专用技能',
  'mcp-reference-missing': '引用的 MCP 服务器不存在'
} as const satisfies Record<SessionExpertIssue['kind'], string>

const deleteOpen = computed(() => pendingDelete.value !== null)

function issueLabel(issue: SessionExpertIssue): string {
  return ISSUE_LABELS[issue.kind] ?? issue.kind
}

/** 诊断行只带标识与路径，正文里拼成一行人话。 */
function issueText(issue: SessionExpertIssue): string {
  const who = issue.expertId ?? '（无标识）'
  const target = issue.skillId ?? issue.serverName
  return target === null ? who : `${who}：${target}`
}

/** 名单只取前三个，再多用「等 N 个」收住：列表行不是清单页。 */
function nameList(ids: readonly string[]): string {
  return ids.length <= 3 ? ids.join('、') : `${ids.slice(0, 3).join('、')} 等 ${ids.length} 个`
}

/** 继承模式相对基线的加减：没有改动时不写括号，避免每行都带一个空括注。 */
function delta(add: readonly string[], remove: readonly string[]): string {
  if (add.length === 0 && remove.length === 0) return ''
  const parts: string[] = []
  if (add.length > 0) parts.push(`+${add.length}`)
  if (remove.length > 0) parts.push(`−${remove.length}`)
  return `（${parts.join(' ')}）`
}

/** 能力摘要：只描述范围口径与数量，不把整个名单塞进列表。 */
function capabilitySummary(expert: SessionExpertView): string {
  const skills = expert.skillsMode === 'only'
    ? (expert.skillIds.length === 0
      ? '技能 0 个（仅用选中）'
      : `技能 ${expert.skillIds.length} 个（仅用选中：${nameList(expert.skillIds)}）`)
    // 继承模式下的 `skills` 只作提示，不参与装配，所以标出来避免被当成实际范围。
    : `技能继承默认${delta(expert.skillAddIds, expert.skillRemoveIds)}${
      expert.skillIds.length > 0 ? `；声明 ${nameList(expert.skillIds)} 仅提示` : ''}`
  const mcp = expert.mcpMode === 'only'
    ? `MCP ${expert.mcpServerIds.length} 个（仅用选中）`
    : `MCP 继承默认${delta(expert.mcpAddIds, expert.mcpRemoveIds)}`
  return `${skills} · ${mcp}`
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
        专家不增删工具、不改预算，也不派子代理；它能做的是收窄本会话的技能与 MCP 服务器范围，
        工具、权限与确认流程不受它影响。
      </p>
    </header>

    <ExpertCapabilityDefaultsCard
      :capabilities="capabilities"
      :error="capabilitiesError"
      :saving="defaultsSaving"
      @save="store.saveDefaults"
    />

    <section class="settings-section" aria-labelledby="settings-experts-list-title" :aria-busy="!loaded">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-experts-list-title" class="settings-section-title">可用专家</h2>
          <p class="mt-1 text-xs text-desk-muted">
            内置专家随应用发布，只能派生副本；自定义专家可以在页面内新建与编辑，也可以删除。标识创建后不可改。
          </p>
        </div>
        <div class="flex items-center gap-2">
          <AppButton variant="ghost" :disabled="!loaded" @click="refresh">重新读取</AppButton>
          <AppButton variant="primary" :disabled="!loaded" @click="store.openCreate()">新建专家</AppButton>
        </div>
      </div>

      <p v-if="loadError !== null" role="alert" class="status-notice status-notice-error mt-3">
        读取专家清单失败：{{ loadError }}
      </p>

      <p v-else-if="loaded && experts.length === 0" role="status" class="mt-3 text-xs text-desk-muted">
        还没有可用的专家。内置专家需要重新构建随包资源后才会出现；自定义专家可以用右上角「新建专家」从空白创建，或从内置专家派生副本。
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
              <p class="mt-1 text-2xs text-desk-muted">能力范围：{{ capabilitySummary(expert) }}</p>
              <p v-if="expert.unavailableSkillIds.length > 0" class="mt-1 text-2xs text-desk-warning">
                不可用：{{ expert.unavailableSkillIds.join('、') }}（定义仍可用，这些引用不生效）
              </p>
              <p v-if="expert.truncated" class="mt-1 text-2xs text-desk-warning">
                正文过长：召唤时只注入前一段并补一行截断说明，定义文件本身不变
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <AppButton
                v-if="expert.source === 'builtin'"
                variant="ghost"
                :disabled="busyId !== null"
                @click="store.derive(expert.id)"
              >
                {{ isBusy(expert) ? '派生中…' : '派生副本' }}
              </AppButton>
              <template v-else>
                <AppButton
                  variant="ghost"
                  :disabled="busyId !== null"
                  @click="store.openEdit(expert.id)"
                >
                  编辑
                </AppButton>
                <AppButton
                  variant="ghost"
                  :disabled="busyId !== null"
                  @click="pendingDelete = expert"
                >
                  删除
                </AppButton>
              </template>
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

    <ExpertEditorDialog
      :open="editorOpen"
      :expert-id="editingId"
      @cancel="store.closeEditor()"
    />

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
