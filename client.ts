// ============================================================================
// WeixinClient — 封装微信 iLink Bot 消息收发
// ============================================================================

import { getUpdates as apiGetUpdates, getConfig, sendMessage as apiSendMessage, sendTyping as apiSendTyping, isSessionExpired } from './api.js'
import { debugLog } from './logger.js'
import type { Credentials, IncomingMessage, MessageItem, WeixinMessage } from './types.js'

export class SessionExpiredError extends Error {
  constructor() {
    super('SESSION_EXPIRED')
    this.name = 'SessionExpiredError'
  }
}

export class WeixinClient {
  private readonly token: string
  private baseUrl: string
  private cursor = ''
  private readonly typingTickets = new Map<string, string>()
  private readonly contextTokens = new Map<string, string>()

  constructor(private readonly credentials: Credentials) {
    this.baseUrl = credentials.baseUrl
    this.token = credentials.token
  }

  get accountId(): string {
    return this.credentials.accountId
  }

  get userId(): string {
    return this.credentials.userId
  }

  // --- 消息接收 ---

  async getUpdates(signal?: AbortSignal): Promise<IncomingMessage[]> {
    let response
    try {
      response = await apiGetUpdates(this.baseUrl, this.token, this.cursor, signal)
    } catch (error) {
      if (isSessionExpired(error)) {
        throw new SessionExpiredError()
      }
      throw error
    }

    this.cursor = response.get_updates_buf || this.cursor
    const incoming: IncomingMessage[] = []

    for (const raw of response.msgs ?? []) {
      this.rememberContext(raw)
      const normalized = this.normalizeIncomingMessage(raw)
      if (normalized) {
        incoming.push(normalized)
      }
    }

    return incoming
  }

  // --- 消息发送 ---

  async sendText(userId: string, text: string): Promise<void> {
    const contextToken = this.contextTokens.get(userId)
    if (!contextToken) {
      throw new Error(`No cached context token for user ${userId}`)
    }
    const message = text.trim()
    if (!message) {
      throw new Error('Message text cannot be empty')
    }
    await apiSendMessage(this.baseUrl, this.token, userId, message, contextToken)
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

  // --- 内部 ---

  rememberContext(raw: { from_user_id?: string; to_user_id?: string; context_token?: string; message_type?: number }): void {
    const userId = raw.message_type === 1 ? raw.from_user_id : raw.to_user_id
    if (userId && raw.context_token) {
      this.contextTokens.set(userId, raw.context_token)
    }
  }

  private normalizeIncomingMessage(raw: { message_type?: number; message_id?: string | number; from_user_id?: string; create_time_ms?: number; context_token?: string; item_list?: MessageItem[] }): IncomingMessage | null {
    if (raw.message_type !== 1) return null // 只处理用户消息

    debugLog(`normalizeIncomingMessage: item_list=${JSON.stringify(raw.item_list)?.slice(0, 500)}`)
    const items = raw.item_list ?? []
    const { type, text, imageUrl, imageAesKey } = extractContent(items)

    return {
      messageId: String(raw.message_id ?? ''),
      userId: raw.from_user_id ?? '',
      text,
      type,
      imageUrl,
      imageAesKey,
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

function extractContent(items: MessageItem[]): { type: IncomingMessage['type']; text: string; imageUrl?: string; imageAesKey?: string } {
  let hasVideo = false
  let hasFile = false

  for (const item of items) {
    debugLog(`extractContent: item.type=${item.type}`)
    switch (item.type) {
      case 1: { // 文本
        let text = item.text_item?.text?.trim() ?? ''
        // 处理引用消息
        const ref = item.ref_msg?.message_item
        if (ref?.text_item?.text) {
          text = `[引用: ${ref.text_item.text.trim()}]\n${text}`
        }
        if (text) return { type: 'text', text }
        break
      }
      case 2: { // 图片
        debugLog(`extractContent: image_item=${JSON.stringify(item.image_item)}`)
        const imageUrl = item.image_item?.media?.full_url
        const aesKey = item.image_item?.aeskey
        if (imageUrl) {
          return { type: 'image', text: '', imageUrl, imageAesKey: aesKey }
        }
        return { type: 'image', text: '' }
      }
      case 3: { // 语音
        const voiceText = item.voice_item?.text?.trim()
        if (voiceText) return { type: 'voice', text: voiceText }
        return { type: 'voice', text: '[语音消息，暂不支持]' }
      }
      case 4: { // 文件
        hasFile = true
        break
      }
      case 5: { // 视频
        hasVideo = true
        break
      }
    }
  }

  if (hasFile) return { type: 'file', text: '' }
  if (hasVideo) return { type: 'video', text: '' }
  return { type: 'unknown', text: '' }
}
