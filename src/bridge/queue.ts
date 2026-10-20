// ============================================================================
// 消息队列 + 批处理
// ============================================================================

import { createHash, randomUUID } from 'node:crypto'
import type { ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { debugLog } from '../shared/logger.js'
import { WeixinClient } from '../wechat/client.js'
import { fetchImageAsBase64, fetchFile, saveFileToDisk, type ImageData } from '../wechat/media.js'
import {
  MAX_IMAGE_PREFETCH_CONCURRENCY,
} from '../shared/constants.js'
import { summarizePreview, formatError, extractTextFromMessageContent } from '../shared/utils.js'
import { redactUrl } from '../shared/logger.js'
import type { IncomingMessage } from '../wechat/types.js'
import { getConfigCache } from './config.js'
import { resolveImageBatchWaitMs, resolveImageMaxBytes, receiptText } from './config-values.js'
import { markWechatSource, WECHAT_SOURCE_TAG, DEFAULT_WECHAT_BLOCKED_TOOLS, type WechatUserContent } from '../messaging/wechat-source.js'

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
  replyProfile?: { blockedTools: string[] }
}

export type Ctx = ExtensionContext | ExtensionCommandContext

function contentKey(content: unknown): string {
  const text = extractTextFromMessageContent(content) ?? ''
  const images = Array.isArray(content)
    ? content.filter(part => part?.type === 'image').map(part => [part.mimeType, part.data])
    : []
  return createHash('sha256').update(JSON.stringify([text, images])).digest('hex')
}

// --- 配置读取（同步，基于内存缓存） ---

