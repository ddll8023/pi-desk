<!-- 模型设置：以供应商为主线的一页，把「能不能用」（凭据）、「指向哪里与有哪些模型」（models.json 条目）
     和「对话页显示哪些」（桌面端展示偏好）收在同一个供应商上下文里。
     三份数据各由各自的存储提供，页面只做编排：凭据由 Pi 保存在 auth.json（内容不回读到页面），
     条目写 Pi 的 models.json，展示偏好写桌面端配置。登录流程进行中或刚结束时固定在顶部，
     展开另一行不会让它消失。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { AuthError, AuthFlowSnapshot, AuthProviderStatus } from '../../../shared/auth-api'
import type { ModelsConfigProvider } from '../../../shared/models-config-api'
import type { ModelSummary } from '../../../shared/runtime-api'
import { useAuthStore } from '../stores/auth'
import { useModelsConfigStore } from '../stores/models-config'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import { copyText } from '../clipboard'
import { providerStatusLabel } from '../provider-status'
import AppButton from './ui/AppButton.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import ProviderCredentialSection from './ProviderCredentialSection.vue'
import ProviderCreateDialog from './ProviderCreateDialog.vue'
import ProviderDefinitionSection from './ProviderDefinitionSection.vue'
import ProviderVisibilitySection from './ProviderVisibilitySection.vue'

/** 清单一行：供应商身份加上三份数据里与它相关的汇总。 */
interface ProviderRow {
  readonly id: string
  readonly name: string
  /** 凭据状态文案，与凭据区块共用同一份判断。 */
  readonly status: string
  /** Pi 报告的已知模型数；不依赖模型目录是否已加载。 */
  readonly modelCount: number
  /** 在对话页被隐藏的模型数。 */
  readonly hiddenCount: number
  /** 是否在 models.json 里有自定义条目。 */
  readonly custom: boolean
  /** models.json 条目是否已配置密钥；没有条目时为 false。 */
  readonly hasApiKey: boolean
  readonly configured: boolean
  readonly authStatus: AuthProviderStatus
  /** models.json 里的条目；没有条目时为 null。 */
  readonly entry: ModelsConfigProvider | null
  /** 当前模型目录里属于它的模型；目录未就绪时为空。 */
  readonly models: readonly ModelSummary[]
  /** 它在对话页被隐藏的模型 id。 */
  readonly hiddenIds: ReadonlySet<string>
}

const authStore = useAuthStore()
const modelsConfigStore = useModelsConfigStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()

const {
  statusView,
  providers: authProviders,
  configError,
  flow,
  activeFlow,
  flowAction,
  logoutAction,
  secretInput,
  selectInput,
  configuredCount
} = storeToRefs(authStore)

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
/** 清单容器；展开详情后用它把该行的详情滚到完全可见。 */
const listElement = ref<HTMLElement | null>(null)
/** 是否正在用弹窗新建自定义供应商。 */
const creating = ref(false)
/** 新建弹窗的初始供应商 ID；从某个供应商的详情进入时带上它的 ID。 */
const createProviderId = ref('')
/** 编辑区块的重置版本；取消编辑时递增，让区块回到已保存的条目。 */
const editorVersion = ref(0)
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

const runtimeReady = computed(() => runtimeStore.view.phase === 'ready')

/** 传给凭据区块的可用性来源：Runtime 能力就绪时是「已有模型的 Provider」，未就绪时为 null。 */
const runtimeModelProviders = computed<ReadonlySet<string> | null>(() => {
  const view = runtimeStore.capabilitiesView
  if (view.phase !== 'ready') return null
  return new Set(view.data.models.map((model) => model.provider))
})

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
 * 被隐藏的模型数：目录已加载时只统计仍存在的模型（历史残留不计入展示），
 * 目录未就绪时退回偏好里的原始条目数。
 */
function hiddenCountFor(
  models: readonly ModelSummary[],
  hiddenIds: ReadonlySet<string>,
  catalogLoaded: boolean
): number {
  if (!catalogLoaded) return hiddenIds.size
  return models.filter((model) => hiddenIds.has(model.id)).length
}

