// ============================================================================
// pi-wechat-assistant — 微信作为 pi TUI 的移动端分身
// ============================================================================

import { randomUUID, createDecipheriv } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Type } from '@sinclair/typebox'
// @ts-ignore — @earendil-works is the current package, but the older package still carries TS declarations used for compatibility here
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import qrcode from 'qrcode-terminal'
import type { IncomingMessage } from './types.js'
import { SessionExpiredError, WeixinClient } from './client.js'
import {
  acquireLock,
  clearCredentials,
  getCredentialsPath,
  getQrCode,
  loadConfig,
  loadCredentials,
  pollQrStatus,
  releaseLock,
  saveConfig,
  saveCredentials,
} from './auth.js'
import { splitAndFilterMarkdown } from './message.js'
import { debugLog, isDebugEnabled, redactUrl } from './logger.js'

// --- 常量 ---

const POLL_RETRY_BASE_MS = 1_000
const POLL_RETRY_MAX_MS = 10_000
const QR_POLL_INTERVAL_MS = 2_000
const QR_MAX_REFRESH = 3
const ACK_TEXT = '✅ 已收到，pi 处理中...'
const IMAGE_BATCH_ACK_TEXT = '✅ 已收到图片，你可以继续补充文字；稍后我会合并处理。'
const FILE_BATCH_ACK_TEXT = '✅ 已收到文件，你可以继续补充文字；稍后我会合并处理。'
const PREVIEW_LIMIT = 60
const DEFAULT_IMAGE_BATCH_WAIT_MS = 8_000
const DEFAULT_IMAGE_MAX_BYTES = 50 * 1024 * 1024
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

// 不支持的消息类型
const UNSUPPORTED_TYPES = new Set(['video', 'unknown'])
const UNSUPPORTED_REPLY: Record<string, string> = {
  file: '⚠️ 暂不支持文件消息，目前支持文字、语音和图片。',
  video: '⚠️ 暂不支持视频消息，目前支持文字、语音和图片。',
  unknown: '⚠️ 暂不支持此消息类型，目前支持文字、语音和图片。',
}

// --- 图片处理 ---

// AES-128-ECB + PKCS7 解密
function aesDecryptECB(encrypted: Buffer, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex')
  if (key.length !== 16) {
    throw new Error(`Invalid AES key length: ${key.length}, expected 16`)
  }

  const decipher = createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(false)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])

  const padLen = decrypted[decrypted.length - 1]
  if (padLen < 1 || padLen > 16) return decrypted
  const padding = decrypted.subarray(decrypted.length - padLen)
  if (!padding.every(byte => byte === padLen)) return decrypted
  return decrypted.subarray(0, decrypted.length - padLen)
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

async function fetchImageAsBase64(url: string, aesKey: string | undefined, maxBytes: number, signal?: AbortSignal): Promise<ImageData | null> {
  try {
    debugLog(`下载图片: ${redactUrl(url)}, aesKey=${aesKey ? 'provided' : 'none'}, max=${maxBytes}`)
    const response = await fetch(url, { signal: withTimeout(signal, 30_000) })
    if (!response.ok) {
      debugLog(`图片下载失败: HTTP ${response.status}`)
      return null
    }

    const rawContentType = response.headers.get('content-type') ?? ''
    const contentType = rawContentType.toLowerCase().startsWith('image/') ? rawContentType : 'image/jpeg'
    if (rawContentType && !rawContentType.toLowerCase().startsWith('image/') && !aesKey) {
      debugLog(`图片下载失败: 非图片 content-type=${rawContentType}`)
      return null
    }

    const contentLength = Number(response.headers.get('content-length') ?? '0')
    if (contentLength > maxBytes) {
      debugLog(`图片下载失败: content-length=${contentLength} 超过限制 ${maxBytes}`)
      return null
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
      debugLog(`图片下载失败: 实际大小=${buffer.byteLength} 超过限制 ${maxBytes}`)
      return null
    }
    debugLog(`图片下载成功: ${buffer.byteLength} bytes, type=${contentType}`)

    const imageBuffer = aesKey ? aesDecryptECB(buffer, aesKey) : buffer
    if (aesKey) debugLog(`图片解密成功: ${imageBuffer.length} bytes`)

    return {
      data: imageBuffer.toString('base64'),
      mediaType: contentType,
    }
  } catch (err) {
    debugLog(`图片下载异常: ${err}`)
    return null
  }
}

