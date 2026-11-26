/**
 * 宿主启动阶段的展示文案：标题栏、输入坞与空态共用同一份口径。
 * 只描述等待中在做什么，不改变可提交条件，也不替主进程判断失败。
 */
import type { HostStartupStage } from '../../../shared/runtime-api'

export interface RuntimeStageText {
  /** 一行标题，用于状态胶囊与空态标题。 */
  readonly title: string
  /** 一句说明，用于空态描述与输入坞提示。 */
  readonly hint: string
}

export function runtimeStageText(stage: HostStartupStage | null): RuntimeStageText {
  if (stage === 'initialize') {
    return {
      title: '正在加载 Agent 运行时',
      hint: '首次启动需要加载官方运行时，加载完成后才会建立会话。'
    }
  }
  if (stage === 'binding') {
    return {
      title: '正在准备会话',
      hint: '运行时已就绪，正在装配会话与随包资源。'
    }
  }
  return {
    title: '正在启动 Pi',
    hint: '正在以当前项目启动 Runtime 并准备会话。'
  }
}
