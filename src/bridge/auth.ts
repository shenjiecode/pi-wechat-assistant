// ============================================================================
// 认证与凭证管理
// ============================================================================

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { DEFAULT_BASE_URL, fetchQrCode, getQrCodeStatus, type QrStatusResponse } from '../wechat/api.js'
import type { Credentials } from '../wechat/types.js'
import { inspectBridgeLock, type BridgeLockState } from './bridge-lock.js'
import { acquireBridgeLock, releaseBridgeLock, requestBridgeHandoff, handoffRequested } from './bridge-ownership.js'

// --- 路径 ---

const STATE_DIR = path.join(os.homedir(), '.pi', 'agent', 'wechat-assistant')
const CREDS_FILE = path.join(STATE_DIR, 'credentials.json')
const CONFIG_FILE = path.join(STATE_DIR, 'config.json')
const LOCK_FILE = path.join(STATE_DIR, 'session.lock')
const CONTEXT_TOKENS_FILE = path.join(STATE_DIR, 'context-tokens.json')
const CURSOR_FILE = path.join(STATE_DIR, 'cursor.json')
const SEEN_IDS_FILE = path.join(STATE_DIR, 'seen-ids.json')

export function getStateDir(): string {
  return STATE_DIR
}

export function getCredentialsPath(): string {
  return CREDS_FILE
}

// --- 通用文件辅助 ---

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 })
  // mkdir 的 mode 不会修改已有目录；尽力收紧旧安装的状态目录权限。
  await fs.chmod(STATE_DIR, 0o700).catch(() => {})
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    // 旧版本创建的文件可能权限较宽；读取时顺手收紧，不因 chmod 失败影响启动。
    await fs.chmod(filePath, 0o600).catch(() => {})
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureStateDir()
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  // writeFile 的 mode 不会修改已有文件。
  await fs.chmod(filePath, 0o600)
}

async function deleteFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch {
    // ignore
  }
}

// --- 消息游标（跨重启持久化，防止重放历史消息导致重复回复） ---

export async function loadCursor(): Promise<string> {
  const data = await readJsonFile<{ cursor: string }>(CURSOR_FILE)
  return data?.cursor ?? ''
}

export async function saveCursor(cursor: string): Promise<void> {
  if (!cursor) return
  await writeJsonFile(CURSOR_FILE, { cursor, updatedAt: new Date().toISOString() })
}

// --- 已见消息 id（持久化去重，游标丢失/过期时兜底防重发） ---

const MAX_SEEN_IDS = 5_000

export async function loadSeenIds(): Promise<Set<string>> {
  const data = await readJsonFile<{ ids: string[] }>(SEEN_IDS_FILE)
  return new Set(data?.ids ?? [])
}

export async function saveSeenIds(ids: Set<string>): Promise<void> {
  const arr = Array.from(ids)
  if (arr.length === 0) return
  // 只保留最近 N 个，防止文件无限增长
  const trimmed = arr.length > MAX_SEEN_IDS ? arr.slice(arr.length - MAX_SEEN_IDS) : arr
  await writeJsonFile(SEEN_IDS_FILE, { ids: trimmed, updatedAt: new Date().toISOString() })
}

/** 登录身份变化后清除旧长轮询位置，避免跨凭证复用游标和去重记录。 */
export async function clearTransportState(): Promise<void> {
  await Promise.all([deleteFile(CURSOR_FILE), deleteFile(SEEN_IDS_FILE)])
}

// --- 凭证 ---

export async function loadCredentials(): Promise<Credentials | null> {
  return readJsonFile<Credentials>(CREDS_FILE)
}

export async function saveCredentials(creds: Credentials): Promise<void> {
  await writeJsonFile(CREDS_FILE, { ...creds, savedAt: new Date().toISOString() })
}

export async function clearCredentials(): Promise<void> {
  await deleteFile(CREDS_FILE)
}

export async function clearContextTokens(): Promise<void> {
  await deleteFile(CONTEXT_TOKENS_FILE)
}

// --- 配置 ---

export interface BridgeConfig {
  autoStart?: boolean
  /** 收件回执通知，默认开启；兼容已有 sendAck: false 配置。 */
  sendAck?: boolean
  /** 自定义文字/图片收件回执；空白或未设置时使用默认文案。 */
  ackText?: string
  imageBatchAckText?: string
  /** 持锁接管方式：ask=弹窗确认（默认），auto=对支持协作交接的会话直接请求交接。 */
  handoff?: 'ask' | 'auto'
  /** 默认同步 TUI 输入和 AI 回复到微信；关闭后仅转发微信任务回复。 */
  bidirectionalSync?: boolean
  /** 是否允许微信端 /tools 命令修改本机工具权限（安全考虑，默认关闭） */
  allowRemoteTools?: boolean
  /** 来源标识与微信回复约定共用此开关，默认开启。 */
  messageSourceTag?: {
    enabled?: boolean
    wechatTag?: string
    /** 微信请求禁止调用的本机提问工具；默认 question / questionnaire，[] 可关闭守卫。 */
    blockedTools?: string[]
  }
  /** 图片批量合并等待时间；收到文字补充会立即处理 */
  imageBatchWaitMs?: number
  /** 单张图片最大下载大小，单位字节 */
  imageMaxBytes?: number
}

