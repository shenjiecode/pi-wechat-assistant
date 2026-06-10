// ============================================================================
// WeixinClient — 封装微信 iLink Bot 消息收发
// ============================================================================

import {
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
import { debugLog } from './logger.js'
import type { Credentials, IncomingMessage, MessageItem, WeixinMessage } from './types.js'
import {
  loadContextTokens,
  saveContextTokensThrottled,
  flushContextTokens,
} from './auth.js'
import {
  CDN_BASE,
  STREAM_ENCRYPTION_THRESHOLD,
  LONG_POLL_TIMEOUT_MS,
} from './constants.js'

export class SessionExpiredError extends Error {
  constructor() {
    super('SESSION_EXPIRED')
    this.name = 'SessionExpiredError'
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
  private readonly token: string
  private baseUrl: string
  private cursor = ''
  private readonly typingTickets = new Map<string, string>()
  private readonly contextTokens = new Map<string, string>()
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
    const persisted = await loadContextTokens()
    this._lastActiveUserId = persisted.lastUserId
    for (const [userId, token] of Object.entries(persisted.tokens)) {
      this.contextTokens.set(userId, token)
    }
  }

  get accountId(): string { return this.credentials.accountId }
  get userId(): string { return this.credentials.userId }
  get lastActiveUserId(): string | null { return this._lastActiveUserId }

  getKnownUsers(): string[] {
    return Array.from(this.contextTokens.keys())
  }

  // --- 生命周期 ---

  /** 退出前确保 context tokens 落盘 */
  async dispose(): Promise<void> {
    this._disposed = true
    if (this._contextTokensDirty) {
      const tokens: Record<string, string> = {}
      for (const [k, v] of this.contextTokens) tokens[k] = v
      await flushContextTokens({ lastUserId: this._lastActiveUserId, tokens })
      this._contextTokensDirty = false
    }
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

    this.cursor = response.get_updates_buf || this.cursor
    const incoming: IncomingMessage[] = []

    for (const raw of response.msgs ?? []) {
      this.rememberContext(raw)
      const normalized = this.normalizeIncomingMessage(raw)
      if (normalized) incoming.push(normalized)
    }
    return incoming
  }

  // --- 消息发送 ---

  async sendText(userId: string, text: string): Promise<void> {
    const contextToken = this.contextTokens.get(userId)
    if (!contextToken) throw new Error(`No cached context token for user ${userId}`)
    const message = text.trim()
    if (!message) throw new Error('Message text cannot be empty')
    await apiSendMessage(this.baseUrl, this.token, userId, message, contextToken)
  }

  /** 发送文件 — 委托给 sendMedia */
  async sendFile(userId: string, filePath: string, fileName?: string): Promise<void> {
    await this.sendMedia(userId, filePath, 3, fileName)
  }

  /** 发送图片 — 委托给 sendMedia */
  async sendImage(userId: string, filePath: string): Promise<void> {
    await this.sendMedia(userId, filePath, 1)
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
    const contextToken = this.contextTokens.get(userId)
    if (!contextToken) throw new Error(`No cached context token for user ${userId}`)

    const { rawSize, rawMd5, aesKey, encryptedBuffer } = await encryptFile(filePath)
    const filekey = randomBytes(16).toString('hex')
    const name = displayName ?? basename(filePath)

    const { item } = await uploadAndBuildItem(
      this.baseUrl, this.token, userId, filekey,
      mediaType, rawSize, rawMd5, encryptedBuffer, aesKey, name,
    )

    await sendMediaMessage(this.baseUrl, this.token, userId, contextToken, [item])
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
    const userId = raw.message_type === 1 ? raw.from_user_id : raw.to_user_id
    if (userId && raw.context_token) {
      this.contextTokens.set(userId, raw.context_token)
      this._lastActiveUserId = userId
      this._contextTokensDirty = true
      this._schedulePersist()
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
    debugLog(`normalizeIncomingMessage: item_list=${JSON.stringify(raw.item_list)?.slice(0, 500)}`)
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
        debugLog(`extractContent: image_item=${JSON.stringify(item.image_item)}`)
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
