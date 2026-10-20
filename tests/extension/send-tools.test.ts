import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as path from 'node:path'
import { registerWechatTools } from '../../src/extension/send-tools.js'

const files = vi.hoisted(() => ({ exists: true, size: 1024 }))
vi.mock('node:fs', () => ({ existsSync: () => files.exists, statSync: () => ({ size: files.size }) }))
vi.mock('../../src/bridge/auth.js', () => ({ getBridgeLockState: async () => ({ kind: 'missing' }) }))

beforeEach(() => { files.exists = true; files.size = 1024 })
describe('extracted sending tools', () => {
  function setup() {
    const tools = new Map<string, any>()
    let running = true
    let client = { userId: 'user', sendFile: vi.fn().mockResolvedValue(undefined), sendImage: vi.fn().mockResolvedValue(undefined) }
    const initial = client
    registerWechatTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, true, {
      getClient: () => client as any, isRunning: () => running, latestCtx: () => ({ cwd: process.cwd() }) as any,
    })
    return { tools, initial, stop: () => { running = false }, replace: (next: typeof client) => { client = next } }
  }

  it.each([['send_file_to_wechat', 'filePath', 'sendFile'], ['send_image_to_wechat', 'imagePath', 'sendImage']] as const)('uses current client for retained %s and rechecks stop after the guard', async (name, field, method) => {
    const state = setup()
    const next = { userId: 'new-user', sendFile: vi.fn().mockResolvedValue(undefined), sendImage: vi.fn().mockResolvedValue(undefined) }
    state.replace(next)
    const tool = state.tools.get(name)
    await tool.execute('one', { [field]: 'output.txt' })
    expect(next[method]).toHaveBeenCalledWith('new-user', path.join(process.cwd(), 'output.txt'), ...(method === 'sendFile' ? [undefined] : []))
    expect(state.initial[method]).not.toHaveBeenCalled()
    next[method].mockClear()
    const pending = tool.execute('two', { [field]: 'output.txt' })
    state.stop()
    expect(JSON.stringify(await pending)).toContain('未启动')
    expect(next[method]).not.toHaveBeenCalled()
  })

  it('preserves path, existence and size guards', async () => {
    const { tools, initial } = setup()
    const tool = tools.get('send_file_to_wechat')
    expect(JSON.stringify(await tool.execute('path', { filePath: '../outside.txt' }))).toContain('安全限制')
    files.exists = false
    expect(JSON.stringify(await tool.execute('missing', { filePath: 'missing.txt' }))).toContain('文件不存在')
    files.exists = true
    files.size = 50 * 1024 * 1024 + 1
    expect(JSON.stringify(await tool.execute('large', { filePath: 'large.txt' }))).toContain('文件过大')
    expect(initial.sendFile).not.toHaveBeenCalled()
  })
})
