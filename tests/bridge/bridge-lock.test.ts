import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const files = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), chmod: vi.fn(), unlink: vi.fn(), open: vi.fn() }))
vi.mock('node:fs/promises', () => files)
import { inspectBridgeLock, describeBridgeLock, bridgeStartBlocker, bridgeLockMetadata, type BridgeLockState } from '../../src/bridge/bridge-lock.js'
import { acquireLock, saveContextTokensThrottled, flushContextTokens } from '../../src/bridge/auth.js'

describe('bridge lock diagnostics', () => {
  const owner = { pid: 123456, sessionId: 'other-session' }
  beforeEach(() => {
    vi.clearAllMocks()
    files.readFile.mockResolvedValue(JSON.stringify(owner))
    files.open.mockResolvedValue({ close: vi.fn() })
    files.writeFile.mockResolvedValue(undefined)
    files.mkdir.mockResolvedValue(undefined)
    files.chmod.mockResolvedValue(undefined)
    vi.spyOn(process, 'kill').mockReturnValue(true)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
  it('waits for a timer write before flushing handoff state', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    files.writeFile.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    saveContextTokensThrottled({ lastUserId: 'user', tokens: { user: 'old' } })
    await vi.advanceTimersByTimeAsync(5_000)
    const flushed = flushContextTokens({ lastUserId: 'user', tokens: { user: 'new' } })
    await Promise.resolve()
    expect(files.writeFile).toHaveBeenCalledTimes(1)
    finish()
    await flushed
    expect(files.writeFile).toHaveBeenCalledTimes(2)
    expect(files.writeFile.mock.calls[1][1]).toContain('new')
  })
  it('reports a live other owner without claiming that polling is healthy', async () => {
    const state = await inspectBridgeLock('mock-lock')
    expect(state).toEqual({ kind: 'other', ...owner })
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(owner.pid, 0)
    expect(describeBridgeLock(state)).toContain('/wechat stop')
    expect(describeBridgeLock(state)).not.toContain('tmux')
    expect((await acquireLock('new-session')).success).toBe(false)
    expect(files.writeFile).not.toHaveBeenCalled()
  })
  it('distinguishes undeclared handoff support from non-interactive startup', () => {
    const state = { kind: 'other' as const, ...owner }
    expect(bridgeStartBlocker(state, true)).toMatchObject({ code: 'HANDOFF_UNSUPPORTED', message: expect.stringContaining('未声明协作交接支持') })
    expect(describeBridgeLock(state)).toContain('升级并重启持锁会话')
    const supported = { ...state, protocol: 1 }
    expect(bridgeStartBlocker(supported, false)).toMatchObject({ code: 'HANDOFF_NON_INTERACTIVE', message: expect.stringContaining('无界面或非交互模式') })
    expect(describeBridgeLock(supported)).toContain('支持协作交接')
  })
  it.each<BridgeLockState>([{ kind: 'missing' }, { kind: 'stale', ...owner }, { kind: 'other', ...owner, protocol: 1 }])('allows startup inspection for $kind', state => {
    expect(bridgeStartBlocker(state, true)).toBeUndefined()
  })
  it('preserves unknown-lock diagnostics and excludes private fields from log metadata', () => {
    const state = { kind: 'unknown' as const, pid: owner.pid, reason: 'private file /secret/path' }
    expect(bridgeStartBlocker(state, true)?.code).toBe('LOCK_UNKNOWN')
    expect(bridgeLockMetadata(state)).toBe('owner=unknown ownerPid=123456 protocol=undeclared')
    expect(bridgeLockMetadata({ kind: 'other', ...owner, sessionId: 'private-session', protocol: 1 })).toBe('owner=other ownerPid=123456 protocol=1')
  })
  it.each(['EPERM', 'EACCES', 'UNKNOWN'])('does not steal a lock when the PID probe fails with %s', async code => {
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('probe'), { code }) })
    expect(await inspectBridgeLock('mock-lock')).toMatchObject({ kind: 'unknown', pid: owner.pid })
    expect((await acquireLock('new-session')).success).toBe(false)
    expect(files.writeFile).not.toHaveBeenCalled()
  })
  it('allows a lock whose owner is confirmed to have exited', async () => {
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('exited'), { code: 'ESRCH' }) })
    expect(await inspectBridgeLock('mock-lock')).toMatchObject({ kind: 'stale' })
    expect((await acquireLock('new-session')).success).toBe(true)
    expect(files.writeFile).toHaveBeenCalledTimes(1)
  })
  it('allows an absent lock', async () => {
    files.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    expect(await inspectBridgeLock('mock-lock')).toEqual({ kind: 'missing' })
    expect((await acquireLock('new-session')).success).toBe(true)
  })
  it.each(['invalid-json', '{}', '{"pid":-1,"sessionId":"x"}', '{"pid":0,"sessionId":"x"}', '{"pid":"123","sessionId":"x"}', '{"pid":1.5,"sessionId":"x"}'])('rejects malformed locks without probing PIDs: %s', async contents => {
    files.readFile.mockResolvedValue(contents)
    expect(await inspectBridgeLock('mock-lock')).toMatchObject({ kind: 'unknown' })
    expect((await acquireLock('new-session')).success).toBe(false)
    expect(process.kill).not.toHaveBeenCalled()
    expect(files.writeFile).not.toHaveBeenCalled()
  })
  it('does not treat unreadable state as missing', async () => {
    files.readFile.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    expect(await inspectBridgeLock('mock-lock')).toMatchObject({ kind: 'unknown' })
    expect(await acquireLock('new-session')).toMatchObject({ success: false, code: 'LOCK_UNKNOWN' })
  })
  it('renews only the matching current-process session', async () => {
    files.readFile.mockResolvedValue(JSON.stringify({ pid: process.pid, sessionId: 'mine' }))
    expect(await inspectBridgeLock('mock-lock')).toMatchObject({ kind: 'current' })
    expect(process.kill).not.toHaveBeenCalled()
    expect((await acquireLock('mine')).success).toBe(true)
    expect((await acquireLock('different')).success).toBe(false)
    expect(files.writeFile).not.toHaveBeenCalled()
  })
})
