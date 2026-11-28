// ============================================================================
// Multi-process OS-level E2E: two REAL pi-worker OS processes (distinct PIDs)
// contend for the REAL session.lock with the REAL filesystem mutex and real
// process.kill(pid, 0) liveness checks, over real HTTP to the fake servers.
// ============================================================================

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeLlmServer } from './fake-llm-server.js'
import { createDeviceEnvironment, disposeDeviceEnvironment, startFakeLlm, type ManagedDeviceEnvironment } from './helpers.js'

const WAIT = { timeout: 30_000, interval: 50 } as const
// node --import requires a file:// URL on Windows (raw C:\ paths throw ERR_UNSUPPORTED_ESM_URL_SCHEME).
const LOADER_URL = new URL('./ts-loader.mjs', import.meta.url).href
const WORKER_PATH = fileURLToPath(new URL('./pi-worker.ts', import.meta.url))
/** Exact takeover choice offered by runtime.ts for ask-mode handoff. */
const TAKEOVER_CHOICE = '请求旧会话停止，等待释放后在本会话启动'

interface WorkerEvent {
  pid: number
  event: string
  message?: string
  level?: string
  title?: string
  options?: string[]
  answer?: string | null
  error?: string
  projectDir?: string
}

class Worker {
  readonly pid: number
  readonly projectDir: string
  readonly events: WorkerEvent[] = []
  private readonly child: ReturnType<typeof spawn>
  private readonly stderr: string[] = []
  private exited = false

  constructor(projectDir: string, fakeIlinkUrl: string, fakeLlmUrl: string, tempHome: string) {
    this.projectDir = projectDir
    this.child = spawn(process.execPath, ['--import', LOADER_URL, WORKER_PATH], {
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        E2E_ILINK_URL: fakeIlinkUrl,
        E2E_LLM_URL: fakeLlmUrl,
        E2E_PROJECT_DIR: projectDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.pid = this.child.pid!
    createInterface({ input: this.child.stdout! }).on('line', line => {
      try { this.events.push(JSON.parse(line) as WorkerEvent) } catch { /* ignore non-JSON noise */ }
    })
    this.child.stderr!.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString('utf8')))
    this.child.on('exit', () => { this.exited = true })
  }

  send(command: Record<string, unknown>): void {
    this.child.stdin!.write(JSON.stringify(command) + '\n')
  }

  isAlive(): boolean {
    if (this.exited) return false
    try { process.kill(this.pid, 0); return true } catch { return false }
  }

  eventCount(): number { return this.events.length }

  waitForEvent(event: string, options: { from?: number; timeoutMs?: number } = {}): Promise<WorkerEvent> {
    const from = options.from ?? 0
    return vi.waitFor(() => {
      const index = this.events.findIndex((candidate, position) => position >= from && candidate.event === event)
      expect(index, `event ${event} after #${from}; got ${JSON.stringify(this.events)} stderr=${this.stderr.join('')}`).toBeGreaterThanOrEqual(0)
      return this.events[index]
    }, { timeout: options.timeoutMs ?? 30_000, interval: 50 })
  }

  notifyMessages(): string[] {
    return this.events.filter(candidate => candidate.event === 'notify').map(candidate => candidate.message ?? '')
  }

  async dispose(): Promise<void> {
    if (this.exited) return
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        this.child.kill('SIGKILL')
        resolve()
      }, 5_000)
      this.child.once('exit', () => { clearTimeout(timeout); resolve() })
      try { this.send({ type: 'shutdown' }) } catch { this.child.kill('SIGKILL') }
    })
  }
}

let env: ManagedDeviceEnvironment
let fakeLlm: FakeLlmServer
let workers: Worker[] = []
const lockFile = () => env.statePath('session.lock')

beforeEach(async () => {
  env = await createDeviceEnvironment({ config: { sendAck: false, handoff: 'auto' } })
  fakeLlm = await startFakeLlm(env, new FakeLlmServer())
  workers = []
})

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.dispose().catch(() => {})
  await disposeDeviceEnvironment(env)
})

