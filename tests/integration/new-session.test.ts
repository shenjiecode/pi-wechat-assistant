import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'

const state = vi.hoisted(() => ({ clients: [] as any[], owner: null as string | null, directory: '', config: {} as any, cancelNew: false }))
vi.mock('../../src/bridge/config.js', () => ({
  loadConfig: async () => state.config, getConfigCache: () => state.config,
}))
vi.mock('../../src/messaging/wechat-prompt.js', () => ({
  WechatPrompt: class { rules = null; async load() {} clear() {} },
}))
vi.mock('../../src/bridge/auth.js', () => ({
  loadCredentials: async () => ({ userId: 'bound-user' }),
  acquireLock: async (id: string) => { state.owner = id; return { success: true } },
  releaseLock: async () => { state.owner = null },
  hasHandoffRequest: async () => false,
  getBridgeLockState: async () => state.owner
    ? { kind: 'current', pid: process.pid, sessionId: state.owner, protocol: 1 }
    : { kind: 'missing' },
  requestHandoff: vi.fn(),
}))
vi.mock('../../src/bridge/state-storage.js', async () => ({
  ...await vi.importActual<typeof import('../../src/bridge/state-storage.js')>('../../src/bridge/state-storage.js'),
  getStateDir: () => state.directory,
}))
vi.mock('../../src/wechat/client.js', () => ({
  SessionExpiredError: class extends Error {},
  WeixinClient: { create: async () => {
    const client = {
      userId: 'bound-user', onStatusChange: undefined, onNeedsFreshContext: undefined,
      sendText: vi.fn(async () => {}), notifyStart: vi.fn(async () => {}), notifyStop: vi.fn(async () => {}),
      pauseSending: vi.fn(async () => {}), resumeSending: vi.fn(),
      reloadReceiveState: vi.fn(async () => {}), flushReceiveState: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}), startTyping: vi.fn(async () => {}), stopTyping: vi.fn(async () => {}),
      deliver: (_messages: any[]) => {},
      getUpdates: vi.fn((signal: AbortSignal) => new Promise<any[]>(resolve => {
        client.deliver = resolve
        if (signal.aborted) resolve([])
        else signal.addEventListener('abort', () => resolve([]), { once: true })
      })),
    }
    state.clients.push(client)
    return client
  } },
}))
import extension from '../../index.js'

const message = (text: string) => ({
  userId: 'bound-user', raw: { from_user_id: 'bound-user' }, type: 'text', text,
  imageUrls: [], timestamp: Date.now(), contextToken: '',
})
const replies = () => state.clients.flatMap(client => client.sendText.mock.calls.map((call: any[]) => call[1]))
const receiver = () => state.clients.findLast(client => client.getUpdates.mock.calls.length > 0)
const assistant = (text: string) => ({
  role: 'assistant' as const, api: 'openai-completions' as const, provider: 'wechat-test', model: 'mock',
  content: [{ type: 'text' as const, text }], stopReason: 'stop' as const, timestamp: Date.now(),
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
})

