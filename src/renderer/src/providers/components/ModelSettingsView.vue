<!-- 模型设置：以供应商为主线的一页，把「能不能用」（凭据）、「指向哪里与有哪些模型」（models.json 条目）
     和「对话页显示哪些」（桌面端展示偏好）收在同一个供应商上下文里。
     页面只做编排：清单行就地展开凭据与可见性，models.json 条目在弹窗里编辑；
     登录输入与授权细节由页面级弹窗承载。
     三份数据各由各自的存储提供：凭据由 Pi 保存在 auth.json（内容不回读到页面），
     条目写 Pi 的 models.json，展示偏好写桌面端配置。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { AuthError, AuthMethod, AuthProviderStatus } from '../../../../shared/auth-api'
import type { ModelsConfigProvider } from '../../../../shared/models-config-api'
import type { ModelSummary } from '../../../../shared/runtime-api'
import { useAuthStore } from '../stores/auth'
import { useModelsConfigStore } from '../stores/models-config'
import { useRuntimeStore } from '../../sessions/stores/runtime'
import { useSessionStore } from '../../sessions/stores/session'
import { copyText } from '../../ui/clipboard'
import { providerStatusLabel } from '../provider-status'
import AppButton from '../../ui/AppButton.vue'
import AuthFlowDialog from './AuthFlowDialog.vue'
import ConfirmDialog from '../../ui/ConfirmDialog.vue'
import ProviderEditorDialog from './ProviderEditorDialog.vue'
import ProviderListItem, { type ProviderRow } from './ProviderListItem.vue'

/** 新建条目的初始内容；供应商 ID 由入口带入，其余字段给出可直接保存的最小骨架。 */
const INITIAL_RAW_TEXT = JSON.stringify({ api: 'openai-completions', models: [{ id: '' }] }, null, 2)

const authStore = useAuthStore()
const modelsConfigStore = useModelsConfigStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()

const { statusView, providers: authProviders, configError, flow, flowAction, logoutAction, configuredCount }
  = storeToRefs(authStore)

const {
  view: configView,
  providers: customProviders,
  snapshot,
  parseError,
  busy: configBusy,
  actionError
} = storeToRefs(modelsConfigStore)

const { availableModels, hiddenModels, modelDisplayLoaded, modelDisplayView } = storeToRefs(runtimeStore)

/** 统一搜索词；同时匹配供应商名称与 provider id。 */
const query = ref('')
/** 就地展开详情的供应商 id；null 表示都不展开。 */
const expandedId = ref<string | null>(null)
/** 编辑器弹窗的目标；null 表示未打开。 */
const editor = ref<{ mode: 'create' | 'edit'; providerId: string; initialRawText: string } | null>(null)
/** 认证目标独立于展开行，收起详情或过滤清单不会丢失正在进行的认证入口。 */
const authTarget = ref<{ providerId: string; name: string; method: AuthMethod } | null>(null)
const authDialogOpen = ref(false)
const authStarting = ref(false)
const authStartFailed = ref(false)
/** 正在从云端刷新模型的供应商 ID；null 表示当前没有刷新进行中。 */
const refreshingProviderId = ref<string | null>(null)

/** 最近一次写成功的提示；只在本次停留期间展示。 */
const notice = ref<string | null>(null)
/** 待确认的凭据删除目标；确认后才发出退出登录请求。 */
const pendingCredentialRemoval = ref<AuthProviderStatus | null>(null)
/** 待确认的自定义条目删除目标。 */
const pendingDelete = ref<string | null>(null)
/** 最近一次复制成功的区块标识，只用于给出「已复制」反馈。 */
const copiedBlock = ref<string | null>(null)
/** 最近一次复制失败的区块标识；失败必须可见，不能停在「复制」。 */
const failedBlock = ref<string | null>(null)

/** 模型目录是否已就绪；未就绪时隐藏计数退回偏好里的原始条目数。 */
const catalogLoaded = computed(() => runtimeStore.capabilitiesView.phase === 'ready')

/** 当前模型目录按 provider 归组；目录未就绪时为空，清单仍由凭据状态与 models.json 条目支撑。 */
const modelsByProvider = computed<ReadonlyMap<string, readonly ModelSummary[]>>(() => {
  const collected = new Map<string, ModelSummary[]>()
  for (const model of availableModels.value) {
    const models = collected.get(model.provider) ?? []
    models.push(model)
    collected.set(model.provider, models)
  }
  return collected
})

