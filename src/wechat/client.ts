// ============================================================================
// WeixinClient — 封装微信 iLink Bot 消息收发
// ============================================================================

import {
  ApiError,
  notifyStart as apiNotifyStart,
  notifyStop as apiNotifyStop,
  getUpdates as apiGetUpdates,
  getConfig,
  sendMessage as apiSendMessage,
  sendTyping as apiSendTyping,
  isSessionExpired,
  getUploadUrl,
  uploadToCdn,
  sendMediaMessage,
} from './api.js'
import { randomBytes, createHash } from 'node:crypto'
import { createCipheriv } from 'node:crypto'
import { readFile, open as fsOpen } from 'node:fs/promises'
import { basename } from 'node:path'
import { debugLog } from '../shared/logger.js'
import { isAuthorizedWeChatSender } from './security.js'
import type { Credentials, IncomingMessage, MessageItem, WeixinMessage } from './types.js'
import {
  loadContextTokens,
  saveContextTokensThrottled,
  flushContextTokens,
  loadCursor,
  saveCursor,
  loadSeenIds,
  saveSeenIds,
} from '../bridge/transport-state.js'
import {
  CDN_BASE,
  STREAM_ENCRYPTION_THRESHOLD,
  LONG_POLL_TIMEOUT_MS,
} from '../shared/constants.js'

export class SessionExpiredError extends Error {
  constructor() {
    super('SESSION_EXPIRED')
    this.name = 'SessionExpiredError'
  }
}

export interface ApiCallResult {
  success: boolean
  at: string
  error?: string
  code?: number
  httpStatus?: number
}

function failedApiCall(error: unknown): ApiCallResult {
  return {
    success: false,
    at: new Date().toISOString(),
    error: error instanceof Error ? error.message || '接口请求失败' : String(error),
    ...(error instanceof ApiError ? { code: error.code, httpStatus: error.status } : {}),
  }
}

// --- 加密辅助 ---

/** AES-128-ECB 加密（微信 iLink Bot 要求） */
async function encryptFile(
  filePath: string,
): Promise<{ rawSize: number; rawMd5: string; aesKey: string; encryptedBuffer: Buffer }> {
  const fileBuffer = await readFile(filePath)
  const rawSize = fileBuffer.length
  const rawMd5 = createHash('md5').update(fileBuffer).digest('hex')
  const aesKey = randomBytes(16).toString('hex')
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(aesKey, 'hex'), null)
  // 对大文件使用 Buffer.concat 一次性创建仍会双倍内存，但 50MB 上限在可接受范围
  const encryptedBuffer = Buffer.concat([cipher.update(fileBuffer), cipher.final()])
  return { rawSize, rawMd5, aesKey, encryptedBuffer }
}

// --- 媒体发送 item 类型 ---

interface MediaItem {
  type: number
  file_item?: {
    media: { encrypt_query_param: string; aes_key: string; encrypt_type: 1 }
    file_name: string
    len: string
  }
  image_item?: {
    media: { encrypt_query_param: string; aes_key: string; encrypt_type: 1 }
    mid_size: number
  }
}

async function uploadAndBuildItem(
  baseUrl: string,
  token: string,
  userId: string,
  filekey: string,
  mediaType: number,
  rawSize: number,
  rawMd5: string,
  encryptedBuffer: Buffer,
  aesKey: string,
  displayName: string,
): Promise<{ item: MediaItem }> {
  const encryptedSize = encryptedBuffer.length

  const uploadResp = await getUploadUrl(baseUrl, token, {
    filekey,
    mediaType,
    toUserId: userId,
    rawSize,
    rawMd5,
    encryptedSize,
    aesKey,
  })

  let uploadParam = uploadResp.upload_param
  if (!uploadParam && uploadResp.upload_full_url) {
    const url = new URL(uploadResp.upload_full_url)
    uploadParam = url.searchParams.get('encrypted_query_param') ?? undefined
  }
  if (!uploadParam) throw new Error('Failed to get upload URL')

  const downloadParam = await uploadToCdn(CDN_BASE, uploadParam, filekey, encryptedBuffer)
  const encodedAesKey = Buffer.from(aesKey, 'utf-8').toString('base64')

  const isImage = mediaType === 1
  const item: MediaItem = isImage
    ? {
        type: 2, // IMAGE
        image_item: {
          media: { encrypt_query_param: downloadParam, aes_key: encodedAesKey, encrypt_type: 1 },
          mid_size: encryptedSize,
        },
      }
    : {
        type: 4, // FILE
        file_item: {
          media: { encrypt_query_param: downloadParam, aes_key: encodedAesKey, encrypt_type: 1 },
          file_name: displayName,
          len: String(rawSize),
        },
      }

  return { item }
}

