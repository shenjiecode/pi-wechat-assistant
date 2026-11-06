// ============================================================================
// 测试: remote-commands.ts — /tools 默认禁用与开启后放行
// ============================================================================

import { describe, it, expect, vi } from 'vitest'
import { handleRemoteCommand, type RemoteCommandDeps } from '../../src/extension/remote-commands.js'

// --- 工厂: 构造可测试的远程命令依赖 ---

function makeDeps(opts?: { remoteToolsEnabled?: boolean }) {
  const enabled = opts?.remoteToolsEnabled ?? false
  const sendText = vi.fn()
  const client = { sendText } as any
  const deps: RemoteCommandDeps = {
    pi: {
      getActiveTools: vi.fn(() => ['read']),
      getAllTools: vi.fn(() => [{ name: 'read' }, { name: 'bash' }]),
      setActiveTools: vi.fn(),
    } as any,
    getCtx: () => null,
    client: () => null,
    queueLength: () => 0,
    isRemoteToolsEnabled: async () => enabled,
  }
  return { deps, client, sendText }
}

describe('微信端 /new', () => {
  it('consumes the command even before context is ready', async () => {
    const { deps, client, sendText } = makeDeps()
    expect(await handleRemoteCommand('/new', 'user_1', client, deps)).toBe(true)
    expect(sendText).toHaveBeenCalledWith('user_1', expect.stringContaining('上下文尚未就绪'))
  })

  it('dispatches without an early success reply', async () => {
    const { deps, client, sendText } = makeDeps()
    const ctx = {} as any
    deps.getCtx = () => ctx
    deps.newSession = vi.fn(() => null)
    expect(await handleRemoteCommand('/new', 'user_1', client, deps)).toBe(true)
    expect(deps.newSession).toHaveBeenCalledWith('', 'user_1', ctx)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('lists /new in help', async () => {
    const { deps, client, sendText } = makeDeps()
    await handleRemoteCommand('/help', 'user_1', client, deps)
    expect(sendText).toHaveBeenCalledWith('user_1', expect.stringContaining('/new'))
  })
})

describe('微信端 /tools 开关', () => {
  it('默认禁用：返回提示且不触碰工具权限', async () => {
    const { deps, client, sendText } = makeDeps({ remoteToolsEnabled: false })

    const handled = await handleRemoteCommand('/tools', 'user_1', client, deps)

    expect(handled).toBe(true)
    expect(sendText).toHaveBeenCalledTimes(1)
    const reply = sendText.mock.calls[0][1] as string
    expect(reply).toContain('默认禁用')
    expect(reply).toContain('/wechat remotetools on')
    expect((deps.pi as any).setActiveTools).not.toHaveBeenCalled()
  })

  it('禁用状态下带参数也一样拦截', async () => {
    const { deps, client, sendText } = makeDeps({ remoteToolsEnabled: false })

    await handleRemoteCommand('/tools bash,read', 'user_1', client, deps)

    expect((deps.pi as any).setActiveTools).not.toHaveBeenCalled()
    expect(sendText.mock.calls[0][1]).toContain('默认禁用')
  })

  it('开启后放行：可查看与设置活跃工具', async () => {
    const { deps, client, sendText } = makeDeps({ remoteToolsEnabled: true })

    await handleRemoteCommand('/tools', 'user_1', client, deps)
    expect(sendText.mock.calls[0][1]).toContain('活跃工具')

    await handleRemoteCommand('/tools bash,read', 'user_1', client, deps)
    expect((deps.pi as any).setActiveTools).toHaveBeenCalledWith(['bash', 'read'])
    expect(sendText.mock.calls[1][1]).toContain('✅')
  })
})
