// ============================================================================
// 测试: 微信远程命令安全限制
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleRemoteCommand } from '../src/remote-commands.js'

const originalRemoteTools = process.env.PI_WECHAT_ALLOW_REMOTE_TOOLS

afterEach(() => {
  if (originalRemoteTools === undefined) delete process.env.PI_WECHAT_ALLOW_REMOTE_TOOLS
  else process.env.PI_WECHAT_ALLOW_REMOTE_TOOLS = originalRemoteTools
})

function makeDeps() {
  return {
    pi: {
      getActiveTools: vi.fn(() => ['read']),
      getAllTools: vi.fn(() => [{ name: 'read' }, { name: 'shell' }]),
      setActiveTools: vi.fn(),
    },
    getCtx: vi.fn(() => null),
    client: vi.fn(() => null),
    queueLength: vi.fn(() => 0),
  }
}

describe('WeChat /tools', () => {
  it('is disabled by default and never calls setActiveTools', async () => {
    delete process.env.PI_WECHAT_ALLOW_REMOTE_TOOLS
    const deps = makeDeps()
    const client = { sendText: vi.fn().mockResolvedValue(undefined) }

    await expect(handleRemoteCommand('/tools shell', 'bound-user', client as any, deps as any)).resolves.toBe(true)

    expect(deps.pi.setActiveTools).not.toHaveBeenCalled()
    expect(client.sendText).toHaveBeenCalledWith('bound-user', expect.stringContaining('/tools 默认禁用'))
  })

  it('/help documents that /tools is disabled by default', async () => {
    const deps = makeDeps()
    const client = { sendText: vi.fn().mockResolvedValue(undefined) }

    await handleRemoteCommand('/help', 'bound-user', client as any, deps as any)

    expect(client.sendText).toHaveBeenCalledWith('bound-user', expect.stringContaining('/tools 默认禁用'))
  })
})
