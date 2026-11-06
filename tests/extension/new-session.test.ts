import { describe, expect, it, vi } from 'vitest'
import { registerNewSession } from '../../src/extension/new-session.js'

function setup() {
  const commands: Record<string, any> = {}
  const sendUserMessage = vi.fn()
  const reply = vi.fn(async () => {})
  const deps = {
    supported: vi.fn(() => true), pending: vi.fn(() => false), running: vi.fn(() => true),
    start: vi.fn(async () => {}), reply,
  }
  const ctx = {
    isIdle: vi.fn(() => true), hasPendingMessages: vi.fn(() => false),
    sessionManager: { getSessionId: () => 'old-session' },
    newSession: vi.fn(async (_options: any) => ({ cancelled: true })),
  }
  const controller = registerNewSession({
    registerCommand: (name: string, command: any) => { commands[name] = command }, sendUserMessage,
  } as any, deps)
  const run = (args = 'create bound-user old-session') => commands['wechat-new-session'].handler(args, ctx)
  return { controller, deps, ctx, run, sendUserMessage }
}

describe('remote new session', () => {
  it.each(['unsupported', 'stopped', 'busy', 'Pi queue', 'bridge queue'] as const)('refuses %s without dispatch', reason => {
    const s = setup()
    if (reason === 'unsupported') s.deps.supported.mockReturnValue(false)
    if (reason === 'stopped') s.deps.running.mockReturnValue(false)
    if (reason === 'busy') s.ctx.isIdle.mockReturnValue(false)
    if (reason === 'Pi queue') s.ctx.hasPendingMessages.mockReturnValue(true)
    if (reason === 'bridge queue') s.deps.pending.mockReturnValue(true)
    expect(s.controller.request('', 'bound-user', s.ctx)).toMatch(/^❌/)
    expect(s.sendUserMessage).not.toHaveBeenCalled()
    expect(s.controller.changing).toBe(false)
  })

  it('rejects arguments and concurrent requests', () => {
    const s = setup()
    expect(s.controller.request('extra', 'bound-user', s.ctx)).toContain('用法')
    expect(s.controller.request('', 'bound-user', s.ctx)).toBeNull()
    expect(s.controller.request('', 'bound-user', s.ctx)).toContain('正在新建')
    expect(s.sendUserMessage).toHaveBeenCalledExactlyOnceWith('/wechat-new-session create bound-user old-session', {
      expandPromptTemplates: true, deliverAs: 'followUp',
    })
  })

  it('rechecks pending input when the command executes', async () => {
    const s = setup()
    s.controller.request('', 'bound-user', s.ctx)
    s.ctx.hasPendingMessages.mockReturnValue(true)
    await s.run()
    expect(s.ctx.newSession).not.toHaveBeenCalled()
    expect(s.deps.reply).toHaveBeenCalledWith('bound-user', expect.stringContaining('待处理消息'))
    expect(s.controller.changing).toBe(false)
  })

  it('refuses a command issued for a session that has since changed', async () => {
    const s = setup()
    await s.run('create bound-user stale-session')
    expect(s.ctx.newSession).not.toHaveBeenCalled()
    expect(s.deps.reply).toHaveBeenCalledWith('bound-user', expect.stringContaining('会话已变化'))
  })

  it('clears the transition if dispatch throws', () => {
    const s = setup()
    s.sendUserMessage.mockImplementation(() => { throw new Error('stale runtime') })
    expect(() => s.controller.request('', 'bound-user', s.ctx)).toThrow('stale runtime')
    expect(s.controller.changing).toBe(false)
  })

  it('reports cancellation and permits another request', async () => {
    const s = setup()
    s.controller.request('', 'bound-user', s.ctx)
    await s.run()
    expect(s.deps.reply).toHaveBeenCalledWith('bound-user', expect.stringContaining('已取消'))
    expect(s.controller.request('', 'bound-user', s.ctx)).toBeNull()
  })

  it('reports failure without claiming success', async () => {
    const s = setup()
    s.ctx.newSession.mockRejectedValue(new Error('replacement failed'))
    s.controller.request('', 'bound-user', s.ctx)
    await s.run()
    expect(s.deps.reply).toHaveBeenCalledExactlyOnceWith('bound-user', expect.stringContaining('replacement failed'))
    expect(s.deps.start).not.toHaveBeenCalled()
    expect(s.controller.changing).toBe(false)
  })

  it('uses only the fresh context after replacement', async () => {
    const s = setup()
    const freshSend = vi.fn(async () => {})
    s.ctx.newSession.mockImplementation(async options => {
      await options.withSession({ sessionManager: { getSessionId: () => 'new-session' }, sendUserMessage: freshSend })
      return { cancelled: false }
    })
    s.controller.request('', 'bound-user', s.ctx)
    await s.run()
    expect(freshSend).toHaveBeenCalledExactlyOnceWith('/wechat-new-session resume bound-user new-session', {
      expandPromptTemplates: true, deliverAs: 'followUp',
    })
    expect(s.sendUserMessage).toHaveBeenCalledTimes(1)
    expect(s.deps.reply).not.toHaveBeenCalled()
    expect(s.controller.changing).toBe(false)
  })

  it('does not confirm an unchanged session ID', async () => {
    const s = setup()
    s.ctx.newSession.mockImplementation(async options => {
      await options.withSession({ sessionManager: s.ctx.sessionManager })
      return { cancelled: false }
    })
    await s.run()
    expect(s.deps.reply).toHaveBeenCalledWith('bound-user', expect.stringContaining('different session'))
  })

  it('starts the bridge before success and validates the target session', async () => {
    const s = setup()
    await s.run('resume bound-user wrong-session')
    expect(s.deps.start).not.toHaveBeenCalled()
    await s.run('resume bound-user old-session')
    expect(s.deps.start).toHaveBeenCalledExactlyOnceWith(s.ctx)
    expect(s.deps.start.mock.invocationCallOrder[0]).toBeLessThan(s.deps.reply.mock.invocationCallOrder[0])
    expect(s.deps.reply).toHaveBeenCalledWith('bound-user', expect.stringContaining('桥接已恢复'))
  })

  it('reports a thrown restart error as a partial success', async () => {
    const s = setup()
    s.deps.start.mockRejectedValue(new Error('restart failed'))
    await s.run('resume bound-user old-session')
    expect(s.deps.reply).toHaveBeenCalledExactlyOnceWith('bound-user', expect.stringContaining('恢复桥接失败: restart failed'))
  })

  it('distinguishes bridge restart failure from session creation failure', async () => {
    const s = setup()
    s.deps.running.mockReturnValue(false)
    await s.run('resume bound-user old-session')
    expect(s.deps.reply).toHaveBeenCalledWith('bound-user', expect.stringContaining('已新建空白会话，但微信桥接启动失败'))
  })
})