// ============================================================================

export class WeixinClient {
  lastSend: (ApiCallResult & { needsFreshContext?: boolean }) | null = null
  readonly lastLifecycle: { start: ApiCallResult | null; stop: ApiCallResult | null } = { start: null, stop: null }
  /** Fired once per persistent ret=-2 streak so the UI can explain the remedy. */
  onNeedsFreshContext?: () => void
  onStatusChange?: () => void
  private sendFailureHinted = false
  private readonly token: string
  private baseUrl: string
  private cursor = ''
  private readonly typingTickets = new Map<string, string>()
  private readonly contextTokens = new Map<string, string>()
  private _seenMessageIds = new Set<string>()
  private _lastActiveUserId: string | null = null
  private _contextTokensDirty = false
  private _disposed = false

  /** 使用静态工厂创建实例（构造函数不执行 I/O） */
  static async create(credentials: Credentials): Promise<WeixinClient> {
    const client = new WeixinClient(credentials)
    await client._init()
    return client
  }

  private constructor(private readonly credentials: Credentials) {
    this.baseUrl = credentials.baseUrl
    this.token = credentials.token
  }

  private async _init(): Promise<void> {
    await this.reloadReceiveState()
  }

  /** Reload only after owning the bridge lock; a previous owner may have advanced it. */
  async reloadReceiveState(): Promise<void> {
    this.contextTokens.clear()
    const persisted = await loadContextTokens()
    // context token 只允许属于当前扫码凭证绑定用户，避免旧凭证或旧版本
    // 留下的其他用户状态被继续使用。
    const ownToken = persisted.tokens[this.userId]
    if (ownToken) this.contextTokens.set(this.userId, ownToken)
    this._lastActiveUserId = persisted.lastUserId === this.userId ? this.userId : null
    // 恢复上次游标，避免重启后服务端重放历史消息导致重复回复
    this.cursor = await loadCursor()
    // 恢复已见消息 id（游标丢失/过期时兜底去重）
    this._seenMessageIds = await loadSeenIds()
  }

  get accountId(): string { return this.credentials.accountId }
  get userId(): string { return this.credentials.userId }
  get lastActiveUserId(): string | null { return this._lastActiveUserId }
  get hasContextToken(): boolean { return this.contextTokens.has(this.userId) }

  async notifyStart(): Promise<void> { await this.notifyLifecycle('start') }

  async notifyStop(): Promise<void> { await this.notifyLifecycle('stop') }

  private async notifyLifecycle(kind: 'start' | 'stop'): Promise<void> {
    try {
      await (kind === 'start' ? apiNotifyStart : apiNotifyStop)(this.baseUrl, this.token)
      this.lastLifecycle[kind] = { success: true, at: new Date().toISOString() }
    } catch (error) {
      this.lastLifecycle[kind] = failedApiCall(error)
      throw error
    } finally {
      this.onStatusChange?.()
    }
  }

  private async sendWithFallback(userId: string, send: (contextToken: string | undefined) => Promise<unknown>): Promise<void> {
    if (!isAuthorizedWeChatSender(userId, this.userId)) throw new Error('只能发送给扫码绑定用户')
    const contextToken = this.contextTokens.get(userId)
    try {
      try {
        await send(contextToken)
      } catch (error) {
        // Only retry explicit backend rejection; transport failures may already have delivered.
        if (!contextToken || !(error instanceof ApiError) || error.code !== -2) throw error
        debugLog('sendmessage ret=-2，尝试不带 context_token 重试一次')
        await send(undefined)
      }
      this.lastSend = { success: true, at: new Date().toISOString() }
      this.sendFailureHinted = false
    } catch (error) {
      this.lastSend = { ...failedApiCall(error), needsFreshContext: error instanceof ApiError && error.code === -2 }
      // One warning per failure streak: repeats add no information, and a
      // successful send re-arms the hint for the next incident.
      if (this.lastSend.needsFreshContext && !this.sendFailureHinted) {
        this.sendFailureHinted = true
        this.onNeedsFreshContext?.()
      }
      throw error
    } finally {
      this.onStatusChange?.()
    }
  }

  getKnownUsers(): string[] {
    return Array.from(this.contextTokens.keys())
  }

  // --- 生命周期 ---

  /** 退出前确保 context tokens 落盘 */
  async dispose(): Promise<void> {
    this._disposed = true
    await this.flushReceiveState()
  }

  async flushReceiveState(): Promise<void> {
    if (this._contextTokensDirty) {
      const tokens: Record<string, string> = {}
      for (const [k, v] of this.contextTokens) tokens[k] = v
      await flushContextTokens({ lastUserId: this._lastActiveUserId, tokens })
      this._contextTokensDirty = false
    }
  }

