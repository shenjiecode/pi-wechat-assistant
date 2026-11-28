// ============================================================================
// Shared E2E bootstrap: isolated HOME, fake servers, real Pi SDK runtime.
// No vitest imports — this module is also loaded by tests/e2e/pi-worker.ts
// inside spawned child processes.
// ============================================================================

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
} from '@earendil-works/pi-coding-agent'
import extension from '../../index.js'
import { WECHAT_FILES_SUBDIR } from '../../src/shared/constants.js'
import { REDIRECT_BASE, FakeIlinkServer, installNetworkRedirect } from './fake-ilink-server.js'
import type { FakeLlmServer } from './fake-llm-server.js'

export { WECHAT_FILES_SUBDIR, REDIRECT_BASE }

export const PROVIDER_ID = 'fake-openai'
export const MODEL_ID = 'mock-model'
export const TEST_TOKEN = 'test-token'
export const ACCOUNT_ID = 'bot-account'
export const BOUND_USER_ID = 'bound-user'

export interface RuntimeHandle {
  runtime: AgentSessionRuntime
  sessionFile: string | null
  notifies: Array<{ message: string; level: string }>
  errors: unknown[]
  selectCalls: Array<{ title: string; options: string[] }>
  /** Programmed answers (shifted in order) for extension ui.select dialogs. */
  selectAnswers: string[]
}

export interface DeviceEnvironment {
  tempHome: string
  projectDir: string
  wechatFilesDir: string
  stateDir: string
  fakeIlink: FakeIlinkServer

  /** Read a file relative to the isolated state dir. */
  statePath(...segments: string[]): string
  projectPath(...segments: string[]): string
}

export interface ManagedDeviceEnvironment extends DeviceEnvironment {
  /** Fake LLM server when one was started via startFakeLlm(). */
  fakeLlm: FakeLlmServer | null
  redirect: ReturnType<typeof installNetworkRedirect>
  oldHome: string | undefined
  oldUserProfile: string | undefined
}

export interface CreateEnvironmentOptions {
  config?: Record<string, unknown>
  credentials?: { token?: string; baseUrl?: string; accountId?: string; userId?: string }
  projectFiles?: Record<string, string>
  /** Skip seeding credentials.json (fresh-device QR login scenario). */
  withoutCredentials?: boolean
}

/**
 * Isolate every piece of persisted state under a temp HOME (os.homedir() is
 * resolved dynamically by src/bridge/state-storage.ts), start the fake iLink
 * server and install the fetch redirect. Call startFakeLlm() for the model.
 */
export async function createDeviceEnvironment(options: CreateEnvironmentOptions = {}): Promise<ManagedDeviceEnvironment> {
  const cache = path.join(process.cwd(), 'node_modules', '.cache')
  await fs.mkdir(cache, { recursive: true })
  const tempHome = await fs.mkdtemp(path.join(cache, 'wechat-e2e-home-'))
  const oldHome = process.env.HOME
  const oldUserProfile = process.env.USERPROFILE
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome

  const projectDir = path.join(tempHome, 'project')
  await fs.mkdir(projectDir, { recursive: true })
  for (const [name, content] of Object.entries(options.projectFiles ?? {})) {
    await fs.writeFile(path.join(projectDir, name), content)
  }

  const stateDir = path.join(tempHome, '.pi', 'agent', 'wechat-assistant')
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })

  const credentials = options.credentials ?? {}
  if (!options.withoutCredentials) {
    await fs.writeFile(path.join(stateDir, 'credentials.json'), JSON.stringify({
      token: credentials.token ?? TEST_TOKEN,
      baseUrl: credentials.baseUrl ?? REDIRECT_BASE,
      accountId: credentials.accountId ?? ACCOUNT_ID,
      userId: credentials.userId ?? BOUND_USER_ID,
      savedAt: new Date().toISOString(),
    }, null, 2))
  }

  if (options.config) {
    await fs.writeFile(path.join(stateDir, 'config.json'), JSON.stringify(options.config, null, 2))
  }

  const fakeIlink = new FakeIlinkServer({
    expectedToken: credentials.token ?? TEST_TOKEN,
    boundUserId: credentials.userId ?? BOUND_USER_ID,
    accountId: credentials.accountId ?? ACCOUNT_ID,
  })
  await fakeIlink.start()
  const redirect = installNetworkRedirect(fakeIlink.baseUrl)

  return {
    tempHome,
    projectDir,
    wechatFilesDir: path.join(projectDir, WECHAT_FILES_SUBDIR),
    stateDir,
    fakeIlink,
    fakeLlm: null,
    redirect,
    oldHome,
    oldUserProfile,
    statePath: (...segments: string[]) => path.join(stateDir, ...segments),
    projectPath: (...segments: string[]) => path.join(projectDir, ...segments),
  }
}