// Real Pi session replacement and extension dispatch; only WeChat transport is mocked.
describe('remote /new with the Pi SDK', () => {
  let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined
  let temporary = ''
  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    if (temporary) await rm(temporary, { recursive: true, force: true })
  })

  it.each([false, true])('preserves history, creates empty context and keeps messaging with autoStart=%s', async autoStart => {
    const cache = path.join(process.cwd(), 'node_modules', '.cache')
    await mkdir(cache, { recursive: true })
    temporary = await mkdtemp(path.join(cache, 'wechat-new-sdk-'))
    state.directory = temporary
    state.clients = []; state.owner = null; state.cancelNew = false
    state.config = { autoStart, sendAck: false, messageSourceTag: { enabled: false } }
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(temporary, 'auth.json'), modelsPath: null,
      modelsStorePath: path.join(temporary, 'models.json'), refreshOnCreate: false, allowModelNetwork: false,
    })
    modelRuntime.registerProvider('wechat-test', {
      baseUrl: 'http://127.0.0.1:1', apiKey: 'test-only', api: 'openai-completions',
      models: [{ id: 'mock', name: 'Mock', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
    })
    const modelRequests: any[] = []
    const errors: any[] = []
    const create = async ({ sessionManager, sessionStartEvent }: any) => {
      const services = await createAgentSessionServices({
        cwd: temporary, agentDir: temporary, modelRuntime,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [extension, pi => {
            pi.on('session_before_switch', () => state.cancelNew ? { cancel: true } : undefined)
          }],
          systemPrompt: 'Disposable integration instructions.',
          agentsFilesOverride: () => ({ agentsFiles: [{
            path: path.join(temporary, 'AGENTS.md'), content: 'Disposable project instructions.',
          }] }),
        },
      })
      const result = await createAgentSessionFromServices({
        services, sessionManager, sessionStartEvent, model: modelRuntime.getModel('wechat-test', 'mock'), tools: [],
      })
      result.session.agent.streamFunction = (_model, context) => {
        modelRequests.push(context)
        const stream = createAssistantMessageEventStream()
        stream.push({ type: 'done', reason: 'stop', message: assistant('fresh reply') })
        return stream
      }
      return { ...result, services, diagnostics: [] }
    }
    const manager = SessionManager.create(temporary, path.join(temporary, 'sessions'))
    manager.appendMessage({ role: 'user', content: 'old-context-marker', timestamp: Date.now() })
    manager.appendMessage(assistant('old reply'))
    const oldFile = manager.getSessionFile()!
    runtime = await createAgentSessionRuntime(create, { cwd: temporary, agentDir: temporary, sessionManager: manager })
    const bind = async (session: any) => session.bindExtensions({
      commandContextActions: { newSession: (options: any) => runtime!.newSession(options) },
      onError: (error: any) => errors.push(error),
    })
    runtime.setRebindSession(bind)
    await bind(runtime.session)
    await runtime.session.prompt('/wechat start')
    const oldHistory = await readFile(oldFile, 'utf8')
    const oldSession = runtime.session
    const oldId = oldSession.sessionId
    const oldReceiver = receiver()
    const listenerCounts = ['SIGINT', 'SIGTERM', 'beforeExit'].map(name => process.listenerCount(name))
    state.cancelNew = true
    oldReceiver.deliver([message('/new')])
    await vi.waitFor(() => expect(replies()).toContain('已取消新建会话，原会话保持不变'))
    expect(runtime.session.sessionId).toBe(oldId)
    expect(receiver()).toBe(oldReceiver)
    expect(oldReceiver.dispose).not.toHaveBeenCalled()
    expect(state.clients).toHaveLength(1)
    state.cancelNew = false
    oldReceiver.deliver([message('/new')])
    await vi.waitFor(() => expect(replies().some(text => text.includes('桥接已恢复'))).toBe(true), { timeout: 10000 })
    expect(errors).toEqual([])
    expect(runtime.session.sessionId).not.toBe(oldId)
    expect(runtime.session.messages).toEqual([])
    expect(runtime.session.systemPrompt).toContain('Disposable integration instructions.')
    expect(runtime.session.systemPrompt).toContain('Disposable project instructions.')
    expect(runtime.session.model?.id).toBe('mock')
    expect(await readFile(oldFile, 'utf8')).toBe(oldHistory)
    expect(modelRequests).toEqual([])
    expect(oldReceiver.dispose).toHaveBeenCalled()
    expect(receiver()).not.toBe(oldReceiver)
    expect(state.clients).toHaveLength(2)
    expect(receiver().sendText).toHaveBeenCalledWith('bound-user', expect.stringContaining('桥接已恢复'))
    expect(['SIGINT', 'SIGTERM', 'beforeExit'].map(name => process.listenerCount(name))).toEqual(listenerCounts)

    receiver().deliver([message('fresh question')])
    await vi.waitFor(() => expect(replies()).toContain('fresh reply'), { timeout: 10000 })
    expect(JSON.stringify(modelRequests)).not.toContain('old-context-marker')
    expect(JSON.stringify(modelRequests)).not.toContain('/wechat-new-session')
    expect(JSON.stringify(runtime.session.messages)).toContain('fresh question')
    expect(state.owner).not.toBeNull()

    const firstNewId = runtime.session.sessionId
    receiver().deliver([message('/new')])
    await vi.waitFor(() => expect(runtime!.session.sessionId).not.toBe(firstNewId), { timeout: 10000 })
    await vi.waitFor(() => expect(replies().filter(text => text.includes('桥接已恢复'))).toHaveLength(2))
    expect(runtime.session.messages).toEqual([])
    expect(errors).toEqual([])
    expect(['SIGINT', 'SIGTERM', 'beforeExit'].map(name => process.listenerCount(name))).toEqual(listenerCounts)
  }, 30000)
})
