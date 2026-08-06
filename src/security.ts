// ============================================================================
// 微信桥接安全边界：身份、重放、文件路径和远程工具开关
// ============================================================================

import { readFileSync } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import * as path from 'node:path'

export const MAX_RECENT_MESSAGE_IDS = 500

/** 仅允许扫码凭证所绑定的微信用户进入桥接。 */
export function isAuthorizedWeChatSender(senderId: string | undefined, credentialUserId: string): boolean {
  return Boolean(credentialUserId) && senderId === credentialUserId
}

/**
 * 将消息 ID 加入一个有界的最近处理窗口。返回新数组，不修改调用方数据。
 * 空 ID 不参与去重，以避免把协议异常消息错误地全部折叠为同一条。
 */
export function recordProcessedMessageId(
  recentIds: readonly string[],
  messageId: string,
  limit = MAX_RECENT_MESSAGE_IDS,
): string[] {
  if (!messageId) return [...recentIds].slice(-limit)
  const withoutCurrent = recentIds.filter(id => id !== messageId)
  return [...withoutCurrent, messageId].slice(-limit)
}

export function isDuplicateMessageId(recentIds: ReadonlySet<string>, messageId: string): boolean {
  return Boolean(messageId) && recentIds.has(messageId)
}

/** 仅从当前 message_end 事件取可发送的 assistant 文本，不接收 session 历史数组。 */
export function getAssistantTextFromMessageEnd(message: { role?: string; content?: unknown }): string | null {
  if (message.role !== 'assistant') return null
  if (typeof message.content === 'string') return message.content.trim() || null
  if (!Array.isArray(message.content)) return null
  const text = message.content
    .filter((part): part is { type?: unknown; text?: unknown } => typeof part === 'object' && part !== null)
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text.trim())
    .filter(Boolean)
    .join('\n')
  return text || null
}

/** 使用 relative 而不是前缀匹配，避免 /project-other 这类路径绕过。 */
export function isPathWithin(parentPath: string, targetPath: string): boolean {
  const relative = path.relative(parentPath, targetPath)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export type ProjectFilePathResult =
  | { allowed: true; resolvedPath: string; cwd: string }
  | { allowed: false; reason: string }

/**
 * 验证待发送文件：必须是项目真实目录内的普通文件，且输入路径的任意项目内段都不能是符号链接。
 */
export async function validateProjectFilePath(filePath: string, cwd: string): Promise<ProjectFilePathResult> {
  const lexicalCwd = path.resolve(cwd)
  const candidate = path.resolve(lexicalCwd, filePath)
  if (!isPathWithin(lexicalCwd, candidate)) {
    return { allowed: false, reason: `安全限制：只能发送项目目录内的文件。\n路径: ${candidate}\n项目: ${lexicalCwd}` }
  }

  let realCwd: string
  try {
    realCwd = await realpath(lexicalCwd)
  } catch {
    return { allowed: false, reason: `无法解析项目目录: ${lexicalCwd}` }
  }

  // 拒绝路径中任何项目内符号链接，而不仅是最后一个文件名。
  const segments = path.relative(lexicalCwd, candidate).split(path.sep).filter(Boolean)
  let current = lexicalCwd
  try {
    for (const segment of segments) {
      current = path.join(current, segment)
      if ((await lstat(current)).isSymbolicLink()) {
        return { allowed: false, reason: `安全限制：不允许通过符号链接发送文件: ${current}` }
      }
    }
  } catch {
    return { allowed: false, reason: `文件不存在或无法读取: ${candidate}` }
  }

  let realTarget: string
  try {
    realTarget = await realpath(candidate)
  } catch {
    return { allowed: false, reason: `文件不存在或无法解析: ${candidate}` }
  }
  if (!isPathWithin(realCwd, realTarget)) {
    return { allowed: false, reason: `安全限制：真实文件路径不在项目目录内。\n路径: ${realTarget}\n项目: ${realCwd}` }
  }

  try {
    if (!(await stat(realTarget)).isFile()) {
      return { allowed: false, reason: `安全限制：只能发送普通文件: ${realTarget}` }
    }
  } catch {
    return { allowed: false, reason: `无法读取文件: ${realTarget}` }
  }

  return { allowed: true, resolvedPath: realTarget, cwd: realCwd }
}

export interface RemoteToolsEnvironment {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  osRelease?: string
}

/** 远程修改工具集仅在 Ubuntu 本机显式开启时可用。 */
export function areRemoteToolsAllowed(options: RemoteToolsEnvironment = {}): boolean {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const osRelease = options.osRelease ?? readHostOsRelease()
  return platform === 'linux' && /ubuntu/i.test(osRelease) && env.PI_WECHAT_ALLOW_REMOTE_TOOLS === '1'
}

function readHostOsRelease(): string {
  try {
    return readFileSync('/etc/os-release', 'utf8')
  } catch {
    return ''
  }
}
