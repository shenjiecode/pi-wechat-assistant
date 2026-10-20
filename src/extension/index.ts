import { loadConfig, getConfigCache } from '../bridge/config.js'
// ============================================================================
// pi-wechat-assistant — 微信作为 pi TUI 的移动端分身
// ============================================================================

import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
// Type-only legacy import also works in hosts that only provide @earendil-works.
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { SessionExpiredError, WeixinClient } from '../wechat/client.js'
import { acquireLock, releaseLock, requestHandoff, hasHandoffRequest, loadCredentials, getBridgeLockState } from '../bridge/auth.js'
import { registerWechatTools as registerSendTools, stoppedBridgeReason } from './send-tools.js'
import { debugLog } from '../shared/logger.js'
import { splitAndFilterMarkdown } from '../messaging/message.js'
import { MessageQueue } from '../bridge/queue.js'
import { handleRemoteCommand, type RemoteCommandDeps } from './remote-commands.js'
import { registerCommands, startBridge, cancelBridgeStart, type CommandDeps } from './commands.js'
import { formatError, isAbortError, extractTextFromMessageContent } from '../shared/utils.js'
import { isAuthorizedWeChatSender } from '../wechat/security.js'
import {
  POLL_RETRY_BASE_MS,
  POLL_RETRY_MAX_MS,
  UNSUPPORTED_TYPES,
  UNSUPPORTED_REPLY,
  WECHAT_FILES_SUBDIR,
} from '../shared/constants.js'
import type { IncomingMessage } from '../wechat/types.js'
import { WechatPrompt } from '../messaging/wechat-prompt.js'
import { appendWechatSystemRules, WECHAT_SOURCE_TAG } from '../messaging/wechat-source.js'
import { formatWechatStatus } from './status.js'
import { ModelFailureNotice, hasSettledEvents, failureNoticeMode, summarizeModelError, type FailureNoticeMode } from './model-failure.js'

const WECHAT_TOOL_NAMES = ['send_file_to_wechat', 'send_image_to_wechat']
const WECHAT_TOOL_STATUS_TYPE = 'wechat-assistant-tool-status'

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

// ============================================================================
// Extension
// ============================================================================

