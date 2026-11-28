// ============================================================================
// Fake OpenAI-compatible LLM server — real HTTP SSE endpoint implemented with
// node:http on an ephemeral port. Records every request so tests assert the
// exact model inputs Pi produced (system prompt, message content, image parts,
// tool definitions).
// ============================================================================

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedLlmRequest {
  body: {
    model?: string
    messages?: Array<Record<string, unknown>>
    tools?: Array<Record<string, unknown>>
    stream?: boolean
    [key: string]: unknown
  }
  headers: http.IncomingHttpHeaders
  receivedAt: number
}

export interface SseChunkChoice {
  index: number
  delta: {
    role?: 'assistant'
    content?: string
    tool_calls?: Array<{
      index: number
      id?: string
      type?: 'function'
      function?: { name?: string; arguments?: string }
    }>
  }
  finish_reason: 'stop' | 'tool_calls' | null
}

export interface SseChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: SseChunkChoice[]
  usage?: Record<string, number>
}

/** A queued responder produces the HTTP reply for the next request. */
export type LlmResponder = (request: RecordedLlmRequest, context: LlmResponseContext) => void

export interface LlmResponseContext {
  sseText(chunks: string[], options?: { model?: string }): void
  sseToolCall(args: { name: string; arguments: Record<string, unknown>; model?: string; callId?: string }): void
  json(status: number, payload: unknown): void
}

export interface FakeLlmOptions {
  defaultReply?: string
  model?: string
}

export class FakeLlmServer {
  readonly requests: RecordedLlmRequest[] = []
  private server: http.Server | null = null
  private port = 0
  private queue: LlmResponder[] = []
  private readonly defaultReply: string
  private readonly defaultModel: string

  constructor(options: FakeLlmOptions = {}) {
    this.defaultReply = options.defaultReply ?? '好的，已完成。'
    this.defaultModel = options.model ?? 'mock-model'
  }

  get baseUrl(): string { return `http://127.0.0.1:${this.port}` }
  /** OpenAI-style base URL (the OpenAI SDK appends /chat/completions). */
  get openaiBaseUrl(): string { return `${this.baseUrl}/v1` }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => { void this.handle(req, res) })
    this.server.on('clientError', (_err, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })
    this.server!.removeAllListeners('error')
    this.port = (this.server!.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = null
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  // --- 编程接口 ---

  /** Queue one streamed text reply (split across several SSE content deltas). */
  queueText(text: string, options: { chunks?: number; model?: string } = {}): void {
    const parts = options.chunks && options.chunks > 1 ? splitEvenly(text, options.chunks) : [text]
    this.queue.push((_request, context) => context.sseText(parts, { model: options.model }))
  }

  /** Queue a streamed reply with explicit content deltas. */
  queueTextChunks(chunks: string[]): void {
    this.queue.push((_request, context) => context.sseText(chunks))
  }

  /** Queue one streamed tool call, then a plain text reply for the follow-up turn. */
  queueToolCall(args: { name: string; arguments: Record<string, unknown>; model?: string; callId?: string }, summary?: string): void {
    this.queue.push((_request, context) => context.sseToolCall(args))
    if (summary !== undefined) this.queueText(summary)
  }

  /** Queue a raw function responder for fully dynamic replies. */
  queueHandler(handler: LlmResponder): void {
    this.queue.push(handler)
  }

  /** Queue an HTTP error response (Pi sees a real provider failure). */
  queueError(status: number, message: string, code = 'upstream_error'): void {
    this.queue.push((_request, context) => context.json(status, { error: { message, type: code, code } }))
  }

  clearQueue(): void { this.queue = [] }

  // --- 便捷断言视图 ---

  /** Flat JSON view of every recorded request (messages + tools). */
  requestBodies(): Array<RecordedLlmRequest['body']> {
    return this.requests.map(request => request.body)
  }

  // --- HTTP ---

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `unexpected path ${url.pathname}` } }))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as RecordedLlmRequest['body']
      const request: RecordedLlmRequest = { body, headers: req.headers, receivedAt: Date.now() }
      this.requests.push(request)

      const responder = this.queue.length > 0 ? this.queue.shift()! : (_request, context) => context.sseText([this.defaultReply])
      responder(request, {
        sseText: (deltas, options) => this.writeSseText(res, deltas, options?.model ?? this.defaultModel),
        sseToolCall: args => this.writeSseToolCall(res, args, args.model ?? this.defaultModel),
        json: (status, payload) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(payload))
        },
      })
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
    }
  }

  private writeChunk(res: http.ServerResponse, chunk: SseChunk): void {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }

  private baseChunk(id: string, model: string): SseChunk {
    return { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: null }] }
  }

  private writeSseText(res: http.ServerResponse, deltas: string[], model: string): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const id = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const first: SseChunk = { ...this.baseChunk(id, model), choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }
    this.writeChunk(res, first)
    for (const delta of deltas) {
      this.writeChunk(res, { ...this.baseChunk(id, model), choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })
    }
    this.writeChunk(res, { ...this.baseChunk(id, model), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    this.writeChunk(res, { ...this.baseChunk(id, model), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, choices: [] })
    res.write('data: [DONE]\n\n')
    res.end()
  }

  private writeSseToolCall(res: http.ServerResponse, args: { name: string; arguments: Record<string, unknown>; callId?: string }, model: string): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const id = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const callId = args.callId ?? `call_${Math.random().toString(36).slice(2, 10)}`
    const serialized = JSON.stringify(args.arguments)
    const first: SseChunk = {
      ...this.baseChunk(id, model),
      choices: [{
        index: 0,
        delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: args.name, arguments: '' } }] },
        finish_reason: null,
      }],
    }
    this.writeChunk(res, first)
    this.writeChunk(res, {
      ...this.baseChunk(id, model),
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: serialized } }] }, finish_reason: null }],
    })
    this.writeChunk(res, { ...this.baseChunk(id, model), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    res.write('data: [DONE]\n\n')
    res.end()
  }
}

function splitEvenly(text: string, parts: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / parts))
  const result: string[] = []
  for (let index = 0; index < text.length; index += size) result.push(text.slice(index, index + size))
  return result
}
