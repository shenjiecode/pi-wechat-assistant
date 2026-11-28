import { getConfigCache, type BridgeConfig } from './config.js'
import { DEFAULT_IMAGE_BATCH_WAIT_MS, DEFAULT_IMAGE_MAX_BYTES, ACK_TEXT, IMAGE_BATCH_ACK_TEXT } from '../shared/constants.js'
import { DEFAULT_WECHAT_BLOCKED_TOOLS, WECHAT_SOURCE_TAG } from '../messaging/wechat-source.js'

// Resolve without rewriting persisted JSON: explicit false/zero and unknown fields survive.
export function resolveImageBatchWaitMs(config: BridgeConfig): number {
  const configured = config.imageBatchWaitMs
  const envValue = Number(process.env.PI_WECHAT_IMAGE_BATCH_WAIT_MS)
  const value = configured ?? (Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_IMAGE_BATCH_WAIT_MS)
  return Math.max(0, Math.min(value, 60_000))
}

export function resolveImageMaxBytes(config: BridgeConfig): number {
  const configured = config.imageMaxBytes
  const envValue = Number(process.env.PI_WECHAT_IMAGE_MAX_BYTES)
  const value = configured ?? (Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_IMAGE_MAX_BYTES)
  return Math.max(1024 * 1024, value)
}

/** Every tri-state config field resolved to its effective value. */
export interface ResolvedBridgeConfig {
  autoStart: boolean
  bidirectionalSync: boolean
  sendAck: boolean
  ackText: string
  imageBatchAckText: string
  completionSummary: boolean
  handoff: 'ask' | 'auto'
  allowRemoteTools: boolean
  sourceEnabled: boolean
  wechatTag: string
  blockedTools: string[]
  imageBatchWaitMs: number
  imageMaxBytes: number
}

/** Centralizes all defaults; callers never repeat `=== true` / `!== false` checks. */
export function resolveConfig(config: BridgeConfig = getConfigCache()): ResolvedBridgeConfig {
  const tag = config.messageSourceTag
  return {
    autoStart: config.autoStart === true,
    bidirectionalSync: config.bidirectionalSync === true,
    sendAck: config.sendAck !== false,
    ackText: config.ackText?.trim() || ACK_TEXT,
    imageBatchAckText: config.imageBatchAckText?.trim() || IMAGE_BATCH_ACK_TEXT,
    completionSummary: config.completionSummary === true,
    handoff: config.handoff === 'auto' ? 'auto' : 'ask',
    allowRemoteTools: config.allowRemoteTools === true,
    sourceEnabled: tag?.enabled !== false,
    wechatTag: tag?.wechatTag?.trim() || WECHAT_SOURCE_TAG,
    blockedTools: [...(tag?.blockedTools ?? DEFAULT_WECHAT_BLOCKED_TOOLS)],
    imageBatchWaitMs: resolveImageBatchWaitMs(config),
    imageMaxBytes: resolveImageMaxBytes(config),
  }
}

export function receiptText(config: BridgeConfig, image = false): string {
  const resolved = resolveConfig(config)
  return image ? resolved.imageBatchAckText : resolved.ackText
}

export function parseImageSetting(key: 'image-wait' | 'image-max', value: string | undefined): number | undefined {
  const numeric = Number(value)
  if (!value || !Number.isFinite(numeric)
    || (key === 'image-wait' ? numeric < 0 || numeric > 60_000 : numeric < 1 || !Number.isSafeInteger(Math.round(numeric * 1024 * 1024)))) return undefined
  return key === 'image-wait' ? Math.min(Math.max(Math.round(numeric), 0), 60_000) : Math.round(numeric * 1024 * 1024)
}
