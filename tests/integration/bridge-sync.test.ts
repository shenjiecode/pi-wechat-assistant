import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeConfig } from '../../src/bridge/config.js'

const state = vi.hoisted(() => ({
  config: {} as BridgeConfig,
  queue: null as any,
  lockConflict: false,
  lockState: { kind: 'missing' } as any,
  requestHandoff: vi.fn(async (_owner: any, _signal?: AbortSignal, _progress?: (elapsedMs: number) => void) => {}),
  debugLog: vi.fn(),
  handoffRequested: false,
  client: {
    userId: 'bound-user', accountId: 'bot', lastActiveUserId: null,
    hasContextToken: false,
    lastSend: null as { success: boolean; at: string; error?: string } | null,
    onStatusChange: undefined as (() => void) | undefined,
    sendText: vi.fn(), notifyStart: vi.fn(), notifyStop: vi.fn(),
    resumeSending: vi.fn(), pauseSending: vi.fn(),
    reloadReceiveState: vi.fn(), flushReceiveState: vi.fn(),
    getUpdates: vi.fn(), dispose: vi.fn(), startTyping: vi.fn(), stopTyping: vi.fn(),
  },
}))
vi.mock('../../src/shared/logger.js', async () => ({
  ...await vi.importActual<typeof import('../../src/shared/logger.js')>('../../src/shared/logger.js'),
  debugLog: state.debugLog,
}))
vi.mock('../../src/wechat/client.js', () => ({
  WeixinClient: { create: vi.fn(async () => state.client) },
  SessionExpiredError: class extends Error {},
}))
vi.mock('../../src/bridge/config.js', () => ({
  loadConfig: vi.fn(async () => state.config),
  saveConfig: vi.fn(async (config: BridgeConfig) => { state.config = config }),
  getConfigCache: vi.fn(() => state.config),
}))
vi.mock('../../src/bridge/state-storage.js', async () => ({
  ...await vi.importActual<typeof import('../../src/bridge/state-storage.js')>('../../src/bridge/state-storage.js'),
  getStateDir: () => process.cwd() + '/node_modules/.cache/wechat-bridge-test-state',
}))
vi.mock('../../src/bridge/auth.js', async () => ({
  ...await vi.importActual<typeof import('../../src/bridge/auth.js')>('../../src/bridge/auth.js'),
  loadCredentials: vi.fn(async () => ({})),
  acquireLock: vi.fn(async (sessionId: string) => {
    if (state.lockConflict) return { success: false, message: '其他 pi 进程持有微信桥接锁（PID 424242）' }
    state.lockState = { kind: 'current', pid: process.pid, sessionId, protocol: 1 }
    return { success: true }
  }),
  requestHandoff: state.requestHandoff,
  releaseLock: vi.fn(async () => { state.lockState = { kind: 'missing' } }),
  hasHandoffRequest: vi.fn(async () => state.handoffRequested),
  getBridgeLockState: vi.fn(async () => state.lockState),
}))
vi.mock('../../src/bridge/queue.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/bridge/queue.js')>('../../src/bridge/queue.js')
  return { ...actual, MessageQueue: class extends actual.MessageQueue {
    constructor(...args: ConstructorParameters<typeof actual.MessageQueue>) { super(...args); state.queue = this }
  } }
})
import extension from '../../index.js'
import { extractTextFromMessageContent } from '../../src/shared/utils.js'
import { BridgeHandoffError } from '../../src/bridge/bridge-ownership.js'

