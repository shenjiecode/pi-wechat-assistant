// Login credentials and bridge ownership. Legacy exports remain for compatibility.
import * as path from 'node:path'
import { DEFAULT_BASE_URL, fetchQrCode, getQrCodeStatus, type QrStatusResponse } from '../wechat/api.js'
import type { Credentials } from '../wechat/types.js'
import { inspectBridgeLock, type BridgeLockState } from './bridge-lock.js'
import { acquireBridgeLock, releaseBridgeLock, requestBridgeHandoff, handoffRequested } from './bridge-ownership.js'
import { getStateDir, ensureStateDir, readJsonFile, writeJsonFile, deleteFile } from './state-storage.js'

export { getStateDir } from './state-storage.js'
export { loadConfig, saveConfig, getConfigCache, type BridgeConfig } from './config.js'
export { loadCursor, saveCursor, loadSeenIds, saveSeenIds, clearTransportState, clearContextTokens, loadContextTokens, saveContextTokensThrottled, flushContextTokens, type PersistedContextTokens } from './transport-state.js'

const CREDS_FILE = path.join(getStateDir(), 'credentials.json')
const LOCK_FILE = path.join(getStateDir(), 'session.lock')
export function getCredentialsPath(): string { return CREDS_FILE }

export async function loadCredentials(): Promise<Credentials | null> {
  return readJsonFile<Credentials>(CREDS_FILE)
}

export async function saveCredentials(creds: Credentials): Promise<void> {
  await writeJsonFile(CREDS_FILE, { ...creds, savedAt: new Date().toISOString() })
}

export async function clearCredentials(): Promise<void> {
  await deleteFile(CREDS_FILE)
}

// --- 简单文件锁 ---

export function getBridgeLockState() { return inspectBridgeLock(LOCK_FILE) }
export async function acquireLock(sessionId: string) {
  await ensureStateDir()
  return acquireBridgeLock(LOCK_FILE, sessionId)
}
export function releaseLock(sessionId: string) { return releaseBridgeLock(LOCK_FILE, sessionId) }
export function requestHandoff(owner: Extract<BridgeLockState, { sessionId: string }>, signal?: AbortSignal, onProgress?: (elapsedMs: number) => void) {
  return requestBridgeHandoff(LOCK_FILE, owner, 30_000, signal, onProgress)
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