const customProviderById = computed<ReadonlyMap<string, ModelsConfigProvider>>(() => {
  const entries = new Map<string, ModelsConfigProvider>()
  for (const provider of customProviders.value) entries.set(provider.id, provider)
  return entries
})

function hiddenIdsOf(provider: string): ReadonlySet<string> {
  return new Set(
    hiddenModels.value
      .filter((hidden) => hidden.provider === provider)
      .map((hidden) => hidden.modelId)
  )
}

/**
 * 被隐藏的模型数：目录已就绪时只统计仍存在的模型（历史残留不计入展示），
 * 目录未就绪时退回偏好里的原始条目数。
 */
function hiddenCountFor(
  models: readonly ModelSummary[],
  hiddenIds: ReadonlySet<string>,
  catalogReady: boolean
): number {
  if (!catalogReady) return hiddenIds.size
  return models.filter((model) => hiddenIds.has(model.id)).length
}

function toRow(provider: AuthProviderStatus): ProviderRow {
  const catalogReady = catalogLoaded.value
  const entry = customProviderById.value.get(provider.providerId) ?? null
  const models = modelsByProvider.value.get(provider.providerId) ?? []
  const hiddenIds = hiddenIdsOf(provider.providerId)
  return {
    id: provider.providerId,
    name: provider.name,
    status: providerStatusLabel(provider),
    modelCount: provider.modelCount,
    hiddenCount: hiddenCountFor(models, hiddenIds, catalogReady),
    custom: entry !== null,
    hasApiKey: entry?.hasApiKey === true,
    configured: provider.configured,
    authStatus: provider,
    entry,
    models,
    hiddenIds
  }
}

/**
 * 清单：默认只列「已配置凭据 / 有已知模型 / 是 models.json 自定义条目」的供应商，
 * 有搜索词时只显示匹配项，不受默认清单范围限制，未配置的供应商仍能被搜到并录入密钥。
 * 排序沿用既有口径：自定义在前、未配置在后，其余按名称升序。
 */
const providerRows = computed<ProviderRow[]>(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  return authProviders.value
    .map(toRow)
    .filter((row) => {
      if (keyword !== '') return matches(row, keyword)
      return row.configured || row.modelCount > 0 || row.custom
    })
    .sort((left, right) => {
      if (left.custom !== right.custom) return left.custom ? -1 : 1
      if (left.configured !== right.configured) return left.configured ? -1 : 1
      return left.name.localeCompare(right.name)
    })
})

function matches(row: ProviderRow, keyword: string): boolean {
  return row.name.toLocaleLowerCase().includes(keyword) || row.id.toLocaleLowerCase().includes(keyword)
}

/** 全量口径：不随搜索过滤变化，否则「恢复全部显示」会误判成没有可恢复的模型。 */
const totalHiddenCount = computed(() => hiddenModels.value.length)

const existingProviderIds = computed(() => customProviders.value.map((provider) => provider.id))

const displayLoading = computed(() => (
  modelDisplayView.value.phase === 'loading' || modelDisplayView.value.phase === 'idle'
))
const displayError = computed(() => (
  modelDisplayView.value.phase === 'error' ? modelDisplayView.value.error.message : null
))
/** 写入期间不禁用：开关是乐观更新，再点一次即为重试；只有偏好未加载时没有确认基线可写。 */
const canToggle = computed(() => modelDisplayLoaded.value && !displayLoading.value)

const configLoadError = computed(() => (
  configView.value.phase === 'error' ? configView.value.error.message : null
))
const configLoading = computed(() => configView.value.phase === 'loading' || configView.value.phase === 'idle')
/** models.json 写动作错误：就近展示在触发它的条目区块，不放到页面顶部。 */
const configActionError = computed(() => actionError.value?.message ?? null)

/** 流程错误在认证弹窗内展示；没有可恢复目标的历史启动错误仍在页面保留。 */
const authErrors = computed(() => {
  const entries: { readonly key: string; readonly error: AuthError }[] = []
  if (statusView.value.phase === 'error') entries.push({ key: 'status', error: statusView.value.error })
  if (flowAction.value.phase === 'error' && authTarget.value === null && flow.value === null) {
    entries.push({ key: 'flow', error: flowAction.value.error })
  }
  if (logoutAction.value.phase === 'error') entries.push({ key: 'logout', error: logoutAction.value.error })
  return entries
})

