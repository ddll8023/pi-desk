<!-- 供应商清单行：展示当前状态、模型统计并承载展开区。
     行头提供直接编辑或录入的快捷入口；展开区就地组织凭据、定义摘要与模型展示偏好。 -->
<script lang="ts">
import type { AuthMethod, AuthProviderStatus } from '../../../../shared/auth-api'
import type { ModelsConfigProvider } from '../../../../shared/models-config-api'
import type { ModelSummary } from '../../../../shared/runtime-api'

/** 清单一行：供应商身份加上三份数据里与它相关的汇总。 */
export interface ProviderRow {
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
</script>

<script setup lang="ts">
import { computed } from 'vue'
import { useRuntimeStore } from '../../sessions/stores/runtime'
import AppButton from '../../ui/AppButton.vue'
import ProviderCredentialSection from './ProviderCredentialSection.vue'
import ProviderEntrySummary from './ProviderEntrySummary.vue'
import ProviderVisibilitySection from './ProviderVisibilitySection.vue'

const props = withDefaults(
  defineProps<{
    readonly row: ProviderRow
    /** 该行是否已展开详情；同一时刻只有一行展开。 */
    readonly expanded: boolean
    /** 展示偏好是否可写；为假时可见性开关禁用。 */
    readonly canToggle: boolean
    /** 展示偏好正在读取；与「这个供应商没有模型」区分。 */
    readonly displayLoading: boolean
    readonly displayError: string | null
    /** models.json 尚未读完。 */
    readonly configLoading: boolean
    /** models.json 无法解析的原因。 */
    readonly parseError: string | null
    /** models.json 写动作进行中。 */
    readonly configBusy: boolean
    /** models.json 写动作的错误；就近展示在条目区块，不放到页面顶部。 */
    readonly actionError: string | null
    /** 是否正在从云端刷新该供应商的模型。 */
    readonly refreshingModels?: boolean
  }>(),
  {
    refreshingModels: false
  }
)

const emit = defineEmits<{
  toggle: []
  edit: []
  create: []
  removeEntry: []
  requestRemoveCredential: []
  login: [method: AuthMethod]
  resumeAuth: []
  'refresh-models': []
}>()

const runtimeStore = useRuntimeStore()

/** 传给凭据区块的可用性来源：Runtime 能力就绪时是「已有模型的 Provider」，未就绪时为 null。 */
const runtimeModelProviders = computed<ReadonlySet<string> | null>(() => {
  const view = runtimeStore.capabilitiesView
  if (view.phase !== 'ready') return null
  return new Set(view.data.models.map((model) => model.provider))
})

/** 展开区的 id：供行的 aria-controls 指向被展开的内容。 */
const detailId = computed(() => `provider-detail-${props.row.id}`)

/** 未配置时的首选快捷认证方式；优先 api_key，仅支持 oauth 时为 oauth。 */
const quickAuthMethod = computed<AuthMethod | null>(() => {
  if (props.row.configured) return null
  const types = props.row.authStatus.authTypes
  if (types.length === 1) return types[0] ?? null
  if (types.includes('api_key')) return 'api_key'
  return null
})

/** 供应商级批量：把该行在当前模型目录里的全部模型设为显示或隐藏。 */
function setAllVisible(visible: boolean): void {
  if (!props.canToggle || props.row.models.length === 0) return
  runtimeStore.setModelsVisibility(
    props.row.models.map((model) => ({ provider: model.provider, modelId: model.id })),
    visible
  )
}
</script>

<template>
  <div class="provider-row" :class="{ 'is-expanded': expanded }">
    <div class="provider-row-header" :class="{ 'is-expanded': expanded }">
      <button
        type="button"
        class="provider-row-trigger"
        :aria-expanded="expanded"
        :aria-controls="detailId"
        @click="emit('toggle')"
      >
        <span class="provider-row-trigger__identity">
          <span class="provider-row-trigger__headline">
            <span class="provider-row-trigger__name" :title="row.name">{{ row.name }}</span>
            <span v-if="row.custom" class="provider-row-trigger__custom" :title="row.hasApiKey ? 'models.json 内已配置密钥' : 'models.json 自定义条目'">自定义</span>
          </span>
          <span class="provider-row-trigger__id" :title="row.id">{{ row.id }}</span>
        </span>
        <span class="provider-row-trigger__status" :class="{ 'is-configured': row.configured }" :title="row.status">
          <span class="provider-row-trigger__status-dot" aria-hidden="true" />
          <span class="provider-row-trigger__status-text">{{ row.status }}</span>
        </span>
        <span class="provider-row-trigger__models" title="Pi 报告的已知模型数量，不代表凭据已通过上游认证">
          <span>{{ row.modelCount }} 个模型</span>
          <span v-if="row.hiddenCount > 0" class="provider-row-trigger__hidden">隐藏 {{ row.hiddenCount }}</span>
        </span>
      </button>

