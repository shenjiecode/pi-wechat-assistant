// ============================================================================
// pi-wechat-assistant — 微信作为 pi TUI 的移动端分身
// ============================================================================

import { existsSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Type } from '@sinclair/typebox'
// @ts-ignore — @earendil-works is the current package, but the older package still carries TS declarations used for compatibility here
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { SessionExpiredError, WeixinClient } from './client.js'
import { acquireLock, releaseLock, loadCredentials, loadConfig } from './auth.js'
import { debugLog, isDebugEnabled } from './logger.js'
import { splitAndFilterMarkdown } from './message.js'
import { MessageQueue } from './queue.js'
import { handleRemoteCommand, type RemoteCommandDeps } from './remote-commands.js'
import { registerCommands, type CommandDeps } from './commands.js'
import { ok, fail, formatError, isAbortError, extractAllAssistantReplies, extractTextFromMessageContent } from './utils.js'
import {
  POLL_RETRY_BASE_MS,
  POLL_RETRY_MAX_MS,
  UNSUPPORTED_TYPES,
  UNSUPPORTED_REPLY,
  WECHAT_FILES_SUBDIR,
} from './constants.js'
import type { IncomingMessage } from './types.js'

type Ctx = ExtensionContext | ExtensionCommandContext

// ============================================================================
// TurnContext — 单轮对话会话状态
// ============================================================================

class TurnContext {
  seq = 0
  wechatConversationActive = false
  targetUser: string | null = null
  sentCount = 0
  messages: Array<{ role?: string; content?: unknown }> | null = null
  ended = false

  reset(): void {
    this.wechatConversationActive = false
    this.targetUser = null
    this.sentCount = 0
    this.messages = null
    this.ended = false
  }
}

// ============================================================================
// 路径沙箱校验
// ============================================================================

function isPathInCwd(targetPath: string, cwd: string): boolean {
  const resolved = path.resolve(targetPath)
  const resolvedCwd = path.resolve(cwd)
  return resolved.startsWith(resolvedCwd + path.sep) || resolved === resolvedCwd
}

// ============================================================================
// 工具守卫 — 发送文件/图片到微信的前置校验
// ============================================================================

type ToolGuardResult = {
  allowed: false
  error: ReturnType<typeof fail>
} | {
  allowed: true
  resolvedPath: string
  cwd: string
}

function guardSendToWechat(
  client: WeixinClient | null,
  running: boolean,
  lastWechatUser: { userId: string } | null,
  filePath: string,
  latestCtx: Ctx | null,
): ToolGuardResult {
  if (!client) return { allowed: false, error: fail('微信未登录，请先在 TUI 执行 /wechat login 和 /wechat start') }
  if (!running) return { allowed: false, error: fail('微信桥接未启动，请先在 TUI 执行 /wechat start') }
  if (!lastWechatUser) return { allowed: false, error: fail('尚未收到微信用户消息，无法获取 context_token。请先让微信用户发送一条消息。') }

  const cwd = latestCtx?.cwd ?? process.cwd()
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)

  if (!isPathInCwd(resolvedPath, cwd)) {
    return {
      allowed: false,
      error: fail(`安全限制：只能发送项目目录内的文件。\n路径: ${resolvedPath}\n项目: ${path.resolve(cwd)}`),
    }
  }
  if (!existsSync(resolvedPath)) return { allowed: false, error: fail(`文件不存在: ${resolvedPath}`) }

  return { allowed: true, resolvedPath, cwd }
}

function guardFileSize(resolvedPath: string): ReturnType<typeof fail> | null {
  try {
    const stats = statSync(resolvedPath)
    if (stats.size > 50 * 1024 * 1024) {
      return fail(`文件过大 (${(stats.size / 1024 / 1024).toFixed(1)}MB)，上限 50MB`)
    }
    return null
  } catch {
    return fail(`无法读取文件: ${resolvedPath}`)
  }
}

// ============================================================================
// Extension
// ============================================================================

