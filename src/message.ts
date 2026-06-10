// ============================================================================
// 消息处理工具：Markdown 分段 + 语法过滤
// ============================================================================

/**
 * 将 Markdown 文本按结构分段，每段过滤掉 Markdown 语法。
 *
 * 分段策略：
 * 1. 按 Markdown 标题（#、##、### 等）分段
 * 2. 按水平分割线（---）分段
 * 3. 按空行（双换行）分段
 * 4. 每段过滤 Markdown 语法变成纯文本
 * 5. 兜底长度检查：超长段落按换行二次切割
 * 6. 过短的段落与下一段合并
 */

const DEFAULT_CHUNK_SIZE = 800
const MIN_CHUNK_SIZE = 100 // 过短的段合并到下一段

export function splitAndFilterMarkdown(text: string, maxChunkSize = DEFAULT_CHUNK_SIZE): string[] {
  const rawSections = splitByMarkdownStructure(text)
  const filtered = rawSections.map(filterMarkdownSyntax).map(s => s.trim()).filter(Boolean)

  // 合并过短的段落
  const merged = mergeShortSections(filtered, MIN_CHUNK_SIZE)

  // 兜底长度切割
  const result: string[] = []
  for (const section of merged) {
    if (section.length <= maxChunkSize) {
      result.push(section)
    } else {
      result.push(...splitLongSection(section, maxChunkSize))
    }
  }

  return result
}

// --- Markdown 结构分段 ---

function splitByMarkdownStructure(text: string): string[] {
  const lines = text.split('\n')
  const sections: string[] = []
  let current: string[] = []

  for (const line of lines) {
    // 标题行作为分段点（但不包含在内容中）
    if (/^#{1,6}\s/.test(line)) {
      if (current.length > 0) {
        sections.push(current.join('\n'))
        current = []
      }
      // 去掉 # 前缀，保留标题文字
      current.push(line.replace(/^#{1,6}\s+/, ''))
      continue
    }

    // 水平分割线
    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line) || /^___+\s*$/.test(line)) {
      if (current.length > 0) {
        sections.push(current.join('\n'))
        current = []
      }
      continue
    }

    current.push(line)
  }

  if (current.length > 0) {
    sections.push(current.join('\n'))
  }

  return sections
}

// --- Markdown 语法过滤 ---

function filterMarkdownSyntax(text: string): string {
  return text
    // 代码块 → 保留内容
    .replace(/```[\w]*\n?/g, '')
    .replace(/```/g, '')
    // 粗体
    .replace(/\*\*(.+?)\*\*/g, '$1')
    // 斜体
    .replace(/\*(.+?)\*/g, '$1')
    // 行内代码
    .replace(/`([^`]+)`/g, '$1')
    // 链接 → 只保留文字
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 有序列表
    .replace(/^(\d+)\.\s+/gm, '$1. ')
    // 无序列表 → 用 bullet
    .replace(/^[-*+]\s+/gm, '• ')
}

// --- 合并短段落 ---

function mergeShortSections(sections: string[], minLength: number): string[] {
  if (sections.length === 0) return []

  const result: string[] = []
  let buffer = sections[0]

  for (let i = 1; i < sections.length; i++) {
    const section = sections[i]
    if (buffer.length < minLength) {
      buffer = buffer + '\n\n' + section
    } else {
      result.push(buffer)
      buffer = section
    }
  }

  if (buffer.trim()) {
    result.push(buffer)
  }

  return result
}

// --- 超长段落二次切割 ---

function splitLongSection(text: string, maxLen: number): string[] {
  const chunks: string[] = []
  let remaining = text.trim()

  while (remaining.length > maxLen) {
    // 优先在换行处切
    let splitAt = remaining.lastIndexOf('\n', maxLen)
    if (splitAt < maxLen / 2) {
      // 其次在空格处切
      splitAt = remaining.lastIndexOf(' ', maxLen)
    }
    if (splitAt < maxLen / 2) {
      // 硬切
      splitAt = maxLen
    }

    const chunk = remaining.slice(0, splitAt).trim()
    if (chunk) chunks.push(chunk)
    remaining = remaining.slice(splitAt).trim()
  }

  if (remaining) {
    chunks.push(remaining)
  }

  return chunks
}