export default function wechatAssistant(pi: ExtensionAPI) {
  const modelFailure = new ModelFailureNotice()
  let client: WeixinClient | null = null
  let running = false
  let agentIdle = true
  let agentPreparing = false
  let pollAbort: AbortController | null = null
  let pollTask: Promise<void> | null = null
  let stopping: Promise<void> | null = null
  let latestCtx: Ctx | null = null
  let wechatFilesDir: string | null = null

  const turn = new TurnContext()
  let lockSessionId: string | null = null
  const wechatPrompt = new WechatPrompt()
  let toolsRegistered = false

  // --- 消息队列 ---
  const queue = new MessageQueue(
    () => client,
    () => running,
    () => latestCtx?.isIdle() ?? agentIdle,
    () => pollAbort?.signal,
    () => wechatFilesDir,
    (content, opts) => pi.sendUserMessage(content as any, opts),
    updateStatusBar,
    () => !agentPreparing,
  )

  // --- 通知 ---

  function log(message: string): void { debugLog(message) }

  function notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    if (latestCtx?.hasUI) {
      // Never also print to stdout here: in TUI/RPC modes a stray console.log
      // paints over the interface (it once showed up inside the editor box).
      latestCtx.ui.notify(message, level)
      return
    }
    const printer = level === 'error' ? console.error : console.log
    printer(`[wechat-assistant/${level}] ${message}`)
  }

  function updateStatusBar(): void {
    if (!latestCtx?.hasUI) return
    if (!client && !running) { latestCtx.ui.setStatus('wechat', ''); return }
    latestCtx.ui.setStatus('wechat', formatWechatStatus({
      running,
      bidirectional: getConfigCache().bidirectionalSync === true,
      pending: queue.pending,
      sendFailed: client?.lastSend?.success === false,
    }))
  }

  // --- 锁 ---

  function getLockId(): string {
    if (!lockSessionId) lockSessionId = `pi-wechat-${process.pid}-${randomUUID()}`
    return lockSessionId
  }

  async function lock(): Promise<{ success: boolean; message: string }> {
    const id = getLockId()
    const result = await acquireLock(id)
    if (result.success) lockSessionId = id
    return result
  }

  async function unlock(): Promise<void> {
    if (lockSessionId) await releaseLock(lockSessionId)
    lockSessionId = null
  }

  async function loadClient(): Promise<WeixinClient | null> {
    if (!client) {
      const creds = await loadCredentials()
      if (creds) {
        setClient(await WeixinClient.create(creds))
      }
    }
    return client
  }

  function setClient(value: WeixinClient | null): void {
    if (client) {
      client.onStatusChange = undefined
      client.onNeedsFreshContext = undefined
    }
    client = value
    if (client) {
      client.onStatusChange = updateStatusBar
      client.onNeedsFreshContext = () =>
        notify('微信发送被拒（ret=-2）：通常需要你先从微信发送一条消息激活会话，之后本端即可直接回复。', 'warning')
    }
    queue.lastWechatUser = client ? { userId: client.userId, contextToken: '' } : null
  }

  async function disposeClient(): Promise<void> {
    if (client) {
      await client.dispose()
    }
    setClient(null)
  }

  let bridgeWatch: ReturnType<typeof setInterval> | null = null

  function stopBridgeWatch(): void {
    if (bridgeWatch) { clearInterval(bridgeWatch); bridgeWatch = null }
  }

  let checkingOwnership = false
  async function checkBridgeOwnership(): Promise<void> {
    if (!running || checkingOwnership || !lockSessionId) return
    checkingOwnership = true
    const id = lockSessionId
    try {
      const requested = await hasHandoffRequest(id)
      if (!running || lockSessionId !== id) return
      if (requested) {
        notify('收到微信桥接交接请求，正在停止本会话桥接并释放锁…', 'warning')
        await stopBridge({ releaseLock: true })
        return
      }
      const state = await getBridgeLockState()
      if (!running || lockSessionId !== id) return
      if (state.kind === 'current' && state.sessionId === id) return
      notify('微信桥接锁归属已变化或无法确认，本会话正在停止，请检查 /wechat status。', 'warning')
      await stopBridge({ releaseLock: true })
    } catch (error) {
      log(`桥接交接检查失败: ${formatError(error)}`)
    } finally { checkingOwnership = false }
  }

  function startBridgeWatch(): void {
    stopBridgeWatch()
    bridgeWatch = setInterval(() => { void checkBridgeOwnership() }, 1_000)
    bridgeWatch.unref?.()
  }

  // --- 停止 ---

  function stopBridge(options: { releaseLock?: boolean } = {}): Promise<void> {
    cancelBridgeStart(commandDeps)
    if (stopping) return stopping
    const task = stopBridgeInner(options)
    stopping = task
    void task.finally(() => { if (stopping === task) stopping = null }).catch(() => {})
    return task
  }

  async function stopBridgeInner(options: { releaseLock?: boolean }): Promise<void> {
    const wasRunning = running
    running = false
    stopBridgeWatch()
    modelFailure.reset()
    wechatPrompt.clear()
    if (toolsRegistered) {
      registerWechatTools(false)
      const active = pi.getActiveTools()
      const remaining = active.filter(name => !WECHAT_TOOL_NAMES.includes(name))
      if (remaining.length !== active.length) pi.setActiveTools(remaining)
    }
    pollAbort?.abort()
    const sendsFinished = client?.pauseSending()
    const typingUser = queue.activeRequest?.userId
    queue.reset()
    turn.reset()
    updateStatusBar()
    // Keep the lock until the old receiver and its persistent writes have settled.
    await pollTask?.catch(error => log(`轮询退出: ${formatError(error)}`))
    pollAbort = null
    await sendsFinished
    if (wasRunning && client) {
      await client.flushReceiveState()
      await client.notifyStop().catch(error => {
        log(`notifyStop 失败（不阻断停止）: ${formatError(error)}`)
        notify(`微信下线状态同步失败，本地桥接已停止：${formatError(error)}。详情见 /wechat status。`, 'warning')
      })
    }
    if (typingUser && client) await client.stopTyping(typingUser).catch(() => {})
    if (options.releaseLock) await unlock()
    updateStatusBar()
  }

  // --- 桥接能力：只在启动时注册并激活；回复规则固定加入系统提示词 ---

  async function preflightBridge(): Promise<void> {
    await stopping
    if (getConfigCache().messageSourceTag?.enabled !== false) await wechatPrompt.load()
  }

  async function prepareBridge(): Promise<void> {
    client?.resumeSending()
    registerWechatTools(true)
    const active = pi.getActiveTools()
    const missing = WECHAT_TOOL_NAMES.filter(name => !active.includes(name))
    if (missing.length) pi.setActiveTools([...active, ...missing])
  }

  // --- 轮询 ---

  function pollMessages(activeClient: WeixinClient): Promise<void> {
    const task = runPoll(activeClient, pollAbort!.signal)
    pollTask = task
    startBridgeWatch()
    void task.finally(() => {
      if (pollTask === task) pollTask = null
      if (running) void stopBridge({ releaseLock: true }).catch(error => log(formatError(error)))
    }).catch(() => {})
    return task
  }

  async function runPoll(activeClient: WeixinClient, signal: AbortSignal): Promise<void> {
    await activeClient.notifyStart().catch(error => {
      log(`notifyStart 失败（不阻断启动）: ${formatError(error)}`)
      notify(`微信上线状态同步失败，本地桥接继续运行：${formatError(error)}。详情见 /wechat status。`, 'warning')
    })
    let retryDelay = POLL_RETRY_BASE_MS
    while (running && !signal.aborted && client === activeClient) {
      try {
        const messages = await activeClient.getUpdates(signal)
        retryDelay = POLL_RETRY_BASE_MS
        for (const message of messages) {
          if (!running || signal.aborted) break
          await handleIncomingMessage(message, activeClient)
        }
      } catch (error) {
        if (isAbortError(error)) break
        if (error instanceof SessionExpiredError) {
          notify('微信凭证失效，请手动执行 /wechat login --force 重新登录', 'error')
          break
        }
        log(`轮询失败: ${formatError(error)}`)
        try { await delay(retryDelay, undefined, { signal }) } catch { break }
        retryDelay = Math.min(retryDelay * 2, POLL_RETRY_MAX_MS)
      }
    }
  }

  // --- 单条消息处理 ---

  async function handleIncomingMessage(message: IncomingMessage, activeClient: WeixinClient): Promise<void> {
    // 客户端入口已有同样校验；这里保留边界防御，防止未来新增调用路径时绕过。
    if (!isAuthorizedWeChatSender(message.raw.from_user_id, activeClient.userId)) {
      log(`[AUTH] 丢弃未绑定用户消息: ${message.raw.from_user_id || '(empty)'}`)
      return
    }
    log(`收到消息: type=${message.type}, text=${message.text?.slice(0, 50)}, images=${message.imageUrls.length}`)

    if (UNSUPPORTED_TYPES.has(message.type)) {
      const reply = UNSUPPORTED_REPLY[message.type] ?? UNSUPPORTED_REPLY['unknown']
      try {
        await activeClient.sendText(message.userId, reply)
      } catch (err) {
        log(`回复不支持类型消息失败: ${formatError(err)}`)
      }
      return
    }

    if (message.text.startsWith('/')) {
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
    isRemoteToolsEnabled: async () => (await loadConfig()).allowRemoteTools === true,
  }

  // --- TUI 命令注册 ---

  const commandDeps: CommandDeps = {
    pi,
    prepareBridge,
    preflightBridge,
    wechatPrompt,
    getClient: () => client,
    setClient,
    loadClient,
    isRunning: () => running,
    setRunning: (v) => { running = v; if (v) agentIdle = true },
    requestHandoff,
    setPollAbort: (c) => { pollAbort = c },
    queue,
    lock,
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

  function registerWechatTools(enabled: boolean): void {
    registerSendTools(pi, enabled, { getClient: () => client, isRunning: () => running, latestCtx: () => latestCtx })
    toolsRegistered = true
  }

  // ============================================================================
  // 事件处理
  // ============================================================================

  pi.on('session_start', async (_event, ctx) => {
    latestCtx = ctx
    wechatFilesDir = path.join(ctx.cwd, WECHAT_FILES_SUBDIR)
    await loadClient()
    updateStatusBar()

    const config = await loadConfig()
    // TUI auto-start keeps the manual behaviour, including the takeover prompt;
    // headless modes show the plain lock diagnostic without prompting.
    if (config.autoStart && client) await startBridge('', ctx, commandDeps, ctx.hasUI)
  })

  // Transient model context only: never persist stale stop notices in the session.
  pi.on('context', (event) => {
    const messages = event.messages.filter(message =>
      !(message.role === 'custom' && message.customType === WECHAT_TOOL_STATUS_TYPE))
    if (toolsRegistered && !running) {
      messages.push({
        role: 'custom', customType: WECHAT_TOOL_STATUS_TYPE, display: false, timestamp: Date.now(),
        content: '微信桥接当前已停止，send_file_to_wechat 和 send_image_to_wechat 均不可用。'
          + '不要依据历史中的工具说明尝试发送，也不要声称已发送；用户执行 /wechat start 后才会恢复。',
      })
    }
    if (messages.length !== event.messages.length || (toolsRegistered && !running)) return { messages }
  })

  // Input may be queued: do not change the running reply's source here.
  pi.on('input', async (event, ctx) => {
    latestCtx = ctx
    if (!running) return
    const request = queue.observeInput(event.text, event.images, event.source)
    if (!request || !ctx.isIdle()) return
    const requestClient = client
    const requestSignal = pollAbort?.signal
    // sendUserMessage() returns void and Pi reports pre-run rejections only to its UI.
    // Check public model/auth state for our idle inputs; do not inspect credentials.
    let problem: string | undefined
    const model = ctx.model
    if (!model) problem = '尚未选择模型，请在 Pi 中选择模型后重新发送。'
    else if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      if (!hasSettledEvents(ctx)) problem = '当前模型未配置可用的认证信息，请在 Pi 中检查模型配置或重新登录。'
      else {
        // New hosts can resolve auth lazily; a false synchronous snapshot is not a failure.
        try {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
          if (!auth.ok) problem = summarizeModelError(auth.error)
        } catch (error) { problem = summarizeModelError(formatError(error)) }
      }
    }
    if (!running || !queue.hasSubmittedRequest(request)) return { action: 'handled' as const }
    if (!problem || ctx.model !== model) return
    queue.discardSubmittedRequest(request)
    await requestClient?.stopTyping(request.userId).catch(() => {})
    try {
      if (running && !requestSignal?.aborted && client === requestClient) {
        await requestClient?.sendText(request.userId, `⚠️ 无法开始模型请求：${problem}`)
      }
    }
    catch (error) { log(`模型启动错误通知发送失败: ${formatError(error)}`) }
    updateStatusBar()
    setImmediate(() => void queue.drain())
    return { action: 'handled' as const }
  })

  pi.on('message_start', async (event, ctx) => {
    latestCtx = ctx
    if (event.message.role !== 'user') return
    const previous = queue.activeRequest
    const request = running ? queue.consumeSubmittedRequest(event.message.content) : null
    modelFailure.reset()
    queue.activeRequest = request
    if (previous && previous !== request) void client?.stopTyping(previous.userId).catch(() => {})
    turn.wechatConversationActive = request !== null
    turn.targetUser = request?.userId ?? (running ? client?.userId ?? null : null)
    updateStatusBar()
    setImmediate(() => void queue.drain())
    if (!request && running && client && getConfigCache().bidirectionalSync === true) {
      const content = event.message.content
      const text = extractTextFromMessageContent(content)
      const imageCount = Array.isArray(content) ? content.filter(part => part.type === 'image').length : 0
      const preview = text
        ? text + (imageCount ? `\n[附带 ${imageCount} 张图片]` : '')
        : imageCount ? `发送了 ${imageCount} 张图片` : null
      if (preview) {
        const signal = pollAbort?.signal
        try {
          for (const chunk of splitAndFilterMarkdown(`[电脑端] ${preview}`)) {
            if (!running || signal?.aborted) break
            await client.sendText(client.userId, chunk)
          }
        } catch (error) { log(`TUI 输入同步失败: ${formatError(error)}`) }
      }
    }
  })

  // Hold submissions during preparation on older Pi. Append the same conditional
  // rules section to every run while the bridge runs; the section itself limits
  // application to requests that start with the WeChat marker.
  pi.on('before_agent_start', (event, ctx) => {
    latestCtx = ctx
    agentPreparing = true
    modelFailure.reset()
    turn.wechatConversationActive = false
    turn.targetUser = null
    queue.activeRequest = null
    if (!running && toolsRegistered) {
      const active = pi.getActiveTools()
      const remaining = active.filter(name => !WECHAT_TOOL_NAMES.includes(name))
      if (remaining.length !== active.length) pi.setActiveTools(remaining)
    }
    const source = getConfigCache().messageSourceTag
    if (!running || source?.enabled === false || wechatPrompt.rules === null) return
    return {
      systemPrompt: appendWechatSystemRules(event.systemPrompt, wechatPrompt.rules, source?.wechatTag?.trim() || WECHAT_SOURCE_TAG),
    }
  })

  // Block known TUI-only question tools for a confirmed WeChat request. Modern
  // Pi also emits tool_call for nested calls made through codemode.
  pi.on('tool_call', async (event, ctx) => {
    latestCtx = ctx
    if (!running && WECHAT_TOOL_NAMES.includes(event.toolName)) {
      return { block: true, reason: await stoppedBridgeReason() }
    }
    if (!running || !turn.wechatConversationActive) return
    if (!queue.activeRequest?.replyProfile?.blockedTools.includes(event.toolName)) return
    return {
      block: true,
      reason: '当前请求来自微信，请直接在回复正文中提问，用简单编号列出选项并说明如何回复。'
        + '提出问题后结束本次回复，等待下一条微信消息，不要打开本机 TUI 提问界面。',
    }
  })

  // agent 开始 → 记录 turn 元数据
  pi.on('agent_start', async (_event, ctx) => {
    turn.seq++
    latestCtx = ctx
    agentIdle = false
    agentPreparing = false
    turn.sentCount = 0
    turn.messages = null
    turn.ended = false

    // Retry loops have no new user message; retain its source and question guard.
    modelFailure.startAttempt()
    setImmediate(() => void queue.drain())
  })

  // 增量发送；来源识别保留，双向配置决定是否同步 TUI 回合。
  pi.on('message_end', async (event, ctx) => {
    if (event.message.role !== 'assistant') return
    if (!running || !client) return
    modelFailure.observe(event.message, ctx.signal)
    if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
      // Never forward failed partial output: retries may replay it.
      if (!hasSettledEvents(ctx) && event.message.stopReason === 'error') await sendModelFailure('attempt')
      return
    }
    if (!turn.wechatConversationActive && getConfigCache().bidirectionalSync !== true) return

    const targetUserId = turn.targetUser ?? client.userId
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

    const sendSignal = pollAbort?.signal
    try {
      const chunks = splitAndFilterMarkdown(text)
      for (let i = 0; i < chunks.length; i++) {
        if (!running || sendSignal?.aborted) break
        log(`[MSG-END-CHUNK] ${i + 1}/${chunks.length} len=${chunks[i].length}`)
        await client.sendText(targetUserId, chunks[i])
      }
      turn.sentCount++
      log(`[MSG-END-DONE] incrementally sent, totalSent=${turn.sentCount}`)
    } catch (err) {
      log(`[MSG-END-ERROR] ${formatError(err)}`)
    }
  })

  // agent 结束 → 收尾（补发已移除：message_end 已逐条增量发送，
  // 补发依赖 event.messages 为“本次 run”的范围假设，omp -c 恢复会话后
  // messages 含全量历史，slice(sentCount) 会把历史回复全部重发到微信）
  pi.on('agent_end', async (event, ctx) => {
    latestCtx = ctx
    agentIdle = true
    agentPreparing = false
    turn.ended = true
    turn.messages = event.messages as Array<{ role?: string; content?: unknown }>

    const msgCount = turn.messages.length
    const assistantMsgs = turn.messages.filter(m => m?.role === 'assistant').length
    log(`[AGENT-END] turn#${turn.seq} source=${turn.wechatConversationActive ? 'WECHAT' : 'TUI'} targetUser=${turn.targetUser} messages=${msgCount} assistant=${assistantMsgs} sentCount=${turn.sentCount}`)

    if (queue.activeRequest) {
      await client?.stopTyping(queue.activeRequest.userId).catch(() => {})
    }
    updateStatusBar()

    log(`[AGENT-END-DEFER] deferring drainQueue`)
    setImmediate(() => void queue.drain())
  })

  async function sendModelFailure(mode: FailureNoticeMode, aborted = false): Promise<void> {
    if (!running || !client || !turn.targetUser) return
    if (!turn.wechatConversationActive && getConfigCache().bidirectionalSync !== true) return
    const notice = modelFailure.take(mode, aborted)
    if (!notice) return
    try { await client.sendText(turn.targetUser, notice) }
    catch (error) { log(`模型错误通知发送失败: ${formatError(error)}`) }
  }

  // Old loaders accept unknown event registrations but never dispatch them.
  // Keep the optional-event cast isolated; the API matrix checks the capability probe.
  const onSettlement = pi.on as unknown as (
    name: 'agent_before_settle' | 'agent_settled',
    handler: (event: { outcome?: string; aborted?: boolean }, ctx: ExtensionContext) => void | Promise<void>,
  ) => unknown
  const boundarySubscription = onSettlement('agent_before_settle', event => { modelFailure.beforeSettle(event.outcome ?? '') })
  onSettlement('agent_settled', async (event, ctx) => {
    latestCtx = ctx
    const sending = sendModelFailure(failureNoticeMode(ctx, boundarySubscription), event.aborted === true)
    modelFailure.reset()
    queue.activeRequest = null
    turn.wechatConversationActive = false
    turn.targetUser = null
    await sending
  })

  // 会话关闭 → 清理 + 落盘 context tokens
  pi.on('session_shutdown', async (_event, ctx) => {
    latestCtx = ctx
    await stopBridge({ releaseLock: true })
    await disposeClient()
  })

  // --- 进程退出清理 ---

  const exitHandler = () => {
    // Never release ownership while this process is still polling or sending.
    void stopBridge({ releaseLock: true }).then(disposeClient).catch(error => log(formatError(error)))
  }

  process.once('SIGINT', exitHandler)
  process.once('SIGTERM', exitHandler)
  process.once('beforeExit', exitHandler)
}
