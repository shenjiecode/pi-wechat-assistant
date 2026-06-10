// ============================================================================
// 微信远程命令处理
// ============================================================================

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { debugLog } from './logger.js'
import { formatError } from './utils.js'
import { getImageMaxBytes, getImageBatchWaitMs } from './queue.js'
import { WeixinClient } from './client.js'

type Ctx = ExtensionContext | ExtensionCommandContext

export interface RemoteCommandDeps {
  pi: ExtensionAPI
  getCtx: () => Ctx | null
  client: () => WeixinClient | null
  queueLength: () => number
}

type RemoteCommandFn = (args: string, userId: string, client: WeixinClient, deps: RemoteCommandDeps) => Promise<string | null>

const commands: Record<string, RemoteCommandFn> = {
  async model(args, userId, client, deps) {
    const ctx = deps.getCtx()
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
    const success = await deps.pi.setModel(model)
    return success
      ? `✅ 已切换模型: ${model.provider}/${model.id}`
      : `❌ 切换失败: ${model.provider}/${model.id} 没有可用的 API key`
  },

  async thinking(args, _userId, _client, deps) {
    const valid = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
    type ThinkingLevel = typeof valid[number]
    if (!args) return `当前 thinking level: ${deps.pi.getThinkingLevel()}\n可选: ${valid.join(', ')}`
    if (valid.includes(args as ThinkingLevel)) {
      deps.pi.setThinkingLevel(args as ThinkingLevel)
      return `✅ thinking level 已设为: ${args}`
    }
    return `❌ 无效 level: ${args}\n可选: ${valid.join(', ')}`
  },

  async tools(args, _userId, _client, deps) {
    if (!args) {
      const active = deps.pi.getActiveTools()
      const all = deps.pi.getAllTools().map(t => t.name)
      const lines = ['活跃工具:', ...active.map(t => `  ✅ ${t}`), '', '全部工具:']
      for (const t of all) lines.push(`  ${active.includes(t) ? '✅' : '⬜'} ${t}`)
      return lines.join('\n')
    }
    const toolNames = args.split(/[,\s]+/).filter(Boolean)
    const allNames = deps.pi.getAllTools().map(t => t.name)
    const invalid = toolNames.filter(t => !allNames.includes(t))
    if (invalid.length > 0) return `❌ 未知工具: ${invalid.join(', ')}\n输入 /tools 查看全部`
    deps.pi.setActiveTools(toolNames.filter(t => allNames.includes(t)))
    return `✅ 活跃工具已设为: ${toolNames.filter(t => allNames.includes(t)).join(', ')}`
  },

  async compact(_args, userId, client, deps) {
    const ctx = deps.getCtx()
    if (!ctx) return '❌ 会话上下文尚未就绪'
    ctx.compact({
      onComplete: () => { void client.sendText(userId, '✅ 上下文压缩完成') },
      onError: (error) => { void client.sendText(userId, `❌ 压缩失败: ${error.message}`) },
    })
    return '⏳ 正在压缩上下文...'
  },

  async stop(_args, _userId, _client, deps) {
    const ctx = deps.getCtx()
    if (!ctx) return '❌ 会话上下文尚未就绪'
    if (ctx.isIdle()) return '当前没有在执行任务'
    ctx.abort()
    return '✅ 已发送停止信号'
  },

  async status(_args, _userId, _client, deps) {
    const ctx = deps.getCtx()
    if (!ctx) return '❌ 会话上下文尚未就绪'
    const lines: string[] = []
    if (ctx.model) lines.push(`模型: ${ctx.model.provider}/${ctx.model.id}`)
    lines.push(`Thinking: ${deps.pi.getThinkingLevel()}`)
    lines.push(`工具数: ${deps.pi.getActiveTools().length}`)
    lines.push(`排队消息: ${deps.queueLength()}`)

    const branch = ctx.sessionManager.getBranch()
    let startIndex = 0
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i].type === 'compaction') { startIndex = i + 1; break }
    }
    let userMsgs = 0, assistantMsgs = 0, toolCalls = 0, toolResults = 0
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCost = 0
    for (let i = startIndex; i < branch.length; i++) {
      const entry = branch[i]
      if (entry.type !== 'message') continue
      const msg = (entry as { message?: { role?: string; content?: Array<{ type: string }>; usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } } }).message
      if (!msg) continue
      if (msg.role === 'user') userMsgs++
      else if (msg.role === 'assistant') {
        assistantMsgs++
        totalInput += msg.usage?.input ?? 0
        totalOutput += msg.usage?.output ?? 0
        totalCacheRead += msg.usage?.cacheRead ?? 0
        totalCost += msg.usage?.cost?.total ?? 0
        toolCalls += (msg.content ?? []).filter((c: { type: string }) => c.type === 'toolCall').length
      } else if (msg.role === 'toolResult') toolResults++
    }
    const totalMsgs = userMsgs + assistantMsgs + toolResults
    if (totalMsgs > 0) {
      lines.push(`消息: ${userMsgs}u / ${assistantMsgs}a / ${toolCalls}tc / ${toolResults}tr = ${totalMsgs}`)
      lines.push(`Token: ${(totalInput + totalOutput + totalCacheRead).toLocaleString()} (in ${totalInput.toLocaleString()} + out ${totalOutput.toLocaleString()} + cache ${totalCacheRead.toLocaleString()})`)
    }
    if (totalCost > 0) lines.push(`费用: $${totalCost.toFixed(4)}`)
    if (startIndex > 0) lines.push('(数据从最近一次压缩后开始计算)')

    const usage = ctx.getContextUsage()
    if (usage) {
      if (usage.tokens != null) {
        const pct = usage.percent != null ? ` (${usage.percent}%)` : ''
        lines.push(`上下文: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens${pct}`)
      } else {
        const estimated = totalInput + totalOutput + totalCacheRead
        if (estimated > 0) {
          lines.push(`上下文: ~${estimated.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (压缩后估算)`)
        } else {
          lines.push(`上下文: 待首次回复 / ${usage.contextWindow.toLocaleString()} tokens`)
        }
      }
    }

    lines.push(`图片等待: ${getImageBatchWaitMs() / 1000}s | 上限: ${Math.round(getImageMaxBytes() / 1024 / 1024)}MB`)
    return lines.join('\n')
  },

  async config(_args, _userId, _client, _deps) {
    return [
      `图片合并等待: ${getImageBatchWaitMs()}ms`,
      `图片上限: ${getImageMaxBytes()} bytes (${Math.round(getImageMaxBytes() / 1024 / 1024)}MB)`,
      '可在 config.json 或环境变量中调整：',
      'PI_WECHAT_IMAGE_BATCH_WAIT_MS',
      'PI_WECHAT_IMAGE_MAX_BYTES',
    ].join('\n')
  },

  async name(args, _userId, _client, deps) {
    if (!args) {
      const current = deps.pi.getSessionName()
      return current ? `当前会话名称: ${current}\n输入 /name <新名称> 来修改` : '当前会话未命名\n输入 /name <名称> 来设置'
    }
    deps.pi.setSessionName(args)
    return `✅ 会话名称已设为: ${args}`
  },

  async session(_args, _userId, _client, deps) {
    const ctx = deps.getCtx()
    if (!ctx) return '❌ 会话上下文尚未就绪'
    const sm = ctx.sessionManager
    const lines: string[] = []
    const file = sm.getSessionFile()
    if (file) {
      const display = file.length > 60 ? '...' + file.slice(-57) : file
      lines.push(`文件: ${display}`)
    }
    lines.push(`会话 ID: ${sm.getSessionId()}`)

    const branch = sm.getBranch()
    let userCount = 0, assistantCount = 0, toolCallCount = 0, toolResultCount = 0, messageCount = 0
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCost = 0

    for (const entry of branch) {
      if (entry.type !== 'message') continue
      messageCount++
      const msg = (entry as { message?: { role?: string; content?: unknown[]; usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } } }).message
      if (!msg) continue
      switch (msg.role) {
        case 'user': userCount++; break
        case 'assistant': {
          assistantCount++
          if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if ((part as { type?: string }).type === 'toolCall') toolCallCount++
            }
          }
          if (msg.usage) {
            totalInput += msg.usage.input ?? 0
            totalOutput += msg.usage.output ?? 0
            totalCacheRead += msg.usage.cacheRead ?? 0
            totalCost += msg.usage.cost?.total ?? 0
          }
          break
        }
        case 'toolResult': toolResultCount++; break
      }
    }
    lines.push('')
    lines.push('Messages')
    lines.push(` User: ${userCount}`)
    lines.push(` Assistant: ${assistantCount}`)
    lines.push(` Tool Calls: ${toolCallCount}`)
    lines.push(` Tool Results: ${toolResultCount}`)
    lines.push(` Total: ${messageCount}`)
    if (totalInput > 0 || totalOutput > 0) {
      const totalTokens = totalInput + totalOutput + totalCacheRead
      lines.push('')
      lines.push('Tokens')
      lines.push(` Input: ${totalInput.toLocaleString()}`)
      lines.push(` Output: ${totalOutput.toLocaleString()}`)
      if (totalCacheRead > 0) lines.push(` Cache Read: ${totalCacheRead.toLocaleString()}`)
      lines.push(` Total: ${totalTokens.toLocaleString()}`)
    }
    if (totalCost > 0) {
      lines.push('')
      lines.push('Cost')
      lines.push(` Total: $${totalCost.toFixed(3)}`)
    }
    return lines.join('\n')
  },

  async help(_args, _userId, _client, _deps) {
    return [
      '📋 微信远程命令:',
      '',
      '/status          查看当前状态',
      '/stop            停止当前生成',
      '/model           查看 / 切换模型',
      '/name <名称>     设置会话名称',
      '/session         查看会话详情',
      '/config          查看图片相关配置',
      '/help            显示帮助',
      '',
      '高级: /thinking, /tools, /compact',
      '直接发文字、语音、图片、文件 = 正常对话',
    ].join('\n')
  },
}

export async function handleRemoteCommand(
  text: string,
  userId: string,
  client: WeixinClient,
  deps: RemoteCommandDeps,
): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return false
  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/)
  const args = rest.join(' ')
  const handler = commands[cmd]
  if (!handler) return false
  try {
    const reply = await handler(args, userId, client, deps)
    if (reply !== null) await client.sendText(userId, reply)
  } catch (err) {
    debugLog(`远程命令 /${cmd} 执行失败: ${formatError(err)}`)
    await client.sendText(userId, `❌ 命令执行失败: ${formatError(err)}`).catch(() => {})
  }
  return true
}
