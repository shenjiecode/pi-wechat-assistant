// ============================================================================
// 微信远程命令处理
// ============================================================================

import { debugLog, debugError } from '../shared/logger.js'
import { formatError } from '../shared/utils.js'
import { WeixinClient } from '../wechat/client.js'
import type { BridgeRuntime } from './runtime.js'
import { resolveConfig } from '../bridge/config-values.js'

interface BranchMessage {
  role?: string
  content?: Array<{ type?: string }>
  usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } }
}

interface BranchEntry {
  type?: string
  message?: BranchMessage
}

interface SessionStats {
  messageCount: number
  userMsgs: number
  assistantMsgs: number
  toolCalls: number
  toolResults: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCost: number
}

/** Shared branch traversal for the /status and /session remote commands. */
function collectSessionStats(entries: readonly BranchEntry[]): SessionStats {
  const stats: SessionStats = {
    messageCount: 0, userMsgs: 0, assistantMsgs: 0, toolCalls: 0, toolResults: 0,
    totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCost: 0,
  }
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    stats.messageCount++
    const msg = entry.message
    if (!msg) continue
    if (msg.role === 'user') stats.userMsgs++
    else if (msg.role === 'assistant') {
      stats.assistantMsgs++
      stats.totalInput += msg.usage?.input ?? 0
      stats.totalOutput += msg.usage?.output ?? 0
      stats.totalCacheRead += msg.usage?.cacheRead ?? 0
      stats.totalCost += msg.usage?.cost?.total ?? 0
      stats.toolCalls += (msg.content ?? []).filter(part => part.type === 'toolCall').length
    } else if (msg.role === 'toolResult') stats.toolResults++
  }
  return stats
}

type RemoteCommandFn = (args: string, userId: string, client: WeixinClient, rt: BridgeRuntime) => Promise<string | null>

