// ============================================================================
// 消息队列 + 批处理
// ============================================================================

import { randomUUID } from 'node:crypto'
import type { ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { debugLog } from './logger.js'
import { WeixinClient } from './client.js'
import { splitAndFilterMarkdown } from './message.js'
import { fetchImageAsBase64, fetchFile, saveFileToDisk, type ImageData } from './media.js'
import {
  ACK_TEXT,
  IMAGE_BATCH_ACK_TEXT,
  DEFAULT_IMAGE_BATCH_WAIT_MS,
  DEFAULT_IMAGE_MAX_BYTES,
  MAX_IMAGE_PREFETCH_CONCURRENCY,
} from './constants.js'
import { summarizePreview, formatError } from './utils.js'
import { redactUrl } from './logger.js'
import type { IncomingMessage } from './types.js'
import { getConfigCache } from './auth.js'

// --- 类型 ---

export interface QueuedMessage {
  id: string
  userId: string
  messageId: string
  receivedAt: Date
  text: string
  preview: string
  contextToken: string
  imageUrl?: string
  imageAesKey?: string
  imageData?: ImageData
  fileEncryptParam?: string
  fileAesKey?: string
  fileName?: string
  fileBuffer?: Buffer
}

export type Ctx = ExtensionContext | ExtensionCommandContext

// --- 配置读取（同步，基于内存缓存） ---

export function getImageBatchWaitMs(): number {
  const configured = getConfigCache().imageBatchWaitMs
  const envValue = Number(process.env.PI_WECHAT_IMAGE_BATCH_WAIT_MS)
  const value = configured ?? (Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_IMAGE_BATCH_WAIT_MS)
  return Math.max(0, Math.min(value, 60_000))
}

export function getImageMaxBytes(): number {
  const configured = getConfigCache().imageMaxBytes
  const envValue = Number(process.env.PI_WECHAT_IMAGE_MAX_BYTES)
  const value = configured ?? (Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_IMAGE_MAX_BYTES)
  return Math.max(1024 * 1024, value)
}

// --- 简单信号量 ---

class Semaphore {
  private _permits: number
  private readonly _waiters: Array<() => void> = []

  constructor(permits: number) {
    this._permits = permits
  }

  async acquire(): Promise<void> {
    if (this._permits > 0) { this._permits--; return }
    return new Promise<void>(resolve => this._waiters.push(resolve))
  }

  release(): void {
    const waiter = this._waiters.shift()
    if (waiter) { waiter() } else { this._permits++ }
  }
}

// --- 队列管理器 ---

export class MessageQueue {
  readonly queue: QueuedMessage[] = []
  pendingInjection: QueuedMessage | null = null
  activeRequest: QueuedMessage | null = null

  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private imageBatchAckSent = false
  private _draining = false

  /** 待注入的已保存文件列表（文件不进入队列和 AI 注入，等文字/图片触发时拼接） */
  private accumulatedFiles: Array<{ name: string; size: number; path: string }> = []

  /** 最后对话的微信用户（用于桥接双向同步） */
  lastWechatUser: { userId: string; contextToken: string } | null = null

  /** 图片预下载并发信号量 */
  private readonly _prefetchSemaphore = new Semaphore(MAX_IMAGE_PREFETCH_CONCURRENCY)

  constructor(
    private readonly getClient: () => WeixinClient | null,
    private readonly isRunning: () => boolean,
    private readonly getAgentIdle: () => boolean,
    private readonly getPollSignal: () => AbortSignal | undefined,
    private readonly getWechatFilesDir: () => string | null,
    private readonly sendUserMessage: (
      content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>,
      opts?: { deliverAs: 'followUp' },
    ) => void,
    private readonly updateStatusBar: () => void,
  ) {}

  // --- 入队 ---

  enqueue(message: IncomingMessage): void {
    const log = debugLog
    const imageCount = message.imageUrls.length
    const hasImages = imageCount > 0
    const hasText = !!message.text
    const hasFile = !!message.fileEncryptParam
    log(`[ENQUEUE] type=${message.type} text=${message.text?.slice(0, 40)} images=${imageCount} hasFile=${hasFile} queueBefore=${this.queue.length} agentIdle=${this.getAgentIdle()} batchTimer=${!!this.batchTimer}`)

    const client = this.getClient()

    const base = {
      userId: message.userId,
      messageId: message.messageId,
      receivedAt: message.timestamp,
      contextToken: message.contextToken,
    }

    // 文件：立即下载保存 + 自动回复，不入队，不参与计时器
    if (hasFile) {
      void this._handleFile(message)
    }

    // 文字部分
    if (hasText) {
      this.queue.push({
        id: randomUUID(),
        ...base,
        text: message.text,
        preview: summarizePreview(message.text),
      })
    }

    // 图片部分 — 每张图一个 QueuedMessage（批处理会合并）
    for (const img of message.imageUrls) {
      const request: QueuedMessage = {
        id: randomUUID(),
        ...base,
        text: '',
        preview: '[图片]',
        imageUrl: img.url,
        imageAesKey: img.aesKey,
      }
      this.queue.push(request)
      void this.prefetchImage(request)
    }

    this.lastWechatUser = { userId: message.userId, contextToken: message.contextToken }
    log(`[ENQUEUE-DONE] text=${hasText} images=${imageCount} file=${hasFile} queueAfter=${this.queue.length} accumulatedFiles=${this.accumulatedFiles.length}`)
    this.updateStatusBar()

    // 只有文字 → 立即 drain（顺便带上累积的文件）
    if (hasText) {
      if (this.batchTimer) {
        clearTimeout(this.batchTimer)
        this.batchTimer = null
        log(`[ENQUEUE-TEXT] batch timer was active, will drain immediately`)
      } else {
        log(`[ENQUEUE-TEXT] no batch timer, calling drainQueue directly`)
      }
      void this.drain()
      return
    }

    // 纯图片 → 批处理 ack + 计时器
    if (hasImages) {
      if (!this.imageBatchAckSent && client) {
        this.imageBatchAckSent = true
        void client.sendText(message.userId, IMAGE_BATCH_ACK_TEXT).catch(err => log(`[IMAGE-ACK-FAIL] ${formatError(err)}`))
      }
      this.restartBatchTimer('图片')
      return
    }

    // 纯文件（无文字无图片）→ 已自动保存，不做任何注入
    log(`[ENQUEUE-FILE-ONLY] file saved, no AI injection`)
  }

  /** 文件处理：下载 → 保存到项目目录 → 自动回复 → 累积 */
  private async _handleFile(message: IncomingMessage): Promise<void> {
    const log = debugLog
    const client = this.getClient()
    const fileName = message.fileName ?? '未知文件'

    const buffer = await fetchFile(message.fileEncryptParam!, message.fileAesKey, this.getPollSignal())
    if (!buffer) {
      log(`[FILE-DL-FAIL] ${fileName}`)
      if (client) void client.sendText(message.userId, `⚠️ 文件下载失败: ${fileName}`).catch(() => {})
      return
    }

    const wechatFilesDir = this.getWechatFilesDir()
    if (!wechatFilesDir) {
      log(`[FILE-SAVE-FAIL] wechatFilesDir 未设置`)
      return
    }
    const savedPath = await saveFileToDisk(buffer, fileName, wechatFilesDir)
    if (!savedPath) {
      log(`[FILE-SAVE-FAIL] 保存失败: ${fileName}`)
      return
    }

    this.accumulatedFiles.push({ name: fileName, size: buffer.length, path: savedPath })
    log(`[FILE-SAVED] ${fileName} (${(buffer.length / 1024).toFixed(1)} KB) → ${savedPath}`)

    if (client) {
      const kb = (buffer.length / 1024).toFixed(1)
      void client.sendText(message.userId, `✅ 已保存: ${fileName} (${kb} KB)`).catch(() => {})
    }
  }

  private restartBatchTimer(label: string): void {
    const waitMs = getImageBatchWaitMs()
    if (this.batchTimer) clearTimeout(this.batchTimer)
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null
      debugLog(`${label}批处理计时器到期`)
      void this.drain()
    }, waitMs)
    debugLog(`${label}批处理计时器已设置: ${waitMs / 1000}s`)
  }

  // --- 预下载（带并发控制） ---

  async prefetchImage(request: QueuedMessage): Promise<void> {
    if (!request.imageUrl) return
    await this._prefetchSemaphore.acquire()
    try {
      const imageData = await fetchImageAsBase64(request.imageUrl, request.imageAesKey, getImageMaxBytes(), this.getPollSignal())
      request.imageData = imageData ?? undefined
      debugLog(`图片预下载: ${imageData ? `success, size=${imageData.data.length}` : 'failed'}`)
    } finally {
      this._prefetchSemaphore.release()
    }
  }

  // --- 队列排出 ---

  async drain(): Promise<void> {
    const log = debugLog

    // 防重入保护
    if (this._draining) { log(`[DRAIN-SKIP] already draining`); return }
    this._draining = true

    try {
      await this._doDrain()
    } finally {
      this._draining = false
    }
  }

  private async _doDrain(): Promise<void> {
    const log = debugLog
    const client = this.getClient()

    const pendingFiles = this.accumulatedFiles.splice(0)

    log(`[DRAIN-ENTER] running=${this.isRunning()} client=${!!client} queue=${this.queue.length} pendingFiles=${pendingFiles.length} pendingInjection=${!!this.pendingInjection} activeRequest=${!!this.activeRequest} agentIdle=${this.getAgentIdle()} batchTimer=${!!this.batchTimer}`)
    if (!this.isRunning() || !client) { log(`[DRAIN-SKIP] not running or no client`); return }
    if (this.pendingInjection) { log(`[DRAIN-SKIP] pendingInjection already set`); return }
    if (this.batchTimer) { log(`[DRAIN-SKIP] 批处理计时器运行中`); return }
    if (this.queue.length === 0 && pendingFiles.length === 0) { log(`[DRAIN-SKIP] queue empty and no pending files`); return }

    const batch = this.queue.splice(0)
    if (batch.length === 0) { log(`[DRAIN-SKIP] queue empty after splice`); return }

    log(`[DRAIN-BATCH] msgs=${batch.length} pendingFiles=${pendingFiles.length}`)
    this.imageBatchAckSent = false
    this.updateStatusBar()

    const first = batch[0]
    const isBusy = !this.getAgentIdle()

    if (!isBusy) {
      this.pendingInjection = first
      log(`[DRAIN-PEND] pendingInjection set`)
    } else {
      log(`[DRAIN-BUSY-DELIVER] agent busy, will use followUp`)
    }
    void client.startTyping(first.userId).catch(() => {})

    const texts: string[] = []
    const images: ImageData[] = []
    const files: Array<{ name: string; path: string; size: number }> = [...pendingFiles]

    for (const msg of batch) {
      if (msg.text) texts.push(msg.text)
      if (msg.imageData) {
        images.push(msg.imageData)
      } else if (msg.imageUrl) {
        log(`现场下载图片: ${redactUrl(msg.imageUrl)}`)
        const imageData = await fetchImageAsBase64(msg.imageUrl, msg.imageAesKey, getImageMaxBytes(), this.getPollSignal())
        if (imageData) images.push(imageData)
      }
    }

    const hasImages = images.length > 0
    const hadImageMessages = batch.some(msg => !!msg.imageUrl)
    const hasFiles = files.length > 0
    const hasText = texts.length > 0

    // 拼接文件信息
    let fileNote = ''
    if (hasFiles) {
      const fileInfos = files.map(f =>
        `- 文件「${f.name}」(${(f.size / 1024).toFixed(1)} KB)，已保存到: ${f.path}`
      ).join('\n')
      fileNote = hasText
        ? `\n\n用户通过微信发送了 ${files.length} 个文件：\n${fileInfos}`
        : `用户通过微信发送了 ${files.length} 个文件：\n${fileInfos}`
    }

    if (hasFiles && !hasImages && !hasText) {
      log(`[DRAIN-FILES-ONLY] no text or images, skipping AI injection`)
      this.updateStatusBar()
      return
    }

    if (hasFiles) {
      const combinedText = texts.join('\n') + fileNote
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{ type: 'text', text: combinedText }]
      for (const img of images) content.push({ type: 'image', data: img.data, mimeType: img.mediaType })
      const deliverOpts = isBusy ? { deliverAs: 'followUp' as const } : undefined
      log(`[DRAIN-SEND] file+text, files=${files.length}, images=${images.length}, mode=${deliverOpts?.deliverAs ?? 'direct'}`)
      this.sendUserMessage(content, deliverOpts)
    } else if (hasImages) {
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
      if (!hasText) {
        content.push({ type: 'text', text: (images.length === 1 ? '请帮我分析这张图片' : `请帮我分析这 ${images.length} 张图片`) })
      } else {
        content.push({ type: 'text', text: texts.join('\n') })
      }
      for (const img of images) content.push({ type: 'image', data: img.data, mimeType: img.mediaType })
      const deliverOpts = isBusy ? { deliverAs: 'followUp' as const } : undefined
      log(`[DRAIN-SEND] image+text, images=${images.length}, mode=${deliverOpts?.deliverAs ?? 'direct'}`)
      this.sendUserMessage(content, deliverOpts)
    } else if (hasText) {
      const deliverOpts = isBusy ? { deliverAs: 'followUp' as const } : undefined
      log(`[DRAIN-SEND] text, text=${texts.join(' ').slice(0, 80)}, mode=${deliverOpts?.deliverAs ?? 'direct'}`)
      this.sendUserMessage(texts.join('\n'), deliverOpts)
    } else {
      if (hadImageMessages) {
        const limitMB = Math.round(getImageMaxBytes() / 1024 / 1024)
        await client.sendText(first.userId, `⚠️ 图片下载失败、格式不支持或超过大小限制（当前上限 ${limitMB}MB）。`).catch(() => {})
      }
      this.pendingInjection = null
      void client.stopTyping(first.userId).catch(() => {})
      // 重新调度 drain，使用 setImmediate 代替 setTimeout(0) 避免堆叠
      setImmediate(() => void this.drain())
      return
    }

    if (!hadImageMessages) {
      try {
        await client.sendText(first.userId, ACK_TEXT)
      } catch (err) {
        log(`发送回执失败: ${formatError(err)}`)
      }
    }
  }

  // --- 统一发送到微信 ---

  async sendRepliesToWechat(replies: string[], targetUserId: string): Promise<void> {
    const client = this.getClient()
    if (!client) return
    for (const reply of replies) {
      const chunks = splitAndFilterMarkdown(reply)
      for (const chunk of chunks) {
        await client.sendText(targetUserId, chunk)
      }
    }
  }

  // --- 重置 ---

  reset(): void {
    this.queue.length = 0
    this.pendingInjection = null
    this.activeRequest = null
    this.imageBatchAckSent = false
    this.accumulatedFiles = []
    this._draining = false
    if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null }
  }

  get pending(): number {
    return this.queue.length
  }
}