      <div class="provider-row-actions">
        <AppButton
          v-if="row.custom"
          variant="compact"
          class="provider-row-actions__quick"
          @click="emit('edit')"
        >
          编辑
        </AppButton>
        <AppButton
          v-else-if="quickAuthMethod !== null"
          variant="compact"
          class="provider-row-actions__quick"
          @click="emit('login', quickAuthMethod)"
        >
          {{ quickAuthMethod === 'oauth' ? '登录' : '录入 Key' }}
        </AppButton>
        <button
          type="button"
          class="provider-row-toggle-btn"
          :aria-expanded="expanded"
          :aria-controls="detailId"
          :aria-label="expanded ? `收起 ${row.name} 详情` : `展开 ${row.name} 详情`"
          @click="emit('toggle')"
        >
          <span>{{ expanded ? '收起' : '详情' }}</span>
          <svg class="provider-row-trigger__chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m6 3 5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 详情仍在供应商上下文内展开，各类操作用分隔与标题表达层级。 -->
    <div v-if="expanded" :id="detailId" :data-provider-detail="row.id" class="provider-detail">
      <section class="provider-detail-section">
        <div class="provider-detail-section__heading">
          <h3 class="provider-detail-section__title">凭据</h3>
        </div>
        <ProviderCredentialSection
          :provider="row.authStatus"
          :runtime-model-providers="runtimeModelProviders"
          :refreshing="refreshingModels"
          @request-remove="emit('requestRemoveCredential')"
          @login="emit('login', $event)"
          @resume="emit('resumeAuth')"
          @refresh-models="emit('refresh-models')"
        />
      </section>

      <section class="provider-detail-section">
        <div class="provider-detail-section__heading">
          <h3 class="provider-detail-section__title">端点与模型</h3>
        </div>
        <p v-if="actionError !== null" role="alert" class="status-notice status-notice-error">
          {{ actionError }}
        </p>
        <ProviderEntrySummary
          :entry="row.entry"
          :loading="configLoading"
          :parse-error="parseError"
          :busy="configBusy"
          @edit="emit('edit')"
          @create="emit('create')"
        />
      </section>

      <section class="provider-detail-section">
        <div class="provider-detail-section__heading">
          <div class="provider-detail-section__heading-text">
            <h3 class="provider-detail-section__title">在对话页显示</h3>
            <span class="provider-detail-section__scope">仅影响模型选择器</span>
          </div>
          <div class="provider-detail__bulk-actions">
            <AppButton
              variant="compact"
              :disabled="!canToggle || row.models.length === 0 || row.hiddenIds.size === 0"
              @click="setAllVisible(true)"
            >
              全部显示
            </AppButton>
            <AppButton
              variant="compact"
              :disabled="!canToggle || row.models.length === 0"
              @click="setAllVisible(false)"
            >
              全部隐藏
            </AppButton>
          </div>
        </div>
        <p v-if="displayError !== null" role="alert" class="provider-detail__error">
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
      </section>

      <!-- 破坏性操作收在详情末尾，不与认证、编辑和可见性操作混排。 -->
      <div v-if="row.entry !== null" class="provider-detail__danger">
        <AppButton variant="quiet-danger" :disabled="configBusy" @click="emit('removeEntry')">删除这个自定义供应商</AppButton>
        <p class="provider-detail__danger-hint">只移除 models.json 中的这个条目，不影响凭据及其他供应商。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.provider-row {
  min-width: 0;
}

.provider-row-header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  transition: background-color var(--default-transition-duration) ease;
}

.provider-row-header:hover {
  background: var(--color-desk-surface-subtle);
}

.provider-row-header.is-expanded {
  box-shadow: inset 2px 0 0 var(--color-desk-accent);
}

.provider-row-header.is-expanded .provider-row-trigger__name {
  color: var(--color-desk-accent);
}

