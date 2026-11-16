/**
 * 作品库的三个原子工具：清单、详情与登记。
 *
 * 通过受限的 SdkPortfolioOperator 把请求交给主进程执行；工具只负责参数形状与文本输出，
 * 不做路径判断与写盘——来源路径是否在工作区内由主进程复核。返回不携带图片内容，
 * 需要看封面或快照时给出库内相对路径，由用户在设置页打开。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { SdkPortfolioOperation, SdkPortfolioResult } from '../protocol'
import type { PortfolioSource } from '../../shared/portfolio-api'
import {
  PORTFOLIO_NAME_MAX_CHARS,
  PORTFOLIO_POINTS_MAX_CHARS,
  PORTFOLIO_SCENE_MAX_CHARS,
  PORTFOLIO_SNAPSHOT_MAX_FILES,
  isPortfolioId
} from '../../shared/portfolio-api'

export type SdkPortfolioOperator = (operation: SdkPortfolioOperation) => Promise<SdkPortfolioResult>

type ToolParameters = Parameters<ExtensionAPI['registerTool']>[0]['parameters']

const LIST_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false
} as unknown as ToolParameters

const READ_PARAMETERS = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '作品标识，形如 w_…；来自 work_list 的结果' }
  }
} as unknown as ToolParameters

const SAVE_PARAMETERS = {
  type: 'object',
  required: ['name', 'scene', 'points'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: `作品名称，1–${PORTFOLIO_NAME_MAX_CHARS} 字` },
    scene: { type: 'string', description: `适用场景，例如「设置页分节」「数据表格页」，1–${PORTFOLIO_SCENE_MAX_CHARS} 字` },
    points: {
      type: 'string',
      description: `设计要点：布局、配色与令牌、字号阶梯、间距、动效与交互约定，不超过 ${PORTFOLIO_POINTS_MAX_CHARS} 字`
    },
    sources: {
      type: 'array',
      description: '来源（可选）：项目名、项目路径、会话标识与登记日期，只作溯源',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { type: 'string' },
          path: { type: 'string' },
          sessionId: { type: 'string' },
          date: { type: 'string' }
        }
      }
    },
    files: {
      type: 'array',
      description: `要留存的源文件相对路径（相对当前会话工作区，最多 ${PORTFOLIO_SNAPSHOT_MAX_FILES} 个）`,
      items: { type: 'string' }
    }
  }
} as unknown as ToolParameters

function failureText(error: string): string {
  return `作品库操作失败：${error}`
}

/** 参数错误只回到模型侧：不派发，避免协议校验失败导致宿主被判定为通信失配。 */
function invalidParameter(text: string): { content: { type: 'text'; text: string }[]; details: undefined } {
  return { content: [{ type: 'text', text }], details: undefined }
}

