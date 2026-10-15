<!-- 设置页的「版本与更新」区块：显示应用自身版本、内置 Pi agent 版本与 Pi 包（扩展）的已安装/最新版本，
     并提供重新检查与复制官方更新命令。只读展示，不在这里执行任何安装或更新；
     Pi agent 随应用发布更新，该行只作信息展示，不当作需要用户处理的待办。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { ExtensionUpdateInfo } from '../../../shared/updates-api'
import { useDesktopStore } from '../stores/desktop'
import { useUpdatesStore } from '../stores/updates'
import { copyText } from '../clipboard'
import AppButton from './ui/AppButton.vue'

const updatesStore = useUpdatesStore()
const desktopStore = useDesktopStore()
const { snapshot, piAgent, checking, checkedAt, checkFailure, checkError } = storeToRefs(updatesStore)
const { connection } = storeToRefs(desktopStore)
const copied = ref(false)
/** 扩展列表的局部折叠状态：默认展开，只影响本页显示，不写入界面偏好。 */
const extensionsOpen = ref(true)

/** 官方更新命令：扩展由 Pi 自己管理，这里只提供复制，不代跑。 */
const UPDATE_COMMAND = 'pi update --extensions'

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

/** Pi agent 的展示文本：内置版本与官方最新版本；取不到最新版时如实说明。 */
const piAgentText = computed(() => {
  const info = piAgent.value
  if (info === null) return '尚未取得版本信息'
  if (info.status === 'unchecked' || info.latestVersion === null) return info.version
  if (info.status === 'update-available') return `${info.version}（官方已发布 ${info.latestVersion}）`
  return `${info.version}（官方最新）`
})

/** Pi agent 取不到最新版本时的原因；没有原因时为 null。 */
const piAgentError = computed(() => piAgent.value?.error ?? null)
/** 官方在最新版本上附带的说明；没有时为 null。 */
const piAgentNote = computed(() => piAgent.value?.note ?? null)

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
        <AppButton variant="compact" :disabled="checking" @click="updatesStore.check()">
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
        <span class="font-mono">{{ piAgentText }}</span>
        <p v-if="piAgentError !== null" class="mt-1 text-2xs text-desk-muted">
          {{ piAgentError }}
        </p>
        <p v-if="piAgentNote !== null" class="mt-1 text-2xs text-desk-muted">
          {{ piAgentNote }}
        </p>
      </dd>
    </dl>

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
              <span class="chip">{{ statusLabel(entry) }}</span>
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

    <p class="mt-4 border-t border-desk-line pt-4 text-2xs text-desk-muted">
      Pi agent 随 pi-desk 一起打包，版本由应用发布保证，不需要你单独更新或执行任何安装命令；
      这里只报告版本。扩展由 Pi 自己管理，更新请执行
      <span class="font-mono">{{ UPDATE_COMMAND }}</span>，或对单个包执行
      <span class="font-mono">pi update &lt;source&gt;</span>；
      更新完成后要在「Pi 资源」页点「重新加载资源」，Pi 才会重新读取这些包。
    </p>
  </section>
</template>
