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
  <div>
    <button
      type="button"
      class="list-card"
      :class="expanded ? 'list-item-active' : ''"
      :aria-expanded="expanded"
      :aria-controls="detailId"
      @click="emit('toggle')"
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
    <div v-if="expanded" :id="detailId" :data-provider-detail="row.id" class="mt-1.5 space-y-3">
      <div class="panel-section">
        <h3 class="panel-section-title">凭据</h3>
        <ProviderCredentialSection
          :provider="row.authStatus"
          :runtime-model-providers="runtimeModelProviders"
          @request-remove="emit('requestRemoveCredential')"
        />
      </div>

      <div class="panel-section space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="panel-section-title">端点与模型</h3>
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
      </div>

      <div class="panel-section space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="panel-section-title">在对话页显示</h3>
          <div class="flex items-center gap-2">
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
  </div>
</template>
