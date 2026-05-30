// ============================================================================
// 微信 iLink Bot API 调用层
// ============================================================================

import { randomBytes, randomUUID } from 'node:crypto'
import type {
  BaseInfo,
  GetConfigResp,
  GetUpdatesReq,
  GetUpdatesResp,
  MessageItemType,
  MessageType,
  MessageState,
  SendMessageReq,
  SendTypingReq,
} from './types.js'

// --- 常量 ---

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const CHANNEL_VERSION = '1.0.0'

// --- 错误 ---

export class ApiError extends Error {
  readonly status: number
  readonly code?: number
  readonly payload?: unknown

  constructor(message: string, options: { status: number; code?: number; payload?: unknown }) {
    super(message)
    this.name = 'ApiError'
    this.status = options.status
    this.code = options.code
    this.payload = options.payload
  }
}

// --- 辅助函数 ---

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION }
}

function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(value), 'utf8').toString('base64')
}

function buildHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': randomWechatUin(),
  }
}

async function parseJsonResponse<T>(response: Response, label: string): Promise<T> {
  const text = await response.text()
  const payload = text ? (JSON.parse(text) as T) : ({} as T)

  if (!response.ok) {
    const body = payload as { errmsg?: string; errcode?: number } | null
    throw new ApiError(body?.errmsg ?? `${label} failed with HTTP ${response.status}`, {
      status: response.status,
      code: body?.errcode,
      payload,
    })
  }

  const body = payload as { ret?: number; errcode?: number; errmsg?: string } | null
  if (typeof body?.ret === 'number' && body.ret !== 0) {
    throw new ApiError(body.errmsg ?? `${label} failed`, {
      status: response.status,
      code: body.errcode ?? body.ret,
      payload,
    })
  }

  return payload
}

// --- 通用请求 ---

async function apiPost<T>(
  baseUrl: string,
  endpoint: string,
  body: unknown,
  token: string,
  timeoutMs = 40_000,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(endpoint, `${normalizeBaseUrl(baseUrl)}/`)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify(body),
    signal: requestSignal,
  })
  return parseJsonResponse<T>(response, endpoint)
}

async function apiGet<T>(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const url = new URL(path, `${normalizeBaseUrl(baseUrl)}/`)
  const response = await fetch(url, { method: 'GET', headers })
  return parseJsonResponse<T>(response, path)
}

// --- 业务 API ---

export async function getUpdates(
  baseUrl: string,
  token: string,
  cursor: string,
  signal?: AbortSignal,
): Promise<GetUpdatesResp> {
  const body: GetUpdatesReq = {
    get_updates_buf: cursor,
    base_info: buildBaseInfo(),
  }
  return apiPost<GetUpdatesResp>(baseUrl, '/ilink/bot/getupdates', body, token, 40_000, signal)
}

export async function sendMessage(
  baseUrl: string,
  token: string,
  userId: string,
  text: string,
  contextToken: string,
): Promise<Record<string, unknown>> {
  return apiPost<Record<string, unknown>>(
    baseUrl,
    '/ilink/bot/sendmessage',
    {
      msg: {
        from_user_id: '',
        to_user_id: userId,
        client_id: randomUUID(),
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: buildBaseInfo(),
    },
    token,
    15_000,
  )
}

export async function getConfig(
  baseUrl: string,
  token: string,
  userId: string,
  contextToken: string,
): Promise<GetConfigResp> {
  return apiPost<GetConfigResp>(
    baseUrl,
    '/ilink/bot/getconfig',
    {
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: buildBaseInfo(),
    },
    token,
    15_000,
  )
}

export async function sendTyping(
  baseUrl: string,
  token: string,
  userId: string,
  ticket: string,
  status: 1 | 2,
): Promise<Record<string, unknown>> {
  const body: SendTypingReq = {
    ilink_user_id: userId,
    typing_ticket: ticket,
    status,
    base_info: buildBaseInfo(),
  }
  return apiPost<Record<string, unknown>>(baseUrl, '/ilink/bot/sendtyping', body, token, 15_000)
}

export async function fetchQrCode(baseUrl: string = DEFAULT_BASE_URL): Promise<QrCodeResponse> {
  return apiGet<QrCodeResponse>(baseUrl, '/ilink/bot/get_bot_qrcode?bot_type=3')
}

export async function getQrCodeStatus(
  qrcode: string,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<QrStatusResponse> {
  return apiGet<QrStatusResponse>(
    baseUrl,
    `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    { 'iLink-App-ClientVersion': '1' },
  )
}

// --- 响应类型 ---

export interface QrCodeResponse {
  qrcode: string
  qrcode_img_content: string
}

export interface QrStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
  redirect_host?: string
}

export function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && error.code === -14
}
