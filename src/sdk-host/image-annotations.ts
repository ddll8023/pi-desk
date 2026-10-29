/** 图片说明通过本轮独立 SDK 消息进入上下文；异步作用域避免迟到提交取走另一轮的标注。 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { cloneImageAnnotations, hasImageAnnotations, IMAGE_ANNOTATION_CUSTOM_TYPE } from '../shared/image-annotation'
import type { ImageAnnotationAttachment, ImageAnnotationDocument } from '../shared/image-annotation'

interface AnnotatedImage {
  readonly annotations?: ImageAnnotationDocument
}
interface Submission {
  readonly imageCount: number
  readonly attachments: readonly ImageAnnotationAttachment[]
  consumed: boolean
}

function percent(value: number): string { return `${Number((value * 100).toFixed(3))}%` }

/** 坐标使用图宽高比例，SDK 等比缩图后仍指向同一区域；不把原图像素坐标冒充缩图坐标。 */
function describe(attachments: readonly ImageAnnotationAttachment[]): string {
  const lines = ['以下是本轮图片的用户标注资料，与用户提示词分别提供。',
    '图片按附件顺序编号。标注编号是区域标识；位置以左上角为原点，按图宽和图高的百分比表示。']
  for (const attachment of attachments) {
    lines.push(`\n图片 ${attachment.imageIndex + 1}`)
    if (attachment.document.overview.trim() !== '') lines.push(`整图说明：${attachment.document.overview.trim()}`)
    for (const item of attachment.document.annotations) {
      const location = item.kind === 'point'
        ? `点位置：x=${percent(item.x)}，y=${percent(item.y)}`
        : `矩形：左=${percent(item.x)}，上=${percent(item.y)}，宽=${percent(item.width)}，高=${percent(item.height)}`
      lines.push(`标注 ${item.id}（${location}）：\n${item.text.trim()}`)
    }
  }
  return lines.join('\n')
}

export class ImageAnnotationContext {
  private readonly submissions = new AsyncLocalStorage<Submission>()

  /** 只在真正启动用户轮次时附带一次，不向下一条提示词预先排入消息。 */
  readonly extension: ExtensionFactory = pi => {
    pi.on('before_agent_start', event => {
      const submission = this.submissions.getStore()
      if (event.messageType !== 'user' || submission === undefined || submission.consumed
        || submission.attachments.length === 0) return
      submission.consumed = true
      return { message: {
        customType: IMAGE_ANNOTATION_CUSTOM_TYPE,
        content: describe(submission.attachments),
        display: false,
        details: { version: 1, imageCount: submission.imageCount, attachments: submission.attachments }
      } }
    })
  }

  /** 提示词照常走命令、输入处理器和模板展开；标注不作为这些处理器的文字参数。 */
  run<T>(images: readonly AnnotatedImage[], action: () => T): T {
    const attachments: ImageAnnotationAttachment[] = []
    images.forEach((image, imageIndex) => {
      if (image.annotations !== undefined && hasImageAnnotations(image.annotations)) {
        attachments.push({ imageIndex, document: cloneImageAnnotations(image.annotations) })
      }
    })
    return this.submissions.run({ imageCount: images.length, attachments, consumed: false }, action)
  }
}
