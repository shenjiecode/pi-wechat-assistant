// ============================================================================
// 常量定义
// ============================================================================

export const POLL_RETRY_BASE_MS = 1_000
export const POLL_RETRY_MAX_MS = 10_000
export const QR_POLL_INTERVAL_MS = 2_000
export const QR_MAX_REFRESH = 3

export const ACK_TEXT = '✅ 已收到，pi 处理中...'
export const IMAGE_BATCH_ACK_TEXT = '✅ 已收到图片，你可以继续补充文字；稍后我会合并处理。'

export const PREVIEW_LIMIT = 60
export const DEFAULT_IMAGE_BATCH_WAIT_MS = 8_000
export const DEFAULT_IMAGE_MAX_BYTES = 50 * 1024 * 1024

/** 图片预下载最大并发数 */
export const MAX_IMAGE_PREFETCH_CONCURRENCY = 3

/** 项目目录下保存微信文件的子目录名 */
export const WECHAT_FILES_SUBDIR = '.pi-wechat-files'

/** CDN 基础地址（文件/图片上传下载） */
export const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'

export const UNSUPPORTED_TYPES = new Set(['video', 'unknown'])

export const UNSUPPORTED_REPLY: Record<string, string> = {
  video: '⚠️ 暂不支持视频消息，目前支持文字、语音、图片和文件。',
  unknown: '⚠️ 暂不支持此消息类型，目前支持文字、语音、图片和文件。',
}
