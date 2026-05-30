// ============================================================================
// pi-wechat-assistant — 微信作为 pi TUI 的移动端分身
// ============================================================================

import { randomUUID } from 'node:crypto'
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

// 不支持的消息类型
const UNSUPPORTED_TYPES = new Set(['image', 'file', 'video', 'unknown'])
const UNSUPPORTED_REPLY: Record<string, string> = {
  image: '⚠️ 暂不支持图片消息，目前支持文字和语音。',
  file: '⚠️ 暂不支持文件消息，目前支持文字和语音。',
  video: '⚠️ 暂不支持视频消息，目前支持文字和语音。',
  unknown: '⚠️ 暂不支持此消息类型，目前支持文字和语音。',
}

// --- 内部队列 ---

interface QueuedMessage {
  id: string
  userId: string
  messageId: string
  receivedAt: Date
  text: string
  preview: string
  contextToken: string
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
    if (!DEBUG) return
    console.log(`[wechat-assistant] ${message}`)
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

  function enqueueMessage(message: IncomingMessage): void {
    const request: QueuedMessage = {
      id: randomUUID(),
      userId: message.userId,
      messageId: message.messageId,
      receivedAt: message.timestamp,
      text: message.text,
      preview: summarizePreview(message.text),
      contextToken: message.contextToken,
    }
    queue.push(request)
    lastWechatUser = { userId: message.userId, contextToken: message.contextToken }
    log(`消息入队: ${request.preview}`)
    updateStatusBar()
    drainQueue()
  }

  function drainQueue(): void {
    if (!running || !client || !agentIdle || pendingInjection || activeRequest) return

    const next = queue.shift()
    if (!next) return

    pendingInjection = next
    updateStatusBar()
    void client.startTyping(next.userId).catch(() => {})
    pi.sendUserMessage(next.text)
  }

  async function completeActiveRequest(
    messages: Array<{ role?: string; content?: unknown }>,
  ): Promise<void> {
    const request = activeRequest
    activeRequest = null
    pendingInjection = null

    if (!request || !client) {
      drainQueue()
      return
    }

    const reply = extractFinalAssistantText(messages)

    try {
      if (reply) {
        const chunks = splitAndFilterMarkdown(reply)
        for (const chunk of chunks) {
          await client.sendText(request.userId, chunk)
        }
      } else {
        notify(`Pi 没有产出可发送的文本回复: ${request.preview}`, 'warning')
      }
    } catch (error) {
      notify(`发送微信回复失败: ${formatError(error)}`, 'error')
    } finally {
      await client.stopTyping(request.userId).catch(() => {})
      updateStatusBar()
      drainQueue()
    }
  }

  // --- TUI → 微信同步 ---

  async function syncReplyToWechat(
    messages: Array<{ role?: string; content?: unknown }>,
  ): Promise<void> {
    log(`syncReplyToWechat called — client=${!!client}, lastUser=${JSON.stringify(lastWechatUser)}`)

    if (!client || !lastWechatUser) return

    const reply = extractFinalAssistantText(messages)
    log(`syncReplyToWechat extracted reply: ${reply ? reply.slice(0, 80) + '...' : 'null'}`)

    if (!reply) return

    try {
      const chunks = splitAndFilterMarkdown(reply)
      log(`syncReplyToWechat sending ${chunks.length} chunk(s) to ${lastWechatUser.userId}`)
      for (const chunk of chunks) {
        await client.sendText(lastWechatUser.userId, chunk)
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

  // --- 单条消息处理 ---

  async function handleIncomingMessage(message: IncomingMessage, activeClient: WeixinClient): Promise<void> {
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

    // 支持的消息 → 发送回执 → 入队
    try {
      await activeClient.sendText(message.userId, ACK_TEXT)
    } catch (err) {
      log(`发送回执失败: ${formatError(err)}`)
    }

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

function extractFinalAssistantText(
  messages: Array<{ role?: string; content?: unknown }>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue

    // 兼容 string 和 Array 两种 content 格式
    if (typeof message.content === 'string') {
      const text = message.content.trim()
      if (text) return text
      continue
    }

    if (!Array.isArray(message.content)) continue

    const text = message.content
      .filter(
        (part): part is { type: 'text'; text: string } =>
          typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text',
      )
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim()

    if (text) return text
  }
  return null
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
