<!-- 设置页的「版本与更新」区块：显示应用自身版本、内置 Pi agent 版本与 Pi 包（扩展）的已安装/最新版本，
     提供重新检查、在应用内更新扩展、把内置 Pi agent 更新到官方最新版本与复制官方更新命令。
     扩展更新只更新已声明的包，不改动包声明；内置 Pi agent 更新只写应用自有的运行时目录。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type {
  AgentInstallFailureReason,
  AgentInstallPhase,
  ExtensionUpdateInfo,
  PackageUpdateFailureReason,
  PackageUpdatePhase
} from '../../../shared/updates-api'
import { useDesktopStore } from '../stores/desktop'
import { useUpdatesStore } from '../stores/updates'
import { copyText } from '../clipboard'
import AppButton from './ui/AppButton.vue'

const updatesStore = useUpdatesStore()
const desktopStore = useDesktopStore()
const {
  snapshot,
  piAgent,
  checking,
  checkedAt,
  checkFailure,
  checkError,
  updating,
  updateProgress,
  updateOutcome,
  updateError,
  installingAgent,
  agentInstallProgress,
  agentInstallOutcome,
  agentInstallError
} = storeToRefs(updatesStore)
const { connection } = storeToRefs(desktopStore)
const copied = ref(false)
/** 扩展列表的局部折叠状态：默认展开，只影响本页显示，不写入界面偏好。 */
const extensionsOpen = ref(true)

/** 官方更新命令：更新也可以在应用内完成，这里保留命令作为命令行环境的替代做法。 */
const UPDATE_COMMAND = 'pi update --extensions'

/** 进度与失败归类的展示文案；状态本身始终以文本出现，不依赖颜色。 */
const phaseLabels = {
  start: '开始',
  progress: '进行中',
  complete: '完成',
  error: '失败'
} satisfies Record<PackageUpdatePhase, string>

const failureReasonLabels = {
  'tool-missing': '缺少命令',
  network: '网络失败',
  untrusted: '项目未信任',
  unknown: '原因未知'
} satisfies Record<PackageUpdateFailureReason, string>

const agentInstallPhaseLabels = {
  download: '取依赖清单',
  install: '安装依赖',
  verify: '校验',
  activate: '切换版本',
  done: '完成'
} satisfies Record<AgentInstallPhase, string>

const agentInstallFailureReasonLabels = {
  'tool-missing': '缺少命令',
  network: '网络失败',
  'verify-failed': '校验未通过',
  'unsupported-version': '版本不在支持范围',
  unknown: '原因未知'
} satisfies Record<AgentInstallFailureReason, string>

const appInfo = computed(() => (connection.value.status === 'ready' ? connection.value.info : null))

/** 上次成功检查的时刻；没有成功过时为 null，不推算。 */
const checkedAtLabel = computed(() => {
  const value = checkedAt.value
  if (value === null) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
})

/** Pi agent 的展示文本：实际加载的版本、它的来源与官方最新版本；取不到最新版时如实说明。 */
const piAgentText = computed(() => {
  const info = piAgent.value
  if (info === null) return '尚未取得版本信息'
  const source = info.runtimeVersion !== null && info.runtimeVersion === info.version ? '，来自运行时目录' : ''
  if (info.status === 'unchecked' || info.latestVersion === null) return `${info.version}${source}`
  if (info.status === 'update-available') return `${info.version}${source}（官方已发布 ${info.latestVersion}）`
  if (info.status === 'unsupported') {
    return `${info.version}${source}（官方已发布 ${info.latestVersion}；不在本应用支持的版本范围内）`
  }
  return `${info.version}${source}（官方最新）`
})

/** 运行时目录里的版本没能用上时给出它的版本号，用于在界面上说明回退；没有这种情况时为 null。 */
const agentRuntimeFallback = computed(() => {
  const info = piAgent.value
  if (info === null || info.runtimeVersion === null || info.runtimeVersion === info.version) return null
  return info.runtimeVersion
})

/** Pi agent 取不到最新版本时的原因；没有原因时为 null。 */
const piAgentError = computed(() => piAgent.value?.error ?? null)
/** 官方在最新版本上附带的说明；没有时为 null。 */
const piAgentNote = computed(() => piAgent.value?.note ?? null)

/** 可更新的条目数：为 0 时不给「全部更新」留一个必然失败的按钮。 */
const updatableCount = computed(() => (
  snapshot.value.extensions.filter((entry) => entry.status === 'update-available').length
))

/** 可安装的目标版本：官方最新版本与已加载版本不同时才给按钮，没结论时不给。 */
const agentUpdateTarget = computed(() => {
  const info = piAgent.value
  if (info === null || info.status !== 'update-available' || info.latestVersion === null) return null
  return info.latestVersion
})