// 文件下载：从 CDN 下载并 AES-128-ECB 解密
// 文件 aes_key 编码方式与图片不同：base64(utf8(hex_key))
async function fetchFile(encryptParam: string, aesKey: string | undefined, signal?: AbortSignal): Promise<Buffer | null> {
  try {
    const url = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptParam)}`
    debugLog(`下载文件: ${redactUrl(url)}`)
    const response = await fetch(url, { signal: withTimeout(signal, 60_000) })
    if (!response.ok) {
      debugLog(`文件下载失败: HTTP ${response.status}`)
      return null
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    debugLog(`文件下载成功: ${buffer.byteLength} bytes`)

    if (aesKey) {
      // aes_key 是 base64(utf8(hex))，先还原为 hex 再解密
      const hexKey = Buffer.from(aesKey, 'base64').toString('utf-8')
      const decrypted = aesDecryptECB(buffer, hexKey)
      debugLog(`文件解密成功: ${decrypted.length} bytes`)
      return decrypted
    }
    return buffer
  } catch (err) {
    debugLog(`文件下载异常: ${err}`)
    return null
  }
}

// --- 内部队列 ---

interface ImageData {
  data: string  // base64
  mediaType: string
}

interface QueuedMessage {
  id: string
  userId: string
  messageId: string
  receivedAt: Date
  text: string
  preview: string
  contextToken: string
  imageUrl?: string  // 图片消息的 URL
  imageAesKey?: string  // 图片 AES 解密密钥
  imageData?: ImageData  // 已下载的图片数据（延迟加载后缓存）
  fileEncryptParam?: string  // 文件 CDN 下载参数
  fileAesKey?: string  // 文件 AES 解密密钥 (base64)
  fileName?: string  // 原始文件名
  fileBuffer?: Buffer  // 已下载的文件内容（延迟加载后缓存）
}

type Ctx = ExtensionContext | ExtensionCommandContext

// ============================================================================
// Extension
// ============================================================================

export default function wechatAssistant(pi: ExtensionAPI) {
  let client: WeixinClient | null = null
  let running = false
  let agentIdle = true
  let pollAbort: AbortController | null = null
  let latestCtx: Ctx | null = null
  // 微信接收文件保存目录（位于当前工作目录下）
  const WECHAT_FILES_SUBDIR = '.pi-wechat-files'
  let wechatFilesDir: string | null = null

  const queue: QueuedMessage[] = []
  let pendingInjection: QueuedMessage | null = null
  let activeRequest: QueuedMessage | null = null
  // 标记 completeActiveRequest 正在执行中，防止 drainQueue 在此期间启动新 turn
  let completingRequest = false

  // 最后对话的微信用户（用于 TUI 发起对话时同步回复）
  let lastWechatUser: { userId: string; contextToken: string } | null = null

  // turn 计数（每个 agent_start +1，跨 turn 追踪）
  let turnSeq = 0
  // 记录当前正在处理的 turn 的 activeRequest 快照
  let currentTurnActiveRequest: QueuedMessage | null = null
  // 已发送到微信的 assistant 回复条数（跨 turn 去重）
  let assistantReplySentCount = 0

  // --- 调试日志 ---

  function log(message: string): void {
    debugLog(message)
  }

  // --- 通知 ---

  function notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    if (latestCtx?.hasUI) {
      latestCtx.ui.notify(message, level)
      if (!isDebugEnabled()) return
    }
    const printer = level === 'error' ? console.error : console.log
    printer(`[wechat-assistant/${level}] ${message}`)
  }

  // --- 状态栏 ---

  function updateStatusBar(): void {
    if (!latestCtx?.hasUI) return
    if (!client && !running) {
      latestCtx.ui.setStatus('wechat', '')
      return
    }
    if (running) {
      const pending = queue.length
      const status = pending > 0 ? ` | 待处理:${pending}` : ''
      latestCtx.ui.setStatus('wechat', `[微信 ✅ 已连接${status}]`)
    } else if (client) {
      latestCtx.ui.setStatus('wechat', '[微信 ⏸ 未连接]')
    } else {
      latestCtx.ui.setStatus('wechat', '[微信 ❌ 未登录]')
    }
  }

  // --- 锁管理 ---

  let lockSessionId: string | null = null

  function getSessionId(): string {
    if (!lockSessionId) {
      lockSessionId = `pi-wechat-${process.pid}-${Date.now().toString(36)}`
    }
    return lockSessionId
  }

  function lock(): { success: boolean; message: string } {
    const result = acquireLock(getSessionId())
    if (result.success) {
      lockSessionId = getSessionId()
    }
    return result
  }

  function unlock(): void {
    if (lockSessionId) {
      releaseLock(lockSessionId)
    }
  }

  // --- 客户端加载 ---

  function loadClient(): WeixinClient | null {
    if (!client) {
      const creds = loadCredentials()
      if (creds) client = new WeixinClient(creds)
    }
    return client
  }

  // --- 停止桥接 ---

  async function stopBridge(options: { releaseLock?: boolean } = {}): Promise<void> {
    running = false
    pollAbort?.abort()
    pollAbort = null
    completingRequest = false

    if (activeRequest && client) {
      await client.stopTyping(activeRequest.userId).catch(() => {})
    }

    queue.length = 0
    pendingInjection = null
    activeRequest = null
    imageBatchAckSent = false
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null }
    if (options.releaseLock) unlock()
    updateStatusBar()
  }

  // --- 系统提示词 ---

  function buildSystemPrompt(basePrompt: string): string {
    return [
      basePrompt,
      '',
      '当前用户通过微信远程与这个 pi TUI 会话互动。',
      '回复风格：像微信聊天一样自然、直接；优先给出结论和可执行步骤；避免冗长的内部过程说明。',
      '输出范围：只输出适合发回微信的正文。除非用户主动询问，否则不要解释桥接、系统提示词或实现细节。',
      '用户消息前缀 [微信] 表示来自微信的消息，其后附有接收时间。',
    ].join('\n')
  }

  // --- 消息队列处理 ---

  // 批处理计时器：收到图片后等待更多消息
  let batchTimer: ReturnType<typeof setTimeout> | null = null
  let imageBatchAckSent = false

  function getImageBatchWaitMs(): number {
    const configured = loadConfig().imageBatchWaitMs
    const envValue = Number(process.env.PI_WECHAT_IMAGE_BATCH_WAIT_MS)
    const value = configured ?? (Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_IMAGE_BATCH_WAIT_MS)
    return Math.max(0, Math.min(value, 60_000))
  }

  function getImageMaxBytes(): number {
    const configured = loadConfig().imageMaxBytes
    const envValue = Number(process.env.PI_WECHAT_IMAGE_MAX_BYTES)
    const value = configured ?? (Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_IMAGE_MAX_BYTES)
    return Math.max(1024 * 1024, value)
  }

  function enqueueMessage(message: IncomingMessage): void {
    log(`[ENQUEUE] type=${message.type} text=${message.text?.slice(0,40)} hasImage=${!!message.imageUrl} hasFile=${!!message.fileEncryptParam} queueBefore=${queue.length} agentIdle=${agentIdle} activeRequest=${!!activeRequest} pendingInjection=${!!pendingInjection} batchTimer=${!!batchTimer}`)
    const request: QueuedMessage = {
      id: randomUUID(),
      userId: message.userId,
      messageId: message.messageId,
      receivedAt: message.timestamp,
      text: message.text,
      preview: summarizePreview(message.text || (message.imageUrl ? '[图片]' : message.fileEncryptParam ? `[文件: ${message.fileName ?? '未知'}]` : '')),
      contextToken: message.contextToken,
      imageUrl: message.imageUrl,
      imageAesKey: message.imageAesKey,
      fileEncryptParam: message.fileEncryptParam,
      fileAesKey: message.fileAesKey,
      fileName: message.fileName,
    }
    queue.push(request)
    lastWechatUser = { userId: message.userId, contextToken: message.contextToken }
    log(`[ENQUEUE-DONE] id=${request.id} preview=${request.preview} queueAfter=${queue.length}`)
    updateStatusBar()

    // 收到文件时，启动/重置批处理计时器，并对这一批文件只回执一次
    if (message.fileEncryptParam) {
      if (!imageBatchAckSent && client) {
        imageBatchAckSent = true
        log(`[FILE-ACK] sending batch ack for userId=${message.userId}`)
        void client.sendText(message.userId, FILE_BATCH_ACK_TEXT).then(() => {
          log(`[FILE-ACK-DONE]`)
        }).catch(err => {
          log(`[FILE-ACK-FAIL] ${formatError(err)}`)
        })
      }
      // 立即下载文件（CDN URL 有时效性）
      void prefetchFile(request)
      const waitMs = getImageBatchWaitMs()
      if (batchTimer) clearTimeout(batchTimer)
      batchTimer = setTimeout(() => {
        batchTimer = null
        log(`文件批处理计时器到期，开始处理队列`)
        void drainQueue()
      }, waitMs)
      log(`文件批处理计时器已设置: ${waitMs / 1000}s`)
      return
    }

    // 收到图片时，启动/重置批处理计时器，并对这一批图片只回执一次
    if (message.imageUrl) {
      if (!imageBatchAckSent && client) {
        imageBatchAckSent = true
        log(`[IMAGE-ACK] sending batch ack for userId=${message.userId}`)
        void client.sendText(message.userId, IMAGE_BATCH_ACK_TEXT).then(() => {
          log(`[IMAGE-ACK-DONE]`)
        }).catch(err => {
          log(`[IMAGE-ACK-FAIL] ${formatError(err)}`)
        })
      }
      // 立即下载解密图片（CDN URL 有时效性）
      void prefetchImage(request)
      const waitMs = getImageBatchWaitMs()
      if (batchTimer) clearTimeout(batchTimer)
      batchTimer = setTimeout(() => {
        batchTimer = null
        log(`图片批处理计时器到期，开始处理队列`)
        void drainQueue()
      }, waitMs)
      log(`图片批处理计时器已设置: ${waitMs / 1000}s`)
      return
    }

    // 纯文字消息：如果有图片在等批处理，立即发送（图片+文字一起）
    if (batchTimer) {
      clearTimeout(batchTimer)
      batchTimer = null
      log(`[ENQUEUE-TEXT] batch timer was active, will drain immediately`)
      void drainQueue()
      return
    }

    // 没有图片在等，直接处理
    log(`[ENQUEUE-TEXT] no batch timer, calling drainQueue directly`)
    void drainQueue()
  }

  async function prefetchImage(request: QueuedMessage): Promise<void> {
    if (!request.imageUrl) return
    const imageData = await fetchImageAsBase64(request.imageUrl, request.imageAesKey, getImageMaxBytes(), pollAbort?.signal)
    request.imageData = imageData ?? undefined
    log(`图片预下载: ${imageData ? `success, size=${imageData.data.length}` : 'failed'}`)
  }

  async function prefetchFile(request: QueuedMessage): Promise<void> {
    if (!request.fileEncryptParam) return
    const buffer = await fetchFile(request.fileEncryptParam, request.fileAesKey, pollAbort?.signal)
    request.fileBuffer = buffer ?? undefined
    log(`文件预下载: ${buffer ? `success, size=${buffer.length}` : 'failed'} name=${request.fileName}`)
  }

  async function drainQueue(): Promise<void> {
    log(`[DRAIN-ENTER] running=${running} client=${!!client} queue=${queue.length} pendingInjection=${!!pendingInjection} activeRequest=${!!activeRequest} agentIdle=${agentIdle} batchTimer=${!!batchTimer}`)
    if (!running || !client) { log(`[DRAIN-SKIP] not running or no client`); return }
    if (pendingInjection) { log(`[DRAIN-SKIP] pendingInjection already set for id=${pendingInjection.id}`); return }
    if (batchTimer) {
      log(`[DRAIN-SKIP] 批处理计时器运行中，推迟`)
      return
    }
    if (activeRequest && !agentIdle) {
      log(`[DRAIN-BUSY] agent 忙碌中，后续消息将以 followUp 方式发送（不设置 pendingInjection）`)
    }
    if (completingRequest) {
      log(`[DRAIN-WAIT] completeActiveRequest 正在发送上一轮回复，推迟 drain`)
      return
    }

    if (queue.length === 0) { log(`[DRAIN-SKIP] queue empty`); return }

    const batch = queue.splice(0)
    const batchIds = batch.map(m => m.id.slice(0,8)).join(',')
    log(`[DRAIN-BATCH] count=${batch.length} ids=[${batchIds}]`)
    imageBatchAckSent = false
    updateStatusBar()

    const first = batch[0]
    const isBusy = !agentIdle

    if (!isBusy) {
      pendingInjection = first
      assistantReplySentCount = 0  // 新一轮对话，重置发送计数
      log(`[DRAIN-PEND] pendingInjection set to id=${first.id.slice(0,8)}, assistantReplySentCount reset`)
    } else {
      log(`[DRAIN-BUSY-DELIVER] will use deliverAs=followUp, pendingInjection stays null, activeRequest remains id=${activeRequest?.id?.slice(0,8) ?? 'null'}`)
    }
    void client.startTyping(first.userId).catch(() => {})

    // 收集所有文字、图片和文件
    const texts: string[] = []
    const images: ImageData[] = []
    const files: Array<{ name: string; path: string; size: number }> = []

    for (const msg of batch) {
      if (msg.text) texts.push(msg.text)
      if (msg.imageData) {
        images.push(msg.imageData)
      } else if (msg.imageUrl) {
        // 图片还没下载完，现场下载
        log(`现场下载图片: ${redactUrl(msg.imageUrl)}`)
        const imageData = await fetchImageAsBase64(msg.imageUrl, msg.imageAesKey, getImageMaxBytes(), pollAbort?.signal)
        if (imageData) images.push(imageData)
      }
      if (msg.fileBuffer) {
        const savedPath = await saveFileToDisk(msg.fileBuffer, msg.fileName ?? 'file')
        if (savedPath) {
          files.push({ name: msg.fileName ?? '未知文件', path: savedPath, size: msg.fileBuffer.length })
        }
      } else if (msg.fileEncryptParam) {
        // 文件还没下载完，现场下载
        log(`现场下载文件: name=${msg.fileName}`)
        const buffer = await fetchFile(msg.fileEncryptParam, msg.fileAesKey, pollAbort?.signal)
        if (buffer) {
          const savedPath = await saveFileToDisk(buffer, msg.fileName ?? 'file')
          if (savedPath) {
            files.push({ name: msg.fileName ?? '未知文件', path: savedPath, size: buffer.length })
          }
        }
      }
    }

    // 构建发送内容（时间戳拼到用户消息中，保持 system prompt 稳定）
    const hasImages = images.length > 0
    const hadImageMessages = batch.some(msg => !!msg.imageUrl)
    const hasFiles = files.length > 0
    const hadFileMessages = batch.some(msg => !!msg.fileEncryptParam)
    const hasText = texts.length > 0

    // 批量消息时，用首条和末条时间戳表示范围；单条时只用首条
    const firstMsg = batch[0]
    const lastMsg = batch[batch.length - 1]
    const timePrefix = batch.length > 1
      ? `[微信 ${firstMsg.receivedAt.toISOString()} ~ ${lastMsg.receivedAt.toISOString()}] `
      : `[微信 ${firstMsg.receivedAt.toISOString()}] `

    // 有文件时，将文件路径信息拼入文字，agent 可用 read 工具读取
    if (hasFiles) {
      const fileInfos = files.map(f =>
        `- 文件「${f.name}」(${(f.size / 1024).toFixed(1)} KB)，已保存到: ${f.path}`
      ).join('\n')
      const fileNote = hasText
        ? `\n\n用户通过微信发送了 ${files.length} 个文件：\n${fileInfos}`
        : `用户通过微信发送了 ${files.length} 个文件：\n${fileInfos}`
      const combinedText = timePrefix + texts.join('\n') + fileNote
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{ type: 'text', text: combinedText }]
      for (const img of images) {
        content.push({ type: 'image', data: img.data, mimeType: img.mediaType })
      }
      const deliverOpts = isBusy ? { deliverAs: 'followUp' as const } : undefined
      log(`[DRAIN-SEND] file+text, files=${files.length}, images=${images.length}, mode=${deliverOpts?.deliverAs ?? 'direct'}`)
      pi.sendUserMessage(content, deliverOpts)
    } else if (hasImages) {
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
      // 有图片但没文字时，自动加描述
      if (!hasText) {
        content.push({ type: 'text', text: timePrefix + (images.length === 1 ? '请帮我分析这张图片' : `请帮我分析这 ${images.length} 张图片`) })
      } else {
        content.push({ type: 'text', text: timePrefix + texts.join('\n') })
      }
      for (const img of images) {
        content.push({ type: 'image', data: img.data, mimeType: img.mediaType })
      }
      const deliverOpts = isBusy ? { deliverAs: 'followUp' as const } : undefined
      log(`[DRAIN-SEND] image+text, images=${images.length}, text=${hasText ? texts.join(' ').slice(0, 50) : '(auto)'}, mode=${deliverOpts?.deliverAs ?? 'direct'}, turnSeq=${turnSeq}`)
      pi.sendUserMessage(content, deliverOpts)
    } else if (hasText) {
      const deliverOpts = isBusy ? { deliverAs: 'followUp' as const } : undefined
      log(`[DRAIN-SEND] text, text=${texts.join(' ').slice(0, 80)}, mode=${deliverOpts?.deliverAs ?? 'direct'}, turnSeq=${turnSeq}`)
      pi.sendUserMessage(timePrefix + texts.join('\n'), deliverOpts)
    } else {
      // 什么都没有，跳过；给用户一个明确失败提示
      if (hadImageMessages || hadFileMessages) {
        const limitMB = Math.round(getImageMaxBytes() / 1024 / 1024)
        const msg = hadImageMessages
          ? `⚠️ 图片下载失败、格式不支持或超过大小限制（当前上限 ${limitMB}MB）。`
          : `⚠️ 文件下载失败或格式不支持。`
        await client.sendText(first.userId, msg).catch(() => {})
      }
      pendingInjection = null
      void client.stopTyping(first.userId).catch(() => {})
      drainQueue()
      return
    }

    // 文本消息在发送给 agent 后回执；图片/文件批次已在收到第一条时合并回执，避免刷屏
    if (!hadImageMessages && !hadFileMessages) {
      try {
        await client.sendText(first.userId, ACK_TEXT)
      } catch (err) {
        log(`发送回执失败: ${formatError(err)}`)
      }
    }
  }

  // 保存微信接收的文件到工作目录下的 .pi-wechat-files/
  async function saveFileToDisk(buffer: Buffer, fileName: string): Promise<string | null> {
    if (!wechatFilesDir) {
      log('文件保存失败: wechatFilesDir 未设置')
      return null
    }
    try {
      fs.mkdirSync(wechatFilesDir, { recursive: true })
      const ts = Date.now().toString(36)
      const safeName = fileName.replace(/[^\w.\-\u4e00-\u9fff]/g, '_')
      const filePath = path.join(wechatFilesDir, `${ts}_${safeName}`)
      fs.writeFileSync(filePath, buffer)
      return filePath
    } catch (err) {
      log(`文件保存失败: ${err}`)
      return null
    }
  }

  async function completeActiveRequest(
    messages: Array<{ role?: string; content?: unknown }>,
  ): Promise<void> {
    const request = activeRequest
    activeRequest = null
    completingRequest = true
    log(`[COMPLETE-ENTER] request=${!!request} requestId=${request?.id?.slice(0,8) ?? 'null'} client=${!!client} turnSeq=${turnSeq} sentCount=${assistantReplySentCount}`)

    if (!request || !client) {
      log(`[COMPLETE-SKIP] no request or client, calling drainQueue`)
      completingRequest = false
      drainQueue()
      return
    }

    // 取全部 assistant 回复，跳过已发送的
    const allReplies = extractAllAssistantReplies(messages)
    const newReplies = allReplies.slice(assistantReplySentCount)
    log(`[COMPLETE-REPLIES] all=${allReplies.length} sent=${assistantReplySentCount} new=${newReplies.length}`)
    assistantReplySentCount = allReplies.length

    try {
      if (newReplies.length > 0) {
        for (let ri = 0; ri < newReplies.length; ri++) {
          const reply = newReplies[ri]
          const chunks = splitAndFilterMarkdown(reply)
          log(`[COMPLETE-SEND] reply ${ri + 1}/${newReplies.length} userId=${request.userId} chunks=${chunks.length} preview=${reply.slice(0, 40)}`)
          for (let i = 0; i < chunks.length; i++) {
            log(`[COMPLETE-CHUNK] ${i + 1}/${chunks.length} len=${chunks[i].length} preview=${chunks[i].slice(0, 40)}`)
            await client.sendText(request.userId, chunks[i])
          }
        }
        log(`[COMPLETE-DONE] sent ${newReplies.length} replies`)
      } else {
        // 不是问题：allReplies.length > 0 说明增量发送（message_end）已经发出去了
        if (allReplies.length === 0) {
          log(`[COMPLETE-NOREPLY] no assistant text in any reply`)
          notify(`Pi 没有产出可发送的文本回复: ${request.preview}`, 'warning')
        } else {
          log(`[COMPLETE-NOREPLY-SAFE] all ${allReplies.length} replies already sent incrementally, nothing to do`)
        }
      }
    } catch (error) {
      log(`[COMPLETE-ERROR] ${formatError(error)}`)
      notify(`发送微信回复失败: ${formatError(error)}`, 'error')
    } finally {
      completingRequest = false
      await client.stopTyping(request.userId).catch(() => {})
      updateStatusBar()
      log(`[COMPLETE-DEFER] deferring drainQueue via setTimeout(0)`)
      setTimeout(() => drainQueue(), 0)
    }
  }

  // --- TUI → 微信同步 ---

  async function syncReplyToWechat(
    messages: Array<{ role?: string; content?: unknown }>,
  ): Promise<void> {
    log(`[SYNC-ENTER] client=${!!client} lastUser=${!!lastWechatUser} userId=${lastWechatUser?.userId} turnSeq=${turnSeq} sentCount=${assistantReplySentCount}`)

    if (!client || !lastWechatUser) {
      log(`[SYNC-SKIP] no client or lastWechatUser`)
      return
    }

    const allReplies = extractAllAssistantReplies(messages)
    const newReplies = allReplies.slice(assistantReplySentCount)
    log(`[SYNC-REPLIES] all=${allReplies.length} sent=${assistantReplySentCount} new=${newReplies.length}`)
    assistantReplySentCount = allReplies.length

    if (newReplies.length === 0) {
      log(`[SYNC-NOREPLY] no new replies`)
      return
    }

    try {
      for (let ri = 0; ri < newReplies.length; ri++) {
        const reply = newReplies[ri]
        const chunks = splitAndFilterMarkdown(reply)
        log(`[SYNC-SEND] reply ${ri + 1}/${newReplies.length} userId=${lastWechatUser.userId} chunks=${chunks.length} preview=${reply.slice(0, 40)}`)
        for (let i = 0; i < chunks.length; i++) {
          log(`[SYNC-CHUNK] ${i + 1}/${chunks.length} len=${chunks[i].length} preview=${chunks[i].slice(0, 40)}`)
          await client.sendText(lastWechatUser.userId, chunks[i])
        }
      }
      log(`[SYNC-DONE] sent ${newReplies.length} replies`)
    } catch (error) {
      log(`[SYNC-ERROR] ${formatError(error)}`)
    }
  }

  // 增量发送：每完成一条 assistant 回复，立即发到微信
  pi.on('message_end', async (event, ctx) => {
    if (event.message.role !== 'assistant') return
    if (!running || !client || !activeRequest) return

    const text = extractTextFromMessageContent(event.message.content)
    if (!text) {
      log(`[MSG-END-SKIP] assistant message has no text content (likely toolCall only)`)
      return
    }

    log(`[MSG-END] incremental send, userId=${activeRequest.userId} textLen=${text.length} preview=${text.slice(0, 60)} sentCount=${assistantReplySentCount}`)

    try {
      const chunks = splitAndFilterMarkdown(text)
      for (let i = 0; i < chunks.length; i++) {
        log(`[MSG-END-CHUNK] ${i + 1}/${chunks.length} len=${chunks[i].length}`)
        await client.sendText(activeRequest.userId, chunks[i])
      }
      assistantReplySentCount++
      log(`[MSG-END-DONE] incrementally sent 1 reply, totalSent=${assistantReplySentCount}`)
    } catch (err) {
      log(`[MSG-END-ERROR] ${formatError(err)}`)
    }
  })

  // --- 长轮询 ---

  async function pollMessages(activeClient: WeixinClient): Promise<void> {
    let retryDelay = POLL_RETRY_BASE_MS

    while (running && client === activeClient) {
      try {
        const messages = await activeClient.getUpdates(pollAbort?.signal)
        retryDelay = POLL_RETRY_BASE_MS

        for (const message of messages) {
          await handleIncomingMessage(message, activeClient)
        }
      } catch (error) {
        if (isAbortError(error)) break

        if (error instanceof SessionExpiredError) {
          notify('微信 Session 已过期，请执行 /wechat-login 重新登录', 'error')
          await stopBridge({ releaseLock: true })
          break
        }

        log(`轮询失败: ${formatError(error)}`)
        await delay(retryDelay)
        retryDelay = Math.min(retryDelay * 2, POLL_RETRY_MAX_MS)
      }
    }
  }

  // --- 远程命令处理 ---

  // --- 远程命令表：命令名 → 处理函数 ---
  // 每个处理函数返回发给用户的文本（null 表示不发送）
  type RemoteCommandFn = (args: string, userId: string, client: WeixinClient) => Promise<string | null>

  const remoteCommands: Record<string, RemoteCommandFn> = {
    async model(args, userId, client) {
      if (!latestCtx) return '❌ 会话上下文尚未就绪，请稍后再试'
      const registry = latestCtx.modelRegistry
      if (!args) {
        const models = registry.getAvailable()
        const current = latestCtx.model ? `${latestCtx.model.provider}/${latestCtx.model.id}` : 'unknown'
        const lines = [`当前模型: ${current}`, '', '可用模型:']
        const seen = new Set<string>()
        for (const m of models) {
          const key = `${m.provider}/${m.id}`
          if (seen.has(key)) continue
          seen.add(key)
          lines.push(`  ${key}${key === current ? ' ←' : ''}`)
        }
        return lines.join('\n')
      }
      let model
      if (args.includes('/')) {
        const [provider, ...idParts] = args.split('/')
        model = registry.find(provider, idParts.join('/'))
      } else {
        for (const m of registry.getAvailable()) {
          if (m.id === args || m.id.includes(args)) { model = m; break }
        }
      }
      if (!model) return `❌ 未找到模型: ${args}\n输入 /model 查看可用列表`
      const success = await pi.setModel(model)
      return success
        ? `✅ 已切换模型: ${model.provider}/${model.id}`
        : `❌ 切换失败: ${model.provider}/${model.id} 没有可用的 API key`
    },

    async thinking(args, _userId, _client) {
      const valid = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
      if (!args) return `当前 thinking level: ${pi.getThinkingLevel()}\n可选: ${valid.join(', ')}`
      if (valid.includes(args)) {
        pi.setThinkingLevel(args as any)
        return `✅ thinking level 已设为: ${args}`
      }
      return `❌ 无效 level: ${args}\n可选: ${valid.join(', ')}`
    },

    async tools(args, _userId, _client) {
      if (!args) {
        const active = pi.getActiveTools()
        const all = pi.getAllTools().map(t => t.name)
        const lines = ['活跃工具:', ...active.map(t => `  ✅ ${t}`), '', '全部工具:']
        for (const t of all) lines.push(`  ${active.includes(t) ? '✅' : '⬜'} ${t}`)
        return lines.join('\n')
      }
      const toolNames = args.split(/[,\s]+/).filter(Boolean)
      const allNames = pi.getAllTools().map(t => t.name)
      const invalid = toolNames.filter(t => !allNames.includes(t))
      if (invalid.length > 0) return `❌ 未知工具: ${invalid.join(', ')}\n输入 /tools 查看全部`
      const valid = toolNames.filter(t => allNames.includes(t))
      pi.setActiveTools(valid)
      return `✅ 活跃工具已设为: ${valid.join(', ')}`
    },

    async compact(_args, userId, client) {
      if (!latestCtx) return '❌ 会话上下文尚未就绪'
      latestCtx.compact({
        onComplete: () => { void client.sendText(userId, '✅ 上下文压缩完成') },
        onError: (error) => { void client.sendText(userId, `❌ 压缩失败: ${error.message}`) },
      })
      return '⏳ 正在压缩上下文...'
    },

    async stop(_args, userId, _client) {
      if (!latestCtx) return '❌ 会话上下文尚未就绪'
      if (latestCtx.isIdle()) return '当前没有在执行任务'
      latestCtx.abort()
      return '✅ 已发送停止信号'
    },

    async status(_args, _userId, _client) {
      if (!latestCtx) return '❌ 会话上下文尚未就绪'
      const lines: string[] = []

      // 模型和配置
      if (latestCtx.model) lines.push(`模型: ${latestCtx.model.provider}/${latestCtx.model.id}`)
      lines.push(`Thinking: ${pi.getThinkingLevel()}`)
      lines.push(`工具数: ${pi.getActiveTools().length}`)
      lines.push(`排队消息: ${queue.length}`)

      // 消息/Token 统计：从最近一次压缩后开始计算
      const branch = latestCtx.sessionManager.getBranch()
      let startIndex = 0
      for (let i = branch.length - 1; i >= 0; i--) {
        if (branch[i].type === 'compaction') { startIndex = i + 1; break }
      }
      let userMsgs = 0, assistantMsgs = 0, toolCalls = 0, toolResults = 0
      let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCost = 0
      for (let i = startIndex; i < branch.length; i++) {
        const entry = branch[i]
        if (entry.type !== 'message') continue
        const msg = (entry as { message?: { role?: string; content?: Array<{ type: string }>; usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } } }).message
        if (!msg) continue
        if (msg.role === 'user') userMsgs++
        else if (msg.role === 'assistant') {
          assistantMsgs++
          totalInput += msg.usage?.input ?? 0
          totalOutput += msg.usage?.output ?? 0
          totalCacheRead += msg.usage?.cacheRead ?? 0
          totalCost += msg.usage?.cost?.total ?? 0
          toolCalls += (msg.content ?? []).filter((c: { type: string }) => c.type === 'toolCall').length
        } else if (msg.role === 'toolResult') toolResults++
      }
      const totalMsgs = userMsgs + assistantMsgs + toolResults
      if (totalMsgs > 0) {
        lines.push(`消息: ${userMsgs}u / ${assistantMsgs}a / ${toolCalls}tc / ${toolResults}tr = ${totalMsgs}`)
        lines.push(`Token: ${(totalInput + totalOutput + totalCacheRead).toLocaleString()} (in ${totalInput.toLocaleString()} + out ${totalOutput.toLocaleString()} + cache ${totalCacheRead.toLocaleString()})`)
      }
      if (totalCost > 0) lines.push(`费用: $${totalCost.toFixed(4)}`)
      if (startIndex > 0) lines.push('(数据从最近一次压缩后开始计算)')

      // 上下文用量
      const usage = latestCtx.getContextUsage()
      if (usage) {
        if (usage.tokens != null) {
          const pct = usage.percent != null ? ` (${usage.percent}%)` : ''
          lines.push(`上下文: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens${pct}`)
        } else {
          // 压缩后 tokens 为 null，用分支统计的 token 数作为降级估算
          const estimated = totalInput + totalOutput + totalCacheRead
          if (estimated > 0) {
            lines.push(`上下文: ~${estimated.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (压缩后估算)`)
          } else {
            lines.push(`上下文: 待首次回复 / ${usage.contextWindow.toLocaleString()} tokens`)
          }
        }
      }

      // 微信配置
      lines.push(`图片等待: ${getImageBatchWaitMs() / 1000}s | 上限: ${Math.round(getImageMaxBytes() / 1024 / 1024)}MB`)
      return lines.join('\n')
    },

    async config(_args, _userId, _client) {
      return [
        `图片合并等待: ${getImageBatchWaitMs()}ms`,
        `图片上限: ${getImageMaxBytes()} bytes (${Math.round(getImageMaxBytes() / 1024 / 1024)}MB)`,
        '可在 config.json 或环境变量中调整：',
        'PI_WECHAT_IMAGE_BATCH_WAIT_MS',
        'PI_WECHAT_IMAGE_MAX_BYTES',
      ].join('\n')
    },

    async name(args, _userId, _client) {
      if (!args) {
        const current = pi.getSessionName()
        return current ? `当前会话名称: ${current}\n输入 /name <新名称> 来修改` : '当前会话未命名\n输入 /name <名称> 来设置'
      }
      pi.setSessionName(args)
      return `✅ 会话名称已设为: ${args}`
    },

    async session(_args, _userId, _client) {
      if (!latestCtx) return '❌ 会话上下文尚未就绪'
      const sm = latestCtx.sessionManager
      const lines: string[] = []

      // 文件路径（截断显示）
      const file = sm.getSessionFile()
      if (file) {
        const display = file.length > 60 ? '...' + file.slice(-57) : file
        lines.push(`文件: ${display}`)
      }
      lines.push(`会话 ID: ${sm.getSessionId()}`)

      // 只统计当前分支（与 TUI /session 一致）
      const branch = sm.getBranch()
      let userCount = 0, assistantCount = 0, toolCallCount = 0, toolResultCount = 0, messageCount = 0
      let totalInput = 0, totalOutput = 0, totalCacheRead = 0
      let totalCost = 0

      for (const entry of branch) {
        if (entry.type !== 'message') continue
        messageCount++
        const msg = (entry as { message?: { role?: string; content?: unknown[]; usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } } }).message
        if (!msg) continue
        switch (msg.role) {
          case 'user':
            userCount++
            break
          case 'assistant': {
            assistantCount++
            // tool call 内嵌在 assistant content 中
            if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if ((part as { type?: string }).type === 'toolCall') toolCallCount++
              }
            }
            if (msg.usage) {
              totalInput += msg.usage.input ?? 0
              totalOutput += msg.usage.output ?? 0
              totalCacheRead += msg.usage.cacheRead ?? 0
              totalCost += msg.usage.cost?.total ?? 0
            }
            break
          }
          case 'toolResult':
            toolResultCount++
            break
        }
      }

      lines.push('')
      lines.push('Messages')
      lines.push(` User: ${userCount}`)
      lines.push(` Assistant: ${assistantCount}`)
      lines.push(` Tool Calls: ${toolCallCount}`)
      lines.push(` Tool Results: ${toolResultCount}`)
      lines.push(` Total: ${messageCount}`)

      if (totalInput > 0 || totalOutput > 0) {
        const totalTokens = totalInput + totalOutput + totalCacheRead
        lines.push('')
        lines.push('Tokens')
        lines.push(` Input: ${totalInput.toLocaleString()}`)
        lines.push(` Output: ${totalOutput.toLocaleString()}`)
        if (totalCacheRead > 0) lines.push(` Cache Read: ${totalCacheRead.toLocaleString()}`)
        lines.push(` Total: ${totalTokens.toLocaleString()}`)
      }

      if (totalCost > 0) {
        lines.push('')
        lines.push('Cost')
        lines.push(` Total: $${totalCost.toFixed(3)}`)
      }

      return lines.join('\n')
    },

    async help(_args, _userId, _client) {
      return [
        '📋 微信远程命令:',
        '',
        '/status          查看当前状态',
        '/stop            停止当前生成',
        '/model           查看 / 切换模型',
        '/name <名称>     设置会话名称',
        '/session         查看会话详情',
        '/config          查看图片相关配置',
        '/help            显示帮助',
        '',
        '高级: /thinking, /tools, /compact',
        '直接发文字、语音、图片 = 正常对话',
      ].join('\n')
    },
  }

  async function handleRemoteCommand(
    text: string,
    userId: string,
    activeClient: WeixinClient,
  ): Promise<boolean> {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) return false

    const [cmd, ...rest] = trimmed.slice(1).split(/\s+/)
    const args = rest.join(' ')

    const handler = remoteCommands[cmd]
    if (!handler) return false

    try {
      const reply = await handler(args, userId, activeClient)
      if (reply !== null) {
        await activeClient.sendText(userId, reply)
      }
    } catch (err) {
      log(`远程命令 /${cmd} 执行失败: ${formatError(err)}`)
      await activeClient.sendText(userId, `❌ 命令执行失败: ${formatError(err)}`).catch(() => {})
    }
    return true
  }

  // --- 单条消息处理 ---

  async function handleIncomingMessage(message: IncomingMessage, activeClient: WeixinClient): Promise<void> {
    log(`收到消息: type=${message.type}, text=${message.text?.slice(0, 50)}, imageUrl=${redactUrl(message.imageUrl)}, imageAesKey=${message.imageAesKey ? 'provided' : 'none'}`)
    
    // 不支持的类型 → 直接回复告知
    if (UNSUPPORTED_TYPES.has(message.type)) {
      const reply = UNSUPPORTED_REPLY[message.type] ?? UNSUPPORTED_REPLY['unknown']
      try {
        activeClient.rememberContext(message.raw)
        await activeClient.sendText(message.userId, reply)
      } catch (err) {
        log(`回复不支持类型消息失败: ${formatError(err)}`)
      }
      return
    }

    // 远程命令拦截
    if (message.text.startsWith('/')) {
      activeClient.rememberContext(message.raw)
      const handled = await handleRemoteCommand(message.text, message.userId, activeClient)
      if (handled) return
      // 未识别的 / 命令 → 当普通消息处理
    }

    // 支持的消息 → 入队（回执在发送给 agent 后发送）
    enqueueMessage(message)
  }

  // ============================================================================
  // 命令注册
  // ============================================================================

  // --- 子命令处理函数 ---

  async function cmdLogin(args: string, ctx: Ctx): Promise<void> {
    latestCtx = ctx
    const force = args.split(/\s+/).includes('--force')

    if (!force) {
      const cached = loadClient()
      if (cached) {
        notify(`已加载本地微信凭证: ${getCredentialsPath()}`, 'info')
        return
      }
    }

    if (running) {
      await stopBridge({ releaseLock: true })
    }

    let currentBaseUrl: string | undefined

    try {
      const qr = await getQrCode(currentBaseUrl)
      const qrText = await renderQrCode(qr.url)
      notify(`请用微信扫码登录：\n\n${qrText}\n\n二维码链接：${qr.url}`, 'info')

      let lastStatus: string | null = null
      let refreshCount = 0

      while (true) {
        await delay(QR_POLL_INTERVAL_MS)
        const result = await pollQrStatus(qr.token, currentBaseUrl)

        if (result.redirectHost) {
          currentBaseUrl = `https://${result.redirectHost}`
          log(`重定向到: ${currentBaseUrl}`)
        }

        if (result.status === lastStatus) continue
        lastStatus = result.status

        if (result.status === 'scaned') {
          notify('已扫码，请在手机上确认登录', 'info')
          continue
        }

        if (result.status === 'confirmed' && result.credentials) {
          saveCredentials(result.credentials)
          client = new WeixinClient(result.credentials)
          notify('微信登录成功 ✅', 'info')
          updateStatusBar()
          return
        }

        if (result.status === 'expired') {
          refreshCount++
          if (refreshCount >= QR_MAX_REFRESH) {
            notify(`二维码多次过期，请重新执行 /wechat login`, 'error')
            return
          }
          notify(`二维码已过期，正在刷新 (${refreshCount}/${QR_MAX_REFRESH})...`, 'info')
          const newQr = await getQrCode(currentBaseUrl)
          qr.token = newQr.token
          const newQrText = await renderQrCode(newQr.url)
          notify(`请重新扫码：\n\n${newQrText}\n\n二维码链接：${newQr.url}`, 'info')
          lastStatus = null
          continue
        }

        if (result.status === 'scaned_but_redirect') continue
      }
    } catch (error) {
      notify(`微信登录失败: ${formatError(error)}`, 'error')
    }
  }

  async function cmdStart(_args: string, ctx: Ctx): Promise<void> {
    latestCtx = ctx
    const activeClient = loadClient()
    if (!activeClient) {
      notify('未找到微信凭证，请先执行 /wechat login', 'error')
      return
    }
    if (running) {
      notify('微信桥接已经在运行', 'info')
      return
    }
    const lockResult = lock()
    if (!lockResult.success) {
      notify(lockResult.message, 'error')
      return
    }
    running = true
    agentIdle = true
    pollAbort = new AbortController()
    notify('微信桥接已启动 📱', 'info')
    updateStatusBar()
    void pollMessages(activeClient).finally(() => {
      if (pollAbort?.signal.aborted) pollAbort = null
    })
  }

  async function cmdStop(_args: string, ctx: Ctx): Promise<void> {
    latestCtx = ctx
    await stopBridge({ releaseLock: true })
    notify('微信桥接已停止', 'info')
    updateStatusBar()
  }

  async function cmdStatus(_args: string, ctx: Ctx): Promise<void> {
    latestCtx = ctx
    const activeClient = client ?? loadClient()
    const lines = [
      `运行状态: ${running ? '✅ 运行中' : '⏸ 已停止'}`,
      `凭证状态: ${activeClient ? '✅ 已登录' : '❌ 未登录'}`,
      `账号 ID: ${activeClient?.accountId ?? '-'}`,
      `用户 ID: ${activeClient?.userId ?? '-'}`,
      `排队消息: ${queue.length}`,
      `凭证路径: ${getCredentialsPath()}`,
      `自动启动: ${loadConfig().autoStart ? '已开启' : '已关闭'}`,
      `图片合并等待: ${getImageBatchWaitMs()}ms`,
      `图片上限: ${Math.round(getImageMaxBytes() / 1024 / 1024)}MB`,
    ]
    notify(lines.join('\n'), 'info')
  }

  async function cmdLogout(_args: string, ctx: Ctx): Promise<void> {
    latestCtx = ctx
    await stopBridge({ releaseLock: true })
    clearCredentials()
    client = null
    notify(`已清除微信凭证: ${getCredentialsPath()}`, 'info')
    updateStatusBar()
  }

  async function cmdConfig(args: string, ctx: Ctx): Promise<void> {
    latestCtx = ctx
    const [key, value] = args.trim().split(/\s+/)
    const config = loadConfig()

    if (!key) {
      notify([
        `自动启动: ${config.autoStart ? '已开启' : '已关闭'}`,
        `图片合并等待: ${getImageBatchWaitMs()}ms`,
        `图片上限: ${Math.round(getImageMaxBytes() / 1024 / 1024)}MB`,
        '',
        '用法:',
        '/wechat config image-wait 8000',
        '/wechat config image-max 50',
      ].join('\n'), 'info')
      return
    }

    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) {
      notify('配置值必须是正数', 'error')
      return
    }

    if (key === 'image-wait') {
      config.imageBatchWaitMs = Math.min(Math.max(Math.round(numeric), 0), 60_000)
    } else if (key === 'image-max') {
      config.imageMaxBytes = Math.round(numeric * 1024 * 1024)
    } else {
      notify('未知配置项。支持: image-wait, image-max', 'error')
      return
    }

    saveConfig(config)
    notify('微信桥接配置已更新 ✅', 'info')
  }

  async function cmdAutostart(_args: string, ctx: Ctx): Promise<void> {
    latestCtx = ctx
    const config = loadConfig()
    config.autoStart = !config.autoStart
    saveConfig(config)
    notify(`自动启动已${config.autoStart ? '开启 ✅' : '关闭 ❌'}`, 'info')
  }

  // --- /wechat 总命令 ---

  pi.registerCommand('wechat', {
    description: '微信桥接管理：login | start | stop | status | config | logout | autostart',
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/)
      const restArgs = rest.join(' ')

      const help = [
        '/wechat login             扫码登录',
        '/wechat login --force     强制重新扫码',
        '/wechat start             启动桥接',
        '/wechat stop              停止桥接',
        '/wechat status            查看状态',
        '/wechat config            查看/设置配置',
        '/wechat logout            清除凭证并停止',
        '/wechat autostart         开关自动启动',
      ].join('\n')

      switch (sub) {
        case 'login':       return cmdLogin(restArgs, ctx)
        case 'start':       return cmdStart(restArgs, ctx)
        case 'stop':        return cmdStop(restArgs, ctx)
        case 'status':      return cmdStatus(restArgs, ctx)
        case 'config':      return cmdConfig(restArgs, ctx)
        case 'logout':      return cmdLogout(restArgs, ctx)
        case 'autostart':   return cmdAutostart(restArgs, ctx)
        default:
          notify(`未知子命令: ${sub || '(无)'}\n\n${help}`, 'warning')
      }
    },
  })

  // --- send_file tool: AI 可直接调用发文件到微信 ---
  pi.registerTool({
    name: 'send_file_to_wechat',
    label: 'Send File to WeChat',
    description: '发送文件到当前微信对话。用于将 AI 产出的代码、报告、图片等文件直接发给微信用户。',
    promptSnippet: '发送指定路径的文件到微信',
    promptGuidelines: [
      '当用户通过微信要求产出文件时，先写入文件再用 send_file_to_wechat 发送。',
      'send_file_to_wechat 需要微信桥接处于 start 状态，并且用户曾发送过消息（建立了 context_token）。',
      '如果发送失败，工具会返回错误信息。不要重试超过 1 次。',
    ],
    parameters: Type.Object({
      filePath: Type.String({ description: '要发送的文件路径（绝对路径或相对路径）' }),
      fileName: Type.Optional(Type.String({ description: '在微信中显示的文件名（可选，默认使用原文件名）' })),
    }),
    async execute(_toolCallId, params, _signal) {
      if (!client) {
        return { content: [{ type: 'text', text: '❌ 微信未登录，请先在 TUI 执行 /wechat login 和 /wechat start' }], details: {} }
      }
      if (!running) {
        return { content: [{ type: 'text', text: '❌ 微信桥接未启动，请先在 TUI 执行 /wechat start' }], details: {} }
      }
      if (!lastWechatUser) {
        return { content: [{ type: 'text', text: '❌ 尚未收到微信用户消息，无法获取 context_token。请先让微信用户发送一条消息。' }], details: {} }
      }
      // 解析文件路径（相对于当前工作目录）
      const cwd = latestCtx?.cwd ?? process.cwd()
      const resolvedPath = path.isAbsolute(params.filePath) ? params.filePath : path.join(cwd, params.filePath)
      if (!fs.existsSync(resolvedPath)) {
        return { content: [{ type: 'text', text: `❌ 文件不存在: ${resolvedPath}` }], details: {} }
      }
      try {
        const stats = fs.statSync(resolvedPath)
        if (stats.size > 50 * 1024 * 1024) {
          return { content: [{ type: 'text', text: `❌ 文件过大 (${(stats.size / 1024 / 1024).toFixed(1)}MB)，上限 50MB` }], details: {} }
        }
        await client.sendFile(lastWechatUser.userId, resolvedPath, params.fileName)
        const name = params.fileName ?? path.basename(resolvedPath)
        return { content: [{ type: 'text', text: `✅ 文件「${name}」(${(stats.size / 1024).toFixed(1)} KB) 已发送到微信` }], details: {} }
      } catch (err) {
        log(`send_file_to_wechat 失败: ${formatError(err)}`)
        return { content: [{ type: 'text', text: `❌ 发送失败: ${formatError(err)}` }], details: {} }
      }
    },
  })

  // --- send_image_to_wechat tool: AI 可直接发图片到微信 ---
  pi.registerTool({
    name: 'send_image_to_wechat',
    label: 'Send Image to WeChat',
    description: '发送图片到当前微信对话。用于将 AI 生成的图表、截图等图片直接发给微信用户，用户可在微信中直接预览。',
    promptSnippet: '发送指定路径的图片到微信（可预览）',
    promptGuidelines: [
      '当用户通过微信要求生成图表/截图/图片时，先生成图片文件再用 send_image_to_wechat 发送。',
      'send_image_to_wechat 需要微信桥接处于 start 状态，并且用户曾发送过消息。',
      '如果发送失败不要重试超过 1 次。',
    ],
    parameters: Type.Object({
      imagePath: Type.String({ description: '要发送的图片路径（绝对路径或相对路径，支持 png/jpg/gif/webp）' }),
    }),
    async execute(_toolCallId, params, _signal) {
      if (!client) {
        return { content: [{ type: 'text', text: '❌ 微信未登录，请先在 TUI 执行 /wechat login 和 /wechat start' }], details: {} }
      }
      if (!running) {
        return { content: [{ type: 'text', text: '❌ 微信桥接未启动，请先在 TUI 执行 /wechat start' }], details: {} }
      }
      if (!lastWechatUser) {
        return { content: [{ type: 'text', text: '❌ 尚未收到微信用户消息，无法获取 context_token。请先让微信用户发送一条消息。' }], details: {} }
      }
      const cwd = latestCtx?.cwd ?? process.cwd()
      const resolvedPath = path.isAbsolute(params.imagePath) ? params.imagePath : path.join(cwd, params.imagePath)
      if (!fs.existsSync(resolvedPath)) {
        return { content: [{ type: 'text', text: `❌ 图片不存在: ${resolvedPath}` }], details: {} }
      }
      try {
        const stats = fs.statSync(resolvedPath)
        if (stats.size > 50 * 1024 * 1024) {
          return { content: [{ type: 'text', text: `❌ 图片过大 (${(stats.size / 1024 / 1024).toFixed(1)}MB)，上限 50MB` }], details: {} }
        }
        await client.sendImage(lastWechatUser.userId, resolvedPath)
        return { content: [{ type: 'text', text: `✅ 图片 (${(stats.size / 1024).toFixed(1)} KB) 已发送到微信` }], details: {} }
      } catch (err) {
        log(`send_image_to_wechat 失败: ${formatError(err)}`)
        return { content: [{ type: 'text', text: `❌ 发送失败: ${formatError(err)}` }], details: {} }
      }
    },
  })

  // ============================================================================
  // 事件处理
  // ============================================================================

  // 会话启动
  pi.on('session_start', async (_event, ctx) => {
    latestCtx = ctx
    wechatFilesDir = path.join(ctx.cwd, WECHAT_FILES_SUBDIR)
    client ??= loadClient()
    updateStatusBar()

    // 自动启动
    const config = loadConfig()
    if (config.autoStart && client) {
      const lockResult = lock()
      if (lockResult.success) {
        running = true
        agentIdle = true
        pollAbort = new AbortController()
        notify('微信桥接已自动启动 📱', 'info')
        updateStatusBar()
        void pollMessages(client).finally(() => {
          if (pollAbort?.signal.aborted) pollAbort = null
        })
      } else {
        log(`自动启动失败: ${lockResult.message}`)
      }
    }
  })

  // TUI 输入同步到微信：单用户个人助手场景下，让微信端也能看到桌面端发起了什么
  pi.on('input', async (event, ctx) => {
    latestCtx = ctx
    if (!running || !client || !lastWechatUser) {
      log(`[INPUT-SKIP] running=${running} client=${!!client} lastUser=${!!lastWechatUser}`)
      return
    }
    if (event.source === 'extension') {
      log(`[INPUT-SKIP] source=extension`)
      return
    }

    const text = event.text?.trim()
    if (!text || text.startsWith('/')) {
      log(`[INPUT-SKIP] empty or command: ${text?.slice(0, 20)}`)
      return
    }

    const imageNote = event.images?.length ? `\n[附带 ${event.images.length} 张图片]` : ''
    const preview = summarizePreview(text)
    log(`[INPUT-SYNC] syncing TUI input to WeChat: ${preview}${imageNote}`)
    await client.sendText(lastWechatUser.userId, `💻 TUI 发送：${preview}${imageNote}`).catch(err => {
      log(`[INPUT-SYNC-FAIL] ${formatError(err)}`)
    })
  })

  // 注入系统提示词（仅微信指令，时间戳拼到用户消息中以保持 system prompt 稳定）
  pi.on('before_agent_start', async (event, ctx) => {
    latestCtx = ctx
    const request = pendingInjection ?? activeRequest
    log(`[BEFORE-AGENT] turnSeq=${turnSeq} pendingInjection=${pendingInjection?.id?.slice(0,8) ?? 'null'} activeRequest=${activeRequest?.id?.slice(0,8) ?? 'null'} willInject=${!!request}`)
    if (!request) return
    const injectedPrompt = buildSystemPrompt(event.systemPrompt)
    log(`[BEFORE-AGENT-INJECT] injecting wechat system prompt (${injectedPrompt.length} chars)`)
    return { systemPrompt: injectedPrompt }
  })

  // agent 开始
  pi.on('agent_start', async (_event, ctx) => {
    turnSeq++
    latestCtx = ctx
    agentIdle = false
    currentTurnActiveRequest = null
    if (pendingInjection) {
      activeRequest = pendingInjection
      currentTurnActiveRequest = pendingInjection
      log(`[AGENT-START] turn#${turnSeq} source=WECHAT pendingInjection.id=${pendingInjection.id.slice(0,8)} activeRequest set, pendingInjection cleared`)
      pendingInjection = null
    } else {
      log(`[AGENT-START] turn#${turnSeq} source=TUI (no pendingInjection), activeRequest=${activeRequest?.id?.slice(0,8) ?? 'null'}`)
      // TUI 新对话：重置微信回复计数
      if (!activeRequest) assistantReplySentCount = 0
    }
  })

  // agent 结束 → 发回微信
  pi.on('agent_end', async (event, ctx) => {
    latestCtx = ctx
    agentIdle = true
    const turnActiveReq = currentTurnActiveRequest
    const msgCount = (event.messages as Array<{ role?: string }>).length
    const assistantMsgs = (event.messages as Array<{ role?: string }>).filter(m => m?.role === 'assistant').length
    log(`[AGENT-END] turn#${turnSeq} activeRequest=${activeRequest?.id?.slice(0,8) ?? 'null'} turnActiveReq=${turnActiveReq?.id?.slice(0,8) ?? 'null'} running=${running} client=${!!client} lastUser=${!!lastWechatUser} totalMessages=${msgCount} assistantMessages=${assistantMsgs}`)

    if (activeRequest) {
      log(`[AGENT-END-ROUTE] has activeRequest → completeActiveRequest`)
      await completeActiveRequest(event.messages as Array<{ role?: string; content?: unknown }>)
    } else if (running && client && lastWechatUser) {
      log(`[AGENT-END-ROUTE] no activeRequest, running+client+lastUser → syncReplyToWechat`)
      await syncReplyToWechat(event.messages as Array<{ role?: string; content?: unknown }>)
    } else {
      log(`[AGENT-END-ROUTE] no route matched (activeRequest=${!!activeRequest} running=${running} client=${!!client} lastUser=${!!lastWechatUser})`)
    }
  })

  // 会话关闭
  pi.on('session_shutdown', async (_event, ctx) => {
    latestCtx = ctx
    await stopBridge({ releaseLock: true })
  })
}