function toRow(provider: AuthProviderStatus): ProviderRow {
  const catalogLoaded = availableModels.value.length > 0
  const entry = customProviderById.value.get(provider.providerId) ?? null
  const models = modelsByProvider.value.get(provider.providerId) ?? []
  const hiddenIds = hiddenIdsOf(provider.providerId)
  return {
    id: provider.providerId,
    name: provider.name,
    status: providerStatusLabel(provider),
    modelCount: provider.modelCount,
    hiddenCount: hiddenCountFor(models, hiddenIds, catalogLoaded),
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
 * 其余内置未配置的收进搜索——命中的行不受这条限制，未配置的供应商仍能被搜到并录入密钥。
 * 排序沿用既有口径：自定义在前、未配置在后，其余按名称升序。
 */
const providerRows = computed<ProviderRow[]>(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  return authProviders.value
    .map(toRow)
    .filter((row) => {
      if (keyword !== '' && matches(row, keyword)) return true
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

const totalHiddenCount = computed(() => providerRows.value.reduce((sum, row) => sum + row.hiddenCount, 0))

const existingProviderIds = computed(() => customProviders.value.map((provider) => provider.id))

const displayLoading = computed(() => modelDisplayView.value.phase === 'loading')
const displayBusy = computed(() => modelDisplayView.value.phase === 'saving')
const displayError = computed(() => (
  modelDisplayView.value.phase === 'error' ? modelDisplayView.value.error.message : null
))
const canToggle = computed(() => modelDisplayLoaded.value && !displayBusy.value && !displayLoading.value)

const configLoadError = computed(() => (
  configView.value.phase === 'error' ? configView.value.error.message : null
))
const configLoading = computed(() => configView.value.phase === 'loading' || configView.value.phase === 'idle')
const configActionError = computed(() => actionError.value?.message ?? null)

/** 登录流程刚结束且 Runtime 就绪时，给出重启式重载的一行提示。 */
const showReloadHint = computed(() => flow.value?.phase === 'completed' && runtimeReady.value)

/** 流程卡片的登录方式文案；与具体 Provider 无关，只反映本次流程用的是哪一类认证。 */
const flowMethodLabel = computed(() => (flow.value?.method === 'oauth' ? '账户登录' : 'API Key'))

/** 本页要展示的认证错误：状态读取、登录流程操作与退出登录各自保留错误。 */
const authErrors = computed(() => {
  const entries: { readonly key: string; readonly error: AuthError }[] = []
  if (statusView.value.phase === 'error') entries.push({ key: 'status', error: statusView.value.error })
  if (flowAction.value.phase === 'error') entries.push({ key: 'flow', error: flowAction.value.error })
  if (logoutAction.value.phase === 'error') entries.push({ key: 'logout', error: logoutAction.value.error })
  return entries
})

function promptPlaceholder(snapshot: AuthFlowSnapshot): string {
  const placeholder = snapshot.prompt?.placeholder ?? null
  if (placeholder !== null && placeholder !== '') return placeholder
  return snapshot.prompt?.kind === 'secret' ? '粘贴密钥后提交' : '输入后提交'
}

function phaseLabel(snapshot: AuthFlowSnapshot | null): string {
  if (snapshot === null) return ''
  switch (snapshot.phase) {
    case 'waiting': return '进行中'
    case 'prompt': return '等待输入'
    case 'cancelling': return '正在取消'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
  }
}

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
  void revealExpanded(row.id)
}

/** 展开后确保详情完整落在视口内，不让用户自己往下滑。 */
async function revealExpanded(id: string): Promise<void> {
  await nextTick()
  listElement.value
    ?.querySelector<HTMLElement>(`[data-provider-detail="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ block: 'nearest' })
}

/** 打开新建弹窗；从某个供应商的详情进入时带上它的 ID 作为初始值。 */
function startCreate(presetId = ''): void {
  modelsConfigStore.clearActionError()
  notice.value = null
  creating.value = true
  createProviderId.value = presetId
}

/** 取消：编辑时丢弃未保存的改动，回到已保存的条目；弹窗由父级关闭。 */
function cancelDefinition(): void {
  editorVersion.value += 1
}

/** 保存成功：给出提示、关掉弹窗并让刚保存的供应商就地展开。 */
function onSaved(id: string): void {
  notice.value = `已保存供应商 ${id}；改动需要重新加载会话后才会反映到输入坞的模型列表。`
  creating.value = false
  expandedId.value = id
  void revealExpanded(id)
}

/** 重新读取：同时刷新凭据状态与 models.json 快照，两者互不阻塞。 */
function refreshAll(): void {
  modelsConfigStore.clearActionError()
  notice.value = null
  void modelsConfigStore.refresh()
  void authStore.refresh()
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
  notice.value = `已删除供应商 ${id}；改动需要重新加载会话后才会生效。`
  if (expandedId.value === id) expandedId.value = null
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

/** 供应商级批量：把该行在当前模型目录里的全部模型设为显示或隐藏。 */
function setRowVisibility(row: ProviderRow, visible: boolean): void {
  if (!canToggle.value || row.models.length === 0) return
  runtimeStore.setModelsVisibility(
    row.models.map((model) => ({ provider: model.provider, modelId: model.id })),
    visible
  )
}

onMounted(() => {
  void modelsConfigStore.refresh()
  void authStore.initialize()
})

onUnmounted(() => {
  authStore.dispose()
})
</script>

<template>
  <div class="space-y-4">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">模型</h1>
      <p class="mt-1 text-sm text-desk-muted">
        管理 Pi 的供应商凭据与自定义供应商，并选择对话页显示哪些模型。
      </p>
    </header>

    <!-- 登录流程：固定在清单上方，展开另一行不会让它从视野里消失。 -->
    <section v-if="activeFlow !== null && flow !== null" class="panel-section">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="panel-section-title">{{ flow.providerId }}</h2>
        <span class="chip">{{ flowMethodLabel }} · {{ phaseLabel(flow) }}</span>
      </div>

      <p v-if="flow.prompt === null" class="hint-text">
        流程正在进行；如果浏览器已经打开授权页，请在浏览器中完成登录。这里的进度来自 Pi。
      </p>

      <p v-if="flow.message !== null" class="hint-text">{{ flow.message }}</p>

      <dl v-if="flow.deviceCode !== null" class="space-y-0.5 text-xs">
        <div class="flex flex-wrap items-baseline gap-1.5">
          <dt class="text-desk-muted">设备码</dt>
          <dd class="font-mono">{{ flow.deviceCode.userCode }}</dd>
        </div>
        <div class="flex flex-wrap items-baseline gap-1.5">
          <dt class="text-desk-muted">验证地址</dt>
          <dd class="break-all font-mono">{{ flow.deviceCode.verificationUri }}</dd>
        </div>
      </dl>

      <ul v-if="flow.messages.length > 0" class="space-y-0.5">
        <li
          v-for="(message, index) in flow.messages"
          :key="`flow-message-${index}`"
          class="whitespace-pre-wrap break-words text-xs text-desk-muted"
        >{{ message }}</li>
      </ul>

      <div v-if="flow.hasOpenableUrl" class="space-y-1">
        <AppButton
          :disabled="flowAction.phase === 'sending'"
          @click="authStore.openUrl()"
        >
          {{ flow.browserOpened ? '再次在系统浏览器中打开' : '在系统浏览器中打开授权页' }}
        </AppButton>
        <p v-if="flow.browserOpened" class="hint-text">授权页已交给系统浏览器打开。</p>
      </div>

      <form
        v-if="flow.prompt !== null"
        class="space-y-2"
        @submit.prevent="authStore.respond()"
      >
        <p class="text-xs">{{ flow.prompt.message }}</p>

        <div v-if="flow.prompt.kind === 'select'" class="space-y-1.5">
          <label
            v-for="option in flow.prompt.options"
            :key="option.id"
            class="list-card flex items-start gap-2 text-xs"
          >
            <input v-model="selectInput" type="radio" :value="option.id" name="auth-select">
            <span>
              {{ option.label }}
              <span
                v-if="option.description !== null"
                class="block text-2xs text-desk-muted"
              >{{ option.description }}</span>
            </span>
          </label>
        </div>

        <input
          v-else
          v-model="secretInput"
          :type="flow.prompt.kind === 'secret' ? 'password' : 'text'"
          :placeholder="promptPlaceholder(flow)"
          autocomplete="off"
          spellcheck="false"
          class="text-control"
        >

        <div class="flex flex-wrap items-center gap-2">
          <AppButton type="submit" variant="primary" :disabled="flowAction.phase === 'sending'">
            {{ flowAction.phase === 'sending' ? '正在提交…' : '提交' }}
          </AppButton>
          <AppButton :disabled="flowAction.phase === 'sending'" @click="authStore.cancel()">
            取消登录
          </AppButton>
        </div>
      </form>

      <div v-else>
        <AppButton :disabled="flowAction.phase === 'sending'" @click="authStore.cancel()">
          取消登录
        </AppButton>
      </div>
    </section>

    <!-- 流程结束后只留一行结论，不把清单整体下推。 -->
    <div v-else-if="flow !== null" role="status" class="status-notice">
      <p>
        {{ flow.providerId }} · {{ flowMethodLabel }} {{ phaseLabel(flow) }}<span v-if="flow.message !== null">：{{ flow.message }}</span>
      </p>
      <p v-if="showReloadHint" class="mt-1">
        凭据已交由 Pi 保存。新配置的 Provider 只有在 Runtime 重新启动后才会出现在可用模型里。
      </p>
      <AppButton
        v-if="showReloadHint"
        variant="compact"
        class="mt-2"
        :disabled="sessionStore.opening"
        @click="reloadRuntime"
      >
        {{ sessionStore.opening ? '正在重新加载…' : '重新加载 Runtime（保留会话）' }}
      </AppButton>
    </div>

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
    <p v-if="configActionError !== null" role="alert" class="status-notice status-notice-error">
      {{ configActionError }}
    </p>
    <p v-if="notice !== null" class="status-notice status-notice-info">{{ notice }}</p>

    <div class="flex flex-wrap items-center gap-2">
      <input
        v-model="query"
        type="search"
        placeholder="按名称或 provider 过滤"
        class="text-control sm:max-w-64"
      >
      <span v-if="statusView.phase === 'ready'" class="chip">
        已配置 {{ configuredCount }} / {{ authProviders.length }}
      </span>
      <span class="chip">隐藏 {{ totalHiddenCount }} 个模型</span>
      <AppButton
        variant="compact"
        :disabled="!canToggle || totalHiddenCount === 0"
        @click="showAll"
      >
        恢复全部显示
      </AppButton>
      <AppButton
        variant="compact"
        class="ml-auto"
        :disabled="configBusy || statusView.phase === 'loading'"
        @click="refreshAll"
      >
        重新读取
      </AppButton>
      <AppButton
        variant="primary"
        :disabled="configBusy || parseError !== null"
        @click="startCreate()"
      >
        添加自定义供应商
      </AppButton>
    </div>

    <p v-if="snapshot !== null" class="font-mono text-2xs text-desk-muted">{{ snapshot.filePath }}</p>
    <p v-if="snapshot?.truncated === true" class="status-notice status-notice-warn">
      条目过多，这里只展示了一部分；其余条目仍保留在文件里。
    </p>

    <section class="space-y-1.5">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="panel-section-title">供应商</h2>
        <span class="chip">{{ providerRows.length }}</span>
      </div>

      <p v-if="statusView.phase === 'loading'" class="hint-text">正在读取凭据状态…</p>
      <p v-else-if="providerRows.length === 0" class="hint-text">
        {{ authProviders.length === 0 ? 'Pi 没有报告任何 Provider。' : '没有匹配的供应商；清空搜索可以看到全部已配置项。' }}
      </p>

      <ul v-else ref="listElement" class="space-y-1.5">
        <li v-for="row in providerRows" :key="row.id">
          <button
            type="button"
            class="list-card"
            :class="expandedId === row.id ? 'list-item-active' : ''"
            :aria-expanded="expandedId === row.id"
            @click="toggleRow(row)"
          >
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <p class="text-sm font-medium">
                {{ row.name }}
                <span class="ml-1 font-mono text-2xs text-desk-muted">{{ row.id }}</span>
              </p>
              <p class="text-2xs text-desk-muted">
                {{ row.status }} · {{ row.modelCount }} 个模型<span v-if="row.hiddenCount > 0"> · 已隐藏 {{ row.hiddenCount }}</span>
              </p>
            </div>
            <p v-if="row.custom" class="mt-0.5 text-2xs text-desk-muted">
              在 models.json 里有自定义条目<span v-if="row.hasApiKey"> · 已配置密钥</span>
            </p>
          </button>

          <!-- 详情就地展开在被点的那一行下面，不用滑到页面底部。 -->
          <div v-if="expandedId === row.id" :data-provider-detail="row.id" class="mt-1.5 space-y-3">
            <div class="panel-section">
              <h3 class="panel-section-title">凭据</h3>
              <ProviderCredentialSection
                :provider="row.authStatus"
                :runtime-model-providers="runtimeModelProviders"
                @request-remove="pendingCredentialRemoval = row.authStatus"
              />
            </div>

            <div class="panel-section space-y-4">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h3 class="panel-section-title">端点与模型</h3>
                <AppButton
                  v-if="row.entry !== null"
                  variant="quiet-danger"
                  :disabled="configBusy"
                  @click="pendingDelete = row.id"
                >
                  从 models.json 删除
                </AppButton>
              </div>
              <ProviderDefinitionSection
                v-if="row.entry !== null"
                :key="`${row.id}-v${editorVersion}`"
                mode="edit"
                :provider-id="row.id"
                :initial-raw-text="row.entry.json"
                :existing-provider-ids="existingProviderIds"
                @saved="onSaved"
                @cancel="cancelDefinition"
              />
              <p v-else-if="configLoading" class="hint-text">正在读取 models.json…</p>
              <p v-else-if="parseError !== null" class="hint-text">
                models.json 目前无法解析，先在外部修正文件再点「重新读取」，这里才会显示它的条目。
              </p>
              <p v-else class="hint-text">
                这个供应商不在 models.json 的 providers 里，用的是 Pi 内置定义。还没有 models.json 时，新增供应商会创建它。
              </p>
              <AppButton
                v-if="row.entry === null && parseError === null"
                variant="compact"
                :disabled="configBusy"
                @click="startCreate(row.id)"
              >
                添加到 models.json
              </AppButton>
            </div>

            <div class="panel-section space-y-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h3 class="panel-section-title">在对话页显示</h3>
                <div class="flex items-center gap-2">
                  <AppButton
                    variant="compact"
                    :disabled="!canToggle || row.models.length === 0 || row.hiddenIds.size === 0"
                    @click="setRowVisibility(row, true)"
                  >
                    全部显示
                  </AppButton>
                  <AppButton
                    variant="compact"
                    :disabled="!canToggle || row.models.length === 0"
                    @click="setRowVisibility(row, false)"
                  >
                    全部隐藏
                  </AppButton>
                </div>
              </div>
              <p v-if="displayError !== null" role="alert" class="status-notice status-notice-error">
                {{ displayError }}
              </p>
              <p v-else-if="displayLoading" class="hint-text">正在读取展示偏好…</p>
              <p v-else-if="row.models.length === 0" class="hint-text">
                当前模型目录里没有这个供应商的模型。启动 Runtime 或配置凭据后再回来设置。
              </p>
              <ProviderVisibilitySection
                v-else
                :provider="row.id"
                :models="row.models"
                :hidden-model-ids="row.hiddenIds"
                :disabled="!canToggle"
              />
            </div>
          </div>
        </li>
      </ul>
    </section>

    <ProviderCreateDialog
      :open="creating"
      :preset-provider-id="createProviderId"
      :existing-provider-ids="existingProviderIds"
      @saved="onSaved"
      @cancel="creating = false"
    />

    <section class="panel-section">
      <h2 class="panel-section-title">边界说明</h2>
      <ul class="list-disc space-y-1 pl-4 text-xs leading-5 text-desk-muted">
        <li>提交的密钥只经一次受限通道交给 Pi，不进入聊天、提示词、偏好或日志；已保存的凭据不会回传到页面。</li>
        <li>退出登录只删除 Pi 保存在 auth.json 里的凭据，不影响环境变量与 models.json 里配置的凭据或密钥命令。</li>
        <li>凭据与条目变化后，运行中的 Runtime 仍使用启动时的模型快照，需要重新加载才会生效。</li>
        <li>只写 <span class="font-mono">models.json</span> 里 <span class="font-mono">providers</span> 下被编辑的那一个条目；其他供应商、其他顶层键与条目里未涉及的字段原样保留。</li>
        <li>真实密钥以明文存在 <span class="font-mono">models.json</span>（Pi 自身的格式）；这里不回显已保存的密钥，也不把它写进日志。</li>
        <li>文件在应用之外被改过时，本次保存会被拒绝；点「重新读取」后再保存即可。</li>
        <li>对话页的模型可见性只影响输入坞模型选择器的候选项，不改变 Pi 的模型配置；偏好读取失败时不过滤任何模型。</li>
      </ul>
    </section>

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