  private sendingEnabled = true
  private pendingSends = new Set<Promise<void>>()

  resumeSending(): void { this.sendingEnabled = true }

  async pauseSending(): Promise<void> {
    this.sendingEnabled = false
    await Promise.allSettled([...this.pendingSends])
  }

  private trackSend(send: () => Promise<void>): Promise<void> {
    if (!this.sendingEnabled) return Promise.reject(new Error('微信桥接已停止，发送工具不可用'))
    const task = send()
    this.pendingSends.add(task)
    void task.finally(() => this.pendingSends.delete(task)).catch(() => {})
    return task
  }

  // --- 消息接收 ---

  async getUpdates(signal?: AbortSignal): Promise<IncomingMessage[]> {
    let response
    try {
      response = await apiGetUpdates(this.baseUrl, this.token, this.cursor, signal)
    } catch (error) {
      if (isSessionExpired(error)) throw new SessionExpiredError()
      throw error
    }

    if (signal?.aborted) return []
    this.cursor = response.get_updates_buf || this.cursor
    // 持久化游标（写失败不致命，下次可能重放；由 _seenMessageIds 兜底去重）
    if (this.cursor) {
      await saveCursor(this.cursor).catch(() => {})
    }

    const incoming: IncomingMessage[] = []

    for (const raw of response.msgs ?? []) {
      // 授权必须发生在缓存 context token、解析内容和消息入队之前。
      if (raw.message_type !== 1) continue
      if (!isAuthorizedWeChatSender(raw.from_user_id, this.userId)) {
        debugLog('[AUTH] drop message from unbound user')
        continue
      }
      const normalized = this.normalizeIncomingMessage(raw)
      if (!normalized) continue
      const id = normalized.messageId
      if (id && this._seenMessageIds.has(id)) {
        debugLog('[DEDUP] skip already-seen message')
        continue
      }
      if (id) {
        this._seenMessageIds.add(id)
        // 防止 Set 无限增长：超限重建（极端情况下去重失效，游标仍是主防线）
        if (this._seenMessageIds.size > 10_000) {
          this._seenMessageIds.clear()
          this._seenMessageIds.add(id)
        }
      }
      this.rememberContext(raw)
      incoming.push(normalized)
    }
    // 交接前等待去重记录落盘。
    if (incoming.length > 0) {
      await saveSeenIds(this._seenMessageIds).catch(() => {})
    }
    return incoming
  }

  // --- 消息发送 ---

  async sendText(userId: string, text: string): Promise<void> {
    // Validate emptiness without stripping code indentation, trailing spaces or newlines.
    if (!text.trim()) throw new Error('Message text cannot be empty')
    await this.trackSend(() => this.sendWithFallback(userId, contextToken => apiSendMessage(this.baseUrl, this.token, userId, text, contextToken)))
  }

  /** 发送文件 — 委托给 sendMedia */
  async sendFile(userId: string, filePath: string, fileName?: string): Promise<void> {
    await this.trackSend(() => this.sendMedia(userId, filePath, 3, fileName))
  }

  /** 发送图片 — 委托给 sendMedia */
  async sendImage(userId: string, filePath: string): Promise<void> {
    await this.trackSend(() => this.sendMedia(userId, filePath, 1))
  }

  /**
   * 通用媒体发送
   * @param mediaType  1=IMAGE, 3=FILE (对应 SendMediaMessageReq item type)
   */
  private async sendMedia(
    userId: string,
    filePath: string,
    mediaType: 1 | 3,
    displayName?: string,
  ): Promise<void> {
    if (!isAuthorizedWeChatSender(userId, this.userId)) throw new Error('只能发送给扫码绑定用户')

    const { rawSize, rawMd5, aesKey, encryptedBuffer } = await encryptFile(filePath)
    const filekey = randomBytes(16).toString('hex')
    const name = displayName ?? basename(filePath)

    const { item } = await uploadAndBuildItem(
      this.baseUrl, this.token, userId, filekey,
      mediaType, rawSize, rawMd5, encryptedBuffer, aesKey, name,
    )

    await this.sendWithFallback(userId, contextToken => sendMediaMessage(this.baseUrl, this.token, userId, contextToken, [item]))
  }

  // --- 输入态 ---

  async startTyping(userId: string): Promise<void> {
    const ticket = await this.getTypingTicket(userId)
    if (!ticket) return
    await apiSendTyping(this.baseUrl, this.token, userId, ticket, 1)
  }

  async stopTyping(userId: string): Promise<void> {
    const ticket = await this.getTypingTicket(userId)
    if (!ticket) return
    await apiSendTyping(this.baseUrl, this.token, userId, ticket, 2)
  }

  // --- 上下文管理 ---

