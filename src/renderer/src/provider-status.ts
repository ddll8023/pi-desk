/** 供应商凭据状态的展示文案：只描述本地凭据解析结果，不声称上游已接受该凭据。 */
import type { AuthProviderStatus } from '../../shared/auth-api'

/**
 * 按凭据来源给出状态文案。清单行与凭据区块共用这一份判断，
 * 避免同一个供应商在不同位置出现不一致的说法。
 */
export function providerStatusLabel(provider: AuthProviderStatus): string {
  if (!provider.configured) {
    return provider.authTypes.length === 0 ? '凭据只能在 Pi 外部提供' : '未配置'
  }
  switch (provider.source) {
    case 'stored':
      return provider.storedType === 'oauth' ? '已保存账户登录' : '已保存 API Key'
    case 'environment':
      return provider.sourceLabel === null ? '来自环境变量' : `来自环境变量 ${provider.sourceLabel}`
    case 'runtime':
      return '来自本次运行的临时密钥'
    case 'config':
      return '来自 models.json 配置'
    default:
      return '已配置'
  }
}