/** 复制到剪贴板；成功与失败都就地反馈，不改变页面其他状态。 */
async function copy(key: string, text: string): Promise<void> {
  const copied = await copyText(text)
  copiedBlock.value = copied ? key : null
  failedBlock.value = copied ? null : key
}

function copyLabel(key: string): string {
  if (copiedBlock.value === key) return '已复制'
  return failedBlock.value === key ? '复制失败' : '复制'
}

/** 点击清单行：详情就地展开在该行下方，再点一次收起；同一时刻只展开一行。 */
function toggleRow(row: ProviderRow): void {
  if (expandedId.value === row.id) {
    expandedId.value = null
    return
  }
  expandedId.value = row.id
}

/** 发起认证时先打开弹窗显示启动中状态，旧流程快照不会被当作本次结果。 */
async function beginAuth(target: { providerId: string; name: string; method: AuthMethod }): Promise<void> {
  if (authStarting.value || flowAction.value.phase === 'sending') return
  if (authStore.activeFlow !== null) {
    resumeAuth()
    return
  }
  authTarget.value = target
  authStartFailed.value = false
  authStarting.value = true
  authDialogOpen.value = true
  try {
    await authStore.login(target.providerId, target.method)
    authStartFailed.value = flowAction.value.phase === 'error'
  } finally {
    authStarting.value = false
  }
}

function startAuth(provider: AuthProviderStatus, method: AuthMethod): void {
  void beginAuth({ providerId: provider.providerId, name: provider.name, method })
}

function retryAuth(): void {
  if (authTarget.value !== null) void beginAuth(authTarget.value)
}

/** 收起不终止流程；重新打开时按当前快照恢复目标，而不是依赖清单仍在展开。 */
function resumeAuth(): void {
  const current = flow.value
  if (!authStarting.value && !authStartFailed.value && current !== null) {
    authTarget.value = {
      providerId: current.providerId,
      name: authProviders.value.find((provider) => provider.providerId === current.providerId)?.name ?? current.providerId,
      method: current.method
    }
  }
  if (authTarget.value !== null) authDialogOpen.value = true
}

/** 先收起认证弹窗再进入既有的会话中断确认链，不叠加两套焦点约束。 */
function reloadFromAuth(): void {
  authDialogOpen.value = false
  void nextTick(reloadRuntime)
}

/** 打开编辑器弹窗：编辑既有条目，或按给定 ID 新建；未保存的改动由弹窗自己确认。 */
function openEditor(next: { mode: 'create' | 'edit'; providerId: string; initialRawText: string }): void {
  modelsConfigStore.clearActionError()
  notice.value = null
  editor.value = next
}

function startCreate(presetId = ''): void {
  openEditor({ mode: 'create', providerId: presetId, initialRawText: INITIAL_RAW_TEXT })
}

function startEdit(row: ProviderRow): void {
  if (row.entry === null) return
  openEditor({ mode: 'edit', providerId: row.id, initialRawText: row.entry.json })
}

/** 保存成功：关掉弹窗并让刚保存的供应商就地展开；空闲时自动重新加载会话。 */
async function onSaved(id: string): Promise<void> {
  notice.value = null
  editor.value = null
  expandedId.value = id
  await runtimeStore.refreshModelPreview(true)
  const reloaded = await sessionStore.reloadCurrent()
  if (!reloaded) {
    notice.value = `已保存供应商 ${id}；改动将在重新加载当前会话后生效。`
  }
}

function cancelEditor(): void {
  editor.value = null
}

/** 重新读取：同时刷新凭据状态与 models.json 快照，两者互不阻塞。 */
function refreshAll(): void {
  modelsConfigStore.clearActionError()
  notice.value = null
  void modelsConfigStore.refresh()
  void authStore.refresh()
}

/** 从云端刷新指定供应商的模型目录；空闲时自动热更新当前会话。 */
async function onRefreshModels(row: ProviderRow): Promise<void> {
  if (refreshingProviderId.value !== null) return
  refreshingProviderId.value = row.id
  notice.value = null
  try {
    const result = await authStore.refreshModels(row.id)
    if (result.ok) {
      await runtimeStore.refreshModelPreview(true)
      const reloaded = await sessionStore.reloadCurrent()
      if (!reloaded) {
        notice.value = `已从云端刷新 ${row.name} 的模型目录（共 ${result.count ?? row.modelCount} 个模型）；会话空闲时重新加载即可在对话中使用。`
      }
    } else {
      notice.value = `从云端刷新 ${row.name} 模型失败：${result.message ?? '未知错误'}`
    }
  } finally {
    refreshingProviderId.value = null
  }
}

