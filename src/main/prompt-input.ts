/**
 * Prompt 文本与图片附件的校验：宿主提交前的唯一入口。
 * 文本与图片至少有一项：只发图片不带文字是合法输入，两者都为空才拒绝。
 * 返回固定的线格式图片，不修改调用方输入，也不就地把错误包装成结果对象。
 */
import type { PromptImageInput } from '../shared/runtime-api'

/** prompt 文本上限，按 UTF-8 字节计。 */
const PROMPT_MAX_BYTES = 1_048_576

/** 允许的图片 MIME 类型；与常见图像格式一致，其他类型一律拒绝。 */
const PROMPT_IMAGE_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** 单张图片 base64 编码后的字符数上限；约对应 3 MiB 原始数据。 */
const PROMPT_IMAGE_MAX_CHARS = 4_194_304

/** 单条 Prompt 最多携带的图片数。 */
const PROMPT_IMAGE_MAX_COUNT = 4

export function validatePromptInput(
  message: string,
  images: readonly PromptImageInput[]
): { readonly ok: true; readonly images: readonly { readonly type: 'image'; readonly data: string; readonly mimeType: string }[] }
  | { readonly ok: false; readonly message: string } {
  if (message.trim() === '' && images.length === 0) {
    return { ok: false, message: 'Prompt 内容与图片不能同时为空。' }
  }
  if (Buffer.byteLength(message, 'utf8') > PROMPT_MAX_BYTES) {
    return { ok: false, message: `Prompt 内容超过 ${PROMPT_MAX_BYTES} 字节上限。` }
  }
  if (images.length > PROMPT_IMAGE_MAX_COUNT) {
    return { ok: false, message: `单条 Prompt 最多携带 ${PROMPT_IMAGE_MAX_COUNT} 张图片。` }
  }
  const wireImages: { type: 'image'; data: string; mimeType: string }[] = []
  for (const image of images) {
    if (!PROMPT_IMAGE_MIME_TYPES.includes(image.mimeType)) {
      return { ok: false, message: `不支持的图片类型：${image.mimeType}。` }
    }
    if (image.data.length === 0 || image.data.length > PROMPT_IMAGE_MAX_CHARS) {
      return { ok: false, message: `图片「${image.name}」超出编码后大小上限。` }
    }
    wireImages.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  }
  return { ok: true, images: wireImages }
}
