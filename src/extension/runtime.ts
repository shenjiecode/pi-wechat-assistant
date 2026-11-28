// ============================================================================
// BridgeRuntime — 微信桥接的全部可变状态与生命周期
// ============================================================================

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { SessionExpiredError, WeixinClient } from '../wechat/client.js'
import {
  acquireLock,
  releaseLock,
  requestHandoff,
  hasHandoffRequest,
  loadCredentials,
  getBridgeLockState,
} from '../bridge/auth.js'
import { loadConfig } from '../bridge/config.js'
import { resolveConfig } from '../bridge/config-values.js'
import { registerWechatTools as registerSendTools } from './send-tools.js'
import { debugLog, debugError } from '../shared/logger.js'
import { bridgeLockMetadata, bridgeStartBlocker, type BridgeLockState } from '../bridge/bridge-lock.js'
import { splitAndFilterMarkdown } from '../messaging/message.js'
import { MessageQueue } from '../bridge/queue.js'
import { ReplyOutbox, OutboxStorageError, type OutboxStatus, type ReplyTransport } from '../bridge/outbox.js'
import { formatError, isAbortError } from '../shared/utils.js'
import { isAuthorizedWeChatSender } from '../wechat/security.js'
import {
  POLL_RETRY_BASE_MS,
  POLL_RETRY_MAX_MS,
  UNSUPPORTED_TYPES,
  UNSUPPORTED_REPLY,
} from '../shared/constants.js'
import type { IncomingMessage } from '../wechat/types.js'
import { WechatPrompt } from '../messaging/wechat-prompt.js'
import { formatWechatStatus } from './status.js'
import { ModelFailureNotice } from './model-failure.js'
import { CompletionSummary } from './completion-summary.js'
import { handleRemoteCommand } from './remote-commands.js'
import type { NewSessionController } from './new-session.js'
import { BridgeHandoffError, type BridgeLockResult } from '../bridge/bridge-ownership.js'

export type Ctx = ExtensionContext | ExtensionCommandContext

export const WECHAT_TOOL_NAMES = ['send_file_to_wechat', 'send_image_to_wechat']
export const WECHAT_TOOL_STATUS_TYPE = 'wechat-assistant-tool-status'

// ============================================================================
// TurnContext — 单轮对话会话状态
// ============================================================================

class TurnContext {
  seq = 0
  wechatConversationActive = false
  targetUser: string | null = null
  sentCount = 0

  reset(): void {
    this.wechatConversationActive = false
    this.targetUser = null
    this.sentCount = 0
  }
}

export class BridgeRuntime {
  readonly pi: ExtensionAPI
  readonly wechatPrompt = new WechatPrompt()
  readonly turn = new TurnContext()
  readonly modelFailure = new ModelFailureNotice()
  readonly completionSummary = new CompletionSummary()
  readonly queue: MessageQueue
  /** Assigned right after registerNewSession; remote /new and dispatch rely on it. */
  newSession!: NewSessionController

  client: WeixinClient | null = null
  outbox: ReplyOutbox | null = null
  running = false
  agentPreparing = false
  latestCtx: Ctx | null = null
  pendingPollMessages = 0
  wechatFilesDir: string | null = null
  toolsRegistered = false
  pollAbort: AbortController | null = null

  private lockSessionId: string | null = null
  private pollTask: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private bridgeWatch: ReturnType<typeof setInterval> | null = null
  private checkingOwnership = false
  private pendingStart: AbortController | null = null

  constructor(pi: ExtensionAPI) {
    this.pi = pi
    this.queue = new MessageQueue(
      () => this.client,
      () => this.running,
      () => this.latestCtx?.isIdle() ?? true,
      () => this.pollAbort?.signal,
      () => this.wechatFilesDir,
      (content, opts) => pi.sendUserMessage(content as any, opts),
      () => this.updateStatusBar(),
      () => !this.agentPreparing,
    )
  }

  // --- 通知与状态栏 ---

  notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    if (this.latestCtx?.hasUI) {
      // Never also print to stdout: in TUI/RPC modes it paints over the interface.
      this.latestCtx.ui.notify(message, level)
      return
    }
    const printer = level === 'error' ? console.error : console.log
    printer(`[wechat-assistant/${level}] ${message}`)
  }

  updateStatusBar(): void {
    const ctx = this.latestCtx
    if (!ctx?.hasUI) return
    if (!this.client && !this.running) { ctx.ui.setStatus('wechat', ''); return }
    ctx.ui.setStatus('wechat', formatWechatStatus({
      running: this.running,
      bidirectional: resolveConfig().bidirectionalSync,
      pending: this.queue.pending,
      pendingReplies: this.outbox?.status.pending,
      uncertainReplies: this.outbox?.status.uncertain,
      sendFailed: this.client?.lastSend?.success === false,
    }))
  }

  outboxStatus(): OutboxStatus {
    return this.outbox?.status ?? { pending: 0, uncertain: 0 }
  }

  // --- 客户端 ---

  async loadClient(): Promise<WeixinClient | null> {
    if (!this.client) {
      const creds = await loadCredentials()
      if (creds) this.setClient(await WeixinClient.create(creds))
    }
    return this.client
  }

  setClient(value: WeixinClient | null): void {
    if (this.client) {
      this.client.onStatusChange = undefined
      this.client.onNeedsFreshContext = undefined
    }
    this.client = value
    this.outbox = null
    if (value) {
      value.onStatusChange = () => this.updateStatusBar()
      value.onNeedsFreshContext = () =>
        this.notify('微信发送被拒（ret=-2）：请从微信发送一条消息激活会话后重试。', 'warning')
    }
  }

  async disposeClient(): Promise<void> {
    if (this.client) await this.client.dispose()
    this.setClient(null)
  }

  async isRemoteToolsEnabled(): Promise<boolean> {
    return resolveConfig(await loadConfig()).allowRemoteTools
  }

  // --- 锁 ---

  private getLockId(): string {
    if (!this.lockSessionId) this.lockSessionId = `pi-wechat-${process.pid}-${randomUUID()}`
    return this.lockSessionId
  }

  lock(): Promise<BridgeLockResult> {
    return acquireLock(this.getLockId())
  }

  private async unlock(): Promise<void> {
    if (this.lockSessionId) await releaseLock(this.lockSessionId)
    this.lockSessionId = null
  }

  // --- 桥接锁归属监控 ---

  private stopBridgeWatch(): void {
    if (this.bridgeWatch) { clearInterval(this.bridgeWatch); this.bridgeWatch = null }
  }

  private startBridgeWatch(): void {
    this.stopBridgeWatch()
    this.bridgeWatch = setInterval(() => { void this.checkBridgeOwnership() }, 1_000)
    this.bridgeWatch.unref?.()
  }

  private async checkBridgeOwnership(): Promise<void> {
    if (!this.running || this.checkingOwnership || !this.lockSessionId) return
    this.checkingOwnership = true
    const id = this.lockSessionId
    try {
      const requested = await hasHandoffRequest(id)
      if (!this.running || this.lockSessionId !== id) return
      if (requested) {
        debugLog(`[bridge-handoff] callerPid=${process.pid} event=request-received`)
        this.notify('收到微信桥接交接请求，正在停止本会话桥接并释放锁…', 'warning')
        await this.stopBridge({ releaseLock: true })
        return
      }
      const state = await getBridgeLockState()
      if (!this.running || this.lockSessionId !== id) return
      if (state.kind === 'current' && state.sessionId === id) return
      debugLog(`[bridge-handoff] callerPid=${process.pid} event=ownership-changed ${bridgeLockMetadata(state)}`)
      this.notify('微信桥接锁归属已变化或无法确认，本会话正在停止，请检查 /wechat status。', 'warning')
      await this.stopBridge({ releaseLock: true })
    } catch (error) {
      debugLog(`桥接交接检查失败: ${debugError(error)}`)
    } finally { this.checkingOwnership = false }
  }

  // --- 桥接启动/停止 ---

  cancelBridgeStart(): void {
    this.pendingStart?.abort()
  }

  async startBridge(ctx: Ctx, interactive = true, source: 'command' | 'auto-start' = 'command'): Promise<void> {
    this.latestCtx = ctx
    if (this.running) { this.notify('微信桥接已经在运行', 'info'); return }
    if (this.pendingStart) { this.notify('微信桥接正在启动或等待交接', 'info'); return }
    const attempt = new AbortController()
    this.pendingStart = attempt
    const check = () => attempt.signal.throwIfAborted()
    const startedAt = Date.now()
    let phase = 'credentials'
    let reason = 'START_FAILED'
    let owner: BridgeLockState = { kind: 'missing' }
    const trace = (event: string, detail = '') => debugLog(`[bridge-start] callerPid=${process.pid} source=${source} interactive=${ctx.hasUI && interactive} event=${event} phase=${phase} elapsedMs=${Math.max(0, Date.now() - startedAt)} ${bridgeLockMetadata(owner)}${detail ? ' ' + detail : ''}`)
    let acquired = false
    let handoffReleaseNotice = ''
    try {
      trace('begin')
      const activeClient = await this.loadClient()
      if (!activeClient) { reason = 'NO_CREDENTIALS'; this.notify('未找到微信凭证，请先执行 /wechat login', 'error'); return }
      if (!ctx.isIdle()) {
        phase = 'agent-idle'
        if (!('waitForIdle' in ctx)) { reason = 'HOST_BUSY'; this.notify('微信桥接尚未启动：请等待当前任务结束后执行 /wechat start。', 'warning'); return }
        this.notify('等待当前任务结束后启动微信桥接…', 'info')
        trace('waiting')
        await ctx.waitForIdle()
      }
      check()
      phase = 'preflight'
      await this.preflightBridge()
      check()
      phase = 'inspect-lock'
      owner = await getBridgeLockState()
      trace('snapshot')
      check()
      const blocker = bridgeStartBlocker(owner, ctx.hasUI && interactive)
      if (blocker) {
        reason = blocker.code
        this.notify(blocker.message, 'error')
        return
      }
      if (owner.kind === 'other' || owner.kind === 'current') {
        const takeover = '请求旧会话停止，等待释放后在本会话启动'
        const mode = resolveConfig(await loadConfig()).handoff
        phase = 'handoff'
        trace(`mode-${mode}`)
        if (mode === 'auto') {
          this.notify(`正在自动请求旧会话（PID ${owner.pid}）停止并释放桥接（最多 30 秒）…`, 'info')
        } else {
          const choice = await ctx.ui.select(`微信桥接由其他 pi 会话持有（PID ${owner.pid}）`, [takeover, '取消'])
          check()
          if (choice !== takeover) { reason = 'DECLINED'; this.notify('已取消，未改动其他会话的微信桥接。', 'info'); return }
          this.notify('正在等待旧会话停止并释放桥接（最多 30 秒）…', 'info')
        }
        const handoffStartedAt = Date.now()
        const ownerPid = owner.pid
        await requestHandoff(owner, attempt.signal, elapsedMs => {
          if (attempt.signal.aborted) return
          trace('waiting-release', `waitMs=${elapsedMs}`)
          if (elapsedMs >= 5_000) this.notify(`仍在等待旧会话（PID ${ownerPid}）停止收发并释放桥接，已等待 ${Math.floor(elapsedMs / 1000)} 秒（最多 30 秒）；无需重复启动。`, 'info')
        })
        check()
        trace('released')
        handoffReleaseNotice = `旧会话已释放桥接（等待 ${((Date.now() - handoffStartedAt) / 1000).toFixed(1)} 秒）`
        this.notify(`${handoffReleaseNotice}，正在启动当前会话…`, 'info')
      }
      phase = 'acquire-lock'
      const result = await this.lock()
      acquired = result.success
      check()
      if (!result.success) {
        reason = result.code ?? 'LOCK_ACQUIRE_FAILED'
        if (result.state) owner = result.state
        this.notify(result.code === 'LOCK_CONFLICT'
          ? `微信桥接未启动：获取锁时归属已变化或被其他会话占用。${result.message} 本次启动已结束，请检查 /wechat status 后重试。`
          : result.message, 'error')
        return
      }
      if (result.state) owner = result.state
      // The previous owner may have advanced its cursor while we were waiting.
      phase = 'reload-state'
      trace('acquired')
      await activeClient.reloadReceiveState()
      check()
      phase = 'prepare'
      await this.prepareBridge()
      check()
      this.running = true
      this.pollAbort = new AbortController()
      reason = 'STARTED'
      // TUI notifications replace one another; retain release evidence on success.
      this.notify(`${handoffReleaseNotice ? handoffReleaseNotice + '；' : ''}微信桥接已启动 📱`, 'info')
      this.updateStatusBar()
      void this.pollMessages(activeClient).catch(error => this.notify(`微信轮询异常退出: ${formatError(error)}`, 'error'))
    } catch (error) {
      const cancelled = attempt.signal.aborted
      reason = cancelled ? 'CANCELLED' : error instanceof BridgeHandoffError ? error.code : 'START_FAILED'
      trace(`error-${debugError(error)}`)
      if (acquired) await this.stopBridge({ releaseLock: true })
      this.notify(cancelled ? '微信桥接启动已取消。' : '微信桥接启动失败: ' + formatError(error), cancelled ? 'info' : 'error')
    } finally {
      trace(reason)
      this.pendingStart = null
    }
  }

  stopBridge(options: { releaseLock?: boolean } = {}): Promise<void> {
    this.cancelBridgeStart()
    if (this.stopping) return this.stopping
    const task = this.stopBridgeInner(options)
    this.stopping = task
    void task.finally(() => { if (this.stopping === task) this.stopping = null }).catch(() => {})
    return task
  }

  private async stopBridgeInner(options: { releaseLock?: boolean }): Promise<void> {
    const startedAt = Date.now()
    const trace = (phase: string) => debugLog(`[bridge-stop] callerPid=${process.pid} phase=${phase} elapsedMs=${Math.max(0, Date.now() - startedAt)}`)
    const wasRunning = this.running
    this.running = false
    this.stopBridgeWatch()
    this.modelFailure.reset()
    this.completionSummary.reset()
    this.wechatPrompt.clear()
    this.deactivateWechatTools()
    this.pollAbort?.abort()
    const sendsFinished = this.client?.pauseSending()
    const outboxFinished = this.outbox?.pause()
    const typingUser = this.queue.activeRequest?.userId
    this.queue.reset()
    this.turn.reset()
    this.updateStatusBar()
    // Keep the lock until the old receiver and its persistent writes have settled.
    trace('poll-drain')
    await this.pollTask?.catch(error => debugLog(`轮询退出: ${debugError(error)}`))
    this.pollAbort = null
    trace('send-drain')
    await sendsFinished
    // Rejected in-flight sends may still be writing their unsent suffix.
    // The next owner must not load the outbox until these writes have finished.
    await outboxFinished
    if (wasRunning && this.client) {
      trace('state-flush')
      await this.client.flushReceiveState()
      trace('notify-stop')
      await this.client.notifyStop().catch(error => {
        debugLog(`notifyStop 失败（不阻断停止）: ${debugError(error)}`)
        this.notify(`微信下线状态同步失败，本地桥接已停止：${formatError(error)}。详情见 /wechat status。`, 'warning')
      })
    }
    trace('typing-stop')
    if (typingUser && this.client) await this.client.stopTyping(typingUser).catch(() => {})
    trace('lock-release')
    if (options.releaseLock) await this.unlock()
    trace('complete')
    this.updateStatusBar()
  }

  // --- 桥接能力：只在启动时注册并激活；回复规则固定加入系统提示词 ---

  async preflightBridge(): Promise<void> {
    await this.stopping
    if (resolveConfig().sourceEnabled) await this.wechatPrompt.load()
  }

  async prepareBridge(): Promise<void> {
    // startBridge calls this only after acquiring the bridge lock.
    if (this.client) {
      this.outbox = await ReplyOutbox.open({ accountId: this.client.accountId, userId: this.client.userId }, () => this.updateStatusBar())
    }
    this.client?.resumeSending()
    this.registerWechatTools(true)
    const active = this.pi.getActiveTools()
    const missing = WECHAT_TOOL_NAMES.filter(name => !active.includes(name))
    if (missing.length) this.pi.setActiveTools([...active, ...missing])
  }

  registerWechatTools(enabled: boolean): void {
    registerSendTools(this.pi, enabled, this)
    this.toolsRegistered = true
  }

  pruneWechatTools(): void {
    const active = this.pi.getActiveTools()
    const remaining = active.filter(name => !WECHAT_TOOL_NAMES.includes(name))
    if (remaining.length !== active.length) this.pi.setActiveTools(remaining)
  }

  deactivateWechatTools(): void {
    if (!this.toolsRegistered) return
    this.registerWechatTools(false)
    this.pruneWechatTools()
  }

  // --- 可恢复的文本回复（不包括回执、命令回复、桌面输入或媒体工具） ---

  private replyTransport(activeClient: WeixinClient): ReplyTransport {
    const signal = this.pollAbort?.signal
    return {
      active: () => this.running && this.client === activeClient && !signal?.aborted,
      // Report the durable outbox outcome, not an earlier transport warning.
      send: text => activeClient.sendText(activeClient.userId, text, { hintOnRejection: false }),
    }
  }

  private reportOutboxError(error: unknown): void {
    if (error instanceof OutboxStorageError) this.notify(error.message, 'error')
  }

  sendReply(userId: string, text: string, ctx: Ctx | null = this.latestCtx) {
    return this.deliverReply(userId, splitAndFilterMarkdown(text), ctx)
  }

  async deliverReply(userId: string, chunks: string[], ctx: Ctx | null) {
    const activeClient = this.client
    const activeOutbox = this.outbox
    if (!this.running || !activeClient || !activeOutbox || userId !== activeClient.userId) return 'stopped'
    try {
      const result = await activeOutbox.deliver(chunks, {
        cwd: ctx?.cwd ?? '', sessionId: ctx?.sessionManager?.getSessionId(),
      }, this.replyTransport(activeClient))
      if (result === 'queued' && activeOutbox.status.pending === 1) {
        this.notify('微信回复已暂存（发送被拒 ret=-2）；从微信发送一条新消息后将自动补发。', 'warning')
      }
      return result
    } catch (error) {
      this.reportOutboxError(error)
      throw error
    }
  }

  // --- 轮询 ---

  pollMessages(activeClient: WeixinClient): Promise<void> {
    const task = this.runPoll(activeClient, this.pollAbort!.signal)
    this.pollTask = task
    this.startBridgeWatch()
    void task.finally(() => {
      if (this.pollTask === task) this.pollTask = null
      if (this.running) void this.stopBridge({ releaseLock: true }).catch(error => debugLog(debugError(error)))
    }).catch(() => {})
    return task
  }

  private async runPoll(activeClient: WeixinClient, signal: AbortSignal): Promise<void> {
    await activeClient.notifyStart().catch(error => {
      debugLog(`notifyStart 失败（不阻断启动）: ${debugError(error)}`)
      this.notify(`微信上线状态同步失败，本地桥接继续运行：${formatError(error)}。详情见 /wechat status。`, 'warning')
    })
    let retryDelay = POLL_RETRY_BASE_MS
    while (this.running && !signal.aborted && this.client === activeClient) {
      try {
        const messages = await activeClient.getUpdates(signal)
        retryDelay = POLL_RETRY_BASE_MS
        for (const [index, message] of messages.entries()) {
          if (!this.running || signal.aborted) break
          this.pendingPollMessages = messages.length - index - 1
          await this.handleIncomingMessage(message, activeClient)
        }
        this.pendingPollMessages = 0
      } catch (error) {
        this.pendingPollMessages = 0
        if (isAbortError(error)) break
        if (error instanceof SessionExpiredError) {
          this.notify('微信凭证失效，请手动执行 /wechat login --force 重新登录', 'error')
          break
        }
        debugLog(`轮询失败: ${debugError(error)}`)
        try { await delay(retryDelay, undefined, { signal }) } catch { break }
        retryDelay = Math.min(retryDelay * 2, POLL_RETRY_MAX_MS)
      }
    }
  }

  // --- 单条消息处理 ---

  private async handleIncomingMessage(message: IncomingMessage, activeClient: WeixinClient): Promise<void> {
    if (!isAuthorizedWeChatSender(message.raw.from_user_id, activeClient.userId)) {
      debugLog('[AUTH] 丢弃未绑定用户消息')
      return
    }
    debugLog(`收到消息: type=${message.type}, textLen=${message.text?.length ?? 0}, images=${message.imageUrls.length}`)

    // getUpdates has already refreshed context and deduplicated this activity.
    // Replay before commands (including /new) and new prompts, but a failure
    // must never consume the new input. Only this bridge owner may send.
    try { await this.outbox?.replay(this.replyTransport(activeClient)) }
    catch (error) {
      debugLog(`待发回复补发失败: ${debugError(error)}`)
      this.reportOutboxError(error)
      if (!(error instanceof OutboxStorageError) && this.outbox?.status.uncertain) {
        this.notify('补发时无法确认是否送达，已暂停该条回复的自动补发；请在 Pi 会话中核对。', 'warning')
      }
    }

    if (!this.running || this.client !== activeClient || this.pollAbort?.signal.aborted) return

    if (UNSUPPORTED_TYPES.has(message.type)) {
      const reply = UNSUPPORTED_REPLY[message.type] ?? UNSUPPORTED_REPLY['unknown']
      try {
        await activeClient.sendText(message.userId, reply)
      } catch (err) {
        debugLog(`回复不支持类型消息失败: ${debugError(err)}`)
      }
      return
    }

    if (this.newSession.changing) {
      await activeClient.sendText(message.userId, '⏳ 正在新建会话，请等待结果后再发送消息')
      return
    }

    if (message.text.startsWith('/')) {
      const handled = await handleRemoteCommand(message.text, message.userId, activeClient, this)
      if (handled) return
    }

    this.queue.enqueue(message)
  }

  // --- 桥接停止时的工具状态提示 ---

  contextNotice(): string {
    return '微信桥接当前已停止，send_file_to_wechat 和 send_image_to_wechat 均不可用。'
      + '不要依据历史中的工具说明尝试发送，也不要声称已发送；用户执行 /wechat start 后才会恢复。'
  }
}