/** 退出登录不可逆：先经确认对话框，确认后才把请求交给主进程。 */
function confirmCredentialRemoval(): void {
  const provider = pendingCredentialRemoval.value
  pendingCredentialRemoval.value = null
  if (provider === null) return
  void authStore.logout(provider.providerId)
}

async function confirmDelete(): Promise<void> {
  const id = pendingDelete.value
  if (id === null) return
  const removed = await modelsConfigStore.remove(id)
  pendingDelete.value = null
  if (!removed) return
  if (expandedId.value === id) expandedId.value = null
  await runtimeStore.refreshModelPreview(true)
  const reloaded = await sessionStore.reloadCurrent()
  if (!reloaded) {
    notice.value = `已删除供应商 ${id}；改动将在重新加载当前会话后生效。`
  }
}

/** 重新加载 Runtime：复用既有重启式重载与中断确认链，让 Pi 重新读取凭据与模型目录。 */
function reloadRuntime(): void {
  void sessionStore.reloadCurrent()
}

/** 恢复全部显示：清空隐藏列表。 */
function showAll(): void {
  if (!canToggle.value || totalHiddenCount.value === 0) return
  runtimeStore.showAllModels()
}

onMounted(() => {
  void modelsConfigStore.refresh()
  void authStore.initialize()
  // 展示偏好按 Runtime 启动读取；这里补一次，避免页面依赖 Runtime 是否已经启动过。
  void runtimeStore.loadModelDisplay()
})

onUnmounted(() => {
  authStore.dispose()
})
</script>

