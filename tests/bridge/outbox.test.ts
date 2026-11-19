import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ApiError } from '../../src/wechat/api.js'
import { MAX_OUTBOX_BYTES, MAX_PENDING_REPLIES, MAX_REPLAY_CHUNKS, OutboxStorageError, ReplyOutbox } from '../../src/bridge/outbox.js'

const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('../../src/bridge/state-storage.js', () => ({ getStateDir: () => state.directory }))
// A writable module namespace for fault injection, with actual filesystem I/O.
vi.mock('node:fs/promises', async () => ({ ...await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises') }))

const identity = { accountId: 'test-bot', userId: 'test-user' }
const origin = { cwd: '/test/project', sessionId: 'original-session' }
const rejected = () => new ApiError('prepare failed', { status: 200, code: -2 })
const stored = async (box: ReplyOutbox) => JSON.parse(await fs.readFile(box.filePath, 'utf8'))
const texts = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(call => call[0])
const contentOnly = (send: ReturnType<typeof vi.fn>) => texts(send).filter(text => !text.startsWith('【补发】'))

beforeEach(async () => {
  const root = path.resolve('node_modules/.cache')
  await fs.mkdir(root, { recursive: true })
  state.directory = await fs.mkdtemp(path.join(root, 'outbox-test-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(state.directory, { recursive: true, force: true })
})

async function queued(chunks = ['result']) {
  const box = await ReplyOutbox.open(identity)
  const send = vi.fn().mockRejectedValueOnce(rejected())
  await expect(box.deliver(chunks, origin, { send, active: () => true })).resolves.toBe('queued')
  return box
}

describe('durable text reply outbox', () => {
  it('does not persist normally delivered messages or replay Pi history', async () => {
    const box = await ReplyOutbox.open(identity)
    const send = vi.fn().mockResolvedValue(undefined)
    await expect(box.deliver(['one', '  code\n\n'], origin, { send, active: () => true })).resolves.toBe('sent')
    expect(texts(send)).toEqual(['one', '  code\n\n'])
    await box.replay({ send, active: () => true })
    expect(send).toHaveBeenCalledTimes(2)
    await expect(fs.stat(box.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([0, 1, 2])('persists only the failed and unsent suffix at chunk %i, then resumes after restart', async failAt => {
    const box = await ReplyOutbox.open(identity)
    const chunks = ['first', '  second\n\n', 'third']
    const send = vi.fn().mockResolvedValue(undefined)
    for (let i = 0; i < failAt; i++) send.mockResolvedValueOnce(undefined)
    send.mockRejectedValueOnce(rejected())
    await expect(box.deliver(chunks, origin, { send, active: () => true })).resolves.toBe('queued')
    expect(texts(send)).toEqual(chunks.slice(0, failAt + 1))
    const data = await stored(box)
    expect(data.identity).toEqual(identity)
    expect(data.replies[0]).toMatchObject({ origin, state: 'pending', nextChunk: 0 })
    expect(data.replies[0].chunks.slice(1)).toEqual(chunks.slice(failAt))
    expect(data.replies[0].chunks[0]).toContain('【补发】')
    expect(data.replies[0].chunks[0]).toContain(data.replies[0].createdAt)
    await box.pause()
    send.mockClear()
    const restored = await ReplyOutbox.open(identity)
    expect(send).not.toHaveBeenCalled()
    await restored.replay({ send, active: () => true })
    expect(contentOnly(send)).toEqual(chunks.slice(failAt))
    expect(restored.status).toEqual({ pending: 0, uncertain: 0 })
    expect((await stored(restored)).replies).toEqual([])
    await restored.replay({ send, active: () => true })
    expect(send).toHaveBeenCalledTimes(chunks.length - failAt + 1)
  })

  it('queues later replies in FIFO order without retrying while inactive, even when texts are identical', async () => {
    const box = await queued(['same'])
    const send = vi.fn().mockResolvedValue(undefined)
    await box.deliver(['same'], origin, { send, active: () => true })
    await box.deliver(['last'], { ...origin, sessionId: 'later-session' }, { send, active: () => true })
    expect(send).not.toHaveBeenCalled()
    const replies = (await stored(box)).replies
    expect(new Set(replies.map((reply: any) => reply.id)).size).toBe(3)
    await box.replay({ send, active: () => true })
    expect(contentOnly(send)).toEqual(['same', 'same', 'last'])
  })

  it('retains a repeated -2 and resumes from the last successful replay chunk', async () => {
    const box = await queued(['one', 'two', 'three'])
    const send = vi.fn().mockResolvedValue(undefined)
      .mockResolvedValueOnce(undefined) // replay label
      .mockResolvedValueOnce(undefined) // one
      .mockRejectedValueOnce(rejected()) // two
    await expect(box.replay({ send, active: () => true })).rejects.toMatchObject({ code: -2 })
    expect(box.status).toEqual({ pending: 1, uncertain: 0 })
    expect((await stored(box)).replies[0].nextChunk).toBe(2)
    await box.pause()
    send.mockClear()
    const restored = await ReplyOutbox.open(identity)
    await restored.replay({ send, active: () => true })
    expect(texts(send)).toEqual(['two', 'three'])
  })

  it.each([new Error('timeout'), new ApiError('expired login', { status: 200, code: -14 })])('does not automatically queue unrelated initial send failures: %s', async error => {
    const box = await ReplyOutbox.open(identity)
    const send = vi.fn().mockRejectedValue(error)
    await expect(box.deliver(['result'], origin, { send, active: () => true })).rejects.toBe(error)
    expect(box.status).toEqual({ pending: 0, uncertain: 0 })
    await expect(fs.stat(box.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('holds ambiguous replay outcomes across restart without blocking independent new replies', async () => {
    const box = await queued(['possibly delivered', 'unsent tail'])
    const send = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('timeout'))
    await expect(box.replay({ send, active: () => true })).rejects.toThrow('timeout')
    expect(box.status).toEqual({ pending: 0, uncertain: 1 })
    await box.pause()
    const restored = await ReplyOutbox.open(identity)
    send.mockReset().mockResolvedValue(undefined)
    await restored.replay({ send, active: () => true })
    expect(send).not.toHaveBeenCalled()
    await expect(restored.deliver(['new reply'], origin, { send, active: () => true })).resolves.toBe('sent')
    expect(texts(send)).toEqual(['new reply'])
    expect((await stored(restored)).replies[0]).toMatchObject({ nextChunk: 1, state: 'uncertain' })
  })

  it('serializes incoming activation behind an in-flight rejection so activation is not missed', async () => {
    const box = await ReplyOutbox.open(identity)
    let reject!: (error: Error) => void
    const send = vi.fn().mockResolvedValue(undefined)
      .mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const delivery = box.deliver(['result'], origin, { send, active: () => true })
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    const replay = box.replay({ send, active: () => true })
    reject(rejected())
    await Promise.all([delivery, replay])
    expect(contentOnly(send)).toEqual(['result', 'result']) // rejection + successful replay
    expect(box.status.pending).toBe(0)
  })

  it('serializes concurrent replay requests and later replies without duplicates or lost writes', async () => {
    const box = await queued(['old'])
    const send = vi.fn().mockResolvedValue(undefined)
    await Promise.all([
      box.replay({ send, active: () => true }), box.replay({ send, active: () => true }),
      box.deliver(['new'], origin, { send, active: () => true }),
    ])
    expect(contentOnly(send)).toEqual(['old', 'new'])
    expect((await stored(box)).replies).toEqual([])
  })

  it('pause waits for a late rejection to be saved, and rejects further sends until a new owner opens it', async () => {
    const box = await ReplyOutbox.open(identity)
    let reject!: (error: Error) => void
    const send = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const delivery = box.deliver(['result'], origin, { send, active: () => true })
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    let paused = false
    const pause = box.pause().then(() => { paused = true })
    expect(paused).toBe(false)
    reject(rejected())
    await Promise.all([delivery, pause])
    expect((await stored(box)).replies).toHaveLength(1)
    await expect(box.deliver(['late'], origin, { send, active: () => true })).resolves.toBe('stopped')
    await box.replay({ send, active: () => true })
    expect(send).toHaveBeenCalledTimes(1)
    const restored = await ReplyOutbox.open(identity)
    expect(restored.status.pending).toBe(1)
  })

  it('rechecks ownership after the pre-send write and restores pending state if stopped', async () => {
    const box = await queued()
    let active = true
    const rename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => { await rename(...args); active = false })
    const send = vi.fn()
    await box.replay({ send, active: () => active })
    expect(send).not.toHaveBeenCalled()
    expect((await stored(box)).replies[0].state).toBe('pending')
  })

  it('bounds replay work per activation and continues the exact suffix next time', async () => {
    const chunks = Array.from({ length: MAX_REPLAY_CHUNKS + 5 }, (_, i) => `chunk-${i}`)
    const box = await queued(chunks)
    const send = vi.fn().mockResolvedValue(undefined)
    await box.replay({ send, active: () => true })
    expect(send).toHaveBeenCalledTimes(MAX_REPLAY_CHUNKS)
    expect(box.status.pending).toBe(1)
    await box.replay({ send, active: () => true })
    expect(contentOnly(send)).toEqual(chunks)
    expect(box.status.pending).toBe(0)
  })

  it('yields to the new input when the replay time budget is spent', async () => {
    const box = await queued(['one', 'two'])
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const send = vi.fn(async () => { now += 6_000 })
    await box.replay({ send, active: () => true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(box.status.pending).toBe(1)
  })

  it.each([{ ...identity, accountId: 'another-bot' }, { ...identity, userId: 'another-user' }])('isolates pending replies by both account and recipient: %j', async other => {
    const original = await queued()
    await original.pause()
    const unrelated = await ReplyOutbox.open(other)
    expect(unrelated.filePath).not.toBe(original.filePath)
    const send = vi.fn()
    await unrelated.replay({ send, active: () => true })
    expect(send).not.toHaveBeenCalled()
    expect((await ReplyOutbox.open(identity)).status.pending).toBe(1)
  })

  it.each(['broken json', 'wrong identity', 'wrong cursor', 'wrong version'])('refuses damaged or misbound state without silently overwriting it: %s', async failure => {
    const box = await queued()
    await box.pause()
    const data = await stored(box)
    if (failure === 'wrong identity') data.identity.userId = 'another-user'
    if (failure === 'wrong cursor') data.replies[0].nextChunk = -1
    if (failure === 'wrong version') data.version = 999
    const json = failure === 'broken json' ? '{broken' : JSON.stringify(data)
    await fs.writeFile(box.filePath, json)
    await expect(ReplyOutbox.open(identity)).rejects.toBeInstanceOf(OutboxStorageError)
    expect(await fs.readFile(box.filePath, 'utf8')).toBe(json)
  })

  it('preserves existing records and removes temporary files when an atomic write fails', async () => {
    const box = await queued(['first'])
    const before = await fs.readFile(box.filePath, 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'))
    await expect(box.deliver(['second'], origin, { send: vi.fn(), active: () => true })).rejects.toBeInstanceOf(OutboxStorageError)
    expect(box.status.pending).toBe(1)
    expect(await fs.readFile(box.filePath, 'utf8')).toBe(before)
    expect(await fs.readdir(path.dirname(box.filePath))).toEqual([path.basename(box.filePath)])
  })

  it('does not send if the durable pre-send checkpoint fails', async () => {
    const box = await queued()
    const send = vi.fn()
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'))
    await expect(box.replay({ send, active: () => true })).rejects.toBeInstanceOf(OutboxStorageError)
    expect(send).not.toHaveBeenCalled()
    expect(box.status).toEqual({ pending: 1, uncertain: 0 })
  })

  it('does not resend after delivery succeeds but its final checkpoint fails', async () => {
    const box = await queued()
    const send = vi.fn(async () => {
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('checkpoint failed'))
    })
    await expect(box.replay({ send, active: () => true })).rejects.toBeInstanceOf(OutboxStorageError)
    expect(box.status).toEqual({ pending: 0, uncertain: 1 })
    await box.pause()
    const restored = await ReplyOutbox.open(identity)
    await restored.replay({ send, active: () => true })
    expect(send).toHaveBeenCalledTimes(1)
    expect((await stored(restored)).replies[0].state).toBe('uncertain')
  })

  it('does not silently evict older replies when the queue is full', async () => {
    const box = await queued(['first'])
    const transport = { send: vi.fn(), active: () => true }
    for (let i = 1; i < MAX_PENDING_REPLIES; i++) await box.deliver([`reply-${i}`], origin, transport)
    const before = await fs.readFile(box.filePath, 'utf8')
    await expect(box.deliver(['overflow'], origin, transport)).rejects.toThrow('已满')
    expect(transport.send).not.toHaveBeenCalled()
    expect(await fs.readFile(box.filePath, 'utf8')).toBe(before)
  })

  it('bounds serialized byte size without truncating a reply or claiming it was saved', async () => {
    const box = await queued()
    const before = await fs.readFile(box.filePath, 'utf8')
    await expect(box.deliver(['x'.repeat(MAX_OUTBOX_BYTES)], origin, { send: vi.fn(), active: () => true })).rejects.toThrow('4 MiB')
    expect(await fs.readFile(box.filePath, 'utf8')).toBe(before)
  })

  it.skipIf(process.platform === 'win32')('uses private POSIX directory and file permissions', async () => {
    const box = await queued()
    expect((await fs.stat(box.filePath)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(path.dirname(box.filePath))).mode & 0o777).toBe(0o700)
  })
})
