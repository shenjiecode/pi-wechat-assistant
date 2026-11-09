import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { formatError } from '../shared/utils.js'

const COMMAND = 'wechat-new-session'
const COMMAND_OPTIONS = { expandPromptTemplates: true, deliverAs: 'followUp' as const }

interface NewSessionDeps {
  supported: () => boolean
  pending: () => boolean
  running: () => boolean
  start: (ctx: ExtensionCommandContext) => Promise<void>
  // A short-lived sender can report failures even after Pi disposes the old runtime.
  reply: (userId: string, text: string) => Promise<void>
}

export function registerNewSession(pi: ExtensionAPI, deps: NewSessionDeps) {
  let changing = false

  function blocker(ctx: { isIdle(): boolean; hasPendingMessages(): boolean }): string | null {
    if (!deps.supported()) return '❌ 当前 Pi 版本不支持远程 /new，请升级至 Pi 0.99.2 或更新版本'
    if (!deps.running()) return '❌ 微信桥接未运行，无法远程新建会话'
    if (!ctx.isIdle()) return '❌ 当前任务尚未结束，请等待完成后再发送 /new'
    if (ctx.hasPendingMessages() || deps.pending()) return '❌ 仍有待处理消息，请等待处理完成后再发送 /new'
    return null
  }

  pi.registerCommand(COMMAND, {
    description: 'Internal WeChat session creation and bridge restart',
    handler: async (args, ctx) => {
      const [action, encodedUser, sessionId] = args.split(' ')
      if (!encodedUser || !['create', 'resume'].includes(action)) return
      const userId = decodeURIComponent(encodedUser)
      if (action === 'resume') {
        if (ctx.sessionManager.getSessionId() !== sessionId) return
        try { await deps.start(ctx) }
        catch (error) {
          await deps.reply(userId, `⚠️ 已新建空白会话，但恢复桥接失败: ${formatError(error)}`)
          return
        }
        await deps.reply(userId, deps.running()
          ? `✅ 已新建空白会话，微信桥接已恢复\n会话 ID: ${sessionId}`
          : '⚠️ 已新建空白会话，但微信桥接启动失败；请在 Pi 中检查 /wechat status')
        return
      }
      const problem = blocker(ctx)
      if (problem) { changing = false; await deps.reply(userId, problem); return }
      const previousId = ctx.sessionManager.getSessionId()
      if (sessionId !== previousId) {
        changing = false
        await deps.reply(userId, '❌ 会话已变化，请在当前会话重新发送 /new')
        return
      }
      changing = true
      try {
        const result = await ctx.newSession({
          withSession: async fresh => {
            const id = fresh.sessionManager.getSessionId()
            if (id === previousId) throw new Error('Pi did not create a different session')
            // Never reuse the old pi/ctx after replacement, including for bridge startup.
            await fresh.sendUserMessage(`/${COMMAND} resume ${encodedUser} ${id}`, COMMAND_OPTIONS)
          },
        })
        if (result.cancelled) await deps.reply(userId, '已取消新建会话，原会话保持不变')
      } catch (error) {
        await deps.reply(userId, `❌ 新建会话或恢复桥接失败: ${formatError(error)}\n请检查 Pi；未确认新会话和桥接均已就绪。`)
      } finally { changing = false }
    },
  })

  return {
    get changing() { return changing },
    request(args: string, userId: string, ctx: Pick<ExtensionCommandContext, 'isIdle' | 'hasPendingMessages' | 'sessionManager'>): string | null {
      if (args) return '用法: /new（不带参数）'
      if (changing) return '⏳ 正在新建会话，请等待结果后再发送消息'
      const problem = blocker(ctx)
      if (problem) return problem
      changing = true
      // Do not await replacement from the poll loop: shutdown must drain that loop.
      try {
        pi.sendUserMessage(`/${COMMAND} create ${encodeURIComponent(userId)} ${ctx.sessionManager.getSessionId()}`, COMMAND_OPTIONS)
      } catch (error) {
        changing = false
        throw error
      }
      return null
    },
  }
}
