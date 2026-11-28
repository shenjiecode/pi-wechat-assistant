// ============================================================================
// pi-wechat-assistant — 微信作为 pi TUI 的移动端分身
// ============================================================================

import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { loadCredentials } from '../bridge/auth.js'
import { WeixinClient } from '../wechat/client.js'
import { stoppedBridgeReason } from './send-tools.js'
import { debugLog, debugError } from '../shared/logger.js'
import { splitAndFilterMarkdown } from '../messaging/message.js'
import { registerNewSession } from './new-session.js'
import { registerCommands } from './commands.js'
import { formatError, extractTextFromMessageContent } from '../shared/utils.js'
import { WECHAT_FILES_SUBDIR } from '../shared/constants.js'
import { appendWechatSystemRules } from '../messaging/wechat-source.js'
import { BridgeRuntime, WECHAT_TOOL_NAMES, WECHAT_TOOL_STATUS_TYPE } from './runtime.js'
import { summarizeModelError } from './model-failure.js'
import { SUMMARY_REPLY_RULE } from './completion-summary.js'
import { loadConfig } from '../bridge/config.js'
import { resolveConfig } from '../bridge/config-values.js'

export default function wechatAssistant(pi: ExtensionAPI) {
  const rt = new BridgeRuntime(pi)

  // --- TUI 命令 ---

  registerCommands(pi, rt)

  const newSession = registerNewSession(pi, {
    pending: () => rt.queue.hasPendingWork || rt.agentPreparing || rt.pendingPollMessages > 0,
    running: () => rt.running,
    start: ctx => rt.startBridge(ctx, false),
    reply: async (userId, text) => {
      if (rt.running && rt.client?.userId === userId) {
        await rt.client.sendText(userId, text)
        return
      }
      const credentials = await loadCredentials()
      if (!credentials || credentials.userId !== userId) throw new Error('微信登录身份已变化，无法发送会话结果')
      const sender = await WeixinClient.create(credentials)
      try { await sender.sendText(userId, text) }
      finally { await sender.dispose() }
    },
  })
  rt.newSession = newSession

  // ============================================================================
  // 事件处理
  // ============================================================================

  pi.on('session_start', async (_event, ctx) => {
    rt.latestCtx = ctx
    rt.wechatFilesDir = path.join(ctx.cwd, WECHAT_FILES_SUBDIR)
    await rt.loadClient()
    rt.updateStatusBar()

    const config = resolveConfig(await loadConfig())
    // TUI auto-start keeps the manual behaviour, including the takeover prompt;
    // headless modes show the plain lock diagnostic without prompting.
    if (config.autoStart && rt.client) await rt.startBridge(ctx, ctx.hasUI, 'auto-start')
  })

  // Transient model context only: never persist stale stop notices in the session.
  pi.on('context', (event) => {
    let changed = false
    const messages = event.messages.filter(message => {
      const stale = message.role === 'custom' && message.customType === WECHAT_TOOL_STATUS_TYPE
      changed ||= stale
      return !stale
    })
    if (rt.toolsRegistered && !rt.running) {
      changed = true
      messages.push({
        role: 'custom', customType: WECHAT_TOOL_STATUS_TYPE, display: false, timestamp: Date.now(),
        content: rt.contextNotice(),
      })
    }
    if (changed) return { messages }
  })

  // Input may be queued: do not change the running reply's source here.
  pi.on('input', async (event, ctx) => {
    rt.latestCtx = ctx
    if (!rt.running) return
    const request = rt.queue.observeInput(event.text, event.images, event.source)
    if (!request || !ctx.isIdle()) return
    const requestClient = rt.client
    const requestSignal = rt.pollAbort?.signal
    // sendUserMessage() returns void and Pi reports pre-run rejections only to its UI.
    // Check public model/auth state for our idle inputs; do not inspect credentials.
    let problem: string | undefined
    const model = ctx.model
    if (!model) problem = '尚未选择模型，请在 Pi 中选择模型后重新发送。'
    else if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      // Auth is resolved lazily; a false synchronous snapshot is not a failure.
      try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
        if (!auth.ok) problem = summarizeModelError(auth.error)
      } catch (error) { problem = summarizeModelError(formatError(error)) }
    }
    if (!rt.running || !rt.queue.hasSubmittedRequest(request)) return { action: 'handled' as const }
    if (!problem || ctx.model !== model) return
    rt.queue.discardSubmittedRequest(request)
    await requestClient?.stopTyping(request.userId).catch(() => {})
    try {
      if (rt.running && !requestSignal?.aborted && rt.client === requestClient) {
        await rt.sendReply(request.userId, `⚠️ 无法开始模型请求：${problem}`, ctx)
      }
    }
    catch (error) { debugLog(`模型启动错误通知发送失败: ${debugError(error)}`) }
    rt.updateStatusBar()
    setImmediate(() => void rt.queue.drain())
    return { action: 'handled' as const }
  })

  pi.on('message_start', async (event, ctx) => {
    rt.latestCtx = ctx
    if (event.message.role !== 'user') return
    const previous = rt.queue.activeRequest
    const request = rt.running ? rt.queue.consumeSubmittedRequest(event.message.content) : null
    rt.modelFailure.reset()
    rt.queue.activeRequest = request
    if (previous && previous !== request) void rt.client?.stopTyping(previous.userId).catch(() => {})
    rt.turn.wechatConversationActive = request !== null
    rt.turn.targetUser = request?.userId ?? (rt.running ? rt.client?.userId ?? null : null)
    const config = resolveConfig()
    const useSummary = rt.turn.targetUser !== null && (rt.turn.wechatConversationActive || config.bidirectionalSync)
      && config.completionSummary
    rt.completionSummary.beginRequest(useSummary
      ? request?.text || request?.preview || extractTextFromMessageContent(event.message.content) || '本轮请求'
      : null, request !== null)
    rt.updateStatusBar()
    setImmediate(() => void rt.queue.drain())
    if (!request && rt.running && rt.client && config.bidirectionalSync) {
      const content = event.message.content
      const text = extractTextFromMessageContent(content)
      const imageCount = Array.isArray(content) ? content.filter(part => part.type === 'image').length : 0
      const preview = text
        ? text + (imageCount ? `\n[附带 ${imageCount} 张图片]` : '')
        : imageCount ? `发送了 ${imageCount} 张图片` : null
      if (preview) {
        const signal = rt.pollAbort?.signal
        try {
          for (const chunk of splitAndFilterMarkdown(`[电脑端] ${preview}`)) {
            if (!rt.running || signal?.aborted) break
            await rt.client.sendText(rt.client.userId, chunk)
          }
        } catch (error) { debugLog(`TUI 输入同步失败: ${debugError(error)}`) }
      }
    }
  })

  pi.on('before_agent_start', (event, ctx) => {
    // Pi normalizes the starting images after this hook, changing both image
    // bytes and text. Bind only the exact input observed before the hook;
    // custom starts without these fields must not inherit it.
    rt.queue.prepareImageRun('prompt' in event ? event.prompt : undefined, 'images' in event ? event.images : undefined)
    rt.latestCtx = ctx
    rt.agentPreparing = true
    rt.modelFailure.reset()
    rt.completionSummary.reset()
    rt.turn.wechatConversationActive = false
    rt.turn.targetUser = null
    rt.queue.activeRequest = null
    if (!rt.running && rt.toolsRegistered) rt.pruneWechatTools()
    const config = resolveConfig()
    if (!rt.running || !config.sourceEnabled || rt.wechatPrompt.rules === null) return
    const rules = config.completionSummary
      ? rt.wechatPrompt.rules + '\n' + SUMMARY_REPLY_RULE : rt.wechatPrompt.rules
    return {
      systemPrompt: appendWechatSystemRules(event.systemPrompt, rules, config.wechatTag),
    }
  })

  // Block known TUI-only question tools for a confirmed WeChat request; the
  // host also emits tool_call for nested calls made through codemode.
  pi.on('tool_call', async (event, ctx) => {
    rt.latestCtx = ctx
    if (!rt.running && WECHAT_TOOL_NAMES.includes(event.toolName)) {
      return { block: true, reason: await stoppedBridgeReason() }
    }
    if (!rt.running || !rt.turn.wechatConversationActive) return
    if (!rt.queue.activeRequest?.replyProfile?.blockedTools.includes(event.toolName)) return
    return {
      block: true,
      reason: '当前请求来自微信，请直接在回复正文中提问，用简单编号列出选项并说明如何回复。'
        + '提出问题后结束本次回复，等待下一条微信消息，不要打开本机 TUI 提问界面。',
    }
  })

  // agent 开始 → 记录 turn 元数据
  pi.on('agent_start', async (_event, ctx) => {
    rt.turn.seq++
    rt.latestCtx = ctx
    rt.agentPreparing = false
    rt.turn.sentCount = 0

    // Retry loops have no new user message; retain its source and question guard.
    rt.modelFailure.startAttempt()
    rt.completionSummary.startAttempt()
    setImmediate(() => void rt.queue.drain())
  })

  // 增量发送；来源识别保留，双向配置决定是否同步 TUI 回合。
  pi.on('message_end', async (event, ctx) => {
    if (event.message.role !== 'assistant') return
    if (!rt.running || !rt.client) return
    rt.modelFailure.observe(event.message, ctx.signal)
    const syncReply = rt.turn.wechatConversationActive || resolveConfig().bidirectionalSync
    rt.completionSummary.observe(event.message, syncReply, ctx.signal)
    if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
      // Never forward failed partial output: retries may replay it.
      return
    }
    if (rt.completionSummary.active || !syncReply) return

    const targetUserId = rt.turn.targetUser ?? rt.client.userId
    if (!targetUserId) {
      debugLog(`[MSG-END-SKIP] no target user`)
      return
    }

    const text = extractTextFromMessageContent(event.message.content)
    if (!text) {
      debugLog(`[MSG-END-SKIP] no text content (likely toolCall only)`)
      return
    }

    debugLog(`[MSG-END] incremental send, textLen=${text.length} sentCount=${rt.turn.sentCount}`)

    try {
      const result = await rt.sendReply(targetUserId, text, ctx)
      if (result === 'sent') rt.turn.sentCount++
      debugLog(`[MSG-END-DONE] delivery=${result} totalSent=${rt.turn.sentCount}`)
    } catch (err) {
      debugLog(`[MSG-END-ERROR] ${debugError(err)}`)
    }
  })

  // agent 结束 → 收尾
  pi.on('agent_end', async (event, ctx) => {
    rt.queue.clearPreparedRun()
    rt.latestCtx = ctx
    rt.agentPreparing = false

    const messages = event.messages
    const assistantMsgs = messages.filter(m => m?.role === 'assistant').length
    debugLog(`[AGENT-END] turn#${rt.turn.seq} source=${rt.turn.wechatConversationActive ? 'WECHAT' : 'TUI'} hasTarget=${!!rt.turn.targetUser} messages=${messages.length} assistant=${assistantMsgs} sentCount=${rt.turn.sentCount}`)

    if (rt.queue.activeRequest) {
      await rt.client?.stopTyping(rt.queue.activeRequest.userId).catch(() => {})
    }
    rt.updateStatusBar()

    setImmediate(() => void rt.queue.drain())
  })

  pi.on('agent_before_settle', event => {
    rt.modelFailure.beforeSettle(event.outcome)
    rt.completionSummary.beforeSettle(event.outcome)
  })

  pi.on('agent_settled', async (event, ctx) => {
    rt.queue.clearPreparedRun()
    rt.latestCtx = ctx
    const syncDesktop = resolveConfig().bidirectionalSync
    const failure = rt.turn.targetUser && (rt.turn.wechatConversationActive || syncDesktop)
      ? rt.modelFailure.take(event.aborted) : null
    const summarized = rt.completionSummary.active
    const summary = rt.completionSummary.take(failure, event.aborted, syncDesktop)
    const chunks = summary ? [summary] : []
    if (!summarized && failure) chunks.push(...splitAndFilterMarkdown(failure))
    const target = rt.turn.targetUser ?? rt.client?.userId
    // Claim this delivery before awaiting I/O. A new request may start during the send.
    rt.modelFailure.reset()
    rt.queue.activeRequest = null
    rt.turn.wechatConversationActive = false
    rt.turn.targetUser = null
    if (target && chunks.length) {
      try { await rt.deliverReply(target, chunks, ctx) }
      catch (error) { debugLog(`微信收尾通知发送失败: ${debugError(error)}`) }
    }
  })

  // 会话关闭 → 清理 + 落盘 context tokens
  pi.on('session_shutdown', async (_event, ctx) => {
    rt.latestCtx = ctx
    try {
      await rt.stopBridge({ releaseLock: true })
      await rt.disposeClient()
    } finally {
      process.removeListener('SIGINT', exitHandler)
      process.removeListener('SIGTERM', exitHandler)
      process.removeListener('beforeExit', exitHandler)
    }
  })

  // --- 进程退出清理 ---

  const exitHandler = () => {
    // Never release ownership while this process is still polling or sending.
    void rt.stopBridge({ releaseLock: true }).then(() => rt.disposeClient()).catch(error => debugLog(debugError(error)))
  }

  process.once('SIGINT', exitHandler)
  process.once('SIGTERM', exitHandler)
  process.once('beforeExit', exitHandler)
}
