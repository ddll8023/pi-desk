/** 内置任务计划工具：只登记结构化计划，不能启动执行或由模型补报运行状态。 */
import type { ExtensionContext, ExtensionFactory, ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { parseTaskFlowPlan, TASK_FLOW_MAX_STEPS, TASK_FLOW_MAX_TEXT } from '../../shared/task-flow'
import type { TaskFlow, TaskFlowPlan } from '../../shared/task-flow'

export const TASK_FLOW_EXTENSION_NAME = 'task-flow'
type ToolParameters = Parameters<ExtensionAPI['registerTool']>[0]['parameters']
export function createTaskFlowExtension(create: (plan: TaskFlowPlan, ctx: ExtensionContext) => TaskFlow): ExtensionFactory {
  return pi => {
    try {
      pi.registerTool({
        name: 'task_plan', label: '任务计划', executionMode: 'sequential',
        description: '将已讨论的多步骤工作登记为串行计划，并关联当前任务。只规划，不执行；用户在任务面板点击“开始执行”后才运行，也支持无附件聊天发送“开始／开始执行”。停止仍使用聊天输入坞停止键。'
          + '每步必须有明确工作说明，只包含用户已同意的范围。开始计划不增加文件修改、测试、构建或其他操作授权。'
          + '不要登记后自行执行。步骤结束前通过 task_report 声明 stepOutcome；等待用户时停止后续派发，用户补充后可显式“继续当前步骤”。修改尚未启动的计划时重新登记。',
        parameters: {
          type: 'object', additionalProperties: false, required: ['title', 'steps'], properties: {
            title: { type: 'string', maxLength: 200, description: '任务目标' },
            steps: { type: 'array', minItems: 1, maxItems: TASK_FLOW_MAX_STEPS, items: {
              type: 'object', additionalProperties: false, required: ['title', 'instruction'], properties: {
                title: { type: 'string', maxLength: 200, description: '步骤名称' },
                instruction: { type: 'string', maxLength: TASK_FLOW_MAX_TEXT, description: '该步工作内容、边界与预期产出；不扩张用户授权' }
              }
            } }
          }
        } as unknown as ToolParameters,
        async execute(_id, input, _signal, _update, ctx) {
          const plan = parseTaskFlowPlan(input)
          if (plan === null) throw new Error('任务计划格式不正确；请提供目标及有明确说明的步骤。')
          const flow = create(plan, ctx)
          return { content: [{ type: 'text', text: `已登记「${flow.title}」，共 ${flow.steps.length} 步。用户可在任务面板查看计划并点击“开始执行”，也可无附件发送“开始／开始执行”。当前没有执行任何步骤，启动不新增操作授权。` }],
            details: { flowId: flow.id, revision: flow.revision } }
        }
      })
    } catch {
      console.error('[task-flow] 计划工具注册失败，任务工具不可用。')
    }
  }
}
