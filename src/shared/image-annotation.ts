/** 图片批注的独立数据契约：编号、归一化位置与说明一起传递，不改写提示词或原图。 */
export interface ImageAnnotation {
  readonly id: number
  readonly kind: 'point' | 'rect'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly text: string
}

export interface ImageAnnotationDocument {
  readonly nextId: number
  readonly overview: string
  readonly annotations: readonly ImageAnnotation[]
}

/** 图片序号只在同一次固定提交内有效，不作为跨会话图片身份。 */
export interface ImageAnnotationAttachment {
  readonly imageIndex: number
  readonly document: ImageAnnotationDocument
}

export const IMAGE_ANNOTATION_CUSTOM_TYPE = 'pi-desk:image-annotations'
export const IMAGE_ANNOTATION_MAX_COUNT = 64
export const IMAGE_ANNOTATION_TEXT_MAX_CHARS = 2_000
export const IMAGE_ANNOTATION_OVERVIEW_MAX_CHARS = 4_000
const MAX_DOCUMENT_CHARS = 32_000

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}
function unit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}
function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000
}

export function emptyImageAnnotations(): ImageAnnotationDocument {
  return { nextId: 1, overview: '', annotations: [] }
}

/** 编辑态允许暂时留空说明，提交时再要求每个标记都有说明。 */
export function parseImageAnnotations(value: unknown): ImageAnnotationDocument | null {
  if (!record(value) || !keys(value, ['nextId', 'overview', 'annotations'])
    || !positiveId(value.nextId) || typeof value.overview !== 'string'
    || value.overview.length > IMAGE_ANNOTATION_OVERVIEW_MAX_CHARS
    || !Array.isArray(value.annotations) || value.annotations.length > IMAGE_ANNOTATION_MAX_COUNT) return null
  const annotations: ImageAnnotation[] = []
  const ids = new Set<number>()
  let chars = value.overview.length
  for (const item of value.annotations) {
    if (!record(item) || !keys(item, ['id', 'kind', 'x', 'y', 'width', 'height', 'text'])
      || !positiveId(item.id) || ids.has(item.id) || item.id >= value.nextId
      || (item.kind !== 'point' && item.kind !== 'rect')
      || !unit(item.x) || !unit(item.y) || !unit(item.width) || !unit(item.height)
      || item.x + item.width > 1 + Number.EPSILON || item.y + item.height > 1 + Number.EPSILON
      || (item.kind === 'point' && (item.width !== 0 || item.height !== 0))
      || (item.kind === 'rect' && (item.width === 0 || item.height === 0))
      || typeof item.text !== 'string' || item.text.length > IMAGE_ANNOTATION_TEXT_MAX_CHARS) return null
    ids.add(item.id)
    chars += item.text.length
    annotations.push({ id: item.id, kind: item.kind, x: item.x, y: item.y,
      width: item.width, height: item.height, text: item.text })
  }
  if (chars > MAX_DOCUMENT_CHARS) return null
  return { nextId: value.nextId, overview: value.overview, annotations }
}

export function cloneImageAnnotations(value: ImageAnnotationDocument): ImageAnnotationDocument {
  return { nextId: value.nextId, overview: value.overview,
    annotations: value.annotations.map(item => ({ ...item })) }
}

export function hasImageAnnotations(value: ImageAnnotationDocument | undefined): boolean {
  return value !== undefined && (value.overview.trim() !== '' || value.annotations.length > 0)
}

export function imageAnnotationError(value: ImageAnnotationDocument | undefined): string | null {
  if (value === undefined) return null
  if (parseImageAnnotations(value) === null) return '图片标注格式或说明总长度超出限制，请减少标注内容。'
  const missing = value.annotations.find(item => item.text.trim() === '')
  return missing === undefined ? null : `请填写标注 ${missing.id} 的说明，或删除这个标记。`
}

export function parseImageAnnotationAttachments(value: unknown): readonly ImageAnnotationAttachment[] | null {
  if (!Array.isArray(value) || value.length > 4) return null
  const result: ImageAnnotationAttachment[] = []
  const indexes = new Set<number>()
  for (const item of value) {
    if (!record(item) || !keys(item, ['imageIndex', 'document'])
      || typeof item.imageIndex !== 'number' || !Number.isInteger(item.imageIndex)
      || item.imageIndex < 0 || item.imageIndex >= 4 || indexes.has(item.imageIndex)) return null
    const document = parseImageAnnotations(item.document)
    if (document === null || imageAnnotationError(document) !== null || !hasImageAnnotations(document)) return null
    indexes.add(item.imageIndex)
    result.push({ imageIndex: item.imageIndex, document })
  }
  return result
}

/** SDK 实时 custom 消息和日志 custom_message 条目共用这一份识别与校验。 */
export function readImageAnnotationMessage(value: unknown): {
  readonly imageCount: number
  readonly attachments: readonly ImageAnnotationAttachment[]
} | null {
  if (!record(value) || value.customType !== IMAGE_ANNOTATION_CUSTOM_TYPE
    || (value.role !== 'custom' && value.type !== 'custom_message') || !record(value.details)) return null
  const details = value.details
  if (!keys(details, ['version', 'imageCount', 'attachments']) || details.version !== 1
    || typeof details.imageCount !== 'number' || !Number.isInteger(details.imageCount)
    || details.imageCount < 1 || details.imageCount > 4) return null
  const imageCount = details.imageCount
  const attachments = parseImageAnnotationAttachments(details.attachments)
  if (attachments === null || attachments.length === 0
    || attachments.some(item => item.imageIndex >= imageCount)) return null
  return { imageCount, attachments }
}
