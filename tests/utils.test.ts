// ============================================================================
// 测试: utils.ts
// ============================================================================

import { describe, it, expect } from 'vitest'
import {
  ok,
  fail,
  extractAllAssistantReplies,
  extractTextFromMessageContent,
  summarizePreview,
  formatError,
  isAbortError,
} from '../src/utils.js'

describe('ok / fail', () => {
  it('ok returns success content', () => {
    const result = ok('done')
    expect(result.content).toEqual([{ type: 'text', text: 'done' }])
    expect(result.details).toEqual({})
  })

  it('fail returns error content with prefix', () => {
    const result = fail('something wrong')
    expect(result.content).toEqual([{ type: 'text', text: '❌ something wrong' }])
  })
})

describe('extractAllAssistantReplies', () => {
  it('extracts string content from assistant messages', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'assistant', content: '  How can I help?  ' },
    ]
    expect(extractAllAssistantReplies(messages)).toEqual(['Hi there', 'How can I help?'])
  })

  it('extracts array content with text parts', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'toolCall', name: 'send_file' },
          { type: 'text', text: 'Part 2' },
        ],
      },
    ]
    expect(extractAllAssistantReplies(messages)).toEqual(['Part 1\nPart 2'])
  })

  it('skips non-assistant messages', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'toolResult', content: 'result' },
    ]
    expect(extractAllAssistantReplies(messages)).toEqual([])
  })

  it('skips empty assistant messages', () => {
    const messages = [
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '  ' },
    ]
    expect(extractAllAssistantReplies(messages)).toEqual([])
  })

  it('handles empty array', () => {
    expect(extractAllAssistantReplies([])).toEqual([])
  })
})

describe('extractTextFromMessageContent', () => {
  it('extracts from string', () => {
    expect(extractTextFromMessageContent('hello')).toBe('hello')
  })

  it('returns null for whitespace string', () => {
    expect(extractTextFromMessageContent('  ')).toBeNull()
  })

  it('extracts from array content', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]
    expect(extractTextFromMessageContent(content)).toBe('hello\nworld')
  })

  it('returns null for non-array non-string', () => {
    expect(extractTextFromMessageContent(42)).toBeNull()
    expect(extractTextFromMessageContent(null)).toBeNull()
    expect(extractTextFromMessageContent({})).toBeNull()
  })

  it('filters out non-text parts', () => {
    const content = [
      { type: 'toolCall', name: 'send' },
      { type: 'text', text: 'only this' },
    ]
    expect(extractTextFromMessageContent(content)).toBe('only this')
  })
})

describe('summarizePreview', () => {
  it('returns full text when short', () => {
    expect(summarizePreview('short')).toBe('short')
  })

  it('truncates long text at 60 chars', () => {
    const long = 'a'.repeat(100)
    const result = summarizePreview(long)
    expect(result.length).toBe(60)
    expect(result.endsWith('…')).toBe(true)
  })

  it('normalizes whitespace', () => {
    expect(summarizePreview('  hello   world  ')).toBe('hello world')
  })
})

describe('formatError', () => {
  it('extracts message from Error', () => {
    expect(formatError(new Error('test'))).toBe('test')
  })

  it('stringifies non-Error values', () => {
    expect(formatError('string error')).toBe('string error')
    expect(formatError(42)).toBe('42')
  })
})

describe('isAbortError', () => {
  it('detects AbortError', () => {
    const err = new DOMException('aborted', 'AbortError')
    // DOMException with name 'AbortError' is the standard AbortError
    Object.defineProperty(err, 'name', { value: 'AbortError' })
    // The function checks error.name === 'AbortError'
    const customErr = new Error('aborted')
    customErr.name = 'AbortError'
    expect(isAbortError(customErr)).toBe(true)
  })

  it('returns false for normal errors', () => {
    expect(isAbortError(new Error('normal'))).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(isAbortError('string')).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })
})
