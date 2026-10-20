import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { resolveImageBatchWaitMs, resolveImageMaxBytes, receiptText, parseImageSetting } from '../../src/bridge/config-values.js'
import { ACK_TEXT, IMAGE_BATCH_ACK_TEXT } from '../../src/shared/constants.js'

const home = vi.hoisted(() => ({ directory: '' }))
vi.mock('node:os', async () => ({
  ...await vi.importActual<typeof import('node:os')>('node:os'),
  homedir: () => home.directory,
}))

let stateDir: string
beforeEach(async () => {
  vi.resetModules()
  const root = path.resolve('node_modules/.cache')
  await fs.mkdir(root, { recursive: true })
  home.directory = await fs.mkdtemp(path.join(root, 'config-compat-'))
  stateDir = path.join(home.directory, '.pi', 'agent', 'wechat-assistant')
  await fs.mkdir(stateDir, { recursive: true })
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  const root = path.resolve('node_modules/.cache') + path.sep
  if (!path.resolve(home.directory).startsWith(root)) throw new Error('Unexpected test directory')
  await fs.rm(home.directory, { recursive: true, force: true })
})

describe('configuration persistence compatibility', () => {
  it('loads the existing path without rewriting and preserves unknown and nested settings across restart', async () => {
    const legacy = { sendAck: false, autoStart: false, bidirectionalSync: false, imageBatchWaitMs: 0,
      ackText: '原有回执', handoff: 'auto', extra: { future: 1 },
      messageSourceTag: { enabled: false, wechatTag: '[custom]', blockedTools: [], future: 'keep' } }
    const file = path.join(stateDir, 'config.json')
    const original = JSON.stringify(legacy)
    await fs.writeFile(file, original)
    const config = await import('../../src/bridge/config.js')
    expect(await config.loadConfig()).toEqual(legacy)
    expect(await fs.readFile(file, 'utf8')).toBe(original)
    await config.saveConfig({ ...await config.loadConfig(), imageMaxBytes: 1048576 })
    vi.resetModules()
    const restarted = await import('../../src/bridge/config.js')
    expect(await restarted.loadConfig()).toEqual({ ...legacy, imageMaxBytes: 1048576 })
    const auth = await import('../../src/bridge/auth.js')
    expect(auth.getConfigCache()).toBe(restarted.getConfigCache())
    expect(auth.saveConfig).toBe(restarted.saveConfig)
  })

  it('keeps process caching and updates it only after a successful write', async () => {
    const config = await import('../../src/bridge/config.js')
    const storage = await import('../../src/bridge/state-storage.js')
    await config.saveConfig({ sendAck: false })
    await fs.writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ sendAck: true }))
    expect(await config.loadConfig()).toEqual({ sendAck: false })
    vi.spyOn(storage, 'writeJsonFile').mockRejectedValueOnce(new Error('disk full'))
    await expect(config.saveConfig({ sendAck: true })).rejects.toThrow('disk full')
    expect(config.getConfigCache()).toEqual({ sendAck: false })
  })

  it.each([undefined, '{broken'])('keeps missing/invalid JSON fallback without creating or repairing files: %s', async content => {
    const file = path.join(stateDir, 'config.json')
    if (content !== undefined) await fs.writeFile(file, content)
    const config = await import('../../src/bridge/config.js')
    expect(await config.loadConfig()).toEqual({})
    if (content === undefined) await expect(fs.stat(file)).rejects.toThrow()
    else expect(await fs.readFile(file, 'utf8')).toBe(content)
  })
})

describe('configuration values', () => {
  it('preserves JSON precedence, environment fallback, explicit zero and clamping', () => {
    vi.stubEnv('PI_WECHAT_IMAGE_BATCH_WAIT_MS', '3000')
    vi.stubEnv('PI_WECHAT_IMAGE_MAX_BYTES', '2097152')
    expect(resolveImageBatchWaitMs({})).toBe(3000)
    expect(resolveImageBatchWaitMs({ imageBatchWaitMs: 0 })).toBe(0)
    expect(resolveImageBatchWaitMs({ imageBatchWaitMs: 90000 })).toBe(60000)
    expect(resolveImageMaxBytes({})).toBe(2097152)
    expect(resolveImageMaxBytes({ imageMaxBytes: 100 })).toBe(1048576)
    vi.stubEnv('PI_WECHAT_IMAGE_BATCH_WAIT_MS', '0')
    vi.stubEnv('PI_WECHAT_IMAGE_MAX_BYTES', 'invalid')
    expect(resolveImageBatchWaitMs({})).toBe(8000)
    expect(resolveImageMaxBytes({})).toBe(50 * 1024 * 1024)
  })

  it('retains default receipts and text trimming', () => {
    expect(receiptText({})).toBe(ACK_TEXT)
    expect(receiptText({ imageBatchAckText: '  ' }, true)).toBe(IMAGE_BATCH_ACK_TEXT)
    expect(receiptText({ ackText: '  hello\nworld  ' })).toBe('hello\nworld')
  })

  it('retains command validation and rounding', () => {
    expect(parseImageSetting('image-wait', '0')).toBe(0)
    expect(parseImageSetting('image-wait', '1.5')).toBe(2)
    expect(parseImageSetting('image-wait', '60001')).toBeUndefined()
    expect(parseImageSetting('image-max', '1.5')).toBe(1572864)
    for (const value of ['', undefined, 'Infinity', 'NaN', '-1', '0.5']) expect(parseImageSetting('image-max', value)).toBeUndefined()
  })
})

describe('transport state isolation', () => {
  it('preserves cursor, seen IDs and final token flush independently of config', async () => {
    const config = await import('../../src/bridge/config.js')
    const transport = await import('../../src/bridge/transport-state.js')
    await config.saveConfig({ sendAck: false })
    await transport.saveCursor('cursor')
    await transport.saveSeenIds(new Set(['one', 'two']))
    expect(await transport.loadCursor()).toBe('cursor')
    expect(await transport.loadSeenIds()).toEqual(new Set(['one', 'two']))
    vi.useFakeTimers()
    transport.saveContextTokensThrottled({ lastUserId: 'old', tokens: { old: 'old-token' } })
    const latest = { lastUserId: 'new', tokens: { new: 'new-token' } }
    await transport.flushContextTokens(latest)
    await vi.advanceTimersByTimeAsync(6000)
    expect(await transport.loadContextTokens()).toEqual(latest)
    await transport.clearTransportState()
    await transport.clearContextTokens()
    expect(await transport.loadCursor()).toBe('')
    expect(await transport.loadSeenIds()).toEqual(new Set())
    expect(await transport.loadContextTokens()).toEqual({ lastUserId: null, tokens: {} })
    expect(JSON.parse(await fs.readFile(path.join(stateDir, 'config.json'), 'utf8'))).toEqual({ sendAck: false })
  })
})
