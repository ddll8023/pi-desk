/** 持有 `@` 文件引用的候选路径；检索由主进程按当前项目完成，这里只保存最后一次查询的结果。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DesktopError } from '../../../shared/desktop-api'
import { searchProjectFiles } from '../services/project-file'

export const useProjectFileStore = defineStore('project-file', () => {
  const entries = ref<readonly string[]>([])
  const pending = ref(false)
  const error = ref<DesktopError | null>(null)
  /** 自增序号：连续输入时只让最后一次查询的结果落地。 */
  let sequence = 0

  /** 检索候选；过期响应（期间又发起了新查询）直接丢弃，不覆盖新结果。 */
  async function search(query: string): Promise<void> {
    const ticket = ++sequence
    pending.value = true
    const result = await searchProjectFiles(query)
    if (ticket !== sequence) return

    pending.value = false
    if (!result.ok) {
      error.value = result.error
      entries.value = []
      return
    }
    error.value = null
    entries.value = result.data.entries
  }

  return { entries, pending, error, search }
})
