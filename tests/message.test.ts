// ============================================================================
// 测试: message.ts — Markdown 分段 + 语法过滤
// ============================================================================

import { describe, it, expect } from 'vitest'
import { splitAndFilterMarkdown } from '../src/message.js'

describe('splitAndFilterMarkdown', () => {
  it('returns plain text as single chunk', () => {
    const result = splitAndFilterMarkdown('hello world')
    expect(result).toEqual(['hello world'])
  })

  it('splits on headings (but merges short sections by design)', () => {
    const input = 'Intro text\n## Section 1\nContent 1\n### Sub\nContent 2'
    const result = splitAndFilterMarkdown(input)
    // short sections get merged (MIN_CHUNK_SIZE=100)
    expect(result.length).toBe(1)
    expect(result[0]).toContain('Intro text')
    expect(result[0]).toContain('Section 1')
    expect(result[0]).toContain('Sub')
  })

  it('strips heading # prefixes, keeps text', () => {
    const input = '# Title\nBody text'
    const result = splitAndFilterMarkdown(input)
    expect(result).toEqual(['Title\nBody text'])
  })

  it('splits on horizontal rules (merged when short)', () => {
    const input = 'Before\n---\nAfter'
    // Both sections < 100 chars → merged
    const result = splitAndFilterMarkdown(input)
    expect(result.length).toBe(1)
    expect(result[0]).toContain('Before')
    expect(result[0]).toContain('After')
  })

  it('filters bold syntax', () => {
    expect(splitAndFilterMarkdown('**bold** text')).toEqual(['bold text'])
  })

  it('filters italic syntax', () => {
    expect(splitAndFilterMarkdown('*italic* text')).toEqual(['italic text'])
  })

  it('filters inline code', () => {
    expect(splitAndFilterMarkdown('`code` here')).toEqual(['code here'])
  })

  it('filters code blocks', () => {
    const input = 'Before\n```\ncode block\n```\nAfter'
    const result = splitAndFilterMarkdown(input)
    expect(result[0]).toContain('Before')
    expect(result[0]).toContain('code block')
    expect(result[0]).toContain('After')
  })

  it('filters links, keeps text', () => {
    expect(splitAndFilterMarkdown('[click here](https://example.com)')).toEqual(['click here'])
  })

  it('converts unordered lists to bullets', () => {
    const input = '- item 1\n- item 2'
    const result = splitAndFilterMarkdown(input)
    expect(result).toEqual(['• item 1\n• item 2'])
  })

  it('converts ordered lists', () => {
    const input = '1. first\n2. second'
    const result = splitAndFilterMarkdown(input)
    expect(result[0]).toBe('1. first\n2. second')
  })

  it('merges short sections', () => {
    const input = '# A\nshort\n## B\nalso short'
    // all sections < 100 chars, should merge
    const result = splitAndFilterMarkdown(input)
    // With the merge logic, short sections get merged
    expect(result.length).toBe(1)
  })

  it('splits long sections at newlines', () => {
    const longLine = 'x'.repeat(90) + '\n'
    const input = longLine.repeat(10)
    const result = splitAndFilterMarkdown(input)
    // 10 lines of 90 chars + newline = 910 chars, should split into at least 2
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(800)
    }
  })

  it('handles empty input', () => {
    expect(splitAndFilterMarkdown('')).toEqual([])
  })

  it('handles whitespace-only input', () => {
    expect(splitAndFilterMarkdown('   \n  \n ')).toEqual([])
  })

  it('handles mixed bold and italic', () => {
    expect(splitAndFilterMarkdown('**bold** and *italic*')).toEqual(['bold and italic'])
  })

  it('handles multiple horizontal rule styles (merged when short)', () => {
    const input = 'A\n***\nB\n___\nC'
    const result = splitAndFilterMarkdown(input)
    // short sections merged
    expect(result.length).toBe(1)
    expect(result[0]).toContain('A')
    expect(result[0]).toContain('B')
    expect(result[0]).toContain('C')
  })
})
