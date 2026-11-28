// ============================================================================
// 测试: remote-commands.ts — /tools 默认禁用与开启后放行
// ============================================================================

import { describe, it, expect, vi } from 'vitest'
import { handleRemoteCommand } from '../../src/extension/remote-commands.js'
import { BridgeRuntime } from '../../src/extension/runtime.js'

const state = vi.hoisted(() => ({ allowRemoteTools: false }))
vi.mock('../../src/bridge/config.js', () => ({
  loadConfig: vi.fn(async () => ({ allowRemoteTools: state.allowRemoteTools })),
  getConfigCache: vi.fn(() => ({ allowRemoteTools: state.allowRemoteTools })),
}))

// --- 工厂: 构造可测试的 BridgeRuntime ---

function makeRuntime(opts?: { remoteToolsEnabled?: boolean }) {
  state.allowRemoteTools = opts?.remoteToolsEnabled ?? false
  const sendText = vi.fn()
  const client = { sendText } as any
  const rt = new BridgeRuntime({
    getActiveTools: vi.fn(() => ['read']),
    getAllTools: vi.fn(() => [{ name: 'read' }, { name: 'bash' }]),
    setActiveTools: vi.fn(),
    getThinkingLevel: vi.fn(() => 'off'),
    setThinkingLevel: vi.fn(),
    setModel: vi.fn(async () => true),
    getSessionName: vi.fn(() => undefined),
    setSessionName: vi.fn(),
    sendUserMessage: vi.fn(),
  } as any)
  return { rt, client, sendText }
}

describe('微信端 /new', () => {
  it('consumes the command even before context is ready', async () => {
    const { rt, client, sendText } = makeRuntime()
    expect(await handleRemoteCommand('/new', 'user_1', client, rt)).toBe(true)
    expect(sendText).toHaveBeenCalledWith('user_1', expect.stringContaining('上下文尚未就绪'))
  })

  it('dispatches without an early success reply', async () => {
    const { rt, client, sendText } = makeRuntime()
    const ctx = {} as any
    rt.latestCtx = ctx
    rt.newSession = { changing: false, request: vi.fn(() => null) }
    expect(await handleRemoteCommand('/new', 'user_1', client, rt)).toBe(true)
    expect(rt.newSession.request).toHaveBeenCalledWith('', 'user_1', ctx)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('lists /new in help', async () => {
    const { rt, client, sendText } = makeRuntime()
    await handleRemoteCommand('/help', 'user_1', client, rt)
    expect(sendText).toHaveBeenCalledWith('user_1', expect.stringContaining('/new'))
  })
})

describe('微信端 /tools 开关', () => {
  it('默认禁用：返回提示且不触碰工具权限', async () => {
    const { rt, client, sendText } = makeRuntime({ remoteToolsEnabled: false })

    const handled = await handleRemoteCommand('/tools', 'user_1', client, rt)

    expect(handled).toBe(true)
    expect(sendText).toHaveBeenCalledTimes(1)
    const reply = sendText.mock.calls[0][1] as string
    expect(reply).toContain('默认禁用')
    expect(reply).toContain('/wechat remotetools on')
    expect((rt.pi as any).setActiveTools).not.toHaveBeenCalled()
  })

  it('禁用状态下带参数也一样拦截', async () => {
    const { rt, client, sendText } = makeRuntime({ remoteToolsEnabled: false })

    await handleRemoteCommand('/tools bash,read', 'user_1', client, rt)

    expect((rt.pi as any).setActiveTools).not.toHaveBeenCalled()
    expect(sendText.mock.calls[0][1]).toContain('默认禁用')
  })

  it('开启后放行：可查看与设置活跃工具', async () => {
    const { rt, client, sendText } = makeRuntime({ remoteToolsEnabled: true })

    await handleRemoteCommand('/tools', 'user_1', client, rt)
    expect(sendText.mock.calls[0][1]).toContain('活跃工具')

    await handleRemoteCommand('/tools bash,read', 'user_1', client, rt)
    expect((rt.pi as any).setActiveTools).toHaveBeenCalledWith(['bash', 'read'])
    expect(sendText.mock.calls[1][1]).toContain('✅')
  })
})