<template>
  <div class="model-settings">
    <header class="model-settings__header">
      <h1 class="model-settings__title">模型</h1>
      <p class="model-settings__description">
        管理 Pi 的供应商凭据与自定义供应商，并选择对话页显示哪些模型。凭据与 models.json 的改动需要在重新加载会话后才会生效。
      </p>
    </header>

    <!-- 错误分层：结论在上一层，原始文本与辅助进程诊断收在可复制的细节里。 -->
    <div
      v-for="entry in authErrors"
      :key="`auth-error-${entry.key}`"
      role="alert"
      class="status-notice status-notice-error"
    >
      <p>{{ entry.error.message }}</p>
      <details v-if="entry.error.detail !== null">
        <summary class="mt-1 text-2xs">技术细节</summary>
        <div class="technical-detail">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-2xs text-desk-muted">原始信息</span>
            <AppButton
              variant="unstyled"
              class="copy-button"
              @click="copy(`error-${entry.key}`, entry.error.detail ?? '')"
            >
              {{ copyLabel(`error-${entry.key}`) }}
            </AppButton>
          </div>
          <pre class="technical-detail-text">{{ entry.error.detail }}</pre>
        </div>
      </details>
    </div>

    <p v-if="configError !== null" role="alert" class="status-notice status-notice-error">
      Pi 报告的本地认证或模型状态问题：{{ configError }}
    </p>

    <p v-if="configLoadError !== null" role="alert" class="status-notice status-notice-error">
      {{ configLoadError }}
    </p>
    <p v-else-if="parseError !== null" role="alert" class="status-notice status-notice-error">
      models.json 无法解析，已暂停写入：{{ parseError }} 先在外部修正文件，再点「重新读取」。
    </p>
    <div v-if="notice !== null" role="status" class="status-notice status-notice-info">
      <p>{{ notice }}</p>
      <AppButton
        variant="compact"
        class="mt-2"
        :disabled="sessionStore.opening"
        @click="reloadRuntime"
      >
        {{ sessionStore.opening ? '正在重新加载…' : '重新加载当前会话' }}
      </AppButton>
    </div>

    <div class="model-settings__toolbar">
      <label class="model-settings__search">
        <span class="sr-only">搜索供应商</span>
        <input
          v-model="query"
          type="search"
          placeholder="按名称或 provider 过滤"
          class="text-control"
        >
      </label>
      <AppButton
        variant="primary"
        class="model-settings__add"
        :disabled="configBusy || parseError !== null"
        @click="startCreate()"
      >添加自定义供应商</AppButton>
      <div class="model-settings__auxiliary">
        <div class="model-settings__toolbar-meta">
          <span v-if="statusView.phase === 'ready'" class="model-settings__stat">
            已配置 <strong>{{ configuredCount }}</strong><span class="model-settings__stat-total">/ {{ authProviders.length }}</span>
          </span>
          <span class="model-settings__stat">隐藏模型 <strong>{{ totalHiddenCount }}</strong></span>
        </div>
        <div class="model-settings__actions">
          <AppButton variant="ghost" :disabled="!canToggle || totalHiddenCount === 0" @click="showAll">恢复全部显示</AppButton>
          <AppButton variant="ghost" :disabled="configBusy || statusView.phase === 'loading'" @click="refreshAll">重新读取</AppButton>
        </div>
      </div>
    </div>
    <p v-if="snapshot?.truncated === true" class="status-notice status-notice-warn">
      条目过多，这里只展示了一部分；其余条目仍保留在文件里。
    </p>

    <section class="model-settings__providers" :aria-busy="statusView.phase === 'loading'">
      <div class="model-settings__section-heading">
        <h2>供应商</h2>
        <span>{{ providerRows.length }} 项</span>
      </div>

      <p v-if="statusView.phase === 'loading'" class="hint-text">正在读取凭据状态…</p>
      <p v-else-if="providerRows.length === 0" class="hint-text">
        {{ authProviders.length === 0 ? 'Pi 没有报告任何 Provider。' : '没有匹配的供应商；清空搜索可以看到全部已配置项。' }}
      </p>

      <ul v-else class="model-settings__provider-list">
        <li v-for="row in providerRows" :key="row.id">
          <ProviderListItem
            :row="row"
            :expanded="expandedId === row.id"
            :can-toggle="canToggle"
            :display-loading="displayLoading"
            :display-error="displayError"
            :config-loading="configLoading"
            :parse-error="parseError"
            :config-busy="configBusy"
            :action-error="configActionError"
            :refreshing-models="refreshingProviderId === row.id"
            @toggle="toggleRow(row)"
            @edit="startEdit(row)"
            @create="startCreate(row.id)"
            @remove-entry="pendingDelete = row.id"
            @request-remove-credential="pendingCredentialRemoval = row.authStatus"
            @login="startAuth(row.authStatus, $event)"
            @resume-auth="resumeAuth"
            @refresh-models="onRefreshModels(row)"
          />
        </li>
      </ul>
    </section>

    <AuthFlowDialog
      :open="authDialogOpen"
      :provider-id="authTarget?.providerId ?? ''"
      :provider-name="authTarget?.name ?? ''"
      :method="authTarget?.method ?? 'api_key'"
      :starting="authStarting"
      :start-failed="authStartFailed"
      :reloading="sessionStore.opening"
      @close="authDialogOpen = false"
      @retry="retryAuth"
      @reload="reloadFromAuth"
    />

    <ProviderEditorDialog
      :open="editor !== null"
      :mode="editor?.mode ?? 'create'"
      :provider-id="editor?.providerId ?? ''"
      :initial-raw-text="editor?.initialRawText ?? ''"
      :existing-provider-ids="existingProviderIds"
      @saved="onSaved"
      @cancel="cancelEditor"
    />

    <details class="model-settings__boundaries">
      <summary>凭据与模型配置说明</summary>
      <p v-if="snapshot !== null" class="model-settings__config-path font-mono text-2xs text-desk-muted">{{ snapshot.filePath }}</p>
      <ul class="model-settings__boundary-list">
        <li>提交的密钥只经一次受限通道交给 Pi，不进入聊天、提示词、偏好或日志；已保存的凭据不会回传到页面。</li>
        <li>退出登录只删除 Pi 保存在 auth.json 里的凭据，不影响环境变量与 models.json 里配置的凭据或密钥命令。</li>
        <li>凭据与条目变化后，运行中的 Runtime 仍使用启动时的模型快照，需要重新加载才会生效。</li>
        <li>只写 <span class="font-mono">models.json</span> 里 <span class="font-mono">providers</span> 下被编辑的那一个条目；其他供应商、其他顶层键与条目里未涉及的字段原样保留。</li>
        <li>真实密钥以明文存在 <span class="font-mono">models.json</span>（Pi 自身的格式）；这里不回显已保存的密钥，也不把它写进日志。</li>
        <li>文件在应用之外被改过时，本次保存会被拒绝；点「重新读取」后再保存即可。</li>
        <li>对话页的模型可见性只影响输入坞模型选择器的候选项，不改变 Pi 的模型配置；偏好读取失败时不过滤任何模型。</li>
      </ul>
    </details>

    <Teleport to="body">
      <ConfirmDialog
        :open="pendingCredentialRemoval !== null"
        title="删除已保存的凭据？"
        description="只删除 Pi 为这个 Provider 保存在 auth.json 里的凭据，不影响环境变量与 models.json 里配置的凭据或密钥命令，也不会在 Provider 侧撤销该凭据。"
        :detail="pendingCredentialRemoval === null ? '' : `${pendingCredentialRemoval.name}（${pendingCredentialRemoval.providerId}）`"
        confirm-label="删除凭据"
        @confirm="confirmCredentialRemoval"
        @cancel="pendingCredentialRemoval = null"
      />
    </Teleport>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="删除自定义供应商"
      :description="`将从 models.json 中移除供应商 ${pendingDelete ?? ''} 的条目。`"
      detail="只删除这一个条目；其他供应商与 Pi 的其他配置都不受影响。删除后需要重新加载会话才会生效。"
      confirm-label="删除"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>