// Keep the existing queue exports as compatibility wrappers.
export function getImageBatchWaitMs(): number { return resolveImageBatchWaitMs(getConfigCache()) }
export function getImageMaxBytes(): number { return resolveImageMaxBytes(getConfigCache()) }

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
  private submittedRequests: Array<{ request: QueuedMessage; key: string; inputObserved: boolean }> = []
  private inputSources: Array<{ key: string; request: QueuedMessage | null }> = []

  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private imageBatchAckSent = false
  private _draining = false
  private generation = 0
  private fileDownloads = new Set<Promise<void>>()

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
    private readonly canSubmit: () => boolean = () => true,
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
      const download = this._handleFile(message, this.generation).catch(error => {
        log(`[FILE-ERROR] ${formatError(error)}`)
      })
      this.fileDownloads.add(download)
      void download.finally(() => this.fileDownloads.delete(download))
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
      if (!this.imageBatchAckSent && client && getConfigCache().sendAck !== false) {
        this.imageBatchAckSent = true
        void client.sendText(message.userId, receiptText(getConfigCache(), true)).catch(err => log(`[IMAGE-ACK-FAIL] ${formatError(err)}`))
      }
      this.restartBatchTimer('图片')
      return
    }

    // 纯文件（无文字无图片）→ 已自动保存，不做任何注入
    log(`[ENQUEUE-FILE-ONLY] file saved, no AI injection`)
  }

  /** 文件处理：下载 → 保存到项目目录 → 自动回复 → 累积 */
  private async _handleFile(message: IncomingMessage, generation: number): Promise<void> {
    const log = debugLog
    const client = this.getClient()
    const fileName = message.fileName ?? '未知文件'

    const buffer = await fetchFile(message.fileEncryptParam!, message.fileAesKey, this.getPollSignal())
    if (generation !== this.generation || !this.isRunning()) return
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
    if (generation !== this.generation || !this.isRunning()) return
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
    const generation = this.generation

    try {
      await this._doDrain()
    } catch (error) {
      if (generation !== this.generation) return
      log(`[DRAIN-ERROR] ${formatError(error)}`)
      const request = this.pendingInjection
      this.pendingInjection = null
      if (request) {
        void this.getClient()?.stopTyping(request.userId).catch(() => {})
        void this.getClient()?.sendText(request.userId, '⚠️ 消息投递失败，请重新发送。').catch(() => {})
      }
    } finally {
      if (generation !== this.generation) return
      this._draining = false
      // Messages received during downloads or the acknowledgement must not wait
      // for agent_end if this run can accept a follow-up already.
      if (this.queue.length && this.isRunning() && this.getClient() && !this.pendingInjection && !this.batchTimer && this.canSubmit()) {
        setImmediate(() => void this.drain())
      }
    }
  }

  private async _doDrain(): Promise<void> {
    const log = debugLog
    const client = this.getClient()

    log(`[DRAIN-ENTER] running=${this.isRunning()} client=${!!client} queue=${this.queue.length} pendingInjection=${!!this.pendingInjection} activeRequest=${!!this.activeRequest} agentIdle=${this.getAgentIdle()} batchTimer=${!!this.batchTimer}`)
    if (!this.isRunning() || !client) { log(`[DRAIN-SKIP] not running or no client`); return }
    if (this.pendingInjection) { log(`[DRAIN-SKIP] pendingInjection already set`); return }
    if (this.batchTimer) { log(`[DRAIN-SKIP] 批处理计时器运行中`); return }
    if (!this.canSubmit()) { log(`[DRAIN-SKIP] agent preparing`); return }
    if (this.queue.length === 0) { log(`[DRAIN-SKIP] queue empty`); return }

    // File and text parts may arrive together. Wait for the current downloads so
    // their saved paths accompany this batch, rather than a later unrelated turn.
    const generation = this.generation
    await Promise.all([...this.fileDownloads])
    if (generation !== this.generation || !this.isRunning() || !this.canSubmit() || this.batchTimer) return

    const batch = this.queue.splice(0)
    if (batch.length === 0) { log(`[DRAIN-SKIP] queue empty after splice`); return }

    const pendingFiles = this.accumulatedFiles.splice(0)

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
    if (generation !== this.generation || !this.isRunning()) return
    if (!this.canSubmit()) {
      this.queue.unshift(...batch)
      this.accumulatedFiles.unshift(...files)
      this.pendingInjection = null
      void client.stopTyping(first.userId).catch(() => {})
      return
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
      this.accumulatedFiles.unshift(...files)
      this.pendingInjection = null
      void client.stopTyping(first.userId).catch(() => {})
      this.updateStatusBar()
      return
    }

    if (hasFiles) {
      const combinedText = texts.join('\n') + fileNote
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{ type: 'text', text: combinedText }]
      for (const img of images) content.push({ type: 'image', data: img.data, mimeType: img.mediaType })
      log(`[DRAIN-SEND] file+text, files=${files.length}, images=${images.length}, mode=followUp`)
      this.submit(content, first)
    } else if (hasImages) {
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
      if (!hasText) {
        content.push({ type: 'text', text: (images.length === 1 ? '请帮我分析这张图片' : `请帮我分析这 ${images.length} 张图片`) })
      } else {
        content.push({ type: 'text', text: texts.join('\n') })
      }
      for (const img of images) content.push({ type: 'image', data: img.data, mimeType: img.mediaType })
      log(`[DRAIN-SEND] image+text, images=${images.length}, mode=followUp`)
      this.submit(content, first)
    } else if (hasText) {
      log(`[DRAIN-SEND] text, text=${texts.join(' ').slice(0, 80)}, mode=followUp`)
      this.submit(texts.join('\n'), first)
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

    if (!hadImageMessages && getConfigCache().sendAck !== false) {
      try {
        await client.sendText(first.userId, receiptText(getConfigCache()))
      } catch (err) {
        log(`发送回执失败: ${formatError(err)}`)
      }
    }
  }

  // --- 重置 ---

  private submit(content: WechatUserContent, request: QueuedMessage): void {
    const config = getConfigCache().messageSourceTag
    const enabled = config?.enabled !== false
    request.replyProfile = enabled
      ? { blockedTools: [...(config?.blockedTools ?? DEFAULT_WECHAT_BLOCKED_TOOLS)] }
      : undefined
    const marked = enabled
      ? markWechatSource(content, config?.wechatTag?.trim() || WECHAT_SOURCE_TAG)
      : content
    const submission = { request, key: contentKey(marked), inputObserved: false }
    this.submittedRequests.push(submission)
    // Safe both while idle and while Pi is preparing or executing a run.
    try {
      this.sendUserMessage(marked, { deliverAs: 'followUp' })
    } catch (error) {
      this.submittedRequests = this.submittedRequests.filter(item => item !== submission)
      this.inputSources = this.inputSources.filter(item => item.request !== request)
      if (this.pendingInjection === request) this.pendingInjection = null
      void this.getClient()?.stopTyping(request.userId).catch(() => {})
      void this.getClient()?.sendText(request.userId, '⚠️ 消息投递失败，请重新发送。').catch(() => {})
      throw error
    }
  }

  /** Input origin is useful only together with a matching bridge submission. */
  observeInput(text: string, images: unknown[] | undefined, source: string): QueuedMessage | undefined {
    const key = contentKey([{ type: 'text', text }, ...(images ?? [])])
    const submitted = source === 'extension'
      ? this.submittedRequests.find(item => item.key === key && !item.inputObserved)
      : undefined
    if (submitted) submitted.inputObserved = true
    this.inputSources.push({ key, request: submitted?.request ?? null })
    return submitted?.request
  }

  /** Also identifies stale asynchronous input checks after a bridge reset. */
  hasSubmittedRequest(request: QueuedMessage): boolean {
    return this.submittedRequests.some(item => item.request === request)
  }

  /** Drop a bridge input rejected before Pi starts a run (no lifecycle events follow). */
  discardSubmittedRequest(request: QueuedMessage): void {
    this.submittedRequests = this.submittedRequests.filter(item => item.request !== request)
    this.inputSources = this.inputSources.filter(item => item.request !== request)
    if (this.pendingInjection === request) this.pendingInjection = null
  }

  /** Match only this bridge's submissions, when Pi actually consumes the message. */
  consumeSubmittedRequest(content: unknown): QueuedMessage | null {
    const key = contentKey(content)
    const inputIndex = this.inputSources.findIndex(item => item.key === key)
    const input = inputIndex >= 0 ? this.inputSources.splice(inputIndex, 1)[0] : undefined
    if (input && !input.request) return null
    const index = this.submittedRequests.findIndex(item => input
      ? item.request === input.request
      : item.key === key && !item.inputObserved)
    if (index < 0) return null
    const [{ request }] = this.submittedRequests.splice(index, 1)
    if (this.pendingInjection === request) this.pendingInjection = null
    this.activeRequest = request
    return request
  }

  reset(): void {
    this.queue.length = 0
    this.pendingInjection = null
    this.activeRequest = null
    this.submittedRequests.length = 0
    this.inputSources.length = 0
    this.generation++
    this.fileDownloads.clear()
    this.imageBatchAckSent = false
    this.accumulatedFiles = []
    this._draining = false
    if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null }
  }

  get pending(): number {
    return this.queue.length
  }
}