/** 内存缓存，供同步读取使用（由异步 initConfig / saveConfig 维护） */
let _configCache: BridgeConfig | null = null

export function getConfigCache(): BridgeConfig {
  return _configCache ?? {}
}

export async function loadConfig(): Promise<BridgeConfig> {
  if (_configCache) return _configCache
  const data = await readJsonFile<BridgeConfig>(CONFIG_FILE)
  _configCache = data ?? {}
  return _configCache
}

export async function saveConfig(config: BridgeConfig): Promise<void> {
  await writeJsonFile(CONFIG_FILE, config)
  _configCache = config
}

// --- 简单文件锁 ---

export function getBridgeLockState() { return inspectBridgeLock(LOCK_FILE) }
export async function acquireLock(sessionId: string) {
  await ensureStateDir()
  return acquireBridgeLock(LOCK_FILE, sessionId)
}
export function releaseLock(sessionId: string) { return releaseBridgeLock(LOCK_FILE, sessionId) }
export function requestHandoff(owner: Extract<BridgeLockState, { sessionId: string }>, signal?: AbortSignal) {
  return requestBridgeHandoff(LOCK_FILE, owner, 30_000, signal)
}
export function hasHandoffRequest(sessionId: string) { return handoffRequested(LOCK_FILE, sessionId) }
// --- 二维码登录 ---

export async function getQrCode(baseUrl?: string): Promise<{ url: string; token: string }> {
  const response = await fetchQrCode(baseUrl)
  return { url: response.qrcode_img_content, token: response.qrcode }
}

export async function pollQrStatus(
  token: string,
  currentBaseUrl?: string,
): Promise<{
  status: QrStatusResponse['status']
  credentials?: Credentials
  redirectHost?: string
}> {
  const baseUrl = currentBaseUrl ?? DEFAULT_BASE_URL
  const response = await getQrCodeStatus(token, baseUrl)

  if (response.status !== 'confirmed') {
    return {
      status: response.status,
      redirectHost: response.redirect_host,
    }
  }

  return {
    status: 'confirmed',
    credentials: {
      token: response.bot_token ?? '',
      baseUrl: response.baseurl || baseUrl,
      accountId: response.ilink_bot_id ?? '',
      userId: response.ilink_user_id ?? '',
    },
  }
}

// --- Context Tokens 持久化 ---

export interface PersistedContextTokens {
  /** 上次活跃的微信用户 ID */
  lastUserId: string | null
  /** userId → context_token 映射 */
  tokens: Record<string, string>
}

/** 用于节流持久化的定时器 */
let _contextTokensFlushTimer: ReturnType<typeof setTimeout> | null = null
let _contextTokensWrite: Promise<void> = Promise.resolve()
const CONTEXT_TOKENS_FLUSH_MS = 5_000

function queueContextTokensWrite(data: PersistedContextTokens): Promise<void> {
  // A timer may already be writing when handoff begins. Flush must wait behind it.
  _contextTokensWrite = _contextTokensWrite.catch(() => {}).then(() => writeJsonFile(CONTEXT_TOKENS_FILE, data))
  return _contextTokensWrite
}

export async function loadContextTokens(): Promise<PersistedContextTokens> {
  const data = await readJsonFile<PersistedContextTokens>(CONTEXT_TOKENS_FILE)
  return data ?? { lastUserId: null, tokens: {} }
}

/**
 * 节流写入 — 5 秒内多次调用只写最后一次。
 * 如果需要在退出前确保写入，请直接 await flushContextTokens()。
 */
export function saveContextTokensThrottled(data: PersistedContextTokens): void {
  if (_contextTokensFlushTimer) clearTimeout(_contextTokensFlushTimer)
  _contextTokensFlushTimer = setTimeout(() => {
    _contextTokensFlushTimer = null
    void queueContextTokensWrite(data).catch(() => {})
  }, CONTEXT_TOKENS_FLUSH_MS)
}

/** 立即持久化 context tokens（退出时使用） */
export async function flushContextTokens(data: PersistedContextTokens): Promise<void> {
  if (_contextTokensFlushTimer) {
    clearTimeout(_contextTokensFlushTimer)
    _contextTokensFlushTimer = null
  }
  await queueContextTokensWrite(data)
}
