import * as path from 'node:path'
import { getStateDir, readJsonFile, writeJsonFile } from './state-storage.js'

const CONFIG_FILE = path.join(getStateDir(), 'config.json')

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

/** 内存缓存，供同步读取使用（由异步 loadConfig / saveConfig 维护）。不重写未知字段或补写默认值。 */
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
