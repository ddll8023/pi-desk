/**
 * 浏览器 URL 规范化纯函数的单元测试。
 *
 * 验证用户输入本地端口、完整 URL、缺少协议的网址及空白内容时的处理。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BLANK_PAGE_URL, normalizeBrowserUrl } from '../../../shared/browser-api.ts'

test('规范化空白输入与 about:blank', () => {
  assert.equal(normalizeBrowserUrl(''), BLANK_PAGE_URL)
  assert.equal(normalizeBrowserUrl('   '), BLANK_PAGE_URL)
  assert.equal(normalizeBrowserUrl('about:blank'), BLANK_PAGE_URL)
})

test('保留已带协议的合法 URL', () => {
  assert.equal(normalizeBrowserUrl('http://localhost:3000'), 'http://localhost:3000')
  assert.equal(normalizeBrowserUrl('https://example.com/api?q=1'), 'https://example.com/api?q=1')
})

test('本地开发地址自动补全 http://', () => {
  assert.equal(normalizeBrowserUrl('localhost:5173'), 'http://localhost:5173')
  assert.equal(normalizeBrowserUrl('127.0.0.1:8080/app'), 'http://127.0.0.1:8080/app')
  assert.equal(normalizeBrowserUrl('localhost'), 'http://localhost')
})

test('常规域名自动补全 https://', () => {
  assert.equal(normalizeBrowserUrl('github.com'), 'https://github.com')
  assert.equal(normalizeBrowserUrl('vuejs.org/guide/introduction.html'), 'https://vuejs.org/guide/introduction.html')
})
