import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

let directory: string
let file: string
beforeEach(async () => {
  const root = path.resolve('node_modules/.cache')
  await fs.mkdir(root, { recursive: true })
  directory = await fs.mkdtemp(path.join(root, 'logger-test-'))
  file = path.join(directory, 'debug.log')
  vi.resetModules()
  vi.stubEnv('PI_WECHAT_DEBUG', '1')
  vi.stubEnv('PI_WECHAT_DEBUG_FILE', file)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  if (!path.resolve(directory).startsWith(path.resolve('node_modules/.cache') + path.sep)) throw new Error('Invalid scratch directory')
  await fs.rm(directory, { recursive: true, force: true })
})

describe('debug log storage', () => {
  it('does not create a file unless explicitly enabled', async () => {
    vi.stubEnv('PI_WECHAT_DEBUG', '0')
    const { debugLog } = await import('../../src/shared/logger.js')
    debugLog('should not be written')
    await expect(fs.stat(file)).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('rotates to one backup before exceeding the size limit', async () => {
    const { debugLog, MAX_LOG_BYTES } = await import('../../src/shared/logger.js')
    await fs.writeFile(file, 'a'.repeat(MAX_LOG_BYTES))
    await fs.writeFile(file + '.1', 'older backup')
    debugLog('new entry')
    expect((await fs.stat(file + '.1')).size).toBe(MAX_LOG_BYTES)
    expect(await fs.readFile(file, 'utf8')).toContain('new entry')
    expect((await fs.readdir(directory)).sort()).toEqual(['debug.log', 'debug.log.1'])
  })

  it('keeps one bounded line even for multiline, oversized input', async () => {
    const { debugLog } = await import('../../src/shared/logger.js')
    debugLog('start\r\nforged entry\u001b[31m' + '字'.repeat(10_000))
    const output = await fs.readFile(file, 'utf8')
    expect(output.trimEnd().split('\n')).toHaveLength(1)
    expect(output).not.toContain('\u001b')
    expect(Buffer.byteLength(output)).toBeLessThan(4096)
  })

  it('does not break the caller when the log destination is unwritable', async () => {
    await fs.mkdir(file)
    const { debugLog } = await import('../../src/shared/logger.js')
    expect(() => debugLog('entry')).not.toThrow()
  })
})

describe('diagnostic metadata', () => {
  it.each(['ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED'])('retains fetch cause code %s without private details', async (code) => {
    const { debugError } = await import('../../src/shared/logger.js')
    const cause = Object.assign(new Error('https://private.test/token /private/path'), { code })
    expect(debugError(new TypeError('fetch failed: private message', { cause }))).toBe(`TypeError code=${code}`)
  })

  it('prefers a top-level code and retains top-level status', async () => {
    const { debugError } = await import('../../src/shared/logger.js')
    expect(debugError({ name: 'ApiError', code: -2, status: 403, cause: { code: 'ENOTFOUND' } })).toBe('ApiError code=-2 status=403')
  })

  it('skips invalid codes while following a bounded cause chain', async () => {
    const { debugError } = await import('../../src/shared/logger.js')
    expect(debugError({ name: 'TypeError', cause: { code: 'token=private', cause: { code: 'ECONNREFUSED', message: '/private/path' } } })).toBe('TypeError code=ECONNREFUSED')
    expect(debugError({ name: 'TypeError', cause: 'private message' })).toBe('TypeError')
  })

  it('stops on cyclic causes', async () => {
    const { debugError } = await import('../../src/shared/logger.js')
    const error: { name: string; cause?: unknown } = { name: 'TypeError' }
    error.cause = error
    expect(debugError(error)).toBe('TypeError')
  })

  it('reads at most three cause hops', async () => {
    const { debugError } = await import('../../src/shared/logger.js')
    const atLimit = { cause: { cause: { cause: { code: 'ENOTFOUND' } } } }
    expect(debugError(atLimit)).toBe('Error code=ENOTFOUND')
    expect(debugError({ cause: atLimit })).toBe('Error')
  })

  it('does not evaluate messages or fail on an unreadable cause', async () => {
    const { debugError } = await import('../../src/shared/logger.js')
    const error = {
      name: 'TypeError',
      get message() { throw new Error('must not read private messages') },
      get cause() { throw new Error('unreadable cause') },
    }
    expect(debugError(error)).toBe('TypeError')
  })

  it('drops URL credentials, paths, queries, fragments and malformed URLs', async () => {
    const { redactUrl } = await import('../../src/shared/logger.js')
    expect(redactUrl('https://user:secret@example.test/private-file?token=secret#secret')).toBe('https://example.test')
    expect(redactUrl('malformed secret')).toBe('[invalid URL]')
    expect(redactUrl('data:text/plain,secret')).toBe('[redacted URL]')
    expect(redactUrl(undefined)).toBe('')
  })

  it('retains actionable error codes without messages, payloads or paths', async () => {
    const { debugError } = await import('../../src/shared/logger.js')
    expect(debugError(Object.assign(new Error('token=private /private/path'), { code: 'ENOENT' }))).toBe('Error code=ENOENT')
    expect(debugError({ name: 'ApiError', code: -2, status: 403, payload: 'secret' })).toBe('ApiError code=-2 status=403')
    expect(debugError('private message')).toBe('Error')
    expect(debugError({ name: 'private message', code: 'token=secret' })).toBe('Error')
  })
})
