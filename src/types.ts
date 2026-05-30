// ============================================================================
// 微信 iLink Bot 协议类型定义
// ============================================================================

// --- 凭证 ---

export interface Credentials {
  token: string
  baseUrl: string
  accountId: string
  userId: string
  savedAt?: string
}

// --- 枚举常量 ---

export const MessageType = {
  USER: 1,
  BOT: 2,
} as const

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const

export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const

// --- API 请求/响应 ---

export interface BaseInfo {
  channel_version: string
}

export interface TextItem {
  text: string
}

export interface ImageItem {
  url?: string
}

export interface VoiceItem {
  text?: string
}

export interface FileItem {
  file_name?: string
}

export interface VideoItem {
  url?: string
}

export interface RefMessage {
  message_item?: MessageItem
  title?: string
}

export interface MessageItem {
  type: number
  text_item?: TextItem
  image_item?: ImageItem
  voice_item?: VoiceItem
  file_item?: FileItem
  video_item?: VideoItem
  ref_msg?: RefMessage
}

export interface WeixinMessage {
  message_id: string | number
  from_user_id: string
  to_user_id: string
  client_id: string
  create_time_ms: number
  message_type: number
  message_state: number
  context_token: string
  item_list: MessageItem[]
}

export interface GetUpdatesReq {
  get_updates_buf: string
  base_info: BaseInfo
}

export interface GetUpdatesResp {
  ret: number
  msgs: WeixinMessage[]
  get_updates_buf: string
  longpolling_timeout_ms?: number
  errcode?: number
  errmsg?: string
}

export interface SendMessageReq {
  msg: {
    from_user_id: string
    to_user_id: string
    client_id: string
    message_type: number
    message_state: number
    context_token: string
    item_list: MessageItem[]
  }
  base_info: BaseInfo
}

export interface SendTypingReq {
  ilink_user_id: string
  typing_ticket: string
  status: 1 | 2
  base_info: BaseInfo
}

export interface GetConfigResp {
  typing_ticket?: string
  ret?: number
  errcode?: number
  errmsg?: string
}

// --- 内部消息类型 ---

export type IncomingMessageType = 'text' | 'image' | 'voice' | 'file' | 'video' | 'unknown'

export interface IncomingMessage {
  messageId: string
  userId: string
  text: string
  type: IncomingMessageType
  raw: WeixinMessage
  contextToken: string
  timestamp: Date
}
