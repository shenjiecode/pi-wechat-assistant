import type { BridgeConfig } from './config.js'
import { DEFAULT_IMAGE_BATCH_WAIT_MS, DEFAULT_IMAGE_MAX_BYTES, ACK_TEXT, IMAGE_BATCH_ACK_TEXT } from '../shared/constants.js'

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

export function receiptText(config: BridgeConfig, image = false): string {
  return image ? config.imageBatchAckText?.trim() || IMAGE_BATCH_ACK_TEXT : config.ackText?.trim() || ACK_TEXT
}

export function parseImageSetting(key: 'image-wait' | 'image-max', value: string | undefined): number | undefined {
  const numeric = Number(value)
  if (!value || !Number.isFinite(numeric)
    || (key === 'image-wait' ? numeric < 0 || numeric > 60_000 : numeric < 1 || !Number.isSafeInteger(Math.round(numeric * 1024 * 1024)))) return undefined
  return key === 'image-wait' ? Math.min(Math.max(Math.round(numeric), 0), 60_000) : Math.round(numeric * 1024 * 1024)
}