// ============================================================================
// 工具函数
// ============================================================================

async function renderQrCode(url: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true }, (code) => resolve(code))
  })
}

function extractAllAssistantReplies(
  messages: Array<{ role?: string; content?: unknown }>,
): string[] {
  const replies: string[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue

    debugLog(`extractAllAssistantReplies: message[${i}] content type=${typeof message.content}, isArray=${Array.isArray(message.content)}`)

    if (typeof message.content === 'string') {
      const text = message.content.trim()
      if (text) replies.push(text)
      continue
    }

    if (!Array.isArray(message.content)) {
      debugLog(`extractAllAssistantReplies: content is not array, skipping`)
      continue
    }

    debugLog(`extractAllAssistantReplies: content array length=${message.content.length}`)
    for (const part of message.content) {
      debugLog(`extractAllAssistantReplies: part type=${(part as any)?.type}`)
    }

    const text = message.content
      .filter(
        (part): part is { type: 'text'; text: string } =>
          typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text',
      )
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim()

    debugLog(`extractAllAssistantReplies: extracted text length=${text.length}`)
    if (text) replies.push(text)
  }
  return replies
}

/** 从单条消息的 content 中提取纯文本，无文本则返回 null */
function extractTextFromMessageContent(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null
  if (!Array.isArray(content)) return null
  const text = content
    .filter((part): part is { type: 'text'; text: string } =>
      typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text',
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
  return text || null
}

function summarizePreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= PREVIEW_LIMIT ? normalized : `${normalized.slice(0, PREVIEW_LIMIT - 1)}…`
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
