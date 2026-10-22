import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { existsSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { Type } from '@sinclair/typebox'
import type { WeixinClient } from '../wechat/client.js'
import { getBridgeLockState } from '../bridge/auth.js'
import { describeBridgeLock } from '../bridge/bridge-lock.js'
import { ok, fail, formatError } from '../shared/utils.js'
import { debugLog, debugError } from '../shared/logger.js'

type Ctx = ExtensionContext | ExtensionCommandContext
interface SendToolDeps {
  getClient: () => WeixinClient | null
  isRunning: () => boolean
  latestCtx: () => Ctx | null
}

function isPathInCwd(targetPath: string, cwd: string): boolean {
  const resolved = path.resolve(targetPath)
  const resolvedCwd = path.resolve(cwd)
  return resolved.startsWith(resolvedCwd + path.sep) || resolved === resolvedCwd
}

// ============================================================================
// 工具守卫 — 发送文件/图片到微信的前置校验
// ============================================================================

type ToolGuardResult = {
  allowed: false
  error: ReturnType<typeof fail>
} | {
  allowed: true
  resolvedPath: string
  cwd: string
}

export async function stoppedBridgeReason(): Promise<string> {
  const state = await getBridgeLockState()
  if (state.kind === 'other' || state.kind === 'unknown') return describeBridgeLock(state)
  return '本会话的微信桥接未启动，请执行 /wechat start；需要查看登录凭据及其他会话状态时执行 /wechat status。'
}

async function guardSendToWechat(
  client: WeixinClient | null,
  running: boolean,
  filePath: string,
  latestCtx: Ctx | null,
): Promise<ToolGuardResult> {
  if (!client || !running) return { allowed: false, error: fail(await stoppedBridgeReason()) }

  const cwd = latestCtx?.cwd ?? process.cwd()
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)

  if (!isPathInCwd(resolvedPath, cwd)) {
    return {
      allowed: false,
      error: fail(`安全限制：只能发送项目目录内的文件。\n路径: ${resolvedPath}\n项目: ${path.resolve(cwd)}`),
    }
  }
  if (!existsSync(resolvedPath)) return { allowed: false, error: fail(`文件不存在: ${resolvedPath}`) }

  return { allowed: true, resolvedPath, cwd }
}

function guardFileSize(resolvedPath: string): ReturnType<typeof fail> | null {
  try {
    const stats = statSync(resolvedPath)
    if (stats.size > 50 * 1024 * 1024) {
      return fail(`文件过大 (${(stats.size / 1024 / 1024).toFixed(1)}MB)，上限 50MB`)
    }
    return null
  } catch {
    return fail(`无法读取文件: ${resolvedPath}`)
  }
}

export function registerWechatTools(pi: ExtensionAPI, enabled: boolean, deps: SendToolDeps): void {
  // Older hosts ignore these fields; their active set and execution guards remain authoritative.
  const visibility = { exposure: enabled ? 'direct' as const : 'hidden' as const, defaultActive: enabled }
  pi.registerTool({
    ...visibility,
    name: 'send_file_to_wechat',
    label: 'Send File to WeChat',
    description: '发送项目目录中的文件到当前微信对话。用于将 AI 产出的代码、报告等文件直接发给微信用户。',
    promptSnippet: enabled ? '发送项目目录中的文件到微信' : undefined,
    promptGuidelines: enabled ? [
      '当用户通过微信要求产出文件时，先写入文件再用 send_file_to_wechat 发送。',
      '只能发送项目工作目录内的文件（安全限制）。',
      '如果发送失败，工具会返回错误信息。不要重试超过 1 次。',
    ] : [],
    parameters: Type.Object({
      filePath: Type.String({ description: '要发送的文件路径（项目目录内的绝对路径或相对路径）' }),
      fileName: Type.Optional(Type.String({ description: '在微信中显示的文件名（可选，默认使用原文件名）' })),
    }),
    async execute(_toolCallId, params, _signal) {
      const guard = await guardSendToWechat(deps.getClient(), deps.isRunning(), params.filePath, deps.latestCtx())
      if (!guard.allowed) return guard.error
      const client = deps.getClient()
      if (!deps.isRunning() || !client) return fail(await stoppedBridgeReason())
      const sizeError = guardFileSize(guard.resolvedPath)
      if (sizeError) return sizeError

      try {
        const stats = statSync(guard.resolvedPath)
        await client.sendFile(client.userId, guard.resolvedPath, params.fileName)
        const name = params.fileName ?? path.basename(guard.resolvedPath)
        return ok(`✅ 文件「${name}」(${(stats.size / 1024).toFixed(1)} KB) 已发送到微信`)
      } catch (err) {
        debugLog(`send_file_to_wechat 失败: ${debugError(err)}`)
        return fail(`发送失败: ${formatError(err)}`)
      }
    },
  })

  pi.registerTool({
    ...visibility,
    name: 'send_image_to_wechat',
    label: 'Send Image to WeChat',
    description: '发送项目目录中的图片到当前微信对话。用于将 AI 生成的图表、截图等直接发给微信用户。',
    promptSnippet: enabled ? '发送项目目录中的图片到微信（可预览）' : undefined,
    promptGuidelines: enabled ? [
      '当用户通过微信要求生成图表/截图/图片时，先生成图片文件再用 send_image_to_wechat 发送。',
      '只能发送项目工作目录内的图片（安全限制）。',
      '如果发送失败不要重试超过 1 次。',
    ] : [],
    parameters: Type.Object({
      imagePath: Type.String({ description: '要发送的图片路径（项目目录内的绝对路径或相对路径，支持 png/jpg/gif/webp）' }),
    }),
    async execute(_toolCallId, params, _signal) {
      const guard = await guardSendToWechat(deps.getClient(), deps.isRunning(), params.imagePath, deps.latestCtx())
      if (!guard.allowed) return guard.error
      const client = deps.getClient()
      if (!deps.isRunning() || !client) return fail(await stoppedBridgeReason())
      const sizeError = guardFileSize(guard.resolvedPath)
      if (sizeError) return sizeError

      try {
        const stats = statSync(guard.resolvedPath)
        await client.sendImage(client.userId, guard.resolvedPath)
        return ok(`✅ 图片 (${(stats.size / 1024).toFixed(1)} KB) 已发送到微信`)
      } catch (err) {
        debugLog(`send_image_to_wechat 失败: ${debugError(err)}`)
        return fail(`发送失败: ${formatError(err)}`)
      }
    },
  })

}
