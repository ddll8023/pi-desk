/** 仅枚举具体的私有 IPv4 网卡地址；来源限制使用所选网卡的真实掩码，不信任转发头或通配监听。 */
import { networkInterfaces } from 'node:os'
import { isIPv4 } from 'node:net'
import type { LanAddress } from '../../shared/lan-remote-api'

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0)
}
export function isPrivateIpv4(address: string): boolean {
  if (!isIPv4(address)) return false
  const value = ipv4Number(address)
  return (value >>> 24) === 10 || (value >>> 20) === 0xac1 || (value >>> 16) === 0xc0a8
}
export function listLanAddresses(): readonly LanAddress[] {
  const addresses: LanAddress[] = []
  const seen = new Set<string>()
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4' || !isPrivateIpv4(entry.address)
        || !isIPv4(entry.netmask) || !isContiguousMask(entry.netmask) || seen.has(entry.address)) continue
      seen.add(entry.address)
      addresses.push({ name, address: entry.address, netmask: entry.netmask })
    }
  }
  return addresses.slice(0, 64)
}
function isContiguousMask(mask: string): boolean {
  const value = ipv4Number(mask)
  const inverse = (~value) >>> 0
  return value !== 0 && ((inverse & (inverse + 1)) >>> 0) === 0
}
export function requireLanAddress(address: string): LanAddress {
  const entry = listLanAddresses().find(candidate => candidate.address === address)
  if (!entry) throw new Error('所选局域网地址已不可用，请重新选择当前网卡地址。')
  return entry
}
export function isLanPeer(binding: LanAddress, peer: string | undefined): boolean {
  const address = peer?.startsWith('::ffff:') ? peer.slice(7) : peer
  if (!address || !isPrivateIpv4(address)) return false
  const mask = ipv4Number(binding.netmask)
  return ((ipv4Number(address) & mask) >>> 0) === ((ipv4Number(binding.address) & mask) >>> 0)
}
export function isBindingCurrent(binding: LanAddress): boolean {
  return listLanAddresses().some(entry => entry.address === binding.address && entry.netmask === binding.netmask)
}