/** Start the fake LLM server and remember it on the environment for disposal. */
export async function startFakeLlm(env: ManagedDeviceEnvironment, fakeLlm: FakeLlmServer): Promise<FakeLlmServer> {
  await fakeLlm.start()
  env.fakeLlm = fakeLlm
  return fakeLlm
}

export async function disposeDeviceEnvironment(env: ManagedDeviceEnvironment): Promise<void> {
  env.redirect.restore()
  await env.fakeIlink.close()
  if (env.fakeLlm) await env.fakeLlm.close()
  if (env.oldHome === undefined) delete process.env.HOME
  else process.env.HOME = env.oldHome
  if (env.oldUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = env.oldUserProfile
  await fs.rm(env.tempHome, { recursive: true, force: true }).catch(() => {})
}

// --- 真实 Pi SDK 运行时 ---

export interface StartRuntimeOptions {
  modelInput?: Array<'text' | 'image'>
  /** Pre-seed persisted session history before the first session binds. */
  preseedHistory?: Array<{ role: 'user' | 'assistant'; text: string }>
}

export async function startPiRuntime(
  env: DeviceEnvironment,
  fakeLlmBaseUrl: string,
  options: StartRuntimeOptions = {},
): Promise<RuntimeHandle> {
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(env.tempHome, 'auth.json'),
    modelsPath: null,
    modelsStorePath: path.join(env.tempHome, 'models.json'),
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
  modelRuntime.registerProvider(PROVIDER_ID, {
    baseUrl: fakeLlmBaseUrl,
    apiKey: 'test-only',
    api: 'openai-completions',
    models: [{
      id: MODEL_ID,
      name: 'Mock Model',
      reasoning: false,
      input: options.modelInput ?? ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 4_096,
    }],
  })

  const sessionsDir = path.join(env.projectDir, 'sessions')
  const manager = SessionManager.create(env.projectDir, sessionsDir)
  for (const entry of options.preseedHistory ?? []) {
    manager.appendMessage(entry.role === 'assistant'
      ? {
          role: 'assistant',
          content: [{ type: 'text' as const, text: entry.text }],
          api: 'openai-completions' as const,
          provider: PROVIDER_ID,
          model: MODEL_ID,
          stopReason: 'stop' as const,
          timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } as never
      : { role: 'user', content: entry.text, timestamp: Date.now() } as never)
  }

  const notifies: RuntimeHandle['notifies'] = []
  const errors: unknown[] = []
  const selectCalls: RuntimeHandle['selectCalls'] = []
  const selectAnswers: string[] = []

  const create = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, images: { autoResize: false } }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [extension as never],
        systemPrompt: 'Device E2E base system prompt.',
        agentsFilesOverride: () => ({ agentsFiles: [] }),
      },
    })
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: modelRuntime.getModel(PROVIDER_ID, MODEL_ID)!,
      // No built-in tools; the extension registers send_file_to_wechat / send_image_to_wechat.
      noTools: true,
    })
    return { ...result, services, diagnostics: [] }
  }

  const runtime = await createAgentSessionRuntime(create, {
    cwd: env.projectDir,
    agentDir: path.join(env.tempHome, 'agent-dir'),
    sessionManager: manager,
  })

  const uiContext = {
    select: async (title: string, optionsList: string[]) => {
      selectCalls.push({ title, options: optionsList })
      return selectAnswers.shift()
    },
    notify: (message: string, level: string) => { notifies.push({ message, level }) },
    setStatus: () => {},
    onTerminalInput: () => () => {},
    confirm: async () => true,
    input: async () => undefined,
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async (_factory: unknown) => undefined,
  }

  const bind = async (session: any) => session.bindExtensions({
    uiContext,
    commandContextActions: { newSession: (options: any) => runtime.newSession(options) },
    onError: (error: unknown) => { errors.push(error) },
  })
  runtime.setRebindSession(bind)
  await bind(runtime.session)

  return {
    runtime,
    sessionFile: runtime.session.sessionManager.getSessionFile() ?? null,
    notifies,
    errors,
    selectCalls,
    selectAnswers,
  }
}

/** Start the bridge with /wechat start and wait for the server-side notifyStart. */
export async function startBridge(handle: RuntimeHandle, fakeIlink: FakeIlinkServer): Promise<void> {
  const baseline = fakeIlink.notifyStarts.length
  await handle.runtime.session.prompt('/wechat start')
  await waitFor(() => fakeIlink.notifyStarts.length > baseline)
}

export async function stopBridge(handle: RuntimeHandle, fakeIlink: FakeIlinkServer): Promise<void> {
  const baseline = fakeIlink.notifyStops.length
  await handle.runtime.session.prompt('/wechat stop')
  await waitFor(() => fakeIlink.notifyStops.length > baseline)
}

/** Poll until truthy; used where vitest's vi.waitFor is unavailable (worker). */
export async function waitFor<T>(predicate: () => T | undefined | null | false, timeoutMs = 10_000, intervalMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value) return value as T
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}
