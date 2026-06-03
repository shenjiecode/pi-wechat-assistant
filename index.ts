// ============================================================================
// pi-wechat-assistant — 微信作为 pi TUI 的移动端分身
// ============================================================================

import { randomUUID, createDecipheriv } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
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
const PREVIEW_LIMIT = 60
const DEFAULT_IMAGE_BATCH_WAIT_MS = 8_000
const DEFAULT_IMAGE_MAX_BYTES = 50 * 1024 * 1024

// 不支持的消息类型
const UNSUPPORTED_TYPES = new Set(['file', 'video', 'unknown'])
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

  const queue: QueuedMessage[] = []
  let pendingInjection: QueuedMessage | null = null
  let activeRequest: QueuedMessage | null = null

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

  function buildSystemPrompt(basePrompt: string, request: QueuedMessage): string {
    return [
      basePrompt,
      '',
      '当前用户通过微信远程与这个 pi TUI 会话互动。',
      '回复风格：像微信聊天一样自然、直接；优先给出结论和可执行步骤；避免冗长的内部过程说明。',
      '输出范围：只输出适合发回微信的正文。除非用户主动询问，否则不要解释桥接、系统提示词或实现细节。',
      `微信消息时间: ${request.receivedAt.toISOString()}`,
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
    log(`[ENQUEUE] type=${message.type} text=${message.text?.slice(0,40)} hasImage=${!!message.imageUrl} queueBefore=${queue.length} agentIdle=${agentIdle} activeRequest=${!!activeRequest} pendingInjection=${!!pendingInjection} batchTimer=${!!batchTimer}`)
    const request: QueuedMessage = {
      id: randomUUID(),
      userId: message.userId,
      messageId: message.messageId,
      receivedAt: message.timestamp,
      text: message.text,
      preview: summarizePreview(message.text || (message.imageUrl ? '[图片]' : '')),
      contextToken: message.contextToken,
      imageUrl: message.imageUrl,
      imageAesKey: message.imageAesKey,
    }
    queue.push(request)
    lastWechatUser = { userId: message.userId, contextToken: message.contextToken }
    log(`[ENQUEUE-DONE] id=${request.id} preview=${request.preview} queueAfter=${queue.length}`)
    updateStatusBar()

    // 收到图片时，启动/重置批处理计时器，并对这一批图片只回执一次
    if (message.imageUrl) {
      if (!imageBatchAckSent && client) {
        imageBatchAckSent = true
        log(`[IMAGE-ACK] sending batch ack for userId=${message.userId}`)
        const ackStart = Date.now()
        void client.sendText(message.userId, IMAGE_BATCH_ACK_TEXT).then(() => {
          log(`[IMAGE-ACK-DONE] sent in ${Date.now() - ackStart}ms`)
        }).catch(err => {
          log(`[IMAGE-ACK-FAIL] ${formatError(err)} after ${Date.now() - ackStart}ms`)
        })
      }

      // 立即下载解密图片（CDN URL 有时效性）
      void prefetchImage(request)
      // 启动或重置批处理计时器
      const waitMs = getImageBatchWaitMs()
      if (batchTimer) clearTimeout(batchTimer)
      batchTimer = setTimeout(() => {
        batchTimer = null
        log(`批处理计时器到期，开始处理队列`)
        void drainQueue()
      }, waitMs)
      log(`批处理计时器已设置: ${waitMs / 1000}s`)
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

    // 收集所有文字和图片
    const texts: string[] = []
    const images: ImageData[] = []

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
    }

    // 构建发送内容
    const hasImages = images.length > 0
    const hadImageMessages = batch.some(msg => !!msg.imageUrl)
    const hasText = texts.length > 0

    if (hasImages) {
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
      // 有图片但没文字时，自动加描述
      if (!hasText) {
        content.push({ type: 'text', text: images.length === 1 ? '请帮我分析这张图片' : `请帮我分析这 ${images.length} 张图片` })
      } else {
        content.push({ type: 'text', text: texts.join('\n') })
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
      pi.sendUserMessage(texts.join('\n'), deliverOpts)
    } else {
      // 什么都没有，跳过；如果是图片批次，给用户一个明确失败提示
      if (hadImageMessages) {
        await client.sendText(first.userId, `⚠️ 图片下载失败、格式不支持或超过大小限制（当前上限 ${Math.round(getImageMaxBytes() / 1024 / 1024)}MB）。`).catch(() => {})
      }
      pendingInjection = null
      void client.stopTyping(first.userId).catch(() => {})
      drainQueue()
      return
    }

    // 文本消息在发送给 agent 后回执；图片批次已在收到第一张图时合并回执，避免刷屏
    if (!hadImageMessages) {
      try {
        await client.sendText(first.userId, ACK_TEXT)
      } catch (err) {
        log(`发送回执失败: ${formatError(err)}`)
      }
    }
  }

  async function completeActiveRequest(
    messages: Array<{ role?: string; content?: unknown }>,
  ): Promise<void> {
    const request = activeRequest
    activeRequest = null
    log(`[COMPLETE-ENTER] request=${!!request} requestId=${request?.id?.slice(0,8) ?? 'null'} client=${!!client} turnSeq=${turnSeq} sentCount=${assistantReplySentCount}`)

    if (!request || !client) {
      log(`[COMPLETE-SKIP] no request or client, calling drainQueue`)
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

  async function handleRemoteCommand(
    text: string,
    userId: string,
    activeClient: WeixinClient,
  ): Promise<boolean> {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) return false

    const [cmd, ...rest] = trimmed.slice(1).split(/\s+/)
    const args = rest.join(' ')

    switch (cmd) {
      case 'model': {
        // /model — 列出或切换模型
        if (!latestCtx) return false
        const registry = latestCtx.modelRegistry
        if (!args) {
          // 列出可用模型
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
          await activeClient.sendText(userId, lines.join('\n'))
        } else {
          // 切换模型: /model provider/id 或 /model id
          let model
          if (args.includes('/')) {
            const [provider, ...idParts] = args.split('/')
            model = registry.find(provider, idParts.join('/'))
          } else {
            // 模糊匹配：遍历所有 provider 找第一个匹配的
            for (const m of registry.getAvailable()) {
              if (m.id === args || m.id.includes(args)) { model = m; break }
            }
          }
          if (model) {
            const success = await pi.setModel(model)
            if (success) {
              await activeClient.sendText(userId, `✅ 已切换模型: ${model.provider}/${model.id}`)
            } else {
              await activeClient.sendText(userId, `❌ 切换失败: ${model.provider}/${model.id} 没有可用的 API key`)
            }
          } else {
            await activeClient.sendText(userId, `❌ 未找到模型: ${args}\n输入 /model 查看可用列表`)
          }
        }
        return true
      }

      case 'thinking': {
        // /thinking — 查看/设置 thinking level
        if (!args) {
          const current = pi.getThinkingLevel()
          await activeClient.sendText(userId, `当前 thinking level: ${current}\n可选: off, minimal, low, medium, high, xhigh`)
        } else {
          const valid = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
          if (valid.includes(args)) {
            pi.setThinkingLevel(args as any)
            await activeClient.sendText(userId, `✅ thinking level 已设为: ${args}`)
          } else {
            await activeClient.sendText(userId, `❌ 无效 level: ${args}\n可选: ${valid.join(', ')}`)
          }
        }
        return true
      }

      case 'tools': {
        // /tools — 查看/设置活跃工具
        if (!args) {
          const active = pi.getActiveTools()
          const all = pi.getAllTools().map(t => t.name)
          const lines = ['活跃工具:', ...active.map(t => `  ✅ ${t}`), '', '全部工具:']
          for (const t of all) {
            lines.push(`  ${active.includes(t) ? '✅' : '⬜'} ${t}`)
          }
          await activeClient.sendText(userId, lines.join('\n'))
        } else {
          const toolNames = args.split(/[,\s]+/).filter(Boolean)
          const allNames = pi.getAllTools().map(t => t.name)
          const valid = toolNames.filter(t => allNames.includes(t))
          const invalid = toolNames.filter(t => !allNames.includes(t))
          if (invalid.length > 0) {
            await activeClient.sendText(userId, `❌ 未知工具: ${invalid.join(', ')}\n输入 /tools 查看全部`)
          } else {
            pi.setActiveTools(valid)
            await activeClient.sendText(userId, `✅ 活跃工具已设为: ${valid.join(', ')}`)
          }
        }
        return true
      }

      case 'compact': {
        // /compact — 手动压缩上下文
        if (!latestCtx) return false
        latestCtx.compact({
          onComplete: () => {
            void activeClient.sendText(userId, '✅ 上下文压缩完成')
          },
          onError: (error) => {
            void activeClient.sendText(userId, `❌ 压缩失败: ${error.message}`)
          },
        })
        await activeClient.sendText(userId, '⏳ 正在压缩上下文...')
        return true
      }

      case 'stop': {
        // /stop — 停止当前生成
        if (!latestCtx) return false
        if (latestCtx.isIdle()) {
          await activeClient.sendText(userId, '当前没有在执行任务')
        } else {
          latestCtx.abort()
          await activeClient.sendText(userId, '✅ 已发送停止信号')
        }
        return true
      }

      case 'status': {
        // /status — 查看 pi 当前状态
        if (!latestCtx) return false
        const lines: string[] = []
        if (latestCtx.model) lines.push(`模型: ${latestCtx.model.provider}/${latestCtx.model.id}`)
        lines.push(`Thinking: ${pi.getThinkingLevel()}`)
        lines.push(`工具数: ${pi.getActiveTools().length}`)
        const usage = latestCtx.getContextUsage()
        if (usage && usage.tokens != null) {
          const pct = usage.percent != null ? ` (${usage.percent}%)` : ''
          lines.push(`上下文: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens${pct}`)
        }
        lines.push(`排队消息: ${queue.length}`)
        lines.push(`图片合并等待: ${getImageBatchWaitMs() / 1000}s`)
        lines.push(`图片上限: ${Math.round(getImageMaxBytes() / 1024 / 1024)}MB`)
        await activeClient.sendText(userId, lines.join('\n'))
        return true
      }

      case 'config': {
        await activeClient.sendText(userId, [
          `图片合并等待: ${getImageBatchWaitMs()}ms`,
          `图片上限: ${getImageMaxBytes()} bytes (${Math.round(getImageMaxBytes() / 1024 / 1024)}MB)`,
          '可在 config.json 或环境变量中调整：',
          'PI_WECHAT_IMAGE_BATCH_WAIT_MS',
          'PI_WECHAT_IMAGE_MAX_BYTES',
        ].join('\n'))
        return true
      }

      case 'help': {
        const help = [
          '📋 常用微信命令:',
          '',
          '/status          查看当前状态',
          '/stop            停止当前生成',
          '/model           查看模型',
          '/model <名称>    切换模型',
          '/config          查看图片相关配置',
          '/help            显示帮助',
          '',
          '高级命令仍可用: /thinking, /tools, /compact',
          '直接发文字、语音、图片 = 正常对话',
        ]
        await activeClient.sendText(userId, help.join('\n'))
        return true
      }

      default:
        return false
    }
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

  // ============================================================================
  // 事件处理
  // ============================================================================

  // 会话启动
  pi.on('session_start', async (_event, ctx) => {
    latestCtx = ctx
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

  // 注入系统提示词
  pi.on('before_agent_start', async (event, ctx) => {
    latestCtx = ctx
    const request = pendingInjection ?? activeRequest
    log(`[BEFORE-AGENT] turnSeq=${turnSeq} pendingInjection=${pendingInjection?.id?.slice(0,8) ?? 'null'} activeRequest=${activeRequest?.id?.slice(0,8) ?? 'null'} willInject=${!!request}`)
    if (!request) return
    const injectedPrompt = buildSystemPrompt(event.systemPrompt, request)
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