export default function wechatAssistant(pi: ExtensionAPI) {
  let client: WeixinClient | null = null
  let running = false
  let agentIdle = true
  let pollAbort: AbortController | null = null
  let latestCtx: Ctx | null = null
  let wechatFilesDir: string | null = null

  const turn = new TurnContext()
  let lockSessionId: string | null = null

  // --- 消息队列 ---
  const queue = new MessageQueue(
    () => client,
    () => running,
    () => agentIdle,
    () => pollAbort?.signal,
    () => wechatFilesDir,
    (content, opts) => pi.sendUserMessage(content as any, opts),
    updateStatusBar,
  )

  // --- 通知 ---

  function log(message: string): void { debugLog(message) }

  function notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    if (latestCtx?.hasUI) {
      latestCtx.ui.notify(message, level)
      if (!isDebugEnabled()) return
    }
    const printer = level === 'error' ? console.error : console.log
    printer(`[wechat-assistant/${level}] ${message}`)
  }

  function updateStatusBar(): void {
    if (!latestCtx?.hasUI) return
    if (!client && !running) { latestCtx.ui.setStatus('wechat', ''); return }
    if (running) {
      const pending = queue.pending
      latestCtx.ui.setStatus('wechat', `[微信 ✅ 已连接${pending > 0 ? ` | 待处理:${pending}` : ''}]`)
    } else if (client) {
      latestCtx.ui.setStatus('wechat', '[微信 ⏸ 未连接]')
    } else {
      latestCtx.ui.setStatus('wechat', '[微信 ❌ 未登录]')
    }
  }

  // --- 锁 ---

  function getLockId(): string {
    if (!lockSessionId) lockSessionId = `pi-wechat-${process.pid}-${Date.now().toString(36)}`
    return lockSessionId
  }

  async function lock(): Promise<{ success: boolean; message: string }> {
    const result = await acquireLock(getLockId())
    if (result.success) lockSessionId = getLockId()
    return result
  }

  async function unlock(): Promise<void> {
    if (lockSessionId) await releaseLock(lockSessionId)
  }

  async function loadClient(): Promise<WeixinClient | null> {
    if (!client) {
      const creds = await loadCredentials()
      if (creds) {
        client = await WeixinClient.create(creds)
        const lastUserId = client.lastActiveUserId
        if (lastUserId) {
          queue.lastWechatUser = { userId: lastUserId, contextToken: '' }
        }
      }
    }
    return client
  }

  async function disposeClient(): Promise<void> {
    if (client) {
      await client.dispose()
    }
    client = null
  }

  // --- 停止 ---

  async function stopBridge(options: { releaseLock?: boolean } = {}): Promise<void> {
    running = false
    pollAbort?.abort()
    pollAbort = null

    if (queue.activeRequest && client) {
      await client.stopTyping(queue.activeRequest.userId).catch(() => {})
    }

    queue.reset()
    turn.reset()
    if (options.releaseLock) await unlock()
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
    ].join('\n')
  }

  // --- 轮询 ---

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

  // --- 单条消息处理 ---

  async function handleIncomingMessage(message: IncomingMessage, activeClient: WeixinClient): Promise<void> {
    log(`收到消息: type=${message.type}, text=${message.text?.slice(0, 50)}, images=${message.imageUrls.length}`)

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

    if (message.text.startsWith('/')) {
      activeClient.rememberContext(message.raw)
      const handled = await handleRemoteCommand(message.text, message.userId, activeClient, remoteCommandDeps)
      if (handled) return
    }

    queue.enqueue(message)
  }

  // --- 远程命令依赖 ---

  const remoteCommandDeps: RemoteCommandDeps = {
    pi,
    getCtx: () => latestCtx,
    client: () => client,
    queueLength: () => queue.pending,
  }

  // --- TUI 命令注册 ---

  const commandDeps: CommandDeps = {
    pi,
    getClient: () => client,
    setClient: (c) => { client = c },
    loadClient,
    isRunning: () => running,
    setRunning: (v) => { running = v; if (v) agentIdle = true },
    getPollAbort: () => pollAbort,
    setPollAbort: (c) => { pollAbort = c },
    queue,
    lock,
    unlock,
    stopBridge,
    pollMessages,
    latestCtx: () => latestCtx,
    setLatestCtx: (ctx) => { latestCtx = ctx },
    updateStatusBar,
    notify,
    disposeClient,
  }

  registerCommands(pi, commandDeps)

  // ============================================================================
  // AI 工具注册
  // ============================================================================

  pi.registerTool({
    name: 'send_file_to_wechat',
    label: 'Send File to WeChat',
    description: '发送项目目录中的文件到当前微信对话。用于将 AI 产出的代码、报告等文件直接发给微信用户。',
    promptSnippet: '发送项目目录中的文件到微信',
    promptGuidelines: [
      '当用户通过微信要求产出文件时，先写入文件再用 send_file_to_wechat 发送。',
      '只能发送项目工作目录内的文件（安全限制）。',
      '如果发送失败，工具会返回错误信息。不要重试超过 1 次。',
    ],
    parameters: Type.Object({
      filePath: Type.String({ description: '要发送的文件路径（项目目录内的绝对路径或相对路径）' }),
      fileName: Type.Optional(Type.String({ description: '在微信中显示的文件名（可选，默认使用原文件名）' })),
    }),
    async execute(_toolCallId, params, _signal) {
      const guard = guardSendToWechat(client, running, queue.lastWechatUser, params.filePath, latestCtx)
      if (!guard.allowed) return guard.error
      const sizeError = guardFileSize(guard.resolvedPath)
      if (sizeError) return sizeError

      try {
        const stats = statSync(guard.resolvedPath)
        await client!.sendFile(queue.lastWechatUser!.userId, guard.resolvedPath, params.fileName)
        const name = params.fileName ?? path.basename(guard.resolvedPath)
        return ok(`✅ 文件「${name}」(${(stats.size / 1024).toFixed(1)} KB) 已发送到微信`)
      } catch (err) {
        log(`send_file_to_wechat 失败: ${formatError(err)}`)
        return fail(`发送失败: ${formatError(err)}`)
      }
    },
  })

  pi.registerTool({
    name: 'send_image_to_wechat',
    label: 'Send Image to WeChat',
    description: '发送项目目录中的图片到当前微信对话。用于将 AI 生成的图表、截图等直接发给微信用户。',
    promptSnippet: '发送项目目录中的图片到微信（可预览）',
    promptGuidelines: [
      '当用户通过微信要求生成图表/截图/图片时，先生成图片文件再用 send_image_to_wechat 发送。',
      '只能发送项目工作目录内的图片（安全限制）。',
      '如果发送失败不要重试超过 1 次。',
    ],
    parameters: Type.Object({
      imagePath: Type.String({ description: '要发送的图片路径（项目目录内的绝对路径或相对路径，支持 png/jpg/gif/webp）' }),
    }),
    async execute(_toolCallId, params, _signal) {
      const guard = guardSendToWechat(client, running, queue.lastWechatUser, params.imagePath, latestCtx)
      if (!guard.allowed) return guard.error
      const sizeError = guardFileSize(guard.resolvedPath)
      if (sizeError) return sizeError

      try {
        const stats = statSync(guard.resolvedPath)
        await client!.sendImage(queue.lastWechatUser!.userId, guard.resolvedPath)
        return ok(`✅ 图片 (${(stats.size / 1024).toFixed(1)} KB) 已发送到微信`)
      } catch (err) {
        log(`send_image_to_wechat 失败: ${formatError(err)}`)
        return fail(`发送失败: ${formatError(err)}`)
      }
    },
  })

  // ============================================================================
  // 事件处理
  // ============================================================================

  pi.on('session_start', async (_event, ctx) => {
    latestCtx = ctx
    wechatFilesDir = path.join(ctx.cwd, WECHAT_FILES_SUBDIR)
    await loadClient()
    updateStatusBar()

    const config = await loadConfig()
    if (config.autoStart && client) {
      const lockResult = await lock()
      if (lockResult.success) {
        running = true
        agentIdle = true
        pollAbort = new AbortController()
        notify('微信桥接已自动启动 📱', 'info')
        updateStatusBar()
        void pollMessages(client).finally(() => {
          if (pollAbort?.signal.aborted) pollAbort = null
        }).catch(err => {
          log(`pollMessages 异常退出: ${formatError(err)}`)
        })
      } else {
        log(`自动启动失败: ${lockResult.message}`)
      }
    }
  })

  // 用户在 TUI 主动输入非命令内容 → 打断微信对话活跃状态
  pi.on('input', (event, ctx) => {
    latestCtx = ctx
    if (event.source === 'extension') return
    const text = event.text?.trim()
    if (!text || text.startsWith('/')) return
    turn.wechatConversationActive = false
  })

  // 系统提示词注入
  pi.on('before_agent_start', async (event, ctx) => {
    latestCtx = ctx
    const request = queue.pendingInjection ?? queue.activeRequest
    log(`[BEFORE-AGENT] turnSeq=${turn.seq} pendingInjection=${!!queue.pendingInjection} activeRequest=${!!queue.activeRequest} willInject=${!!request}`)
    if (!request) return
    const injectedPrompt = buildSystemPrompt(event.systemPrompt)
    log(`[BEFORE-AGENT-INJECT] injecting wechat system prompt`)
    return { systemPrompt: injectedPrompt }
  })

  // agent 开始 → 记录 turn 元数据
  pi.on('agent_start', async (_event, ctx) => {
    turn.seq++
    latestCtx = ctx
    agentIdle = false
    turn.sentCount = 0
    turn.messages = null
    turn.ended = false

    if (queue.pendingInjection) {
      queue.activeRequest = queue.pendingInjection
      turn.wechatConversationActive = true
      turn.targetUser = queue.activeRequest.userId
      log(`[AGENT-START] turn#${turn.seq} source=WECHAT userId=${turn.targetUser} pendingInjection consumed`)
      queue.pendingInjection = null
    } else {
      turn.targetUser = queue.lastWechatUser?.userId ?? null
      log(`[AGENT-START] turn#${turn.seq} source=TUI targetUser=${turn.targetUser ?? 'null'}`)
    }
  })

  // 增量发送（仅微信触发的 turn）
  pi.on('message_end', async (event, ctx) => {
    if (event.message.role !== 'assistant') return
    if (!running || !client || !turn.wechatConversationActive) return

    const targetUserId = turn.targetUser
    if (!targetUserId) {
      log(`[MSG-END-SKIP] no target user`)
      return
    }

    const text = extractTextFromMessageContent(event.message.content)
    if (!text) {
      log(`[MSG-END-SKIP] no text content (likely toolCall only)`)
      return
    }

    log(`[MSG-END] incremental send to ${targetUserId}, textLen=${text.length} preview=${text.slice(0, 60)} sentCount=${turn.sentCount}`)

    try {
      const chunks = splitAndFilterMarkdown(text)
      for (let i = 0; i < chunks.length; i++) {
        log(`[MSG-END-CHUNK] ${i + 1}/${chunks.length} len=${chunks[i].length}`)
        await client.sendText(targetUserId, chunks[i])
      }
      turn.sentCount++
      log(`[MSG-END-DONE] incrementally sent, totalSent=${turn.sentCount}`)
    } catch (err) {
      log(`[MSG-END-ERROR] ${formatError(err)}`)
    }
  })

  // agent 结束 → 补发遗漏 + 收尾
  pi.on('agent_end', async (event, ctx) => {
    latestCtx = ctx
    agentIdle = true
    turn.ended = true
    turn.messages = event.messages as Array<{ role?: string; content?: unknown }>

    const msgCount = turn.messages.length
    const assistantMsgs = turn.messages.filter(m => m?.role === 'assistant').length
    log(`[AGENT-END] turn#${turn.seq} source=${turn.wechatConversationActive ? 'WECHAT' : 'TUI'} targetUser=${turn.targetUser} messages=${msgCount} assistant=${assistantMsgs} sentCount=${turn.sentCount}`)

    const allReplies = extractAllAssistantReplies(turn.messages)
    const newReplies = allReplies.slice(turn.sentCount)
    log(`[AGENT-END-REPLIES] all=${allReplies.length} sent=${turn.sentCount} new=${newReplies.length}`)

    if (turn.wechatConversationActive && newReplies.length > 0 && client && turn.targetUser) {
      try {
        await queue.sendRepliesToWechat(newReplies, turn.targetUser)
        log(`[AGENT-END-DONE] sent ${newReplies.length} remaining replies`)
      } catch (err) {
        log(`[AGENT-END-ERROR] ${formatError(err)}`)
        notify(`发送微信回复失败: ${formatError(err)}`, 'error')
      }
    } else if (allReplies.length === 0) {
      log(`[AGENT-END-NOREPLY] no assistant text`)
    } else {
      log(`[AGENT-END-SAFE] all replies already sent incrementally`)
    }

    if (queue.activeRequest) {
      await client?.stopTyping(queue.activeRequest.userId).catch(() => {})
      queue.activeRequest = null
    }
    updateStatusBar()

    log(`[AGENT-END-DEFER] deferring drainQueue`)
    setImmediate(() => void queue.drain())
  })

  // 会话关闭 → 清理 + 落盘 context tokens
  pi.on('session_shutdown', async (_event, ctx) => {
    latestCtx = ctx
    await stopBridge({ releaseLock: true })
    await disposeClient()
  })

  // --- 进程退出清理 ---

  const exitHandler = () => {
    if (client) {
      // 同步 fire-and-forget（进程退出时无法 await），至少清除锁
      client.dispose().catch(() => {})
    }
    if (lockSessionId) {
      releaseLock(lockSessionId).catch(() => {})
    }
  }

  process.once('SIGINT', exitHandler)
  process.once('SIGTERM', exitHandler)
  process.once('beforeExit', exitHandler)
}