  rememberContext(raw: { from_user_id?: string; to_user_id?: string; context_token?: string; message_type?: number }): void {
    if (
      raw.message_type === 1
      && isAuthorizedWeChatSender(raw.from_user_id, this.userId)
      && raw.context_token
    ) {
      this.contextTokens.set(this.userId, raw.context_token)
      this._lastActiveUserId = this.userId
      this._contextTokensDirty = true
      this._schedulePersist()
      this.onStatusChange?.()
    }
  }

  private _persistTimer: ReturnType<typeof setTimeout> | null = null

  private _schedulePersist(): void {
    if (this._disposed) return
    const tokens: Record<string, string> = {}
    for (const [k, v] of this.contextTokens) tokens[k] = v
    saveContextTokensThrottled({ lastUserId: this._lastActiveUserId, tokens })
  }

  // --- 内部 ---

  private normalizeIncomingMessage(raw: {
    message_type?: number
    message_id?: string | number
    from_user_id?: string
    create_time_ms?: number
    context_token?: string
    item_list?: MessageItem[]
  }): IncomingMessage | null {
    if (raw.message_type !== 1) return null
    debugLog(`normalizeIncomingMessage: items=${raw.item_list?.length ?? 0}`)
    const items = raw.item_list ?? []
    const { text, imageUrls, fileEncryptParam, fileAesKey, fileName, hasVideo, hasVoice } = extractContent(items)

    let type: IncomingMessage['type'] = 'text'
    if (imageUrls.length > 0) type = 'image'
    if (hasVideo) type = 'video'
    if (hasVoice && !text) type = 'voice'
    if (fileEncryptParam) type = 'file'
    if (!text && !imageUrls.length && !hasVoice && !hasVideo && !fileEncryptParam) type = 'unknown'

    return {
      messageId: String(raw.message_id ?? ''),
      userId: raw.from_user_id ?? '',
      text,
      type,
      imageUrls,
      fileEncryptParam,
      fileAesKey,
      fileName,
      raw: raw as WeixinMessage,
      contextToken: raw.context_token ?? '',
      timestamp: new Date(raw.create_time_ms ?? Date.now()),
    }
  }

  private async getTypingTicket(userId: string): Promise<string | null> {
    const cached = this.typingTickets.get(userId)
    if (cached) return cached
    const contextToken = this.contextTokens.get(userId)
    if (!contextToken) return null
    const config = await getConfig(this.baseUrl, this.token, userId, contextToken)
    if (!config.typing_ticket) return null
    this.typingTickets.set(userId, config.typing_ticket)
    return config.typing_ticket
  }
}

// --- 消息内容提取 ---

function extractContent(items: MessageItem[]): {
  text: string
  imageUrls: Array<{ url: string; aesKey?: string }>
  fileEncryptParam?: string
  fileAesKey?: string
  fileName?: string
  hasVideo: boolean
  hasVoice: boolean
} {
  const textParts: string[] = []
  const imageUrls: Array<{ url: string; aesKey?: string }> = []
  let fileEncryptParam: string | undefined
  let fileAesKey: string | undefined
  let fileName: string | undefined
  let hasVideo = false
  let hasVoice = false

  for (const item of items) {
    debugLog(`extractContent: item.type=${item.type}`)
    switch (item.type) {
      case 1: { // 文本
        let text = item.text_item?.text?.trim() ?? ''
        const ref = item.ref_msg?.message_item
        if (ref?.text_item?.text) {
          text = `[引用: ${ref.text_item.text.trim()}]\n${text}`
        }
        if (text) textParts.push(text)
        break
      }
      case 2: { // 图片
        debugLog(`extractContent: image hasUrl=${!!item.image_item?.media?.full_url} encrypted=${!!item.image_item?.aeskey}`)
        const url = item.image_item?.media?.full_url
        const aesKey = item.image_item?.aeskey
        if (url) imageUrls.push({ url, aesKey })
        break
      }
      case 3: { // 语音
        hasVoice = true
        const voiceText = item.voice_item?.text?.trim()
        if (voiceText) {
          textParts.push(`[语音转文字] ${voiceText}`)
        } else {
          textParts.push('[语音消息 — 暂无法识别，可尝试用文字描述需求]')
        }
        break
      }
      case 4: { // 文件
        const encryptParam = item.file_item?.media?.encrypt_query_param
        const aesKey = item.file_item?.media?.aes_key
        const name = item.file_item?.file_name
        if (encryptParam) {
          fileEncryptParam = encryptParam
          fileAesKey = aesKey
          fileName = name
        }
        break
      }
      case 5: { // 视频
        hasVideo = true
        break
      }
    }
  }

  return { text: textParts.join('\n'), imageUrls, fileEncryptParam, fileAesKey, fileName, hasVideo, hasVoice }
}
