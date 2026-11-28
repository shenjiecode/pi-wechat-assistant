// Login credentials and bridge ownership.
import * as path from 'node:path'
import { DEFAULT_BASE_URL, fetchQrCode, getQrCodeStatus, type QrStatusResponse } from '../wechat/api.js'
import type { Credentials } from '../wechat/types.js'
import { inspectBridgeLock, type BridgeLockState } from './bridge-lock.js'
import { acquireBridgeLock, releaseBridgeLock, requestBridgeHandoff, handoffRequested } from './bridge-ownership.js'
import { getStateDir, ensureStateDir, readJsonFile, writeJsonFile, deleteFile } from './state-storage.js'

export function getCredentialsPath(): string { return path.join(getStateDir(), 'credentials.json') }
function getLockFile(): string { return path.join(getStateDir(), 'session.lock') }

export async function loadCredentials(): Promise<Credentials | null> {
  return readJsonFile<Credentials>(getCredentialsPath())
}

export async function saveCredentials(creds: Credentials): Promise<void> {
  await writeJsonFile(getCredentialsPath(), { ...creds, savedAt: new Date().toISOString() })
}

export async function clearCredentials(): Promise<void> {
  await deleteFile(getCredentialsPath())
}

// --- 简单文件锁 ---

export function getBridgeLockState() { return inspectBridgeLock(getLockFile()) }
export async function acquireLock(sessionId: string) {
  await ensureStateDir()
  return acquireBridgeLock(getLockFile(), sessionId)
}
export function releaseLock(sessionId: string) { return releaseBridgeLock(getLockFile(), sessionId) }
export function requestHandoff(owner: Extract<BridgeLockState, { sessionId: string }>, signal?: AbortSignal, onProgress?: (elapsedMs: number) => void) {
  return requestBridgeHandoff(getLockFile(), owner, 30_000, signal, onProgress)
}
export function hasHandoffRequest(sessionId: string) { return handoffRequested(getLockFile(), sessionId) }
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