/** 有更新结论后提示重启 Runtime：更新只改已装包，运行中的 Runtime 不会重新读取。 */
const finishedUpdate = computed(() => updateOutcome.value !== null)

/** 状态文案：没有结论的条目一律说「无法检查」，不用「已是最新」冒充。 */
function statusLabel(entry: ExtensionUpdateInfo): string {
  switch (entry.status) {
    case 'up-to-date': return '已是最新'
    case 'update-available': return '可更新'
    case 'not-installed': return '未安装'
    case 'pinned': return '固定版本'
    case 'local': return '本地源，不检查'
    default: return '无法检查'
  }
}

/** 状态点的语义分类；颜色只是辅助，状态文案始终同时出现。 */
function statusTone(entry: ExtensionUpdateInfo): string {
  switch (entry.status) {
    case 'update-available':
    case 'not-installed': return 'status-dot-warn'
    case 'up-to-date': return 'status-dot-ok'
    default: return 'status-dot-idle'
  }
}

/** 版本文本：npm 用版本号，git 用提交短哈希，local 只说来源，缺值不编造。 */
function versionText(entry: ExtensionUpdateInfo): string {
  if (entry.type === 'local') {
    return entry.installedVersion === null ? '本地路径' : `本地包 ${entry.installedVersion}`
  }
  if (entry.type === 'git') {
    const installed = entry.installedVersion ?? '未知'
    return entry.latestVersion === null
      ? `已装提交 ${installed}`
      : `已装提交 ${installed} → 远端 ${entry.latestVersion}`
  }
  const installed = entry.installedVersion ?? '未知'
  return entry.latestVersion === null ? `已装 ${installed}` : `已装 ${installed} → 最新 ${entry.latestVersion}`
}

function sourceTypeLabel(entry: ExtensionUpdateInfo): string {
  return entry.type === 'npm' ? 'npm' : entry.type === 'git' ? 'git' : '本地'
}

async function copyUpdateCommand(): Promise<void> {
  copied.value = await copyText(UPDATE_COMMAND)
}
</script>

