<!-- 供应商清单行：行内给出身份与三份数据的汇总，就地展开凭据、条目摘要与对话页可见性。
     展开内容留在被点的那一行下面，展开状态与滚动定位由页面持有；
     凭据与可见性各自的写入状态由对应区块自己处理，这里只转发页面级动作。 -->
<script lang="ts">
import type { AuthProviderStatus } from '../../../../shared/auth-api'
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

const props = defineProps<{
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
}>()

const emit = defineEmits<{
  toggle: []
  edit: []
  create: []
  removeEntry: []
  requestRemoveCredential: []
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
  <div class="provider-row">
    <button
      type="button"
      class="provider-row-trigger"
      :class="expanded ? 'is-expanded' : ''"
      :aria-expanded="expanded"
      :aria-controls="detailId"
      @click="emit('toggle')"
    >
      <span class="provider-row-trigger__identity">
        <span class="provider-row-trigger__name">{{ row.name }}</span>
        <span class="provider-row-trigger__id">{{ row.id }}</span>
        <span v-if="row.custom" class="provider-row-trigger__custom">
          自定义<span v-if="row.hasApiKey"> · 已配置密钥</span>
        </span>
      </span>
      <span class="provider-row-trigger__summary">
        <span>{{ row.status }}</span>
        <span>{{ row.modelCount }} 个模型</span>
        <span v-if="row.hiddenCount > 0">隐藏 {{ row.hiddenCount }}</span>
      </span>
      <span class="provider-row-trigger__action">{{ expanded ? '收起' : '详情' }}</span>
    </button>

    <!-- 详情仍在供应商上下文内展开，各类操作用分隔与标题表达层级。 -->
    <div v-if="expanded" :id="detailId" :data-provider-detail="row.id" class="provider-detail">
      <section class="provider-detail-section">
        <h3 class="provider-detail-section__title">凭据</h3>
        <ProviderCredentialSection
          :provider="row.authStatus"
          :runtime-model-providers="runtimeModelProviders"
          @request-remove="emit('requestRemoveCredential')"
        />
      </section>

      <section class="provider-detail-section">
        <div class="provider-detail-section__heading">
          <h3 class="provider-detail-section__title">端点与模型</h3>
          <AppButton
            v-if="row.entry !== null"
            variant="quiet-danger"
            :disabled="configBusy"
            @click="emit('removeEntry')"
          >
            从 models.json 删除
          </AppButton>
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
          <h3 class="provider-detail-section__title">在对话页显示</h3>
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
    </div>
  </div>
</template>

<style scoped>
.provider-row {
  min-width: 0;
}

.provider-row-trigger {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(12rem, 1fr) auto auto;
  align-items: center;
  gap: 0.75rem 1rem;
  border-left: 2px solid transparent;
  padding: 0.75rem 0.625rem;
  color: var(--color-desk-ink);
  text-align: left;
  transition: background-color var(--default-transition-duration) ease, border-color var(--default-transition-duration) ease;
}

.provider-row-trigger:hover,
.provider-row-trigger.is-expanded {
  border-left-color: var(--color-desk-accent);
  background: var(--color-desk-accent-soft);
}

.provider-row-trigger:focus-visible {
  outline: 2px solid var(--color-desk-accent);
  outline-offset: -2px;
}

.provider-row-trigger__identity,
.provider-row-trigger__summary {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.375rem 0.75rem;
}

.provider-row-trigger__name {
  font-size: 0.875rem;
  font-weight: 650;
  line-height: 1.4;
}

.provider-row-trigger__id {
  overflow-wrap: anywhere;
  color: var(--color-desk-muted);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
}

.provider-row-trigger__custom {
  color: var(--color-desk-accent);
  font-size: 0.6875rem;
}

.provider-row-trigger__summary {
  justify-content: flex-end;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}

.provider-row-trigger__action {
  color: var(--color-desk-accent);
  font-size: 0.6875rem;
  font-weight: 600;
  white-space: nowrap;
}

.provider-detail {
  display: grid;
  gap: 0;
  padding: 0 0.625rem 0.75rem 1rem;
}

.provider-detail-section {
  min-width: 0;
  padding: 0.875rem 0;
}

.provider-detail-section + .provider-detail-section {
  border-top: 1px solid var(--color-desk-line);
}

.provider-detail-section__heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 1rem;
  margin-bottom: 0.625rem;
}

.provider-detail-section__title {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 650;
}

.provider-detail__bulk-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
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
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
  }

  .provider-row-trigger__summary {
    grid-column: 1;
    justify-content: flex-start;
  }

  .provider-row-trigger__action {
    grid-column: 2;
    grid-row: 1 / span 2;
  }

  .provider-detail {
    padding-left: 0.75rem;
  }
}
</style>