const commands: Record<string, RemoteCommandFn> = {
  async new(args, userId, _client, rt) {
    const ctx = rt.latestCtx
    if (!ctx) return '❌ 会话上下文尚未就绪，请稍后再试'
    return rt.newSession.request(args, userId, ctx)
  },

  async model(args, userId, client, rt) {
    const ctx = rt.latestCtx
    if (!ctx) return '❌ 会话上下文尚未就绪，请稍后再试'
    const registry = ctx.modelRegistry
    if (!args) {
      const models = registry.getAvailable()
      const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'unknown'
      const lines = [`当前模型: ${current}`, '', '可用模型:']
      const seen = new Set<string>()
      for (const m of models) {
        const key = `${m.provider}/${m.id}`
        if (seen.has(key)) continue
        seen.add(key)
        lines.push(`  ${key}${key === current ? ' ←' : ''}`)
      }
      return lines.join('\n')
    }
    let model
    if (args.includes('/')) {
      const [provider, ...idParts] = args.split('/')
      model = registry.find(provider, idParts.join('/'))
    } else {
      for (const m of registry.getAvailable()) {
        if (m.id === args || m.id.includes(args)) { model = m; break }
      }
    }
    if (!model) return `❌ 未找到模型: ${args}\n输入 /model 查看可用列表`
    const success = await rt.pi.setModel(model)
    return success
      ? `✅ 已切换模型: ${model.provider}/${model.id}`
      : `❌ 切换失败: ${model.provider}/${model.id} 没有可用的 API key`
  },

  async thinking(args, _userId, _client, rt) {
    const valid = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
    type ThinkingLevel = typeof valid[number]
    if (!args) return `当前 thinking level: ${rt.pi.getThinkingLevel()}\n可选: ${valid.join(', ')}`
    if (valid.includes(args as ThinkingLevel)) {
      rt.pi.setThinkingLevel(args as ThinkingLevel)
      return `✅ thinking level 已设为: ${args}`
    }
    return `❌ 无效 level: ${args}\n可选: ${valid.join(', ')}`
  },

  async tools(args, _userId, _client, rt) {
    if (!(await rt.isRemoteToolsEnabled())) {
      return '🔒 出于安全考虑，微信端 /tools 默认禁用（它可修改本机工具权限）\n如需开启，请在电脑端 TUI 执行 /wechat remotetools on'
    }
    if (!args) {
      const active = rt.pi.getActiveTools()
      const all = rt.pi.getAllTools().map(t => t.name)
      const lines = ['活跃工具:', ...active.map(t => `  ✅ ${t}`), '', '全部工具:']
      for (const t of all) lines.push(`  ${active.includes(t) ? '✅' : '⬜'} ${t}`)
      return lines.join('\n')
    }
    const toolNames = args.split(/[,\s]+/).filter(Boolean)
    const allNames = rt.pi.getAllTools().map(t => t.name)
    const invalid = toolNames.filter(t => !allNames.includes(t))
    if (invalid.length > 0) return `❌ 未知工具: ${invalid.join(', ')}\n输入 /tools 查看全部`
    rt.pi.setActiveTools(toolNames.filter(t => allNames.includes(t)))
    return `✅ 活跃工具已设为: ${toolNames.filter(t => allNames.includes(t)).join(', ')}`
  },

  async compact(_args, userId, client, rt) {
    const ctx = rt.latestCtx
    if (!ctx) return '❌ 会话上下文尚未就绪'
    ctx.compact({
      onComplete: () => { void client.sendText(userId, '✅ 上下文压缩完成') },
      onError: (error) => { void client.sendText(userId, `❌ 压缩失败: ${error.message}`) },
    })
    return '⏳ 正在压缩上下文...'
  },

  async stop(_args, _userId, _client, rt) {
    const ctx = rt.latestCtx
    if (!ctx) return '❌ 会话上下文尚未就绪'
    if (ctx.isIdle()) return '当前没有在执行任务'
    ctx.abort()
    return '✅ 已发送停止信号'
  },

  async status(_args, _userId, _client, rt) {
    const ctx = rt.latestCtx
    if (!ctx) return '❌ 会话上下文尚未就绪'
    const lines: string[] = []
    if (ctx.model) lines.push(`模型: ${ctx.model.provider}/${ctx.model.id}`)
    lines.push(`Thinking: ${rt.pi.getThinkingLevel()}`)
    lines.push(`工具数: ${rt.pi.getActiveTools().length}`)
    lines.push(`排队消息: ${rt.queue.pending}`)
    const outbox = rt.outboxStatus()
    lines.push(`待补发回复: ${outbox.pending}`)
    if (outbox.uncertain) lines.push(`送达待确认: ${outbox.uncertain}（不自动重发，请在 Pi 会话中核对）`)

    const branch = ctx.sessionManager.getBranch() as readonly BranchEntry[]
    let startIndex = 0
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i].type === 'compaction') { startIndex = i + 1; break }
    }
    const stats = collectSessionStats(branch.slice(startIndex))
    const totalMsgs = stats.userMsgs + stats.assistantMsgs + stats.toolResults
    if (totalMsgs > 0) {
      lines.push(`消息: ${stats.userMsgs}u / ${stats.assistantMsgs}a / ${stats.toolCalls}tc / ${stats.toolResults}tr = ${totalMsgs}`)
      lines.push(`Token: ${(stats.totalInput + stats.totalOutput + stats.totalCacheRead).toLocaleString()} (in ${stats.totalInput.toLocaleString()} + out ${stats.totalOutput.toLocaleString()} + cache ${stats.totalCacheRead.toLocaleString()})`)
    }
    if (stats.totalCost > 0) lines.push(`费用: $${stats.totalCost.toFixed(4)}`)
    if (startIndex > 0) lines.push('(数据从最近一次压缩后开始计算)')

    const usage = ctx.getContextUsage()
    if (usage) {
      if (usage.tokens != null) {
        const pct = usage.percent != null ? ` (${usage.percent}%)` : ''
        lines.push(`上下文: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens${pct}`)
      } else {
        const estimated = stats.totalInput + stats.totalOutput + stats.totalCacheRead
        if (estimated > 0) {
          lines.push(`上下文: ~${estimated.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (压缩后估算)`)
        } else {
          lines.push(`上下文: 待首次回复 / ${usage.contextWindow.toLocaleString()} tokens`)
        }
      }
    }

    const config = resolveConfig()
    lines.push(`图片等待: ${config.imageBatchWaitMs / 1000}s | 上限: ${Math.round(config.imageMaxBytes / 1024 / 1024)}MB`)
    return lines.join('\n')
  },

  async config(_args, _userId, _client, _rt) {
    const config = resolveConfig()
    return [
      `图片合并等待: ${config.imageBatchWaitMs}ms`,
      `图片上限: ${config.imageMaxBytes} bytes (${Math.round(config.imageMaxBytes / 1024 / 1024)}MB)`,
      '可在 config.json 或环境变量中调整：',
      'PI_WECHAT_IMAGE_BATCH_WAIT_MS',
      'PI_WECHAT_IMAGE_MAX_BYTES',
    ].join('\n')
  },

  async name(args, _userId, _client, rt) {
    if (!args) {
      const current = rt.pi.getSessionName()
      return current ? `当前会话名称: ${current}\n输入 /name <新名称> 来修改` : '当前会话未命名\n输入 /name <名称> 来设置'
    }
    rt.pi.setSessionName(args)
    return `✅ 会话名称已设为: ${args}`
  },

  async session(_args, _userId, _client, rt) {
    const ctx = rt.latestCtx
    if (!ctx) return '❌ 会话上下文尚未就绪'
    const sm = ctx.sessionManager
    const lines: string[] = []
    const file = sm.getSessionFile()
    if (file) {
      const display = file.length > 60 ? '...' + file.slice(-57) : file
      lines.push(`文件: ${display}`)
    }
    lines.push(`会话 ID: ${sm.getSessionId()}`)

    const stats = collectSessionStats(sm.getBranch() as readonly BranchEntry[])
    lines.push('')
    lines.push('Messages')
    lines.push(` User: ${stats.userMsgs}`)
    lines.push(` Assistant: ${stats.assistantMsgs}`)
    lines.push(` Tool Calls: ${stats.toolCalls}`)
    lines.push(` Tool Results: ${stats.toolResults}`)
    lines.push(` Total: ${stats.messageCount}`)
    if (stats.totalInput > 0 || stats.totalOutput > 0) {
      const totalTokens = stats.totalInput + stats.totalOutput + stats.totalCacheRead
      lines.push('')
      lines.push('Tokens')
      lines.push(` Input: ${stats.totalInput.toLocaleString()}`)
      lines.push(` Output: ${stats.totalOutput.toLocaleString()}`)
      if (stats.totalCacheRead > 0) lines.push(` Cache Read: ${stats.totalCacheRead.toLocaleString()}`)
      lines.push(` Total: ${totalTokens.toLocaleString()}`)
    }
    if (stats.totalCost > 0) {
      lines.push('')
      lines.push('Cost')
      lines.push(` Total: $${stats.totalCost.toFixed(3)}`)
    }
    return lines.join('\n')
  },

  async help(_args, _userId, _client, _rt) {
    return [
      '📋 微信远程命令:',
      '',
      '/status          查看当前状态',
      '/stop            停止当前生成',
      '/model           查看 / 切换模型',
      '/name <名称>     设置会话名称',
      '/new             新建空白会话并保持微信连接',
      '/session         查看会话详情',
      '/config          查看图片相关配置',
      '/help            显示帮助',
      '',
      '高级: /thinking, /compact；/tools 默认禁用（电脑端执行 /wechat remotetools on 开启）',
      '直接发文字、语音、图片、文件 = 正常对话',
    ].join('\n')
  },
}

export async function handleRemoteCommand(
  text: string,
  userId: string,
  client: WeixinClient,
  rt: BridgeRuntime,
): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return false
  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/)
  const args = rest.join(' ')
  const handler = commands[cmd]
  if (!handler) return false
  try {
    const reply = await handler(args, userId, client, rt)
    if (reply !== null) await client.sendText(userId, reply)
  } catch (err) {
    debugLog(`远程命令 /${cmd} 执行失败: ${debugError(err)}`)
    await client.sendText(userId, `❌ 命令执行失败: ${formatError(err)}`).catch(() => {})
  }
  return true
}
