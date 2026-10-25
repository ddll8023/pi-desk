<!-- 手机访问设置：显式开启局域网 HTTPS、导出并核对 CA、选择配对授权项目和管理设备；二维码仅在本页内存中保存。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import qrcode from 'qrcode-generator'
import type { LanControlData, LanControlRequest, LanDevice, LanRemoteState } from '../../../../shared/lan-remote-api'
import type { Project } from '../../../../shared/project-api'
import { listProjects } from '../../projects/services/project'
import { copyText } from '../../ui/clipboard'
import AppButton from '../../ui/AppButton.vue'
import ConfirmDialog from '../../ui/ConfirmDialog.vue'
import { controlLanRemote, subscribeLanRemote } from '../services/lan-remote'

const state = shallowRef<LanRemoteState | null>(null)
const projects = shallowRef<readonly Project[]>([])
const selectedAddress = ref('')
const selectedProjects = ref<string[]>([])
const busy = ref(false)
const loading = ref(true)
const error = ref('')
const feedback = ref('')
const now = ref(Date.now())
const pairing = shallowRef<{ url: string; expiresAt: number; serverId: string | null } | null>(null)
const editingDevice = ref<string | null>(null)
const grantProjects = ref<string[]>([])
const revokeDevice = shallowRef<LanDevice | null>(null)
let alive = true
let revision = 0
let release: (() => void) | null = null
let clock: ReturnType<typeof setInterval> | null = null
const running = computed(() => state.value?.phase === 'running')
const validPairing = computed(() => pairing.value !== null && pairing.value.expiresAt > now.value
  && pairing.value.serverId === state.value?.serverId && running.value ? pairing.value : null)
const secondsLeft = computed(() => Math.max(0, Math.ceil(((validPairing.value?.expiresAt ?? now.value) - now.value) / 1000)))
const qrImage = computed(() => {
  if (!validPairing.value) return ''
  const code = qrcode(0, 'M')
  code.addData(validPairing.value.url); code.make()
  return code.createDataURL(5, 20)
})
const phaseLabel = computed(() => ({ stopped: '未开启', starting: '正在开启', running: '已开启', stopping: '正在关闭' })[state.value?.phase ?? 'stopped'])

function applyState(value: LanRemoteState): void {
  if (!alive) return
  revision += 1
  const previousIds = state.value ? new Set(state.value.devices.map(device => device.id)) : null
  const paired = previousIds !== null && value.devices.some(device => !previousIds.has(device.id))
  state.value = value
  if (paired && pairing.value) { pairing.value = null; feedback.value = '手机已配对，项目授权已保存。' }
  if (value.phase !== 'running' || pairing.value?.serverId !== value.serverId) pairing.value = null
  if (!value.addresses.some(entry => entry.address === selectedAddress.value)) selectedAddress.value = value.addresses[0]?.address ?? ''
  if (editingDevice.value !== null && !value.devices.some(device => device.id === editingDevice.value)) editingDevice.value = null
}
async function refresh(): Promise<void> {
  loading.value = true; error.value = ''
  const before = revision
  const [snapshot, projectList] = await Promise.all([controlLanRemote({ action: 'state' }), listProjects()])
  if (!alive) return
  loading.value = false
  if (snapshot.ok && snapshot.data.kind === 'state') {
    if (before === revision) applyState(snapshot.data.state)
  } else if (!snapshot.ok) error.value = snapshot.error.message
  if (projectList.ok) {
    projects.value = projectList.data.projects
    selectedProjects.value = selectedProjects.value.filter(id => projects.value.some(project => project.id === id))
  } else error.value = projectList.error.message
}
async function run(request: LanControlRequest): Promise<LanControlData | null> {
  if (busy.value) return null
  busy.value = true; error.value = ''; feedback.value = ''
  const before = revision
  try {
    const result = await controlLanRemote(request)
    if (!alive) return null
    if (!result.ok) { error.value = result.error.message; return null }
    if (result.data.kind === 'state' && before === revision) applyState(result.data.state)
    return result.data
  } finally { if (alive) busy.value = false }
}
async function createPairing(): Promise<void> {
  const serverId = state.value?.serverId ?? null
  const result = await run({ action: 'pair', projectIds: selectedProjects.value })
  if (result?.kind === 'pairing' && state.value?.serverId === serverId && running.value) {
    pairing.value = { url: result.url, expiresAt: result.expiresAt, serverId }
  }
}
async function exportCertificate(): Promise<void> {
  const result = await run({ action: 'export-certificate' })
  if (result?.kind === 'certificate') feedback.value = result.exported ? '已导出公开 CA 证书；私钥仍留在电脑。' : '已取消导出。'
}
async function copy(value: string, label: string): Promise<void> {
  const copied = await copyText(value)
  if (alive) feedback.value = copied ? `${label}已复制。` : '复制失败，请手动选择文本复制。'
}
function editGrant(device: LanDevice): void {
  editingDevice.value = device.id; grantProjects.value = [...device.projectIds]
}
async function saveGrant(): Promise<void> {
  const id = editingDevice.value
  if (!id) return
  const result = await run({ action: 'grant', deviceId: id, projectIds: grantProjects.value })
  if (result) { editingDevice.value = null; feedback.value = '项目授权已更新；手机需重新连接。' }
}
async function revoke(): Promise<void> {
  const device = revokeDevice.value
  revokeDevice.value = null
  if (device && await run({ action: 'revoke', deviceId: device.id })) feedback.value = '设备授权已撤销，电脑上的任务不受影响。'
}
function projectNames(device: LanDevice): string {
  return device.projectIds.map(id => projects.value.find(project => project.id === id)?.name ?? '已移除项目').join('、') || '未授权项目'
}
onMounted(() => {
  release = subscribeLanRemote(applyState)
  clock = setInterval(() => { now.value = Date.now() }, 1000)
  void refresh()
})
onBeforeUnmount(() => {
  alive = false; release?.()
  if (clock) clearInterval(clock)
  pairing.value = null
})
</script>

