/** 本机专用 CA：私钥仅以系统密钥库加密载荷落盘；叶证书按所选地址签发，公有 CA 可显式导出给手机。 */
import 'reflect-metadata'
import { createPrivateKey, randomBytes, webcrypto, X509Certificate as NodeCertificate } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import {
  AuthorityKeyIdentifierExtension, BasicConstraintsExtension, ExtendedKeyUsage, ExtendedKeyUsageExtension,
  KeyUsageFlags, KeyUsagesExtension, SubjectAlternativeNameExtension, SubjectKeyIdentifierExtension,
  X509Certificate, X509CertificateGenerator
} from '@peculiar/x509'
import type { LanCertificateInfo } from '../../shared/lan-remote-api'
import { isLanRecord } from '../../shared/lan-remote-api'
import { requireLanAddress } from './network'

const DAY = 86_400_000
const SIGNING = { name: 'ECDSA', hash: 'SHA-256' }
const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const
interface CertificateAuthority {
  readonly certificate: X509Certificate
  readonly privateKey: webcrypto.CryptoKey
}
export interface LanTlsMaterial {
  readonly key: string
  readonly cert: string
  readonly info: LanCertificateInfo
}

export class LanTlsManager {
  private pending: Promise<CertificateAuthority> | null = null

  /** 首次显式启用或导出时才读取／生成 CA；失败不覆盖旧文件，也不静默替换手机已信任的根。 */
  private authority(): Promise<CertificateAuthority> {
    if (this.pending) return this.pending
    const pending = this.loadAuthority().catch(error => {
      if (this.pending === pending) this.pending = null
      throw error
    })
    this.pending = pending
    return pending
  }

  private async loadAuthority(): Promise<CertificateAuthority> {
    if (!safeStorage.isEncryptionAvailable()
      || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('系统安全密钥存储不可用，不能以明文保存局域网 CA 私钥。')
    }
    const file = join(app.getPath('userData'), 'lan-remote', 'authority.json')
    let text: string | null = null
    try { text = await readFile(file, 'utf8') } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (text !== null) {
      const stored: unknown = JSON.parse(text)
      if (!isLanRecord(stored) || stored.version !== 1 || typeof stored.certificate !== 'string'
        || typeof stored.encryptedKey !== 'string') throw new Error('本机 CA 文件无法识别，未覆盖原文件。')
      const certificate = new X509Certificate(stored.certificate)
      const key = safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64'))
      const privateKey = await webcrypto.subtle.importKey('pkcs8', Buffer.from(key, 'base64'), KEY_ALGORITHM, false, ['sign'])
      const parsed = new NodeCertificate(certificate.toString('pem'))
      if (!parsed.ca || !parsed.checkPrivateKey(createPrivateKey({
        key: Buffer.from(key, 'base64'), format: 'der', type: 'pkcs8'
      }))) throw new Error('本机 CA 证书与私钥不匹配，未替换原有信任。')
      if (certificate.notBefore.getTime() > Date.now() || certificate.notAfter.getTime() < Date.now() + DAY) {
        throw new Error('本机 CA 尚未生效或已到期，不能继续签发服务证书。')
      }
      return { certificate, privateKey }
    }
    const keys = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify'])
    const certificate = await X509CertificateGenerator.createSelfSigned({
      name: `CN=Pi Desk LAN ${randomBytes(6).toString('hex')}`,
      serialNumber: `01${randomBytes(15).toString('hex')}`,
      notBefore: new Date(Date.now() - 5 * 60_000), notAfter: new Date(Date.now() + 3 * 365 * DAY),
      signingAlgorithm: SIGNING, keys,
      extensions: [new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
        await SubjectKeyIdentifierExtension.create(keys.publicKey, false, webcrypto)]
    }, webcrypto)
    const key = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')
    const stored = { version: 1, certificate: certificate.toString('pem'), encryptedKey: safeStorage.encryptString(key).toString('base64') }
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    try {
      await writeFile(temporary, `${JSON.stringify(stored)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, file)
    } finally { await rm(temporary, { force: true }) }
    return { certificate, privateKey: keys.privateKey }
  }

  async issue(address: string): Promise<LanTlsMaterial> {
    requireLanAddress(address)
    const ca = await this.authority()
    const keys = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify'])
    const certificate = await X509CertificateGenerator.create({
      subject: 'CN=Pi Desk LAN', issuer: ca.certificate.subject,
      serialNumber: `01${randomBytes(15).toString('hex')}`,
      notBefore: new Date(Date.now() - 5 * 60_000),
      notAfter: new Date(Math.min(Date.now() + 30 * DAY, ca.certificate.notAfter.getTime())),
      signingAlgorithm: SIGNING, publicKey: keys.publicKey, signingKey: ca.privateKey,
      extensions: [new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
        new SubjectAlternativeNameExtension([{ type: 'ip', value: address }]),
        await SubjectKeyIdentifierExtension.create(keys.publicKey, false, webcrypto),
        await AuthorityKeyIdentifierExtension.create(ca.certificate.publicKey, false, webcrypto)]
    }, webcrypto)
    const key = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')
    return {
      key: `-----BEGIN PRIVATE KEY-----\n${key.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`,
      cert: `${certificate.toString('pem')}\n${ca.certificate.toString('pem')}`,
      info: this.info(ca.certificate)
    }
  }

  /** 导出只返回公有根证书，绝不回传密钥或加密载荷。 */
  async exportAuthority(): Promise<{ readonly bytes: Buffer; readonly info: LanCertificateInfo }> {
    const ca = await this.authority()
    return { bytes: Buffer.from(ca.certificate.rawData), info: this.info(ca.certificate) }
  }
  private info(certificate: X509Certificate): LanCertificateInfo {
    return { fingerprint: new NodeCertificate(certificate.toString('pem')).fingerprint256, expiresAt: certificate.notAfter.toISOString() }
  }
}
