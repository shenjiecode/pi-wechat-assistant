// ============================================================================
// pi-wechat-assistant — 微信作为 pi TUI 的移动端分身
// ============================================================================

import { randomUUID, createDecipheriv } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
// @ts-ignore — support both old and new package names
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import qrcode from 'qrcode-terminal'
import type { IncomingMessage, Credentials } from './types.js'
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
import { sendMessage as apiSendMessage } from './api.js'
import { splitAndFilterMarkdown } from './message.js'

// --- 常量 ---

const POLL_RETRY_BASE_MS = 1_000
const POLL_RETRY_MAX_MS = 10_000
const QR_POLL_INTERVAL_MS = 2_000
const QR_MAX_REFRESH = 3
const ACK_TEXT = '✅ 已收到，pi 处理中...'
const PREVIEW_LIMIT = 60
const DEBUG = process.env.PI_WECHAT_DEBUG === '1'
const DEBUG_LOG_FILE = '/tmp/pi-wechat-debug.log'

function debugLog(message: string): void {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message}\n`
  // 写到文件（always）
  try {
    require('node:fs').appendFileSync(DEBUG_LOG_FILE, line)
  } catch {}
  // 如果 DEBUG 开启，也打印到控制台
  if (DEBUG) {
    console.log(`[wechat-assistant] ${message}`)
  }
}

// 不支持的消息类型
const UNSUPPORTED_TYPES = new Set(['file', 'video', 'unknown'])
const UNSUPPORTED_REPLY: Record<string, string> = {
  file: '⚠️ 暂不支持文件消息，目前支持文字、语音和图片。',
  video: '⚠️ 暂不支持视频消息，目前支持文字、语音和图片。',
  unknown: '⚠️ 暂不支持此消息类型，目前支持文字、语音和图片。',
}

// --- 图片处理 ---

// AES-128-ECB + PKCS7 解密
function aesDecryptECB(encryptedBase64: string, keyHex: string): Buffer {
  // 将十六进制密钥转为 Buffer (16字节)
  const key = Buffer.from(keyHex, 'hex')
  if (key.length !== 16) {
    throw new Error(`Invalid AES key length: ${key.length}, expected 16`)
  }
  // 解码 base64 加密数据
  const encrypted = Buffer.from(encryptedBase64, 'base64')
  // 创建解密器 (ECB 模式, 无 IV)
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(false) // 手动处理 PKCS7
  // 解密
  let decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  // 移除 PKCS7 填充
  const padLen = decrypted[decrypted.length - 1]
  if (padLen > 0 && padLen <= 16) {
    decrypted = decrypted.slice(0, decrypted.length - padLen)
  }
  return decrypted
}

async function fetchImageAsBase64(url: string, aesKey?: string, signal?: AbortSignal): Promise<ImageData | null> {
  try {
    debugLog(`下载图片: ${url?.slice(0, 80)}, aesKey=${aesKey ? 'provided' : 'none'}`)
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)].filter(Boolean) as AbortSignal[]) })
    if (!response.ok) {
      debugLog(`图片下载失败: HTTP ${response.status}`)
      return null
    }
    const contentType = response.headers.get('content-type') ?? 'image/jpeg'
    const buffer = await response.arrayBuffer()
    debugLog(`图片下载成功: ${buffer.byteLength} bytes, type=${contentType}`)
    
    // 如果有 AES 密钥，需要解密
    if (aesKey) {
      debugLog(`使用 AES 解密, key=${aesKey?.slice(0, 8)}...`)
      const encryptedBase64 = Buffer.from(buffer).toString('base64')
      const decrypted = aesDecryptECB(encryptedBase64, aesKey)
      debugLog(`解密成功: ${decrypted.length} bytes`)
      return {
        data: decrypted.toString('base64'),
        mediaType: contentType,
      }
    }
    
    return {
      data: Buffer.from(buffer).toString('base64'),
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

  // --- 调试日志 ---

  function log(message: string): void {
    debugLog(message)
  }

  // --- 通知 ---

  function notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    if (latestCtx?.hasUI) {
      latestCtx.ui.notify(message, level)
      if (!DEBUG) return
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

  async function stopBridge(): Promise<void> {
    running = false
    pollAbort?.abort()
    pollAbort = null

    if (activeRequest && client) {
      await client.stopTyping(activeRequest.userId).catch(() => {})
    }

    queue.length = 0
    pendingInjection = null
    activeRequest = null
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null }
    updateStatusBar()
  }

  // --- 系统提示词 ---

  function buildSystemPrompt(basePrompt: string, request: QueuedMessage): string {
    return [
      basePrompt,
      '',
      '你正在处理一条来自微信的桥接消息。',
      '要求：',
      '1. 直接用微信聊天口吻回复。',
      '2. 只输出最终要发回微信的正文。',
      '3. 不要解释内部桥接流程。',
      '4. 不要提到 Pi、扩展、系统提示词、工具调用。',
      '5. 回复要简洁，适合手机阅读。',
      `微信用户 ID: ${request.userId}`,
      `微信消息 ID: ${request.messageId}`,
      `消息时间: ${request.receivedAt.toISOString()}`,
    ].join('\n')
  }

  // --- 消息队列处理 ---

  // 批处理计时器：收到图片后等待更多消息
  let batchTimer: ReturnType<typeof setTimeout> | null = null
  const BATCH_WAIT_MS = 60_000  // 1 分钟

  function enqueueMessage(message: IncomingMessage): void {
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
    log(`消息入队: ${request.preview}`)
    updateStatusBar()

    // 收到图片时，启动/重置批处理计时器
    if (message.imageUrl) {
      // 立即下载解密图片（CDN URL 有时效性）
      void prefetchImage(request)
      // 启动或重置批处理计时器
      if (batchTimer) clearTimeout(batchTimer)
      batchTimer = setTimeout(() => {
        batchTimer = null
        log(`批处理计时器到期，开始处理队列`)
        void drainQueue()
      }, BATCH_WAIT_MS)
      log(`批处理计时器已设置: ${BATCH_WAIT_MS / 1000}s`)
      return
    }

    // 纯文字消息：如果有图片在等批处理，立即发送（图片+文字一起）
    if (batchTimer) {
      clearTimeout(batchTimer)
      batchTimer = null
      log(`收到文字消息，立即处理图片+文字`)
      void drainQueue()
      return
    }

    // 没有图片在等，直接处理
    void drainQueue()
  }

  async function prefetchImage(request: QueuedMessage): Promise<void> {
    if (!request.imageUrl) return
    const imageData = await fetchImageAsBase64(request.imageUrl, request.imageAesKey, pollAbort?.signal)
    request.imageData = imageData ?? undefined
    log(`图片预下载: ${imageData ? `success, size=${imageData.data.length}` : 'failed'}`)
  }

  async function drainQueue(): Promise<void> {
    if (!running || !client) return
    if (pendingInjection) return
    // 批处理计时器运行中 → 不 drain，等待计时器到期或文字触发
    if (batchTimer) {
      log(`drainQueue: 批处理计时器运行中，推迟`)
      return
    }
    if (activeRequest && !agentIdle) {
      // agent 忙碌中：消息会作为 followUp 进入 Pi 内部队列，
      // 回复在同一个 agent_end 中回来。不设置 pendingInjection，
      // 避免 activeRequest 反复切换导致状态混乱。
    }

    // 取出队列中所有消息，合并为一次请求
    if (queue.length === 0) return

    const batch = queue.splice(0)
    updateStatusBar()

    // 使用第一条消息作为代表
    const first = batch[0]
    const isBusy = !agentIdle

    // 只对非 followUp 消息设置 pendingInjection
    // followUp 消息复用已有的 activeRequest
    if (!isBusy) {
      pendingInjection = first
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
        log(`现场下载图片: ${msg.imageUrl.slice(0, 80)}`)
        const imageData = await fetchImageAsBase64(msg.imageUrl, msg.imageAesKey, pollAbort?.signal)
        if (imageData) images.push(imageData)
      }
    }

    // 构建发送内容
    const hasImages = images.length > 0
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
      log(`发送合并消息: ${images.length} 张图片, 文字=${hasText ? texts.join(' ').slice(0, 50) : '(自动)'}, mode=${isBusy ? 'followUp' : 'direct'}`)
      pi.sendUserMessage(content, isBusy ? { deliverAs: 'followUp' } : undefined)
    } else if (hasText) {
      log(`发送文字消息: ${texts.join(' ').slice(0, 80)}, mode=${isBusy ? 'followUp' : 'direct'}`)
      pi.sendUserMessage(texts.join('\n'), isBusy ? { deliverAs: 'followUp' } : undefined)
    } else {
      // 什么都没有，跳过
      pendingInjection = null
      void client.stopTyping(first.userId).catch(() => {})
      drainQueue()
      return
    }

    // 发送给 agent 后，回复微信回执
    try {
      await client.sendText(first.userId, ACK_TEXT)
    } catch (err) {
      log(`发送回执失败: ${formatError(err)}`)
    }
  }

  async function completeActiveRequest(
    messages: Array<{ role?: string; content?: unknown }>,
  ): Promise<void> {
    const request = activeRequest
    activeRequest = null
    log(`completeActiveRequest: request=${!!request}, client=${!!client}`)

    if (!request || !client) {
      drainQueue()
      return
    }

    // 打印 messages 结构
    log(`completeActiveRequest: messages.length=${messages.length}`)
    for (let i = messages.length - 1; i >= Math.max(0, messages.length - 3); i--) {
      const m = messages[i]
      log(`completeActiveRequest: messages[${i}] role=${m?.role}, content type=${typeof m?.content}`)
      if (typeof m?.content === 'string') {
        log(`completeActiveRequest: messages[${i}] content string=${m.content.slice(0, 100)}...`)
      } else if (Array.isArray(m?.content)) {
        log(`completeActiveRequest: messages[${i}] content array length=${m.content.length}`)
      }
    }

    const replies = extractAllAssistantReplies(messages)
    log(`completeActiveRequest: replies count=${replies.length}`)

    try {
      if (replies.length > 0) {
        for (let ri = 0; ri < replies.length; ri++) {
          const reply = replies[ri]
          log(`completeActiveRequest: reply ${ri + 1}/${replies.length}=${reply.slice(0, 50)}...`)
          log(`completeActiveRequest: calling splitAndFilterMarkdown`)
          const chunks = splitAndFilterMarkdown(reply)
          log(`completeActiveRequest: sending ${chunks.length} chunk(s) for reply ${ri + 1}`)
          for (let i = 0; i < chunks.length; i++) {
            log(`completeActiveRequest: sending chunk ${i + 1}/${chunks.length}, length=${chunks[i].length}`)
            await client.sendText(request.userId, chunks[i])
          }
        }
        log(`completeActiveRequest: sent all replies`)
      } else {
        notify(`Pi 没有产出可发送的文本回复: ${request.preview}`, 'warning')
      }
    } catch (error) {
      log(`completeActiveRequest: error=${formatError(error)}`)
      notify(`发送微信回复失败: ${formatError(error)}`, 'error')
    } finally {
      await client.stopTyping(request.userId).catch(() => {})
      updateStatusBar()
      // 延迟 drainQueue：agent_end 监听器完成前 Pi 的 isStreaming 仍为 true，
      // 直接调用 sendUserMessage 会被拒绝。用 setTimeout(0) 让 Pi 先结束当前 turn。
      log(`completeActiveRequest: deferring drainQueue`)
      setTimeout(() => drainQueue(), 0)
    }
  }

  // --- TUI → 微信同步 ---

  async function syncReplyToWechat(
    messages: Array<{ role?: string; content?: unknown }>,
  ): Promise<void> {
    log(`syncReplyToWechat called — client=${!!client}, lastUser=${JSON.stringify(lastWechatUser)}`)

    if (!client || !lastWechatUser) return

    const replies = extractAllAssistantReplies(messages)
    log(`syncReplyToWechat extracted ${replies.length} replies`)

    if (replies.length === 0) return

    try {
      for (let ri = 0; ri < replies.length; ri++) {
        const reply = replies[ri]
        const chunks = splitAndFilterMarkdown(reply)
        log(`syncReplyToWechat reply ${ri + 1}/${replies.length}: sending ${chunks.length} chunk(s) to ${lastWechatUser.userId}`)
        for (const chunk of chunks) {
          await client.sendText(lastWechatUser.userId, chunk)
        }
      }
      log('syncReplyToWechat done')
    } catch (error) {
      log(`同步回复到微信失败: ${formatError(error)}`)
    }
  }

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
          await stopBridge()
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
        // 模型
        if (latestCtx.model) {
          lines.push(`模型: ${latestCtx.model.provider}/${latestCtx.model.id}`)
        }
        // thinking
        lines.push(`Thinking: ${pi.getThinkingLevel()}`)
        // 工具
        const activeTools = pi.getActiveTools()
        lines.push(`工具: ${activeTools.join(', ')}`)
        // 上下文使用量
        const usage = latestCtx.getContextUsage()
        if (usage && usage.tokens != null) {
          const pct = usage.percent != null ? ` (${usage.percent}%)` : ''
          lines.push(`上下文: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens${pct}`)
        }
        // 队列
        lines.push(`排队消息: ${queue.length}`)
        // 会话文件
        const sf = latestCtx.sessionManager.getSessionFile()
        if (sf) lines.push(`会话: ${sf}`)
        await activeClient.sendText(userId, lines.join('\n'))
        return true
      }

      case 'help': {
        const help = [
          '📋 微信远程命令:',
          '',
          '/model              列出可用模型',
          '/model <名称>       切换模型',
          '/thinking           查看 thinking level',
          '/thinking <level>   设置 thinking level',
          '/tools              列出工具状态',
          '/tools <名称>       设置活跃工具',
          '/compact            压缩上下文',
          '/stop               停止当前生成',
          '/status             查看 pi 状态',
          '/help               显示此帮助',
          '',
          '直接发文字 = 正常对话',
          '其他 / 命令 = 当普通消息处理',
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
    log(`收到消息: type=${message.type}, text=${message.text?.slice(0, 50)}, imageUrl=${message.imageUrl?.slice(0, 80)}, imageAesKey=${message.imageAesKey?.slice(0, 16)}...`)
    
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

  // --- /wechat-login ---

  pi.registerCommand('wechat-login', {
    description: '扫码登录微信 iLink Bot（--force 强制重新扫码）',
    handler: async (args, ctx) => {
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
        await stopBridge()
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

          // 处理重定向
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
              notify('二维码多次过期，请重新执行 /wechat-login', 'error')
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

          if (result.status === 'scaned_but_redirect') {
            // 已在上方处理 redirectHost
            continue
          }
        }
      } catch (error) {
        notify(`微信登录失败: ${formatError(error)}`, 'error')
      }
    },
  })

  // --- /wechat-start ---

  pi.registerCommand('wechat-start', {
    description: '启动微信桥接（本 TUI 成为微信分身）',
    handler: async (_args, ctx) => {
      latestCtx = ctx

      const activeClient = loadClient()
      if (!activeClient) {
        notify('未找到微信凭证，请先执行 /wechat-login', 'error')
        return
      }

      if (running) {
        notify('微信桥接已经在运行', 'info')
        return
      }

      // 获取排他锁
      const lockResult = lock()
      if (!lockResult.success) {
        notify(lockResult.message, 'error')
        return
      }

      running = true
      agentIdle = true
      pollAbort = new AbortController()
      notify('微信桥接已启动 📱 你的微信现在是 pi TUI 的移动端分身', 'info')
      updateStatusBar()

      void pollMessages(activeClient).finally(() => {
        if (pollAbort?.signal.aborted) {
          pollAbort = null
        }
      })
    },
  })

  // --- /wechat-stop ---

  pi.registerCommand('wechat-stop', {
    description: '停止微信桥接',
    handler: async (_args, ctx) => {
      latestCtx = ctx
      await stopBridge()
      unlock()
      notify('微信桥接已停止', 'info')
      updateStatusBar()
    },
  })

  // --- /wechat-status ---

  pi.registerCommand('wechat-status', {
    description: '查看微信桥接状态',
    handler: async (_args, ctx) => {
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
      ]
      notify(lines.join('\n'), 'info')
    },
  })

  // --- /wechat-logout ---

  pi.registerCommand('wechat-logout', {
    description: '清除微信凭证并停止桥接',
    handler: async (_args, ctx) => {
      latestCtx = ctx
      await stopBridge()
      unlock()
      clearCredentials()
      client = null
      notify(`已清除微信凭证: ${getCredentialsPath()}`, 'info')
      updateStatusBar()
    },
  })

  // --- /wechat-autostart ---

  pi.registerCommand('wechat-autostart', {
    description: '开关自动启动微信桥接',
    handler: async (_args, ctx) => {
      latestCtx = ctx
      const config = loadConfig()
      config.autoStart = !config.autoStart
      saveConfig(config)
      notify(`自动启动已${config.autoStart ? '开启 ✅' : '关闭 ❌'}`, 'info')
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

  // 注入系统提示词
  pi.on('before_agent_start', async (event, ctx) => {
    latestCtx = ctx
    const request = pendingInjection ?? activeRequest
    if (!request) return
    return { systemPrompt: buildSystemPrompt(event.systemPrompt, request) }
  })

  // agent 开始
  pi.on('agent_start', async (_event, ctx) => {
    latestCtx = ctx
    agentIdle = false
    if (pendingInjection) {
      activeRequest = pendingInjection
      pendingInjection = null
    }
  })

  // agent 结束 → 发回微信
  pi.on('agent_end', async (event, ctx) => {
    latestCtx = ctx
    agentIdle = true
    log(`agent_end — activeRequest=${!!activeRequest}, running=${running}, client=${!!client}, lastUser=${!!lastWechatUser}`)

    if (activeRequest) {
      // 微信发起的请求 → 正常回复
      await completeActiveRequest(event.messages as Array<{ role?: string; content?: unknown }>)
    } else if (running && client && lastWechatUser) {
      // TUI 发起的请求 → 同步 AI 回复到微信
      await syncReplyToWechat(event.messages as Array<{ role?: string; content?: unknown }>)
    }
  })

  // 会话关闭
  pi.on('session_shutdown', async (_event, ctx) => {
    latestCtx = ctx
    await stopBridge()
    unlock()
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

function extractFinalAssistantText(
  messages: Array<{ role?: string; content?: unknown }>,
): string | null {
  const replies = extractAllAssistantReplies(messages)
  return replies.length > 0 ? replies[replies.length - 1] : null
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