<template>
  <div class="space-y-4" :aria-busy="loading || busy">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">手机访问</h1>
      <p class="mt-1 text-sm text-desk-muted">在同一局域网内，用手机继续电脑上的对话。手机切换会话不会切换桌面前台。</p>
    </header>
    <p v-if="error" role="alert" class="status-notice status-notice-error">{{ error }}</p>
    <p v-if="feedback" role="status" class="text-sm text-desk-muted">{{ feedback }}</p>
    <section class="settings-section" aria-labelledby="lan-listener-title">
      <div class="settings-section-heading">
        <div><h2 id="lan-listener-title" class="settings-section-title">局域网连接</h2><p class="mt-1 text-xs text-desk-muted">每次启动应用默认关闭；关闭连接不会停止正在运行的 Agent。</p></div>
        <span class="chip" role="status">{{ phaseLabel }}</span>
      </div>
      <label class="field-label" for="lan-address">电脑网卡地址</label>
      <select id="lan-address" v-model="selectedAddress" class="text-control mt-2" :disabled="busy || loading || running">
        <option v-if="!state?.addresses.length" value="">未找到可用的局域网 IPv4 地址</option>
        <option v-for="address in state?.addresses ?? []" :key="address.address" :value="address.address">{{ address.name }} · {{ address.address }}</option>
      </select>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <AppButton v-if="!running" variant="primary" :disabled="busy || loading || !selectedAddress" @click="run({ action: 'start', address: selectedAddress, port: 0 })">开启手机访问</AppButton>
        <AppButton v-else :disabled="busy" @click="run({ action: 'stop' })">关闭手机访问</AppButton>
        <AppButton variant="compact" :disabled="busy || loading" @click="refresh">刷新</AppButton>
      </div>
      <div v-if="state?.origin" class="mt-3 flex flex-wrap items-center gap-2">
        <code class="break-all text-sm">{{ state.origin }}</code><AppButton variant="compact" @click="state?.origin && copy(state.origin, '连接地址')">复制地址</AppButton>
      </div>
      <p v-if="state?.lastError" role="alert" class="mt-3 text-sm text-desk-danger">{{ state.lastError }}</p>
    </section>
    <section class="settings-section" aria-labelledby="lan-certificate-title">
      <h2 id="lan-certificate-title" class="settings-section-title">首次连接</h2>
      <ol class="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-desk-muted">
        <li>导出本机专用 CA 证书，通过可信的文件传输方式发送到手机。</li>
        <li>在手机系统中手动安装并信任该 CA。iPhone 还需在「设置 → 通用 → 关于本机 → 证书信任设置」中开启完全信任；Android 可在系统设置中搜索「安装 CA 证书」。</li>
        <li>核对证书的 SHA-256 指纹，再选择下方允许访问的项目并扫码配对。扫码不能替代证书信任。</li>
      </ol>
      <p class="mt-3 text-xs leading-5 text-desk-muted">CA 会增加手机的证书信任。只安装自己电脑导出的证书，不向他人提供私钥；不再使用时，请从手机系统中移除该 CA。不同系统的菜单名称可能不同。</p>
      <AppButton class="mt-3" :disabled="busy" @click="exportCertificate">导出 CA 证书</AppButton>
      <div v-if="state?.certificate" class="mt-3 space-y-2">
        <p class="field-label">本机 CA 的 SHA-256 指纹</p><code class="block break-all text-xs leading-6">{{ state.certificate.fingerprint }}</code>
        <AppButton variant="compact" @click="state?.certificate && copy(state.certificate.fingerprint, '证书指纹')">复制指纹</AppButton>
      </div>
    </section>
    <section class="settings-section" aria-labelledby="lan-pair-title">
      <h2 id="lan-pair-title" class="settings-section-title">连接一台手机</h2>
      <p class="mt-1 text-xs leading-5 text-desk-muted">只授权明确勾选的项目。手机发送消息能驱动电脑上的 Agent 执行操作，不是只读预览。</p>
      <fieldset class="mt-3 space-y-2" :disabled="busy || loading">
        <legend class="field-label mb-2">这台手机可以访问的项目</legend>
        <label v-for="project in projects" :key="project.id" class="flex items-start gap-2 text-sm">
          <input v-model="selectedProjects" type="checkbox" :value="project.id" class="mt-1 accent-desk-accent" /><span class="min-w-0 break-words">{{ project.name }}</span>
        </label>
        <p v-if="!projects.length" class="text-sm text-desk-muted">先在桌面添加项目，再创建配对。</p>
      </fieldset>
      <AppButton class="mt-4" :disabled="busy || !running || !selectedProjects.length" @click="createPairing">{{ validPairing ? '重新生成配对码' : '生成配对二维码' }}</AppButton>
      <div v-if="validPairing" class="mt-4 space-y-3">
        <img :src="qrImage" alt="手机配对二维码，包含一次性配对码" width="240" height="240" class="lan-pair-code" />
        <p role="status" class="text-xs text-desk-muted">{{ secondsLeft }} 秒后失效 · 仅供自己使用，配对成功后不可再次使用</p>
        <AppButton variant="compact" @click="validPairing && copy(validPairing.url, '配对链接')">复制配对链接</AppButton>
      </div>
    </section>
    <section class="settings-section" aria-labelledby="lan-devices-title">
      <h2 id="lan-devices-title" class="settings-section-title">已授权设备</h2>
      <p v-if="!state?.devices.length" class="mt-3 text-sm text-desk-muted">尚无已授权设备。</p>
      <div v-for="device in state?.devices ?? []" :key="device.id" class="lan-device-row">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0"><h3 class="break-words text-sm font-medium">{{ device.name }}</h3><p class="mt-1 break-words text-xs text-desk-muted">{{ projectNames(device) }}</p></div>
          <div class="flex gap-2"><AppButton variant="compact" :disabled="busy" @click="editGrant(device)">项目授权</AppButton><AppButton variant="quiet-danger" :disabled="busy" @click="revokeDevice = device">撤销</AppButton></div>
        </div>
        <div v-if="editingDevice === device.id" class="mt-3 space-y-3">
          <fieldset class="space-y-2" :disabled="busy"><legend class="field-label mb-2">允许访问的项目</legend>
            <label v-for="project in projects" :key="project.id" class="flex items-center gap-2 text-sm"><input v-model="grantProjects" type="checkbox" :value="project.id" />{{ project.name }}</label>
          </fieldset>
          <div class="flex gap-2"><AppButton :disabled="busy" @click="saveGrant">保存授权</AppButton><AppButton :disabled="busy" @click="editingDevice = null">取消</AppButton></div>
        </div>
      </div>
    </section>
    <ConfirmDialog :open="revokeDevice !== null" title="撤销设备授权" description="该设备会立即断开，重新访问需要再次配对。" detail="电脑上的会话与正在执行的任务不会被删除或停止。" confirm-label="撤销授权" @confirm="revoke" @cancel="revokeDevice = null" />
  </div>
</template>

<style scoped>
.lan-pair-code { width: 240px; max-width: 100%; height: auto; border: 1px solid var(--color-desk-line); background: white; image-rendering: pixelated; }
.lan-device-row { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--color-desk-line); }
</style>
