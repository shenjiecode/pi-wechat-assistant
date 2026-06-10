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

export interface ImageMedia {
  encrypt_query_param?: string
  aes_key?: string  // base64 编码的密钥
  full_url?: string  // 下载地址
  encrypt_type?: 0 | 1
}

export interface ImageItem {
  aeskey?: string  // 十六进制密钥 (32字符)
  media?: ImageMedia
  url?: string
  mid_size?: number
  thumb_size?: number
  thumb_height?: number
  thumb_width?: number
  hd_size?: number
}

export interface VoiceItem {
  text?: string
}

export interface FileItem {
  file_name?: string
  md5?: string
  len?: string
  media?: CDNMedia
}

export interface CDNMedia {
  encrypt_query_param: string
  aes_key: string  // base64 编码的 AES 密钥
  encrypt_type?: 0 | 1
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

// --- CDN 上传 ---

export interface GetUploadUrlReq {
  filekey: string
  media_type: number  // 1=IMG, 2=VID, 3=FILE, 4=VOICE
  to_user_id: string
  rawsize: number
  rawfilemd5: string
  filesize: number
  no_need_thumb: boolean
  aeskey: string
  base_info: BaseInfo
}

export interface GetUploadUrlResp {
  ret: number
  upload_param?: string
  upload_full_url?: string
  errcode?: number
  errmsg?: string
}

export interface SendMediaMessageReq {
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

export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const

// --- 内部消息类型 ---

export type IncomingMessageType = 'text' | 'image' | 'voice' | 'file' | 'video' | 'unknown'

export interface IncomingMessage {
  messageId: string
  userId: string
  text: string
  type: IncomingMessageType
  imageUrl?: string  // 图片消息的 URL
  imageAesKey?: string  // 图片解密密钥
  fileEncryptParam?: string  // 文件 CDN 下载参数 (encrypt_query_param)
  fileAesKey?: string  // 文件 AES 解密密钥 (base64)
  fileName?: string  // 原始文件名
  raw: WeixinMessage
  contextToken: string
  timestamp: Date
}