<style scoped>
.model-settings {
  display: grid;
  gap: 1rem;
  color: var(--color-desk-ink);
}

.model-settings__header {
  max-width: 48rem;
  padding-bottom: 0.25rem;
}

.model-settings__title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 650;
  line-height: 1.35;
  letter-spacing: -0.02em;
}

.model-settings__description {
  margin-top: 0.5rem;
  color: var(--color-desk-muted);
  font-size: 0.8125rem;
  line-height: 1.65;
}

.model-settings__toolbar {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem 0.75rem;
}

.model-settings__search {
  min-width: 0;
}

.model-settings__search .text-control {
  padding-block: 0.4375rem;
  font-size: 0.8125rem;
}

.model-settings__add {
  padding-block: 0.4375rem;
  font-size: 0.8125rem;
}

.model-settings__auxiliary {
  display: flex;
  grid-column: 1 / -1;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.375rem 1rem;
}

.model-settings__toolbar-meta,
.model-settings__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
}

.model-settings__stat {
  color: var(--color-desk-muted);
  font-size: 0.75rem;
  white-space: nowrap;
}

.model-settings__stat strong {
  padding-left: 0.25rem;
  color: var(--color-desk-ink);
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}

.model-settings__stat-total {
  padding-left: 0.125rem;
}

.model-settings__actions {
  margin-left: auto;
}

.model-settings__providers {
  min-width: 0;
}

.model-settings__section-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.25rem 0 0.75rem;
}

.model-settings__section-heading h2 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 650;
}

.model-settings__section-heading > span {
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}

.model-settings__provider-list {
  margin: 0;
  border-block: 1px solid var(--color-desk-line);
  background: var(--color-desk-surface);
  padding: 0;
  list-style: none;
}

.model-settings__provider-list > li {
  min-width: 0;
}

.model-settings__provider-list > li + li {
  border-top: 1px solid var(--color-desk-line);
}

.model-settings__boundaries {
  border-top: 1px solid var(--color-desk-line);
  padding-top: 0.75rem;
}

.model-settings__boundaries summary {
  width: fit-content;
  color: var(--color-desk-muted);
  font-size: 0.75rem;
  cursor: pointer;
}

.model-settings__boundary-list {
  display: grid;
  gap: 0.5rem;
  margin: 0.75rem 0 0;
  padding-left: 1.125rem;
  color: var(--color-desk-muted);
  font-size: 0.75rem;
  line-height: 1.6;
}

.model-settings__config-path {
  margin-top: 0.625rem;
  overflow-wrap: anywhere;
}

.model-settings__boundaries summary:focus-visible {
  outline: 2px solid var(--color-desk-accent);
  outline-offset: 3px;
}

@media (max-width: 440px) {
  .model-settings__toolbar {
    grid-template-columns: minmax(0, 1fr);
  }

  .model-settings__add {
    justify-self: start;
  }

  .model-settings__actions {
    margin-left: 0;
  }
}
</style>