.provider-row-trigger {
  display: grid;
  min-width: 0;
  flex: 1 1 auto;
  min-height: 3.75rem;
  grid-template-columns: minmax(0, 1fr) minmax(7rem, 0.65fr) 5.5rem;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.875rem;
  color: var(--color-desk-ink);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: none;
}

.provider-row-trigger:focus-visible {
  outline: 2px solid var(--color-desk-accent);
  outline-offset: -2px;
}

.provider-row-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.5rem;
  padding-right: 0.875rem;
}

.provider-row-actions__quick {
  font-size: 0.75rem;
}

.provider-row-toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.375rem 0.25rem;
  background: transparent;
  border: none;
  color: var(--color-desk-accent);
  font-size: 0.75rem;
  cursor: pointer;
  white-space: nowrap;
}

.provider-row-toggle-btn:focus-visible {
  outline: 2px solid var(--color-desk-accent);
  outline-offset: 2px;
}

.provider-row-trigger__identity,
.provider-row-trigger__models {
  display: grid;
  min-width: 0;
  gap: 0.125rem;
}

.provider-row-trigger__headline {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.5rem;
}

.provider-row-trigger__name,
.provider-row-trigger__id,
.provider-row-trigger__status-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-row-trigger__name {
  min-width: 0;
  font-size: 0.8125rem;
  font-weight: 600;
}

.provider-row-trigger__id {
  color: var(--color-desk-muted);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
}

.provider-row-trigger__custom {
  flex: none;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}

.provider-row-trigger__status {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.375rem;
  color: var(--color-desk-muted);
  font-size: 0.75rem;
}

.provider-row-trigger__status-dot {
  width: 0.375rem;
  height: 0.375rem;
  flex: none;
  border: 1px solid currentColor;
  border-radius: 50%;
}

.is-configured .provider-row-trigger__status-dot {
  border-color: var(--color-desk-success);
  background: var(--color-desk-success);
}

.provider-row-trigger__models {
  justify-items: end;
  color: var(--color-desk-muted);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

.provider-row-trigger__hidden {
  font-size: 0.6875rem;
}

.provider-row-trigger__chevron {
  width: 0.875rem;
  height: 0.875rem;
  flex: none;
  transition: transform var(--default-transition-duration) ease;
}

.is-expanded .provider-row-trigger__chevron {
  transform: rotate(90deg);
}

.provider-detail {
  display: grid;
  padding: 0.5rem 0.875rem 1rem;
}

.provider-detail-section {
  min-width: 0;
}

.provider-detail-section + .provider-detail-section,
.provider-detail__danger {
  margin-top: 1rem;
  border-top: 1px solid var(--color-desk-line);
  padding-top: 0.875rem;
}

.provider-detail-section__heading,
.provider-detail-section__heading-text {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem 0.75rem;
}

.provider-detail-section__heading {
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.provider-detail-section__title {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
}

.provider-detail-section__scope {
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}

.provider-detail__bulk-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

.provider-detail__danger {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem 0.75rem;
}

.provider-detail__danger-hint {
  margin: 0;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
  line-height: 1.55;
}

.provider-detail__error {
  margin: 0 0 0.625rem;
  border-left: 2px solid var(--color-desk-danger);
  background: var(--color-desk-danger-soft);
  padding: 0.5rem 0.625rem;
  color: var(--color-desk-danger);
  font-size: 0.75rem;
  line-height: 1.5;
}

@media (max-width: 700px) {
  .provider-row-trigger {
    grid-template-columns: minmax(0, 1fr) 5.5rem;
    gap: 0.25rem 0.625rem;
  }

  .provider-row-trigger__identity {
    grid-column: 1;
    grid-row: 1;
  }

  .provider-row-trigger__status {
    grid-column: 1;
    grid-row: 2;
  }

  .provider-row-trigger__models {
    grid-column: 2;
    grid-row: 1 / span 2;
  }
}

@media (max-width: 480px) {
  .provider-row-header {
    flex-wrap: wrap;
  }

  .provider-row-trigger {
    grid-template-columns: minmax(0, 1fr);
  }

  .provider-row-trigger__status {
    grid-column: 1;
    grid-row: 2;
  }

  .provider-row-trigger__models {
    grid-column: 1;
    grid-row: 3;
    justify-items: start;
    display: flex;
    gap: 0.5rem;
  }

  .provider-row-actions {
    width: 100%;
    justify-content: flex-end;
    padding: 0 0.875rem 0.5rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .provider-row-header {
    transition: none;
  }
}
</style>
