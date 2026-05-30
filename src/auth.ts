// ============================================================================
// 认证与凭证管理
// ============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DEFAULT_BASE_URL, fetchQrCode, getQrCodeStatus, type QrStatusResponse } from './api.js'
import type { Credentials } from './types.js'

// --- 路径 ---

const STATE_DIR = path.join(os.homedir(), '.pi', 'agent', 'wechat-assistant')
const CREDS_FILE = path.join(STATE_DIR, 'credentials.json')
const CONFIG_FILE = path.join(STATE_DIR, 'config.json')
const LOCK_FILE = path.join(STATE_DIR, 'session.lock')

export function getStateDir(): string {
  return STATE_DIR
}

export function getCredentialsPath(): string {
  return CREDS_FILE
}

// --- 凭证 ---

export function loadCredentials(): Credentials | null {
  try {
    return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8')) as Credentials
  } catch {
    return null
  }
}

export function saveCredentials(creds: Credentials): void {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(
    CREDS_FILE,
    JSON.stringify({ ...creds, savedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  )
}

export function clearCredentials(): void {
  try {
    fs.unlinkSync(CREDS_FILE)
  } catch {
    // ignore
  }
}

// --- 配置 ---

export interface BridgeConfig {
  autoStart?: boolean
}

export function loadConfig(): BridgeConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as BridgeConfig
  } catch {
    return {}
  }
}

export function saveConfig(config: BridgeConfig): void {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })
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

export function acquireLock(sessionId: string): { success: boolean; message: string } {
  // 检查现有锁
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8')) as LockData
    if (existing.sessionId === sessionId) {
      // 自己的锁，更新
      writeLock(sessionId)
      return { success: true, message: '锁已更新' }
    }
    if (isProcessRunning(existing.pid)) {
      return {
        success: false,
        message: `微信已被其他 pi 实例占用 (PID: ${existing.pid})，请先在那个实例中执行 /wechat-stop`,
      }
    }
    // 进程不存在，锁已失效，可以抢占
  } catch {
    // 锁文件不存在，正常
  }

  writeLock(sessionId)
  return { success: true, message: '成功获取锁' }
}

export function releaseLock(sessionId: string): void {
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8')) as LockData
    if (existing.sessionId === sessionId) {
      fs.unlinkSync(LOCK_FILE)
    }
  } catch {
    // ignore
  }
}

function writeLock(sessionId: string): void {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, sessionId, timestamp: Date.now() } satisfies LockData, null, 2))
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
