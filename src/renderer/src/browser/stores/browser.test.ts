/**
 * 浏览器 Store 的单元测试：验证标签状态管理、导航与更新。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setActivePinia, createPinia } from 'pinia'
import { useBrowserStore } from './browser.ts'
import { BLANK_PAGE_URL, DEFAULT_BROWSER_TITLE } from '../../../../shared/browser-api.ts'

test('初始化空白标签页', () => {
  setActivePinia(createPinia())
  const store = useBrowserStore()

  const tab = store.ensureTab('browser:1', '/path/to/project')
  assert.equal(tab.tabKey, 'browser:1')
  assert.equal(tab.url, BLANK_PAGE_URL)
  assert.equal(tab.title, DEFAULT_BROWSER_TITLE)
  assert.equal(tab.inputUrl, '')
})

test('初始化带有初始 URL 的标签页', () => {
  setActivePinia(createPinia())
  const store = useBrowserStore()

  const tab = store.ensureTab('browser:2', '/path/to/project', 'localhost:5173')
  assert.equal(tab.url, 'http://localhost:5173')
  assert.equal(tab.inputUrl, 'http://localhost:5173')
})

test('导航更新状态与规范化', () => {
  setActivePinia(createPinia())
  const store = useBrowserStore()

  store.ensureTab('browser:3', '/path/to/project')
  store.navigate('browser:3', 'github.com')
  const tab = store.tabs['browser:3']
  assert.equal(tab?.url, 'https://github.com')
  assert.equal(tab?.inputUrl, 'https://github.com')
})

test('移除标签清理状态', () => {
  setActivePinia(createPinia())
  const store = useBrowserStore()

  store.ensureTab('browser:4', '/path/to/project')
  assert.ok(store.tabs['browser:4'] !== undefined)
  store.removeTab('browser:4')
  assert.equal(store.tabs['browser:4'], undefined)
})