<template>
  <section class="settings-section" aria-labelledby="settings-versions-title">
    <div class="settings-section-heading">
      <div>
        <h2 id="settings-versions-title" class="settings-section-title">版本与更新</h2>
        <p class="mt-1 text-xs text-desk-muted">
          应用与内置 Pi agent 的版本，以及 Pi 包（扩展）的已安装版本与远端最新版本。
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        <span v-if="checkedAtLabel !== null" class="chip">上次检查 {{ checkedAtLabel }}</span>
        <AppButton variant="compact" :disabled="updating || updatableCount === 0" @click="updatesStore.update()">
          {{ updating ? '正在更新…' : '全部更新' }}
        </AppButton>
        <AppButton variant="compact" :disabled="checking || updating" @click="updatesStore.check()">
          {{ checking ? '正在检查…' : '检查更新' }}
        </AppButton>
      </div>
    </div>

    <p v-if="snapshot.offline" role="status" class="status-notice status-notice-warn mt-4">
      离线模式（PI_OFFLINE）：只显示已安装版本，没有查询远端版本。
    </p>
    <p v-if="checkError !== null" role="alert" class="status-notice status-notice-error mt-4">
      {{ checkError }}
    </p>
    <p v-if="checkFailure !== null" role="alert" class="status-notice status-notice-error mt-4">
      上次检查失败：{{ checkFailure }}
    </p>

    <dl class="mt-4 grid gap-x-3 gap-y-2 border-t border-desk-line pt-4 text-xs sm:grid-cols-[7rem_1fr]">
      <dt class="text-desk-muted">Pi Desktop</dt>
      <dd>
        <template v-if="appInfo !== null">
          {{ appInfo.appVersion }} · Electron {{ appInfo.electronVersion }} · {{ appInfo.platform }}/{{ appInfo.arch }}
        </template>
        <template v-else>尚未取得应用信息。</template>
      </dd>

      <dt class="text-desk-muted">Pi agent（内置）</dt>
      <dd>
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-mono">{{ piAgentText }}</span>
          <AppButton
            v-if="agentUpdateTarget !== null"
            variant="compact"
            :disabled="installingAgent"
            @click="updatesStore.installAgent(agentUpdateTarget)"
          >
            更新到 {{ agentUpdateTarget }}
          </AppButton>
        </div>
        <p v-if="piAgentError !== null" class="mt-1 text-2xs text-desk-muted">
          {{ piAgentError }}
        </p>
        <p v-if="piAgentNote !== null" class="mt-1 text-2xs text-desk-muted">
          {{ piAgentNote }}
        </p>
        <p v-if="agentRuntimeFallback !== null" role="status" class="status-notice status-notice-warn mt-2">
          运行时目录里的 {{ agentRuntimeFallback }} 没有加载成功，本次已回退到随应用发布的版本；
          重新安装该版本并重启 Runtime 后会再次尝试使用它。
        </p>
      </dd>
    </dl>

    <!-- 内置 Pi agent 安装：进度与扩展更新分开，因为阶段与失败原因不同。 -->
    <div
      v-if="installingAgent || agentInstallProgress.length > 0"
      class="mt-4 border-t border-desk-line pt-4"
      :aria-busy="installingAgent"
    >
      <p role="status" class="text-xs font-semibold">
        {{ installingAgent ? '正在安装内置 Pi agent…' : '上次安装过程' }}
      </p>
      <ul class="mt-2 space-y-1">
        <!-- 列表只追加、不重排，因此按位置索引作为 key 不会造成复用错误。 -->
        <li
          v-for="(progress, index) in agentInstallProgress"
          :key="`${progress.phase}-${index}`"
          class="text-2xs text-desk-muted"
        >
          <span class="chip">{{ agentInstallPhaseLabels[progress.phase] }}</span>
          <span v-if="progress.version !== null" class="ml-2 font-mono">{{ progress.version }}</span>
          <span v-if="progress.message !== null" class="ml-2">{{ progress.message }}</span>
        </li>
      </ul>
    </div>

    <div v-if="agentInstallError !== null" role="alert" class="status-notice status-notice-error mt-4">
      安装请求失败：{{ agentInstallError }}
    </div>

    <div v-if="agentInstallOutcome !== null" class="mt-4 border-t border-desk-line pt-4">
      <p v-if="agentInstallOutcome.offline" role="status" class="status-notice status-notice-warn">
        离线模式（PI_OFFLINE）下不执行安装。
      </p>
      <template v-else-if="agentInstallOutcome.installedVersion !== null">
        <p role="status" class="text-xs font-semibold">
          已安装内置 Pi agent {{ agentInstallOutcome.installedVersion }}
          <span v-if="agentInstallOutcome.previousVersion !== null" class="font-normal text-desk-muted">
            （原 {{ agentInstallOutcome.previousVersion }}）
          </span>
        </p>
        <p role="status" class="status-notice status-notice-warn mt-2">
          运行中的 Runtime 仍在用切换前的版本：在「Pi 资源」页点「重新加载资源」后才会生效。
        </p>
      </template>
      <template v-else>
        <p role="status" class="text-xs font-semibold">
          安装未完成
          <span v-if="agentInstallOutcome.reason !== null" class="font-normal">
            （{{ agentInstallFailureReasonLabels[agentInstallOutcome.reason] }}）
          </span>
        </p>
        <p v-if="agentInstallOutcome.error !== null" role="alert" class="status-notice status-notice-error mt-2">
          {{ agentInstallOutcome.error }}
        </p>
        <p class="mt-2 text-2xs text-desk-muted">
          安装未完成时不会切换当前版本，原本的内置版本仍然可用。
        </p>
      </template>
    </div>

    <!-- 更新进度：只展示更新过程中收到的进度事件，不作为历史记录。 -->
    <div v-if="updating || updateProgress.length > 0" class="mt-4 border-t border-desk-line pt-4" :aria-busy="updating">
      <p role="status" class="text-xs font-semibold">
        {{ updating ? '正在更新扩展…' : '上次更新过程' }}
      </p>
      <ul class="mt-2 space-y-1">
        <!-- 列表只追加、不重排，因此按位置索引作为 key 不会造成复用错误。 -->
        <li
          v-for="(progress, index) in updateProgress"
          :key="`${progress.source}-${index}`"
          class="text-2xs text-desk-muted"
        >
          <span class="chip">{{ phaseLabels[progress.phase] }}</span>
          <span class="ml-2 break-all font-mono">{{ progress.source }}</span>
          <span v-if="progress.message !== null" class="ml-2">{{ progress.message }}</span>
        </li>
      </ul>
    </div>

    <div v-if="updateError !== null" role="alert" class="status-notice status-notice-error mt-4">
      更新请求失败：{{ updateError }}
    </div>

    <!-- 更新结论：离线、成功项、逐项失败与整体失败原因分开呈现，不合并成一句「更新失败」。 -->
    <div v-if="updateOutcome !== null" class="mt-4 border-t border-desk-line pt-4">
      <p v-if="updateOutcome.offline" role="status" class="status-notice status-notice-warn">
        离线模式（PI_OFFLINE）下不执行更新。
      </p>
      <template v-else>
        <p role="status" class="text-xs font-semibold">
          {{ updateOutcome.updated.length > 0 ? `已更新 ${updateOutcome.updated.length} 个来源` : '没有来源被更新' }}
        </p>
        <ul v-if="updateOutcome.updated.length > 0" class="mt-2 space-y-1">
          <li v-for="source in updateOutcome.updated" :key="source" class="break-all text-2xs text-desk-muted">
            <span class="font-mono">{{ source }}</span>
          </li>
        </ul>
        <ul v-if="updateOutcome.failed.length > 0" class="mt-2 space-y-1.5">
          <!-- 同一来源可能因不同原因各记一条，因此用位置索引作 key；列表只追加、不重排。 -->
          <li
            v-for="(failure, index) in updateOutcome.failed"
            :key="`${failure.source}-${index}`"
            class="list-card"
          >
            <p class="flex flex-wrap items-center gap-2 text-xs font-medium">
              <span class="status-dot status-dot-warn"></span>
              <span class="break-all font-mono">{{ failure.source }}</span>
              <span class="chip">{{ failureReasonLabels[failure.reason] }}</span>
            </p>
            <p class="mt-1 break-words text-2xs text-desk-muted">{{ failure.message }}</p>
          </li>
        </ul>
        <p v-if="updateOutcome.error !== null" role="alert" class="status-notice status-notice-error mt-2">
          整体失败原因：{{ updateOutcome.error }}
        </p>
        <p
          v-if="updateOutcome.failed.some((failure) => failure.reason === 'tool-missing')"
          class="mt-2 text-2xs text-desk-muted"
        >
          更新由 Pi 自己的包管理执行，需要系统里可用的 npm（git 源还需要 git）；
          图形界面启动的应用不一定能读到这些命令，可先按上面的原因排查，或改用命令行执行
          <span class="font-mono">{{ UPDATE_COMMAND }}</span>。
        </p>
      </template>
    </div>

    <div class="mt-4 border-t border-desk-line pt-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <!-- 标题本身就是折叠开关：只控制下方列表的显示，不影响检查结果与右侧复制动作。 -->
        <h3 class="text-xs font-semibold">
          <AppButton
            variant="unstyled"
            class="settings-fold-toggle"
            :aria-expanded="extensionsOpen"
            aria-controls="settings-extensions-list"
            @click="extensionsOpen = !extensionsOpen"
          >
            <span class="disclosure" :class="{ 'is-open': extensionsOpen }" aria-hidden="true"></span>
            扩展（{{ snapshot.extensions.length }} 个 Pi 包）
          </AppButton>
        </h3>
        <AppButton variant="compact" @click="copyUpdateCommand()">
          {{ copied ? '已复制' : `复制 ${UPDATE_COMMAND}` }}
        </AppButton>
      </div>
      <div id="settings-extensions-list" v-show="extensionsOpen">
        <p v-if="snapshot.extensions.length === 0" class="mt-2 text-2xs text-desk-muted">
          {{ checkedAt === null ? '还没有检查结果；点「检查更新」读取。' : 'Pi 的 settings.json 里没有声明包。' }}
        </p>
        <ul v-else class="mt-2 space-y-1.5">
          <li v-for="entry in snapshot.extensions" :key="`${entry.scope}-${entry.source}`" class="list-card">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="flex min-w-0 flex-wrap items-center gap-2 text-xs font-medium">
                <span class="status-dot" :class="statusTone(entry)"></span>
                <span class="break-all font-mono">{{ entry.source }}</span>
              </p>
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="chip">{{ statusLabel(entry) }}</span>
                <AppButton
                  v-if="entry.status === 'update-available'"
                  variant="compact"
                  :disabled="updating"
                  @click="updatesStore.update(entry.source)"
                >
                  更新
                </AppButton>
              </div>
            </div>
            <p class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-desk-muted">
              <span class="chip">{{ entry.scope === 'user' ? '用户级' : '项目级' }}</span>
              <span class="chip">{{ sourceTypeLabel(entry) }}</span>
              <span class="font-mono">{{ versionText(entry) }}</span>
            </p>
            <p v-if="entry.error !== null" class="mt-1 break-words text-2xs text-desk-muted">
              {{ entry.error }}
            </p>
          </li>
        </ul>
      </div>
    </div>

    <p
      v-if="finishedUpdate"
      role="status"
      class="status-notice status-notice-warn mt-4"
    >
      更新只改变已安装的包，运行中的 Runtime 不会重新读取：在「Pi 资源」页点「重新加载资源」后才会生效。
    </p>

    <p class="mt-4 border-t border-desk-line pt-4 text-2xs text-desk-muted">
      内置 Pi agent 默认使用应用自带的版本；在上方可以把它更新到官方最新版本，升级
      只写应用自有的运行时目录，不影响系统里安装的官方 Pi 命令，也不改动你的包声明。
      扩展也可以直接在上方更新：更新走 Pi 自己的包管理，因此项目级包仍要求项目已被信任；
      需要命令行时也可执行
      <span class="font-mono">{{ UPDATE_COMMAND }}</span>，或对单个包执行
      <span class="font-mono">pi update &lt;source&gt;</span>。
    </p>
  </section>
</template>
