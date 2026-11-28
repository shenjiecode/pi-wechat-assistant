import { describe, expect, it } from 'vitest'
import { ModelFailureNotice, summarizeModelError } from '../../src/extension/model-failure.js'

describe('structured model failure notices', () => {
  it('redacts common credential forms and URL query/userinfo before truncating', () => {
    const summary = summarizeModelError('Authorization: Bearer private-token api_key="secret value" sk-private-key https://user:pass@example.com/v1?token=hidden#secret')
    for (const secret of ['private-token', 'secret value', 'sk-private-key', 'user:pass', 'token=hidden', '#secret']) {
      expect(summary).not.toContain(secret)
    }
    expect(summary).toContain('https://example.com/v1')
  })
  it('normalizes diagnostics and limits by Unicode code points', () => {
    expect(summarizeModelError('\u001b[31mrate\nlimit\u001b[0m')).toBe('rate limit')
    expect(summarizeModelError('')).toContain('未提供错误详情')
    expect(summarizeModelError('😀'.repeat(301))).toBe('😀'.repeat(300) + '…')
  })
  it('requires an error boundary on both the first and subsequent requests', () => {
    const failure = new ModelFailureNotice()
    for (let i = 0; i < 2; i++) {
      failure.observe({ stopReason: 'error', errorMessage: 'quota' })
      expect(failure.take()).toBeNull()
      failure.beforeSettle('error')
      expect(failure.take()).toContain('自动处理已结束')
      expect(failure.take()).toBeNull()
      failure.reset()
    }
  })
  it('claims a notice once per user request', () => {
    const failure = new ModelFailureNotice()
    failure.observe({ stopReason: 'error', errorMessage: 'quota' })
    failure.beforeSettle('error')
    expect(failure.take()).toContain('自动处理已结束')
    failure.reset()
    failure.observe({ stopReason: 'error', errorMessage: 'quota again' })
    failure.beforeSettle('error')
    expect(failure.take()).not.toBeNull()
  })
  it('suppresses a recovered or non-error settlement', () => {
    const failure = new ModelFailureNotice()
    failure.beforeSettle('completed')
    failure.observe({ stopReason: 'error', errorMessage: 'quota' })
    expect(failure.take()).toBeNull()
    failure.reset()
    failure.observe({ stopReason: 'error', errorMessage: 'quota' })
    failure.beforeSettle('aborted')
    expect(failure.take()).toBeNull()
  })
  it('honors an aborted signal', () => {
    const failure = new ModelFailureNotice()
    const abort = new AbortController()
    failure.observe({ stopReason: 'error', errorMessage: 'quota' }, abort.signal)
    failure.beforeSettle('error')
    abort.abort()
    expect(failure.take()).toBeNull()
  })
})