describe('bridge bidirectional sync and lifecycle', () => {
  let handlers: Record<string, (event: any, ctx: any) => any>
  let commands: Record<string, any>
  let activeTools: string[]
  let registeredTools: Map<string, any>
  let sendUserMessage: ReturnType<typeof vi.fn>
  let ctx: any
  let oldListeners: Map<string, Function[]>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.stubEnv('NO_COLOR', '1')
    state.config = {}
    state.lockConflict = false
    state.handoffRequested = false
    state.requestHandoff.mockReset()
    state.lockState = { kind: 'missing' }
    state.client.hasContextToken = false
    state.client.lastSend = null
    state.client.onStatusChange = undefined
    state.client.sendText.mockResolvedValue(undefined)
    // No real network, credentials, locks, or user messages.
    state.client.getUpdates.mockImplementation((signal: AbortSignal) => new Promise((resolve) => {
      if (signal.aborted) resolve([])
      else signal.addEventListener('abort', () => resolve([]), { once: true })
    }))
    for (const name of ['pauseSending', 'reloadReceiveState', 'flushReceiveState', 'notifyStart', 'notifyStop', 'startTyping', 'stopTyping', 'dispose'] as const) {
      state.client[name].mockResolvedValue(undefined)
    }
    handlers = {}; commands = {}; activeTools = ['read', 'bash']; registeredTools = new Map()
    sendUserMessage = vi.fn()
    ctx = {
      cwd: process.cwd(), hasUI: true, isIdle: vi.fn(() => true), waitForIdle: vi.fn(),
      model: { provider: 'test', id: 'test-model' },
      modelRegistry: { hasConfiguredAuth: vi.fn(() => true), getApiKeyAndHeaders: vi.fn() },
      ui: { notify: vi.fn(), setStatus: vi.fn(), select: vi.fn() },
    }
    oldListeners = new Map(['SIGINT', 'SIGTERM', 'beforeExit'].map(name => [name, process.listeners(name)]))
    installExtension()
    await handlers.session_start({}, ctx)
  })
  function installExtension(unsubscribe = true) {
    extension({
      on: (name: string, handler: any) => { handlers[name] = handler; return unsubscribe ? () => {} : undefined },
      registerCommand: (name: string, command: any) => { commands[name] = command },
      registerTool: (tool: any) => {
        registeredTools.set(tool.name, tool)
        activeTools = activeTools.filter(name => name !== tool.name)
        if (tool.exposure !== 'hidden') activeTools.push(tool.name)
      },
      getActiveTools: () => [...activeTools], setActiveTools: (names: string[]) => { activeTools = [...names] },
      sendUserMessage,
    } as any)
  }
  afterEach(async () => {
    await handlers.session_shutdown({}, ctx)
    for (const [name, previous] of oldListeners) {
      for (const listener of process.listeners(name)) {
        if (!previous.includes(listener)) process.removeListener(name, listener as any)
      }
    }
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  const command = (args: string) => commands.wechat.handler(args, ctx)

  it('toggles receipt notifications in the menu and preserves custom content', async () => {
    state.config.ackText = 'Custom receipt'
    ctx.ui.select.mockResolvedValueOnce('收件回执通知：开启 · 收到文字或图片时发送确认').mockResolvedValueOnce('关闭').mockResolvedValueOnce(undefined)
    await command('config')
    expect(state.config.sendAck).toBe(false)
    expect(state.config.ackText).toBe('Custom receipt')
    await command('config ack on')
    expect(state.config.sendAck).toBe(true)
    await command('config ack maybe')
    expect(state.config.sendAck).toBe(true)
    expect(ctx.ui.notify).toHaveBeenLastCalledWith('用法: /wechat config ack on|off', 'error')
  })

  it.each([['ack-text', 'ackText', '文字回执内容：自定义 / 恢复默认'], ['image-ack-text', 'imageBatchAckText', '图片回执内容：自定义 / 恢复默认']] as const)('edits, cancels and resets %s', async (key, field, label) => {
    state.config.sendAck = false
    await command(`config ${key} Hello world\n收到，正在处理`)
    expect(state.config[field]).toBe('Hello world\n收到，正在处理')
    ctx.ui.input = vi.fn().mockResolvedValueOnce(undefined)
    ctx.ui.select.mockResolvedValueOnce(label).mockResolvedValueOnce(undefined)
    await command('config')
    expect(state.config[field]).toBe('Hello world\n收到，正在处理')
    ctx.ui.input.mockResolvedValueOnce('菜单自定义内容')
    ctx.ui.select.mockResolvedValueOnce(label).mockResolvedValueOnce(undefined)
    await command('config')
    expect(state.config[field]).toBe('菜单自定义内容')
    await command('config show')
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('菜单自定义内容'), 'info')
    ctx.ui.input.mockResolvedValueOnce('   ')
    ctx.ui.select.mockResolvedValueOnce(label).mockResolvedValueOnce(undefined)
    await command('config')
    expect(state.config[field]).toBeUndefined()
    expect(state.config.sendAck).toBe(false)
  })

  it('preserves receipt settings if saving fails', async () => {
    const { saveConfig } = await import('../../src/bridge/config.js')
    state.config = { sendAck: false, ackText: 'original' }
    vi.mocked(saveConfig).mockRejectedValueOnce(new Error('disk full'))
    await command('config ack on')
    expect(state.config.sendAck).toBe(false)
    vi.mocked(saveConfig).mockRejectedValueOnce(new Error('disk full'))
    await command('config ack-text replacement')
    expect(state.config.ackText).toBe('original')
  })

  it.each(['autostart', 'remotetools on'])('keeps cached settings when legacy command %s cannot save', async args => {
    const { saveConfig } = await import('../../src/bridge/config.js')
    state.config = { autoStart: false, allowRemoteTools: false }
    vi.mocked(saveConfig).mockRejectedValueOnce(new Error('disk full'))
    await expect(command(args)).rejects.toThrow('disk full')
    expect(state.config).toEqual({ autoStart: false, allowRemoteTools: false })
  })

  it('opens settings while stopped without registering tools or changing rules', async () => {
    ctx.ui.select.mockResolvedValueOnce(undefined)
    await command('config')
    expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining('微信设置'), expect.arrayContaining([
      '双向同步：关闭 · 电脑输入和 AI 回复也转发到微信', '自动启动微信桥接：关闭 · 打开 pi 时尝试连接微信', '微信消息标识与排版：开启 · 消息加来源标记，回复按微信风格',
    ]))
    expect(registeredTools.size).toBe(0)
    expect(await handlers.before_agent_start({ systemPrompt: 'base', prompt: 'local' }, ctx)).toBeUndefined()
  })

  it('saves a menu choice, preserves advanced fields and redisplays its current value', async () => {
    state.config.messageSourceTag = { wechatTag: '[自定义]', blockedTools: ['ask'] }
    ctx.ui.select.mockResolvedValueOnce('双向同步：关闭 · 电脑输入和 AI 回复也转发到微信').mockResolvedValueOnce('开启').mockResolvedValueOnce(undefined)
    await command('config')
    expect(state.config.bidirectionalSync).toBe(true)
    expect(state.config.messageSourceTag).toEqual({ wechatTag: '[自定义]', blockedTools: ['ask'] })
    expect(ctx.ui.select.mock.calls[2][1]).toContain('双向同步：开启 · 电脑输入和 AI 回复也转发到微信')
    expect(state.client.notifyStart).not.toHaveBeenCalled()
  })

  it('cancels a setting choice without saving', async () => {
    const { saveConfig } = await import('../../src/bridge/config.js')
    ctx.ui.select.mockResolvedValueOnce('双向同步：关闭 · 电脑输入和 AI 回复也转发到微信').mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
    await command('config')
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('supports advanced numeric input including zero delay', async () => {
    ctx.ui.input = vi.fn().mockResolvedValueOnce('0')
    ctx.ui.select.mockResolvedValueOnce('高级设置…').mockResolvedValueOnce('连发图片合并等待：8000 毫秒 · 微信连发多张图时凑成一批')
      .mockResolvedValueOnce('自定义…').mockResolvedValueOnce('返回常用设置').mockResolvedValueOnce(undefined)
    await command('config')
    expect(state.config.imageBatchWaitMs).toBe(0)
    expect(ctx.ui.select.mock.calls[3][1]).toContain('连发图片合并等待：0 毫秒 · 微信连发多张图时凑成一批')
  })

  it.each([
    ['连发图片合并等待：8000 毫秒 · 微信连发多张图时凑成一批', '2 秒（较快）', 'imageBatchWaitMs', 2000],
    ['单张图片下载上限：50 MB · 超过则拒绝下载', '10 MB（较小图片）', 'imageMaxBytes', 10 * 1024 * 1024],
  ] as const)('applies image preset without typing: %s', async (setting, preset, key, value) => {
    ctx.ui.input = vi.fn()
    ctx.ui.select.mockResolvedValueOnce('高级设置…').mockResolvedValueOnce(setting)
      .mockResolvedValueOnce(preset).mockResolvedValueOnce('返回常用设置').mockResolvedValueOnce(undefined)
    await command('config')
    expect(state.config[key]).toBe(value)
    expect(ctx.ui.input).not.toHaveBeenCalled()
  })

  it.each([false, true])('cancels image selection without saving (custom=%s)', async custom => {
    const { saveConfig } = await import('../../src/bridge/config.js')
    ctx.ui.input = vi.fn().mockResolvedValue(undefined)
    ctx.ui.select.mockResolvedValueOnce('高级设置…').mockResolvedValueOnce('单张图片下载上限：50 MB · 超过则拒绝下载')
      .mockResolvedValueOnce(custom ? '自定义…' : undefined)
      .mockResolvedValueOnce('返回常用设置').mockResolvedValueOnce(undefined)
    await command('config')
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it.each(['image-wait -1', 'image-wait 60001', 'image-max 0.5', 'image-max Infinity', 'image-max'])('rejects invalid config: %s', async args => {
    const { saveConfig } = await import('../../src/bridge/config.js')
    await command('config ' + args)
    expect(saveConfig).not.toHaveBeenCalled()
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.any(String), 'error')
  })

  it('does not change cached configuration when saving fails', async () => {
    const { saveConfig } = await import('../../src/bridge/config.js')
    vi.mocked(saveConfig).mockRejectedValueOnce(new Error('disk full'))
    ctx.ui.select.mockResolvedValueOnce('双向同步：关闭 · 电脑输入和 AI 回复也转发到微信').mockResolvedValueOnce('开启').mockResolvedValueOnce(undefined)
    await command('config')
    expect(state.config.bidirectionalSync).toBeUndefined()
    expect(ctx.ui.select.mock.calls[2][1]).toContain('双向同步：关闭 · 电脑输入和 AI 回复也转发到微信')
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('配置未保存'), 'error')
  })

  it('keeps a text-only config command without opening dialogs', async () => {
    await command('config show')
    expect(ctx.ui.select).not.toHaveBeenCalled()
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('双向同步'), 'info')
  })

  it('changes autostart explicitly without starting the current bridge', async () => {
    await command('config auto-start on')
    await command('config auto-start on')
    expect(state.config.autoStart).toBe(true)
    expect(state.client.notifyStart).not.toHaveBeenCalled()
  })

  it('offers the takeover dialog from auto-start when another session holds the lock', async () => {
    state.config.autoStart = true
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'other-session', protocol: 1 }
    ctx.ui.select.mockResolvedValueOnce('取消')
    await handlers.session_start({}, ctx)
    expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining('PID 424242'), expect.anything())
    expect(ctx.ui.notify).toHaveBeenCalledWith('已取消，未改动其他会话的微信桥接。', 'info')
    expect(activeTools).toEqual(['read', 'bash'])
  })

  it('takes over from auto-start after confirmation and starts locally', async () => {
    state.config.autoStart = true
    state.lockConflict = true
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'other-session', protocol: 1 }
    state.requestHandoff.mockImplementation(async () => {
      state.lockConflict = false
      state.lockState = { kind: 'missing' }
    })
    ctx.ui.select.mockResolvedValueOnce('请求旧会话停止，等待释放后在本会话启动')
    await handlers.session_start({}, ctx)
    expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining('PID 424242'), expect.anything())
    expect(state.requestHandoff).toHaveBeenCalledTimes(1)
    expect(activeTools).toEqual(['read', 'bash', 'send_file_to_wechat', 'send_image_to_wechat'])
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(/旧会话已释放桥接.*微信桥接已启动/), 'info')
  })

  it('reports headless auto-start lock conflicts without prompting', async () => {
    state.config.autoStart = true
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'other-session', protocol: 1 }
    ctx.hasUI = false
    const printed: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { printed.push(args.join(' ')) })
    const err = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { printed.push(args.join(' ')) })
    try {
      await handlers.session_start({}, ctx)
    } finally {
      log.mockRestore()
      err.mockRestore()
    }
    expect(ctx.ui.select).not.toHaveBeenCalled()
    expect(printed.join('')).toContain('424242')
    expect(state.requestHandoff).not.toHaveBeenCalled()
    expect(activeTools).toEqual(['read', 'bash'])
  })

  it('keeps source changes behind the idle boundary from the settings window', async () => {
    let idle!: () => void
    ctx.isIdle.mockReturnValue(false)
    ctx.waitForIdle.mockImplementation(() => new Promise<void>(resolve => { idle = resolve }))
    ctx.ui.select.mockResolvedValueOnce('微信消息标识与排版：开启 · 消息加来源标记，回复按微信风格').mockResolvedValueOnce('关闭').mockResolvedValueOnce(undefined)
    const pending = command('config')
    await vi.waitFor(() => expect(ctx.waitForIdle).toHaveBeenCalled())
    expect(state.config.messageSourceTag).toBeUndefined()
    idle()
    await pending
    expect(state.config.messageSourceTag?.enabled).toBe(false)
  })

  it('opens template viewing from settings without starting the bridge', async () => {
    ctx.ui.select.mockResolvedValueOnce('回复模板：查看 / 导出 / 重载 · 约束 AI 回复微信的格式')
      .mockResolvedValueOnce('查看当前模板及路径').mockResolvedValueOnce(undefined)
    await command('config')
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('用户模板路径'), 'info')
    expect(registeredTools.size).toBe(0)
  })

  it('falls back to text without UI instead of requesting a dialog', async () => {
    ctx.hasUI = false
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await command('config')
    expect(ctx.ui.select).not.toHaveBeenCalled()
    expect(output).toHaveBeenCalledWith(expect.stringContaining('双向同步'))
  })
  async function startRun(text: string, source = 'interactive') {
    await handlers.input({ source, text }, ctx)
    await handlers.before_agent_start({ systemPrompt: 'base system prompt', prompt: text }, ctx)
    await handlers.agent_start({}, ctx)
    ctx.isIdle.mockReturnValue(false)
    await handlers.message_start({ message: { role: 'user', content: text } }, ctx)
  }
  async function wechatInput(text: string, newRun = false) {
    const calls = sendUserMessage.mock.calls.length
    state.queue.enqueue({
      messageId: String(calls), userId: 'bound-user', text, type: 'text', imageUrls: [],
      raw: { from_user_id: 'bound-user' }, contextToken: '', timestamp: new Date(),
    })
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledTimes(calls + 1))
    const content = sendUserMessage.mock.calls[calls][0]
    const sentText = extractTextFromMessageContent(content)!
    await handlers.input({ source: 'extension', text: sentText }, ctx)
    if (newRun) {
      await handlers.before_agent_start({ systemPrompt: 'base system prompt', prompt: sentText }, ctx)
      await handlers.agent_start({}, ctx)
      ctx.isIdle.mockReturnValue(false)
    }
    await handlers.message_start({ message: { role: 'user', content } }, ctx)
    return content
  }
  const reply = (text: string) => handlers.message_end({ message: { role: 'assistant', content: text } }, ctx)

  const outgoing = () => state.client.sendText.mock.calls.filter(([, text]) => !text.startsWith('✅ 已收到'))
  const failure = (errorMessage = 'quota exceeded', content: unknown = []) => handlers.message_end({
    message: { role: 'assistant', stopReason: 'error', errorMessage, content },
  }, ctx)
  const settle = async (outcome = 'error', aborted = false) => {
    await handlers.agent_before_settle({ outcome }, ctx)
    await handlers.agent_settled({ aborted }, ctx)
  }
  const modern = () => { ctx.isProjectTrusted = () => ({}) }

  it('honors a saved sendAck false while still delivering AI replies, then enables custom receipts live', async () => {
    state.config.sendAck = false
    await command('start')
    state.client.sendText.mockClear()
    await wechatInput('first', true)
    expect(state.client.sendText).not.toHaveBeenCalled()
    await reply('AI reply')
    expect(state.client.sendText).toHaveBeenCalledWith('bound-user', 'AI reply')
    await handlers.agent_end({ messages: [] }, ctx)
    await command('config ack-text Custom receipt')
    await command('config ack on')
    state.client.sendText.mockClear()
    await wechatInput('second', true)
    expect(state.client.sendText).toHaveBeenCalledWith('bound-user', 'Custom receipt')
  })

  it('notifies modern hosts only at final settlement, even after progress, and never replays history', async () => {
    modern()
    await command('start')
    await wechatInput('work', true)
    await reply('working')
    state.client.sendText.mockClear()
    await failure('quota exceeded', 'partial response that a retry might repeat')
    await handlers.agent_end({ messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'old error' }] }, ctx)
    expect(outgoing()).toEqual([])
    await settle()
    expect(outgoing()).toEqual([['bound-user', expect.stringContaining('quota exceeded')]])
    expect(outgoing()[0][1]).toContain('自动处理已结束')
    await settle()
    expect(outgoing()).toHaveLength(1)
  })

  it('keeps WeChat routing and question guards across retries, and suppresses recovered errors', async () => {
    modern()
    state.config.bidirectionalSync = false
    await command('start')
    await wechatInput('work', true)
    await failure()
    await handlers.agent_end({ messages: [] }, ctx)
    await handlers.agent_start({}, ctx)
    expect((await handlers.tool_call({ toolName: 'question' }, ctx))?.block).toBe(true)
    await reply('recovered')
    await settle('completed')
    expect(outgoing()).toEqual([['bound-user', 'recovered']])
  })

  it('reports only the last failed attempt after modern retry exhaustion', async () => {
    modern()
    await command('start')
    await wechatInput('work', true)
    await failure('temporary failure')
    await handlers.agent_end({ messages: [] }, ctx)
    await handlers.agent_start({}, ctx)
    await failure('final failure')
    await settle()
    expect(outgoing()).toEqual([['bound-user', expect.stringContaining('final failure')]])
  })

  it.each(['aborted-message', 'aborted-settlement', 'retry-cancel-before-boundary', 'aborted-signal'])('does not report user cancellation: %s', async mode => {
    modern()
    await command('start')
    await wechatInput('work', true)
    if (mode === 'retry-cancel-before-boundary') {
      await failure()
      await handlers.agent_settled({}, ctx) // 0.99.2 has no aborted field
      expect(outgoing()).toEqual([])
      // A fresh request restores a real reply target after settlement.
      await wechatInput('second request', true)
      await failure()
      await handlers.agent_settled({}, ctx)
      expect(outgoing()).toEqual([])
      await wechatInput('third request', true)
      await failure()
      await settle()
      expect(outgoing()).toEqual([['bound-user', expect.stringContaining('自动处理已结束')]])
      return
    }
    const abort = new AbortController()
    ctx.signal = abort.signal
    await failure()
    if (mode === 'aborted-message') await handlers.message_end({ message: { role: 'assistant', stopReason: 'aborted', content: [] } }, ctx)
    if (mode === 'aborted-signal') abort.abort()
    await settle(mode === 'aborted-message' ? 'aborted' : 'error', mode === 'aborted-settlement')
    expect(outgoing()).toEqual([])
  })

  describe('Pi 0.84 settlement-only host', () => {
    beforeEach(async () => {
      await handlers.session_shutdown({}, ctx)
      installExtension(false)
      modern()
      await handlers.session_start({}, ctx)
      await command('start')
    })
    it.each(['cancel-during-backoff', 'retry-exhausted'])('sends one conservative notice for %s, including subsequent requests', async outcome => {
      for (let request = 0; request < 2; request++) {
        state.client.sendText.mockClear()
        await wechatInput(`work ${request}`, true)
        await failure('temporary error')
        await handlers.agent_end({ messages: [] }, ctx)
        if (outcome === 'retry-exhausted') {
          await handlers.agent_start({}, ctx)
          await failure('last attempt error')
          await handlers.agent_end({ messages: [] }, ctx)
        }
        expect(outgoing()).toEqual([])
        // Both outcomes have the same public event on 0.84: no aborted field.
        await handlers.agent_settled({}, ctx)
        const detail = outcome === 'retry-exhausted' ? 'last attempt error' : 'temporary error'
        expect(outgoing()).toEqual([['bound-user', `⚠️ 此前一次模型请求失败：${detail}`]])
        await handlers.agent_settled({}, ctx)
        expect(outgoing()).toHaveLength(1)
      }
    })
    it('suppresses a recovered retry', async () => {
      await wechatInput('work', true)
      await failure()
      await handlers.agent_end({ messages: [] }, ctx)
      await handlers.agent_start({}, ctx)
      await reply('recovered')
      await handlers.agent_settled({}, ctx)
      expect(outgoing()).toEqual([['bound-user', 'recovered']])
    })
    it.each(['message', 'signal'])('suppresses explicit cancellation via %s', async mode => {
      await wechatInput('work', true)
      const abort = new AbortController()
      ctx.signal = abort.signal
      await failure()
      if (mode === 'signal') abort.abort()
      else await handlers.message_end({ message: { role: 'assistant', stopReason: 'aborted', content: [] } }, ctx)
      await handlers.agent_settled({}, ctx)
      expect(outgoing()).toEqual([])
    })
  })

  it('does not infer model failure from keywords, tool errors, history, or silence', async () => {
    modern()
    await command('start')
    await wechatInput('work', true)
    await reply('error failed aborted: these are example words')
    state.client.sendText.mockClear()
    await handlers.message_end({ message: { role: 'toolResult', isError: true, content: 'failed' } }, ctx)
    await handlers.agent_end({ messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'historic failure' }] }, ctx)
    await settle('completed')
    expect(outgoing()).toEqual([])
  })

  it('sends one factual legacy attempt notice despite retries and repeated events', async () => {
    await command('start')
    await wechatInput('work', true)
    await failure()
    await handlers.agent_end({ messages: [] }, ctx)
    await handlers.agent_start({}, ctx)
    await failure()
    expect(outgoing()).toEqual([['bound-user', expect.stringContaining('Pi 可能自动重试')]])
    await reply('recovered')
    await wechatInput('second request')
    await failure()
    expect(outgoing()).toHaveLength(3)
  })

  it('does not retry an error notification after an ambiguous send rejection', async () => {
    await command('start')
    await wechatInput('work', true)
    state.client.sendText.mockRejectedValueOnce(new Error('connection lost'))
    await failure()
    await failure()
    expect(outgoing()).toHaveLength(1)
  })

  it.each([false, true])('respects TUI bidirectional sync=%s for failures and clears the old WeChat source', async enabled => {
    modern()
    state.config.bidirectionalSync = enabled
    await command('start')
    await wechatInput('wechat', true)
    await failure('wechat error')
    await startRun('new TUI request')
    state.client.sendText.mockClear()
    await failure('TUI error')
    await settle()
    expect(outgoing()).toHaveLength(enabled ? 1 : 0)
    if (enabled) expect(outgoing()[0][1]).toContain('TUI error')
  })

  it('drops pending notices when stopped', async () => {
    modern()
    await command('start')
    await wechatInput('work', true)
    await failure()
    await command('stop')
    await settle()
    expect(outgoing()).toEqual([])
  })

  it('reports actual WeChat failures with the source marker disabled', async () => {
    modern()
    state.config.messageSourceTag = { enabled: false }
    state.config.bidirectionalSync = false
    await command('start')
    await wechatInput('work', true)
    await failure()
    await settle()
    expect(outgoing()).toEqual([['bound-user', expect.stringContaining('quota exceeded')]])
  })

  it('does not clear a new request while the previous settlement notification is sending', async () => {
    modern()
    state.config.bidirectionalSync = false
    await command('start')
    await wechatInput('first', true)
    await failure()
    let resolve!: () => void
    state.client.sendText.mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
    await handlers.agent_before_settle({ outcome: 'error' }, ctx)
    const sending = handlers.agent_settled({}, ctx)
    await wechatInput('second')
    resolve()
    await sending
    await reply('second answer')
    expect(outgoing()).toHaveLength(2)
    expect(outgoing()[1]).toEqual(['bound-user', 'second answer'])
  })

  it('never rejects TUI or unrelated extension input during startup checks', async () => {
    await command('start')
    ctx.model = undefined
    for (const source of ['interactive', 'extension']) {
      expect(await handlers.input({ source, text: 'unrelated' }, ctx)).toBeUndefined()
    }
    expect(outgoing()).toEqual([])
  })

  it('does not reject busy follow-ups based on a transient model/auth snapshot', async () => {
    await command('start')
    ctx.isIdle.mockReturnValue(false)
    ctx.model = undefined
    await wechatInput('queued request')
    expect(outgoing()).toEqual([])
  })

  // Emulate Pi invoking input while sendUserMessage is delivering an idle request.
  async function deliverIdleInput() {
    let result: any
    sendUserMessage.mockImplementationOnce(async (content: unknown) => {
      result = await handlers.input({ source: 'extension', text: extractTextFromMessageContent(content) }, ctx)
    })
    state.queue.enqueue({ messageId: 'preflight', userId: 'bound-user', text: 'work', type: 'text', imageUrls: [],
      raw: { from_user_id: 'bound-user' }, contextToken: '', timestamp: new Date() })
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalled())
    return () => result
  }

  it.each(['no-model', 'legacy-auth', 'modern-auth'])('reports idle startup rejection without waiting for nonexistent lifecycle events: %s', async mode => {
    await command('start')
    if (mode === 'no-model') ctx.model = undefined
    else {
      ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false)
      if (mode === 'modern-auth') {
        modern()
        ctx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: false, error: 'auth unavailable' })
      }
    }
    const result = await deliverIdleInput()
    await vi.waitFor(() => expect(result()).toEqual({ action: 'handled' }))
    expect(outgoing()).toEqual([['bound-user', expect.stringContaining('无法开始模型请求')]])
    expect(state.queue.pendingInjection).toBeNull()
  })

  it('allows lazy modern authentication rather than treating the synchronous snapshot as failure', async () => {
    modern()
    await command('start')
    ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false)
    ctx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: 'test' })
    await deliverIdleInput()
    await vi.waitFor(() => expect(ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalled())
    expect(outgoing()).toEqual([])
    expect(state.queue.pendingInjection).not.toBeNull()
  })

  it('does not deliver stale asynchronous auth errors after stopping and restarting', async () => {
    modern()
    await command('start')
    ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false)
    let resolve!: (value: unknown) => void
    ctx.modelRegistry.getApiKeyAndHeaders.mockReturnValue(new Promise(done => { resolve = done }))
    const result = await deliverIdleInput()
    await command('stop')
    await command('start')
    resolve({ ok: false, error: 'stale auth failure' })
    await vi.waitFor(() => expect(result()).toEqual({ action: 'handled' }))
    expect(outgoing()).toEqual([])
  })

  it.each([
    { systemPrompt: 'base', prompt: 'TUI request' },
    { systemPrompt: 'base', messageType: 'user', prompt: 'TUI request', systemPromptOptions: { sections: { identity: 'base' } } },
    { systemPrompt: 'base', messageType: 'custom', message: { role: 'custom' }, systemPromptOptions: { sections: {} } },
  ])('leaves legacy and modern system prompts untouched before the bridge starts', async event => {
    const original = structuredClone(event)
    expect(await handlers.before_agent_start(event, ctx)).toBeUndefined()
    expect(event).toEqual(original)
    expect(registeredTools.size).toBe(0)
    expect(activeTools).toEqual(['read', 'bash'])
  })

  it('registers tools only on start, disables them on stop, and reuses them on restart', async () => {
    expect(registeredTools.size).toBe(0)
    await command('start')
    expect(activeTools).toEqual(['read', 'bash', 'send_file_to_wechat', 'send_image_to_wechat'])
    expect(registeredTools.size).toBe(2)
    await command('stop')
    expect(activeTools).toEqual(['read', 'bash'])
    expect(registeredTools.get('send_file_to_wechat').exposure).toBe('hidden')
    expect(registeredTools.get('send_image_to_wechat').exposure).toBe('hidden')
    expect(registeredTools.get('send_file_to_wechat').promptSnippet).toBeUndefined()
    expect(registeredTools.get('send_image_to_wechat').promptGuidelines).toEqual([])
    await command('start')
    expect(registeredTools.size).toBe(2)
    expect(activeTools).toHaveLength(4)
    expect(registeredTools.get('send_file_to_wechat').exposure).toBe('direct')
  })

  it('removes tools reactivated by a legacy tool selector before a stopped run', async () => {
    await command('start')
    await command('stop')
    activeTools.push('send_file_to_wechat', 'send_image_to_wechat')
    expect(await handlers.before_agent_start({ systemPrompt: 'base', prompt: 'local' }, ctx)).toBeUndefined()
    expect(activeTools).toEqual(['read', 'bash'])
    for (const toolName of ['send_file_to_wechat', 'send_image_to_wechat']) {
      expect(await handlers.tool_call({ toolName, parentToolCallId: 'codemode/1' }, ctx)).toMatchObject({ block: true })
    }
  })

  it('keeps stop notices transient and removes them on restart without changing history', async () => {
    const history = [{ role: 'user', content: 'work', timestamp: 1 }]
    const original = structuredClone(history)
    expect(await handlers.context({ messages: history }, ctx)).toBeUndefined()
    await command('start')
    expect(await handlers.context({ messages: history }, ctx)).toBeUndefined()
    await command('stop')
    const stopped = await handlers.context({ messages: history }, ctx)
    expect(stopped.messages).toHaveLength(2)
    expect(stopped.messages[1]).toMatchObject({ role: 'custom', content: expect.stringContaining('均不可用') })
    expect(history).toEqual(original)
    const repeated = await handlers.context({ messages: stopped.messages }, ctx)
    expect(repeated.messages).toHaveLength(2)
    await command('start')
    expect(await handlers.context({ messages: stopped.messages }, ctx)).toEqual({ messages: history })
    expect(await handlers.context({ messages: history }, ctx)).toBeUndefined()
    expect(stopped.messages).toHaveLength(2)
    await command('stop')
    expect((await handlers.context({ messages: history }, ctx)).messages).toHaveLength(2)
  })

  it('explains other-process ownership in status and retained tool calls', async () => {
    await command('start')
    const retainedTool = registeredTools.get('send_file_to_wechat')
    await command('stop')
    state.lockState = { kind: 'other', pid: 123456, sessionId: 'other' }
    await command('status')
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('PID 123456'), 'info')
    const result = await retainedTool.execute('old-call', { filePath: 'unused' })
    expect(result.content[0].text).toContain('本会话不能直接发送')
    expect(result.content[0].text).toContain('/wechat stop')
    expect(result.content[0].text).not.toContain('微信未登录')
  })

  it('reports uncertain lock ownership instead of suggesting forced login', async () => {
    state.lockState = { kind: 'unknown', pid: 123456, reason: '无权限检查持锁进程' }
    await command('status')
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('无法确认'), 'info')
    expect(await handlers.tool_call({ toolName: 'send_image_to_wechat' }, ctx)).toMatchObject({
      block: true, reason: expect.stringContaining('不会自动接管'),
    })
    expect(registeredTools.size).toBe(0)
  })

  it.each([
    { kind: 'other', pid: 123456, sessionId: 'other' },
    { kind: 'unknown', reason: '锁文件不可读' },
  ])('keeps tools unregistered when start cannot establish ownership: $kind', async owner => {
    state.lockState = owner
    if (owner.kind === 'other') ctx.ui.select.mockResolvedValueOnce('取消')
    await command('start')
    if (owner.kind === 'other') {
      expect(ctx.ui.select).not.toHaveBeenCalled()
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('/wechat stop'), 'error')
    } else {
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('无法确认'), 'error')
    }
    expect(registeredTools.size).toBe(0)
    expect(activeTools).toEqual(['read', 'bash'])
    expect(await handlers.before_agent_start({ systemPrompt: 'base', prompt: 'local' }, ctx)).toBeUndefined()
  })

  it('keeps the footer compact before and after acquiring context or sending successfully', async () => {
    state.config.bidirectionalSync = true
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `[微信 ⏸]`)
    await command('start')
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `[微信 ⇄ ▶]`)
    state.client.hasContextToken = true
    state.client.onStatusChange?.()
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `[微信 ⇄ ▶]`)
    state.client.lastSend = { success: true, at: '2026-10-13T10:00:00Z' }
    state.client.onStatusChange?.()
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `[微信 ⇄ ▶]`)
    await command('stop')
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `[微信 ⏸]`)
  })

  it('refreshes the compact sync mode indicator immediately when toggled', async () => {
    await command('start')
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `[微信 ▶]`)
    await command('config bidirectional on')
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `[微信 ⇄ ▶]`)
    await command('config bidirectional off')
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `[微信 ▶]`)
  })

  it('shows a queue count only while messages are pending', async () => {
    state.config.bidirectionalSync = true
    await command('start')
    const pending = vi.spyOn(state.queue, 'pending', 'get').mockReturnValue(3)
    state.client.onStatusChange?.()
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `[微信 ⇄ ▶ | 待处理:3]`)
    pending.mockReturnValue(0)
    state.client.onStatusChange?.()
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `[微信 ⇄ ▶]`)
  })

  it('surfaces send failure without error details and clears it on the next successful send', async () => {
    state.config.bidirectionalSync = true
    await command('start')
    state.client.lastSend = { success: false, at: '2026-10-13T10:00:00Z', error: 'network timeout' }
    state.client.onStatusChange?.()
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `[微信 ⇄ ▶ | 发送失败]`)
    await command('status')
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('失败: network timeout'), 'info')
    state.client.lastSend = { success: true, at: '2026-10-13T10:01:00Z' }
    state.client.onStatusChange?.()
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `[微信 ⇄ ▶]`)
    await command('status')
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('API 返回成功（不代表已读）'), 'info')
  })

  it('explains the fresh-activity remedy when sends are rejected with ret=-2', async () => {
    await command('start')
    expect(state.client.onNeedsFreshContext).toBeTypeOf('function')
    state.client.lastSend = { success: false, at: '2026-10-13T10:00:00Z', error: 'prepare failed', code: -2, needsFreshContext: true }
    await command('status')
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('请先从微信发送一条消息'), 'info')
    state.client.onNeedsFreshContext?.()
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('从微信发送一条消息激活会话'), 'warning')
  })

  it('combines pending count and send failure without extra mode text, hiding both while stopped', async () => {
    state.config.bidirectionalSync = false
    await command('start')
    vi.spyOn(state.queue, 'pending', 'get').mockReturnValue(2)
    state.client.lastSend = { success: false, at: '2026-10-13T10:00:00Z', error: 'rejected' }
    state.client.onStatusChange?.()
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `[微信 ▶ | 待处理:2 | 发送失败]`)
    await command('stop')
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `[微信 ⏸]`)
  })

  it('offers a takeover dialog on a live lock, respecting cancellation', async () => {
    state.lockConflict = true
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'other-session', protocol: 1 }
    ctx.ui.select.mockResolvedValueOnce('取消')
    await command('start')
    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.stringContaining('PID 424242'),
      [expect.stringContaining('请求旧会话停止'), '取消'],
    )
    expect(ctx.ui.notify).toHaveBeenCalledWith('已取消，未改动其他会话的微信桥接。', 'info')
    expect(state.requestHandoff).not.toHaveBeenCalled()
    expect(activeTools).toEqual(['read', 'bash'])
  })

  it('uses automatic handoff without a dialog when handoff is auto', async () => {
    state.config.handoff = 'auto'
    state.lockConflict = true
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'other-session', protocol: 1 }
    state.requestHandoff.mockImplementation(async () => {
      state.lockConflict = false
      state.lockState = { kind: 'missing' }
    })
    await command('start')
    expect(ctx.ui.select).not.toHaveBeenCalled()
    expect(state.requestHandoff).toHaveBeenCalledTimes(1)
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('自动请求旧会话'), 'info')
    expect(activeTools).toEqual(['read', 'bash', 'send_file_to_wechat', 'send_image_to_wechat'])
  })

  it('explains unsupported owners without logging session identifiers', async () => {
    state.config.handoff = 'auto'
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'PRIVATE_SESSION' }
    await command('start')
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('未声明协作交接支持'), 'error')
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('升级并重启持锁会话'), 'error')
    expect(state.requestHandoff).not.toHaveBeenCalled()
    const logs = state.debugLog.mock.calls.flat().join('\n')
    expect(logs).toContain('event=HANDOFF_UNSUPPORTED')
    expect(logs).toContain('ownerPid=424242 protocol=undeclared')
    expect(logs).not.toContain('PRIVATE_SESSION')
  })

  it('keeps handoff release and elapsed time in the final startup notification', async () => {
    state.config.handoff = 'auto'
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'old', protocol: 1 }
    state.requestHandoff.mockImplementation(async (_owner, _signal, progress) => {
      progress?.(0)
      progress?.(5_000)
      progress?.(10_000)
      state.lockState = { kind: 'missing' }
    })
    await command('start')
    const notifications = ctx.ui.notify.mock.calls.map(([text]: [string]) => text)
    expect(notifications.filter((text: string) => text.includes('仍在等待旧会话'))).toEqual([
      expect.stringContaining('已等待 5 秒'), expect.stringContaining('已等待 10 秒'),
    ])
    // Pi TUI displays only the latest notification: a separate startup notice
    // must not immediately erase the useful release confirmation.
    expect(notifications.at(-1)).toContain('旧会话已释放桥接（等待 ')
    expect(notifications.at(-1)).toContain('微信桥接已启动 📱')
    expect(state.debugLog.mock.calls.flat().join('\n')).toContain('event=waiting-release phase=handoff')
    expect(state.debugLog.mock.calls.flat().join('\n')).toContain('waitMs=10000')
  })

  it('reports lock contention after inspection separately from unsupported handoff', async () => {
    const { acquireLock } = await import('../../src/bridge/auth.js')
    vi.mocked(acquireLock).mockResolvedValueOnce({ success: false, code: 'LOCK_CONFLICT', state: { kind: 'other', pid: 424242, sessionId: 'PRIVATE_NEW_OWNER', protocol: 1 }, message: 'other owner' })
    await command('start')
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('获取锁时归属已变化或被其他会话占用'), 'error')
    expect(state.client.notifyStart).not.toHaveBeenCalled()
    expect(state.debugLog.mock.calls.flat().join('\n')).toContain('event=LOCK_CONFLICT phase=acquire-lock')
    expect(state.debugLog.mock.calls.flat().join('\n')).not.toContain('PRIVATE_NEW_OWNER')
  })

  it.each(['HANDOFF_TIMEOUT', 'HANDOFF_OWNER_CHANGED', 'HANDOFF_LOCK_UNKNOWN'] as const)('logs %s without serializing private error text', async code => {
    state.config.handoff = 'auto'
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'PRIVATE_SESSION', protocol: 1 }
    state.requestHandoff.mockRejectedValueOnce(new BridgeHandoffError(code, 'PRIVATE_ERROR https://private.test/path'))
    await command('start')
    const logs = state.debugLog.mock.calls.flat().join('\n')
    expect(logs).toContain(`event=${code} phase=handoff`)
    expect(logs).toContain(`code=${code}`)
    expect(logs).not.toMatch(/PRIVATE_|private\.test/)
    expect(state.client.notifyStart).not.toHaveBeenCalled()
  })

  it('cancels a pending handoff without leaving stale progress notifications', async () => {
    state.config.handoff = 'auto'
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'old', protocol: 1 }
    let progress!: (elapsedMs: number) => void
    state.requestHandoff.mockImplementation(async (_owner, signal, onProgress) => {
      progress = onProgress!
      await new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
    })
    const pending = command('start')
    await vi.waitFor(() => expect(progress).toBeTypeOf('function'))
    await command('stop')
    progress(5_000)
    await pending
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining('已等待 5 秒'), 'info')
    expect(ctx.ui.notify).toHaveBeenCalledWith('微信桥接启动已取消。', 'info')
    expect(state.debugLog.mock.calls.flat().join('\n')).toContain('event=CANCELLED phase=handoff')
    expect(state.client.notifyStart).not.toHaveBeenCalled()
  })

  it('records stop phases while retaining ownership until outgoing sends settle', async () => {
    await command('start')
    let finish!: () => void
    state.client.pauseSending.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const pending = command('stop')
    try {
      await vi.waitFor(() => expect(state.debugLog).toHaveBeenCalledWith(expect.stringContaining('phase=send-drain')))
      expect(state.lockState.kind).toBe('current')
      expect(state.client.notifyStop).not.toHaveBeenCalled()
    } finally { finish() }
    await pending
    const phases = state.debugLog.mock.calls.flat().filter((line: string) => line.startsWith('[bridge-stop]')).map((line: string) => line.match(/phase=([\w-]+)/)![1])
    expect(phases).toEqual(['poll-drain', 'send-drain', 'state-flush', 'notify-stop', 'typing-stop', 'lock-release', 'complete'])
    expect(state.lockState.kind).toBe('missing')
  })

  it('never auto-takes-over legacy owners or headless hosts even with handoff auto', async () => {
    state.config.handoff = 'auto'
    state.lockConflict = true
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'legacy-session' } // 无 protocol=1
    await command('start')
    expect(ctx.ui.select).not.toHaveBeenCalled()
    expect(state.requestHandoff).not.toHaveBeenCalled()
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('424242'), 'error')

    ctx.hasUI = false
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'other-session', protocol: 1 }
    const printed: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { printed.push(args.join(' ')) })
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { printed.push(args.join(' ')) })
    try {
      await command('start')
    } finally {
      log.mockRestore()
      errSpy.mockRestore()
    }
    expect(ctx.ui.select).not.toHaveBeenCalled()
    expect(state.requestHandoff).not.toHaveBeenCalled()
    expect(printed.join('')).toContain('424242')
    expect(printed.join('')).toContain('无界面或非交互模式')
    expect(state.debugLog.mock.calls.flat().join('\n')).toContain('event=HANDOFF_NON_INTERACTIVE')
  })

  it('auto-starts with automatic handoff when handoff is auto', async () => {
    state.config.autoStart = true
    state.config.handoff = 'auto'
    state.lockConflict = true
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'other-session', protocol: 1 }
    state.requestHandoff.mockImplementation(async () => {
      state.lockConflict = false
      state.lockState = { kind: 'missing' }
    })
    await handlers.session_start({}, ctx)
    expect(ctx.ui.select).not.toHaveBeenCalled()
    expect(state.requestHandoff).toHaveBeenCalledTimes(1)
    expect(activeTools).toEqual(['read', 'bash', 'send_file_to_wechat', 'send_image_to_wechat'])
  })

  it('suggests automatic handoff when enabling auto-start', async () => {
    ctx.ui.select.mockResolvedValueOnce('改为自动接管（推荐）')
    await command('config auto-start on')
    expect(state.config.autoStart).toBe(true)
    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.stringContaining('其他会话持有微信桥接'),
      ['改为自动接管（推荐）', '保持每次询问（当前）'],
    )
    expect(state.config.handoff).toBe('auto')
  })

  it('keeps the handoff mode on ask when the auto-start suggestion is declined', async () => {
    ctx.ui.select.mockResolvedValueOnce('保持每次询问（当前）')
    await command('config auto-start on')
    expect(state.config.autoStart).toBe(true)
    expect(state.config.handoff).toBeUndefined()
  })

  it('does not ask again when auto-start is already paired with automatic handoff', async () => {
    state.config.handoff = 'auto'
    await command('config auto-start on')
    expect(ctx.ui.select).not.toHaveBeenCalled()
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('新会话自动启动已开启'), 'info')
  })

  it('mentions the handoff command when enabling auto-start without a UI', async () => {
    ctx.hasUI = false
    const printed: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { printed.push(args.join(' ')) })
    try {
      await command('config auto-start on')
    } finally {
      log.mockRestore()
    }
    expect(printed.join('')).toContain('/wechat config handoff auto')
  })

  it('sets and validates the handoff mode explicitly', async () => {
    await command('config handoff auto')
    expect(state.config.handoff).toBe('auto')
    await command('config handoff maybe')
    expect(ctx.ui.notify).toHaveBeenLastCalledWith('用法: /wechat config handoff ask|auto', 'error')
    expect(state.config.handoff).toBe('auto')
  })

  it('toggles the handoff mode from the settings menu', async () => {
    ctx.ui.select
      .mockResolvedValueOnce('持锁接管方式：询问 · 其他会话持锁时先弹窗确认')
      .mockResolvedValueOnce('自动接管（不再询问）')
      .mockResolvedValueOnce(undefined)
    await command('config')
    expect(state.config.handoff).toBe('auto')
  })

  it('takes over the lock after explicit confirmation and starts locally', async () => {
    state.lockConflict = true
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'other-session', protocol: 1 }
    // 协作交接完成后，旧锁已释放；仍需重新获取锁。
    state.requestHandoff.mockImplementation(async () => {
      state.lockConflict = false
      state.lockState = { kind: 'missing' }
    })
    ctx.ui.select.mockResolvedValueOnce('请求旧会话停止，等待释放后在本会话启动')
    await command('start')
    expect(state.requestHandoff).toHaveBeenCalledTimes(1)
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('微信桥接已启动'), 'info')
    expect(activeTools).toEqual(['read', 'bash', 'send_file_to_wechat', 'send_image_to_wechat'])
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', '[微信 ▶]')
  })

  it('reports a plain error for a live lock without UI', async () => {
    state.lockConflict = true
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'other-session', protocol: 1 }
    ctx.hasUI = false
    const printed: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { printed.push(args.join(' ')) })
    const err = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { printed.push(args.join(' ')) })
    try {
      await command('start')
    } finally {
      log.mockRestore()
      err.mockRestore()
    }
    expect(ctx.ui.select).not.toHaveBeenCalled()
    expect(printed.join('')).toContain('424242')
    expect(state.requestHandoff).not.toHaveBeenCalled()
  })

  it('auto-stops and warns when another session takes over the lock', async () => {
    vi.useFakeTimers()
    try {
      await command('start')
      expect(activeTools).toHaveLength(4)
      state.lockState = { kind: 'other', pid: 424242, sessionId: 'new-owner' }
      await vi.advanceTimersByTimeAsync(5_100)
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('锁归属已变化'), 'warning')
      expect(activeTools).toEqual(['read', 'bash'])
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', '[微信 ⏸]')
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the bridge automatically after login with cached credentials', async () => {
    await command('login')
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('已加载本地微信凭证'), 'info')
    expect(activeTools).toEqual(['read', 'bash', 'send_file_to_wechat', 'send_image_to_wechat'])
    expect(ctx.ui.notify).toHaveBeenCalledWith('微信桥接已启动 📱', 'info')
  })

  it('does not disturb the owner when template preparation fails', async () => {
    const { WechatPrompt } = await import('../../src/messaging/wechat-prompt.js')
    vi.spyOn(WechatPrompt.prototype, 'load').mockRejectedValueOnce(new Error('invalid template'))
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'old', protocol: 1 }
    await command('start')
    expect(ctx.ui.select).not.toHaveBeenCalled()
    expect(state.requestHandoff).not.toHaveBeenCalled()
    expect(activeTools).toEqual(['read', 'bash'])
  })

  it('does not start after a handoff timeout or owner change', async () => {
    state.lockState = { kind: 'other', pid: 424242, sessionId: 'old', protocol: 1 }
    ctx.ui.select.mockImplementation(async (_title: string, choices: string[]) => choices[0])
    state.requestHandoff.mockRejectedValueOnce(new Error('等待旧会话释放超时'))
    await command('start')
    expect(state.client.notifyStart).not.toHaveBeenCalled()
    expect(activeTools).toEqual(['read', 'bash'])
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('超时'), 'error')
  })

  it('serializes starts and cancels startup while waiting for the agent', async () => {
    let ready!: () => void
    ctx.isIdle.mockReturnValue(false)
    ctx.waitForIdle.mockImplementation(() => new Promise<void>(resolve => { ready = resolve }))
    const pending = command('start')
    await vi.waitFor(() => expect(ctx.waitForIdle).toHaveBeenCalled())
    await command('start')
    expect(ctx.waitForIdle).toHaveBeenCalledTimes(1)
    await command('stop')
    ready()
    await pending
    expect(state.client.notifyStart).not.toHaveBeenCalled()
    expect(activeTools).toEqual(['read', 'bash'])
  })

  it('keeps ownership until a late poll completes, drops its messages, and uses a fresh instance on restart', async () => {
    const { releaseLock, acquireLock } = await import('../../src/bridge/auth.js')
    let finishPoll!: (messages: any[]) => void
    state.client.getUpdates.mockImplementationOnce(() => new Promise(resolve => { finishPoll = resolve }))
    await command('start')
    await vi.waitFor(() => expect(finishPoll).toBeTypeOf('function'))
    const oldId = vi.mocked(acquireLock).mock.calls.at(-1)![0]
    const stopped = command('stop')
    expect(releaseLock).not.toHaveBeenCalled()
    expect(activeTools).toEqual(['read', 'bash'])
    finishPoll([{ text: 'late', raw: { from_user_id: 'bound-user' }, imageUrls: [] }])
    await stopped
    expect(sendUserMessage).not.toHaveBeenCalled()
    expect(releaseLock).toHaveBeenCalledWith(oldId)
    expect(state.client.flushReceiveState.mock.invocationCallOrder.at(-1)!).toBeLessThan(vi.mocked(releaseLock).mock.invocationCallOrder.at(-1)!)
    await command('start')
    expect(vi.mocked(acquireLock).mock.calls.at(-1)![0]).not.toBe(oldId)
  })

  it('stops on a cooperative request without cancelling the local AI task', async () => {
    vi.useFakeTimers()
    ctx.abort = vi.fn()
    await command('start')
    state.handoffRequested = true
    await vi.advanceTimersByTimeAsync(1_100)
    expect(activeTools).toEqual(['read', 'bash'])
    expect(state.lockState.kind).toBe('missing')
    expect(ctx.abort).not.toHaveBeenCalled()
  })

  it('stops and releases after session expiry without waiting on itself', async () => {
    const { SessionExpiredError } = await import('../../src/wechat/client.js')
    state.client.getUpdates.mockRejectedValueOnce(new SessionExpiredError())
    await command('start')
    await vi.waitFor(() => expect(state.client.notifyStop).toHaveBeenCalled())
    await vi.waitFor(() => expect(state.lockState.kind).toBe('missing'))
    expect(activeTools).toEqual(['read', 'bash'])
  })

  it('does not double-start when the bridge already runs during login', async () => {
    await command('start')
    ctx.ui.notify.mockClear()
    await command('login')
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('已加载本地微信凭证'), 'info')
    expect(ctx.ui.notify).not.toHaveBeenCalledWith('微信桥接已启动 📱', 'info')
  })

  it('shows the default template while the bridge runs with source rules on by default', async () => {
    await command('start')
    expect(state.config.messageSourceTag?.enabled === false).toBe(false)
    await command('prompt show')
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('直接用正文提问'), 'info')
  })

  it('never prints notifications to stdout while a UI is attached', async () => {
    const printed: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args.join(' '))
    })
    try {
      await command('start')
      await command('config source off')
    } finally {
      log.mockRestore()
    }
    expect(printed.join('')).toBe('')
    expect(ctx.ui.notify).toHaveBeenCalled()
  })

  it('waits for the active run before starting the bridge tools', async () => {
    ctx.isIdle.mockReturnValue(false)
    ctx.waitForIdle.mockImplementation(async () => { ctx.isIdle.mockReturnValue(true) })
    await command('start')
    expect(ctx.waitForIdle).toHaveBeenCalledOnce()
    expect(registeredTools.size).toBe(2)
  })

  it('sends TUI input and new assistant replies when sync is enabled without first inbound activity', async () => {
    state.config.bidirectionalSync = true
    await command('start')
    await startRun('run tests')
    await reply('tests passed')
    expect(state.client.sendText.mock.calls).toEqual([
      ['bound-user', '[电脑端] run tests'], ['bound-user', 'tests passed'],
    ])
    expect(state.client.notifyStart).toHaveBeenCalledTimes(1)
  })

  it.each([
    { text: '比较这两张图', expected: '[电脑端] 比较这两张图\n[附带 2 张图片]' },
    { text: '', expected: '[电脑端] 发送了 2 张图片' },
    { text: '长'.repeat(1200), expected: '[电脑端] ' + '长'.repeat(1200) + '\n[附带 2 张图片]' },
  ])('mirrors consumed TUI images with text length $text.length', async ({ text, expected }) => {
    state.config.bidirectionalSync = true
    await command('start')
    await startRun('earlier task')
    state.client.sendText.mockClear()
    const images = [
      { type: 'image', mimeType: 'image/png', data: 'first-image' },
      { type: 'image', mimeType: 'image/jpeg', data: 'second-image' },
    ]
    const content = [{ type: 'text', text }, ...images]
    const original = structuredClone(content)
    await handlers.input({ source: 'interactive', text, images }, ctx)
    expect(state.client.sendText).not.toHaveBeenCalled()
    await handlers.message_start({ message: { role: 'user', content } }, ctx)
    expect(state.client.sendText.mock.calls.map(([, chunk]) => chunk).join('')).toBe(expected)
    expect(content).toEqual(original)
  })

  it.each(['disabled', 'stopped'])('does not mirror image-only messages when sync is %s', async mode => {
    await command('start')
    if (mode === 'disabled') await command('config bidirectional off')
    else await command('stop')
    const content = [{ type: 'image', mimeType: 'image/png', data: 'image' }]
    await handlers.message_start({ message: { role: 'user', content } }, ctx)
    expect(state.client.sendText).not.toHaveBeenCalled()
  })

  it('does not mirror images submitted by the WeChat bridge', async () => {
    await command('start')
    state.queue.queue.push({
      id: 'image', userId: 'bound-user', messageId: 'image', receivedAt: new Date(),
      text: '', preview: '[图片]', contextToken: '',
      imageData: { data: 'wechat-image', mediaType: 'image/png' },
    })
    await state.queue.drain()
    expect(sendUserMessage).toHaveBeenCalledOnce()
    const content = sendUserMessage.mock.calls[0][0]
    const text = extractTextFromMessageContent(content)!
    const images = content.filter((part: any) => part.type === 'image')
    expect(images).toHaveLength(1)
    await handlers.input({ source: 'extension', text, images }, ctx)
    state.client.sendText.mockClear()
    await handlers.message_start({ message: { role: 'user', content } }, ctx)
    expect(state.queue.activeRequest?.userId).toBe('bound-user')
    expect(state.client.sendText).not.toHaveBeenCalled()
  })

  it('can disable TUI sync without changing the message source selection', async () => {
    state.config.bidirectionalSync = false
    await command('start')
    await startRun('run tests')
    await reply('tests passed')
    expect(state.client.sendText).not.toHaveBeenCalled()
  })

  it('delivers a busy WeChat follow-up with TUI sync off, then switches back to TUI inside the same run', async () => {
    state.config.bidirectionalSync = false
    await command('start')
    await startRun('TUI task')
    await wechatInput('微信任务')
    await handlers.input({ source: 'interactive', text: 'queued TUI input' }, ctx)
    state.client.sendText.mockClear() // Exclude the inbound acknowledgement.
    await reply('wechat reply')
    expect(state.client.sendText.mock.calls).toEqual([['bound-user', 'wechat reply']])
    await handlers.message_start({ message: { role: 'user', content: 'queued TUI input' } }, ctx)
    await reply('TUI reply')
    expect(state.client.sendText).toHaveBeenCalledTimes(1)
  })

  it('appends the same fixed conditional system rules for WeChat and TUI turns while running', async () => {
    await command('start')
    await command('config source on')
    const tools = [...activeTools]
    const content = await wechatInput('微信任务', true)
    expect(content).toMatch(/^\[微信\]/)
    expect(content).not.toContain('直接用正文提问')
    const event = { systemPrompt: 'base system prompt', systemPromptOptions: { sections: { identity: 'base' } }, messageType: 'user', prompt: 'next TUI task' }
    const result = await handlers.before_agent_start(event, ctx)
    expect(result?.systemPrompt).toMatch(/^base system prompt\n\n<wechat-system-rules>/)
    expect(result?.systemPrompt).toContain('直接用正文提问')
    expect(result?.systemPrompt).toContain(JSON.stringify('[微信]'))
    expect(result?.systemPrompt).toContain('仅在当前最新用户请求由微信桥接投递')
    const wechatEvent = { systemPrompt: 'base system prompt', prompt: String(content) }
    expect((await handlers.before_agent_start(wechatEvent, ctx))?.systemPrompt).toBe(result?.systemPrompt)
    expect(activeTools).toEqual(tools)
    await command('config source off')
    const off = { systemPrompt: 'unchanged' }
    const original = structuredClone(off)
    expect(await handlers.before_agent_start(off, ctx)).toBeUndefined()
    expect(off).toEqual(original)
    await handlers.agent_start({}, ctx)
    expect(await wechatInput('普通输入')).toBe('普通输入')
    expect(activeTools).toEqual(tools)
  })

  it('does not mistake a TUI marker for an inbound request', async () => {
    state.config.bidirectionalSync = false
    state.config.messageSourceTag = { enabled: false }
    await command('start')
    await command('config source on')
    await startRun('[微信]\n\nTUI request')
    await reply('local reply')
    expect(state.client.sendText).not.toHaveBeenCalled()
  })

  it('blocks known local question tools by default for a confirmed WeChat request only', async () => {
    await command('start')
    await wechatInput('微信请求', true)
    for (const toolName of ['question', 'questionnaire']) {
      const result = await handlers.tool_call({ toolName, parentToolCallId: 'codemode/1' }, ctx)
      expect(result).toMatchObject({ block: true, reason: expect.stringContaining('回复正文中提问') })
    }
    expect(await handlers.tool_call({ toolName: 'read' }, ctx)).toBeUndefined()
    await handlers.input({ source: 'interactive', text: 'TUI request' }, ctx)
    await handlers.message_start({ message: { role: 'user', content: 'TUI request' } }, ctx)
    expect(await handlers.tool_call({ toolName: 'question' }, ctx)).toBeUndefined()
    await command('config source off')
    await wechatInput('关掉后的微信请求')
    expect(await handlers.tool_call({ toolName: 'question' }, ctx)).toBeUndefined()
  })

  it('allows the user to configure the exact question tools guarded for WeChat', async () => {
    state.config.messageSourceTag = { enabled: true, blockedTools: ['ask_user'] }
    await command('start')
    await wechatInput('微信请求', true)
    expect(await handlers.tool_call({ toolName: 'question' }, ctx)).toBeUndefined()
    expect(await handlers.tool_call({ toolName: 'ask_user' }, ctx)).toMatchObject({ block: true })
    state.config.messageSourceTag.blockedTools = []
    expect(await handlers.tool_call({ toolName: 'ask_user' }, ctx)).toMatchObject({ block: true })
    await wechatInput('下一条请求')
    expect(await handlers.tool_call({ toolName: 'ask_user' }, ctx)).toBeUndefined()
  })

  it('stop notifies the backend and blocks later assistant delivery', async () => {
    await command('start')
    await command('stop')
    await reply('later reply')
    expect(state.client.notifyStop).toHaveBeenCalledTimes(1)
    expect(state.client.sendText).not.toHaveBeenCalled()
  })

  it('warns and keeps polling when a lifecycle state notification fails', async () => {
    state.client.notifyStart.mockRejectedValueOnce(new Error('start boom'))
    await command('start')
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('start boom'), 'warning')
    await vi.waitFor(() => expect(state.client.getUpdates).toHaveBeenCalled())
    state.client.notifyStop.mockRejectedValueOnce(new Error('stop boom'))
    await command('stop')
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('stop boom'), 'warning')
    expect(ctx.ui.notify).toHaveBeenCalledWith('微信桥接已停止', 'info')
  })

  it('formats only the WeChat sending copy and preserves the assistant message', async () => {
    state.config.bidirectionalSync = true
    await command('start')
    await startRun('format reply')
    state.client.sendText.mockClear()
    const fence = String.fromCharCode(96).repeat(3)
    const message = { role: 'assistant', content: [{ type: 'text', text: '**结论** [文档](https://example.com/a_b)\n' + fence + 'js\n  const x = "**";\n' + fence }] }
    const original = structuredClone(message)
    expect(await handlers.message_end({ message }, ctx)).toBeUndefined()
    expect(message).toEqual(original)
    expect(state.client.sendText.mock.calls).toEqual([
      ['bound-user', '结论 文档: https://example.com/a_b'],
      ['bound-user', '代码 (js) (1/1)\n  const x = "**";\n'],
    ])
  })
})
