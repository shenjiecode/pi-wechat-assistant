// ============================================================================
// 认证与凭证管理
// ============================================================================

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { DEFAULT_BASE_URL, fetchQrCode, getQrCodeStatus, type QrStatusResponse } from './api.js'
import type { Credentials } from './types.js'

// --- 路径 ---

const STATE_DIR = path.join(os.homedir(), '.pi', 'agent', 'wechat-assistant')
const CREDS_FILE = path.join(STATE_DIR, 'credentials.json')
const CONFIG_FILE = path.join(STATE_DIR, 'config.json')
const LOCK_FILE = path.join(STATE_DIR, 'session.lock')
const CONTEXT_TOKENS_FILE = path.join(STATE_DIR, 'context-tokens.json')

export function getStateDir(): string {
  return STATE_DIR
}

export function getCredentialsPath(): string {
  return CREDS_FILE
}

// --- 通用文件辅助 ---

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true })
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureStateDir()
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
}

async function deleteFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch {
    // ignore
  }
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
  _configCache = config
  await writeJsonFile(CONFIG_FILE, config)
}

// --- 简单文件锁 ---

interface LockData {
  pid: number
  sessionId: string
  timestamp: number
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function _readLockFile(): Promise<LockData | null> {
  return readJsonFile<LockData>(LOCK_FILE)
}

async function _writeLockFile(sessionId: string): Promise<void> {
  const data: LockData = { pid: process.pid, sessionId, timestamp: Date.now() }
  await writeJsonFile(LOCK_FILE, data)
}

export async function acquireLock(sessionId: string): Promise<{ success: boolean; message: string }> {
  const existing = await _readLockFile()
  if (existing) {
    if (existing.sessionId === sessionId) {
      await _writeLockFile(sessionId)
      return { success: true, message: '锁已更新' }
    }
    if (isProcessRunning(existing.pid)) {
      return {
        success: false,
        message: `微信已被其他 pi 实例占用 (PID: ${existing.pid})，请先在那个实例中执行 /wechat-stop`,
      }
    }
    // 进程不存在，锁已失效，可抢占
  }

  await _writeLockFile(sessionId)
  return { success: true, message: '成功获取锁' }
}

export async function releaseLock(sessionId: string): Promise<void> {
  const existing = await _readLockFile()
  if (existing?.sessionId === sessionId) {
    await deleteFile(LOCK_FILE)
  }
}

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
const CONTEXT_TOKENS_FLUSH_MS = 5_000

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
    void writeJsonFile(CONTEXT_TOKENS_FILE, data)
  }, CONTEXT_TOKENS_FLUSH_MS)
}

/** 立即持久化 context tokens（退出时使用） */
export async function flushContextTokens(data: PersistedContextTokens): Promise<void> {
  if (_contextTokensFlushTimer) {
    clearTimeout(_contextTokensFlushTimer)
    _contextTokensFlushTimer = null
  }
  await writeJsonFile(CONTEXT_TOKENS_FILE, data)
}
