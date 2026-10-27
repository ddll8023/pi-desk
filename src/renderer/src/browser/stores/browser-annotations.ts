/** 浏览器截图批注按标签留在内存；关闭标签时释放对应画面与意见。 */
import { defineStore } from 'pinia'
import { reactive } from 'vue'
import type { BrowserElementContext } from '../../../../shared/browser-api'

export interface BrowserAnnotation {
  readonly id: number
  readonly kind: 'point' | 'rect'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  text: string
}

export interface BrowserAnnotationDocument {
  readonly image: string
  readonly url: string
  annotations: BrowserAnnotation[]
  readonly element: BrowserElementContext | null
  readonly elementAnnotationId: number | null
  visible: boolean
  nextId: number
  submittedFingerprint: string | null
}

export const useBrowserAnnotationsStore = defineStore('browser-annotations', () => {
  const documents = reactive<Record<string, BrowserAnnotationDocument>>({})

  function replace(tabKey: string, image: string, url: string, element: BrowserElementContext | null = null): void {
    const selected: BrowserAnnotation[] = element === null ? [] : [{ id: 1, kind: 'rect', x: element.x, y: element.y,
      width: element.width, height: element.height, text: '' }]
    documents[tabKey] = { image, url, annotations: selected, element, elementAnnotationId: element === null ? null : 1,
      visible: true, nextId: element === null ? 1 : 2, submittedFingerprint: null }
  }

  function remove(tabKey: string): void {
    delete documents[tabKey]
  }

  function fingerprint(tabKey: string): string | null {
    const doc = documents[tabKey]
    return doc ? JSON.stringify([doc.annotations, doc.element]) : null
  }

  function hasUnsubmitted(tabKey: string): boolean {
    const doc = documents[tabKey]
    return !!doc && doc.annotations.length > 0 && fingerprint(tabKey) !== doc.submittedFingerprint
  }

  function markSubmitted(tabKey: string, snapshot: string): void {
    const doc = documents[tabKey]
    if (doc && fingerprint(tabKey) === snapshot) doc.submittedFingerprint = snapshot
  }

  return { documents, replace, remove, fingerprint, hasUnsubmitted, markSubmitted }
})