async function lockState(): Promise<{ pid: number; sessionId: string; protocol?: number } | null> {
  try {
    return JSON.parse(await fs.readFile(lockFile(), 'utf8'))
  } catch {
    return null
  }
}

function startWorker(projectDir: string): Worker {
  const worker = new Worker(projectDir, env.fakeIlink.baseUrl, fakeLlm.openaiBaseUrl, env.tempHome)
  workers.push(worker)
  return worker
}

/** The persisted session JSONL under a worker's project dir. */
async function sessionTexts(projectDir: string): Promise<string> {
  const sessionsDir = path.join(projectDir, 'sessions')
  const files = await fs.readdir(sessionsDir).catch(() => [])
  const contents: string[] = []
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    contents.push(await fs.readFile(path.join(sessionsDir, file), 'utf8').catch(() => ''))
  }
  return contents.join('\n')
}

// ============================================================================

describe('multi-process bridge handoff and outbox takeover', () => {
  it('1. auto handoff: process B takes the lock, process A survives, and B replays A\'s deferred reply into its own project', async () => {
    const projectA = path.join(env.tempHome, 'project-a')
    const projectB = path.join(env.tempHome, 'project-b')
    await fs.mkdir(projectA, { recursive: true })
    await fs.mkdir(projectB, { recursive: true })

    const workerA = startWorker(projectA)
    await workerA.waitForEvent('ready')
    workerA.send({ type: 'start' })
    await workerA.waitForEvent('started')
    await vi.waitFor(() => expect(env.fakeIlink.notifyStarts.length).toBeGreaterThan(0), WAIT)

    expect(await lockState()).toMatchObject({ pid: workerA.pid, protocol: 1 })
    expect(workerA.isAlive()).toBe(true)
    expect(workerA.pid).not.toBe(process.pid)

    // Process A serves a normal message first.
    fakeLlm.queueText('A 进程回复')
    env.fakeIlink.pushText('给A的消息')
    await vi.waitFor(() => expect(env.fakeIlink.sentMessages.some(message => message.text === 'A 进程回复')).toBe(true), WAIT)
    expect(await sessionTexts(projectA)).toContain('给A的消息')

    // Then a ret=-2 rejection persists a pending reply to the on-disk outbox.
    env.fakeIlink.failNextSend({ ret: -2, errmsg: 'prepare failed', failFallbackToo: true })
    fakeLlm.queueText('A 进程待补发回复')
    env.fakeIlink.pushText('给A的第二条')
    await vi.waitFor(() => expect(env.fakeIlink.rejectedSends.length).toBeGreaterThanOrEqual(2), WAIT)
    await vi.waitFor(async () => {
      const dir = env.statePath('outbox')
      const files = await fs.readdir(dir).catch(() => [])
      expect(files.length).toBe(1)
      const outbox = JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'))
      expect(outbox.replies).toHaveLength(1)
      expect(outbox.replies[0].chunks.join('\n')).toContain('A 进程待补发回复')
    }, WAIT)

    // Process B (different project, same HOME) takes over with handoff: auto.
    const workerB = startWorker(projectB)
    await workerB.waitForEvent('ready')
    workerB.send({ type: 'start' })
    await workerB.waitForEvent('started')
    expect(workerB.pid).not.toBe(workerA.pid)

    // A handed off cleanly: lock now belongs to B, A is still alive.
    expect(await lockState()).toMatchObject({ pid: workerB.pid, protocol: 1 })
    expect(workerA.isAlive()).toBe(true)
    expect(workerB.isAlive()).toBe(true)
    expect(workerA.notifyMessages().some(message => message.includes('收到微信桥接交接请求'))).toBe(true)
    await vi.waitFor(() => expect(env.fakeIlink.notifyStops.length).toBeGreaterThan(0), WAIT)

    // The next inbound message makes B replay A's deferred reply and answer itself.
    fakeLlm.queueText('B 进程回复')
    env.fakeIlink.pushText('给B的消息')
    await vi.waitFor(() => expect(env.fakeIlink.sentMessages.some(message => message.text === 'B 进程回复')).toBe(true), WAIT)
    const texts = env.fakeIlink.sentMessages.map(message => message.text)
    expect(texts.some(text => text.startsWith('【补发】'))).toBe(true)
    expect(texts.filter(text => text === 'A 进程待补发回复')).toHaveLength(1)

    // B's own project received the turn; A's project did not.
    const bSessions = await sessionTexts(projectB)
    expect(bSessions).toContain('给B的消息')
    expect(bSessions).toContain('B 进程回复')
    expect(bSessions).not.toContain('给A的消息')
    const aSessions = await sessionTexts(projectA)
    expect(aSessions).not.toContain('给B的消息')
  }, 120_000)

  it('2. ask-mode handoff: declining keeps A in charge, confirming hands off cleanly', async () => {
    // Ask mode is the default; reset the shared auto setting through the real config module.
    const { saveConfig } = await import('../../src/bridge/config.js')
    await saveConfig({ sendAck: false })

    const projectA = path.join(env.tempHome, 'project-a')
    const projectB = path.join(env.tempHome, 'project-b')
    await fs.mkdir(projectA, { recursive: true })
    await fs.mkdir(projectB, { recursive: true })

    const workerA = startWorker(projectA)
    await workerA.waitForEvent('ready')
    workerA.send({ type: 'start' })
    await workerA.waitForEvent('started')
    await vi.waitFor(() => expect(env.fakeIlink.notifyStarts.length).toBeGreaterThan(0), WAIT)

    const workerB = startWorker(projectB)
    await workerB.waitForEvent('ready')

    // First attempt: decline the confirmation dialog.
    workerB.send({ type: 'set-ui-confirm', answer: '取消' })
    await workerB.waitForEvent('ui-answer-programmed')
    const declinedMark = workerB.eventCount()
    workerB.send({ type: 'start' })
    await workerB.waitForEvent('select-resolved', { from: declinedMark })
    await workerB.waitForEvent('started', { from: declinedMark })
    const declinedSelect = workerB.events.slice(declinedMark).find(candidate => candidate.event === 'confirm-requested')
    expect(declinedSelect?.options).toContain(TAKEOVER_CHOICE)
    expect(workerB.notifyMessages().some(message => message.includes('已取消，未改动其他会话的微信桥接'))).toBe(true)
    expect(await lockState()).toMatchObject({ pid: workerA.pid })
    expect(workerA.isAlive()).toBe(true)

    // A still owns and serves messages.
    fakeLlm.queueText('A 仍在服务')
    env.fakeIlink.pushText('仍然问A')
    await vi.waitFor(() => expect(env.fakeIlink.sentMessages.some(message => message.text === 'A 仍在服务')).toBe(true), WAIT)

    // Second attempt: confirm the takeover.
    workerB.send({ type: 'set-ui-confirm', answer: TAKEOVER_CHOICE })
    await workerB.waitForEvent('ui-answer-programmed')
    const confirmMark = workerB.eventCount()
    workerB.send({ type: 'start' })
    await workerB.waitForEvent('select-resolved', { from: confirmMark })
    await workerB.waitForEvent('started', { from: confirmMark })
    expect(await lockState()).toMatchObject({ pid: workerB.pid, protocol: 1 })
    expect(workerA.isAlive()).toBe(true)
    expect(workerA.notifyMessages().some(message => message.includes('收到微信桥接交接请求'))).toBe(true)
    await vi.waitFor(() => expect(env.fakeIlink.notifyStops.length).toBeGreaterThan(0), WAIT)

    // B now serves the bridge end-to-end.
    fakeLlm.queueText('B 已接管')
    env.fakeIlink.pushText('问问B')
    await vi.waitFor(() => expect(env.fakeIlink.sentMessages.some(message => message.text === 'B 已接管')).toBe(true), WAIT)
    expect(await sessionTexts(projectB)).toContain('问问B')
  }, 120_000)
})