export function registerPortfolioTools(pi: ExtensionAPI, operator: SdkPortfolioOperator): void {
  pi.registerTool({
    name: 'work_list',
    label: '作品清单',
    description: '列出作品库中已保存的界面成品，含名称、场景、要点摘要、素材数与更新时间。界面或前端类任务开工前先看这里有没有可复用的成品。',
    parameters: LIST_PARAMETERS,
    async execute() {
      const result = await operator({ kind: 'list' })
      if (!result.ok) return { content: [{ type: 'text', text: failureText(result.error) }], details: undefined }
      if (result.entries.length === 0) {
        return { content: [{ type: 'text', text: '作品库还是空的：只有用户明确要求「存进作品库」时才登记，不主动采集。' }], details: undefined }
      }
      const lines = result.entries.map(entry =>
        `- ${entry.name}（${entry.id}）｜场景：${entry.scene}｜素材 ${entry.assetCount} 个`
        + `${entry.hasCover ? '（有封面）' : ''}｜更新 ${entry.updatedAt}\n  要点：${entry.pointsSummary || '（未填写）'}`)
      return { content: [{ type: 'text', text: `作品库共 ${result.entries.length} 件：\n${lines.join('\n')}` }], details: undefined }
    }
  })

  pi.registerTool({
    name: 'work_read',
    label: '读取作品',
    description: '按作品标识读取要点全文、素材清单与来源。素材只给库内相对路径，不返回图片内容；需要看画面时请用户在设置页「作品」中打开。',
    parameters: READ_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      const params = (rawParams ?? {}) as { id?: unknown }
      if (!isPortfolioId(params.id)) {
        return invalidParameter('参数错误：作品标识应取 work_list 返回的 w_… 形式。')
      }
      const result = await operator({ kind: 'read', id: params.id })
      if (!result.ok) return { content: [{ type: 'text', text: failureText(result.error) }], details: undefined }
      if (result.kind !== 'detail') {
        return invalidParameter('作品读取返回了非详情结果，请重试。')
      }
      const entry = result.entry
      const assets = entry.assets.length === 0
        ? '（无素材）'
        : entry.assets.map(asset => `- [${asset.kind}] ${asset.path}（${asset.bytes} 字节）`).join('\n')
      const sources = entry.sources.length === 0
        ? '（未记录来源）'
        : entry.sources.map(source => `- ${source.project}｜${source.path}｜${source.sessionId ?? '-'}｜${source.date}`).join('\n')
      const text = `${entry.name}（${entry.id}）\n场景：${entry.scene}\n创建：${entry.createdAt}｜更新：${entry.updatedAt}\n\n设计要点：\n${entry.points || '（未填写）'}\n\n素材：\n${assets}\n\n来源：\n${sources}`
      return { content: [{ type: 'text', text }], details: undefined }
    }
  })

  pi.registerTool({
    name: 'work_save',
    label: '登记作品',
    description: '把一份界面成品（页面、组件或 demo 的最终视觉与交互）登记进作品库：要点、可选来源与可选源文件副本。只在用户明确要求「存进作品库」时调用，不主动登记；只新增，不覆盖既有作品。',
    parameters: SAVE_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      const params = (rawParams ?? {}) as {
        name?: string
        scene?: string
        points?: string
        sources?: readonly { project?: string; path?: string; sessionId?: string; date?: string }[]
        files?: readonly string[]
      }
      const today = new Date().toISOString().slice(0, 10)
      const name = typeof params.name === 'string' ? params.name : ''
      const scene = typeof params.scene === 'string' ? params.scene : ''
      const points = typeof params.points === 'string' ? params.points : ''
      // 上限先在这里拦：协议层校验失败会被主进程当成通信失配，代价是整段会话。
      if (name.trim() === '' || name.length > PORTFOLIO_NAME_MAX_CHARS) {
        return invalidParameter(`参数错误：名称不能为空且不能超过 ${PORTFOLIO_NAME_MAX_CHARS} 字。`)
      }
      if (scene.trim() === '' || scene.length > PORTFOLIO_SCENE_MAX_CHARS) {
        return invalidParameter(`参数错误：适用场景不能为空且不能超过 ${PORTFOLIO_SCENE_MAX_CHARS} 字。`)
      }
      if (points.length > PORTFOLIO_POINTS_MAX_CHARS) {
        return invalidParameter(`参数错误：设计要点不能超过 ${PORTFOLIO_POINTS_MAX_CHARS} 字。`)
      }
      const sources: PortfolioSource[] = (params.sources ?? []).map(source => ({
        project: typeof source?.project === 'string' ? source.project.slice(0, 200) : '',
        path: typeof source?.path === 'string' ? source.path.slice(0, 32_768) : '',
        sessionId: typeof source?.sessionId === 'string' && source.sessionId !== '' ? source.sessionId.slice(0, 128) : null,
        date: typeof source?.date === 'string' && source.date !== '' ? source.date.slice(0, 64) : today
      })).filter(source => source.project !== '' || source.path !== '')
      const files = (params.files ?? []).filter((file): file is string => typeof file === 'string' && file !== '')
      if (files.length > PORTFOLIO_SNAPSHOT_MAX_FILES) {
        return invalidParameter(`参数错误：快照最多 ${PORTFOLIO_SNAPSHOT_MAX_FILES} 个文件。`)
      }
      if (files.some(file => file.length > 1_024)) {
        return invalidParameter('参数错误：快照路径过长。')
      }
      const result = await operator({
        kind: 'save',
        name,
        scene,
        points,
        sources,
        files
      })
      if (!result.ok) return { content: [{ type: 'text', text: failureText(result.error) }], details: undefined }
      if (result.kind !== 'detail') return invalidParameter('登记返回了非详情结果，请重试。')
      const entry = result.entry
      return {
        content: [{
          type: 'text',
          text: `已登记「${entry.name}」（${entry.id}），素材 ${entry.assetCount} 个。可以在设置页「作品」查看与补封面。`
        }],
        details: undefined
      }
    }
  })
}
