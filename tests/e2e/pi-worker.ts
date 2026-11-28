// ============================================================================
// pi-worker — standalone worker process for multi-process E2E tests.
// Boots the REAL extension (index.ts) inside a REAL Pi SDK runtime over real
// HTTP to the fake iLink + fake LLM servers, then serves a tiny JSON-line
// command protocol on stdin and emits JSON-line events on stdout.
//
// Spawn with: node --import ./tests/e2e/ts-loader.mjs ./tests/e2e/pi-worker.ts
//
// Environment:
//   E2E_ILINK_URL   base URL of the fake iLink server (for fetch redirect)
//   E2E_LLM_URL     OpenAI-compatible base URL of the fake LLM server
//   E2E_PROJECT_DIR working directory (and cwd) for the runtime
// ============================================================================

import * as path from 'node:path'
import { createInterface } from 'node:readline'
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import extension from '../../index.js'
import { installNetworkRedirect } from './fake-ilink-server.js'
import { PROVIDER_ID, MODEL_ID } from './helpers.js'

const fakeIlinkUrl = process.env.E2E_ILINK_URL
const fakeLlmUrl = process.env.E2E_LLM_URL
const projectDir = process.env.E2E_PROJECT_DIR

if (!fakeIlinkUrl || !fakeLlmUrl || !projectDir) {
  console.error('[pi-worker] missing E2E_ILINK_URL / E2E_LLM_URL / E2E_PROJECT_DIR')
  process.exit(1)
}

// Route WeChat + CDN traffic to the fake server over real localhost HTTP.
const redirect = installNetworkRedirect(fakeIlinkUrl)

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ pid: process.pid, ...event }) + '\n')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { /* the extension installs its own exit handlers */ })
}

async function main(): Promise<void> {
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(projectDir, '.auth.json'),
    modelsPath: null,
    modelsStorePath: path.join(projectDir, '.models.json'),
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
  modelRuntime.registerProvider(PROVIDER_ID, {
    baseUrl: fakeLlmUrl,
    apiKey: 'worker-key',
    api: 'openai-completions',
    models: [{
      id: MODEL_ID,
      name: 'Mock Model',
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 4_096,
    }],
  })

  const notifies: Array<{ message: string; level: string }> = []
  const selectCalls: Array<{ title: string; options: string[] }> = []
  let selectAnswerQueue: Array<string | undefined> = []

  const uiContext = {
    select: async (title: string, options: string[]) => {
      selectCalls.push({ title, options })
      emit({ event: 'confirm-requested', title, options })
      const answer = selectAnswerQueue.length > 0 ? selectAnswerQueue.shift() : undefined
      emit({ event: 'select-resolved', answer: answer ?? null })
      return answer
    },
    notify: (message: string, level: string) => {
      notifies.push({ message, level })
      emit({ event: 'notify', message, level })
    },
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
    custom: async () => undefined,
  }

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
        systemPrompt: 'Worker E2E base system prompt.',
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
    cwd: projectDir,
    agentDir: path.join(projectDir, 'agent-dir'),
    sessionManager: SessionManager.create(projectDir, path.join(projectDir, 'sessions')),
  })

  const bind = async (session: any) => session.bindExtensions({
    uiContext,
    commandContextActions: { newSession: (options: any) => runtime.newSession(options) },
    onError: (error: unknown) => emit({ event: 'extension-error', error: String(error) }),
  })
  runtime.setRebindSession(bind)
  await bind(runtime.session)

  emit({ event: 'ready', projectDir })

  const rl = createInterface({ input: process.stdin })
  let shuttingDown = false

  async function runCommand(line: string): Promise<void> {
    let command: any
    try { command = JSON.parse(line) } catch { emit({ event: 'error', message: 'invalid command line' }); return }
    try {
      switch (command.type) {
        case 'set-ui-confirm': {
          selectAnswerQueue = [...selectAnswerQueue, command.answer]
          emit({ event: 'ui-answer-programmed', answer: command.answer ?? null })
          return
        }
        case 'start': {
          await runtime.session.prompt('/wechat start')
          emit({ event: 'started' })
          return
        }
        case 'stop': {
          await runtime.session.prompt('/wechat stop')
          emit({ event: 'stopped' })
          return
        }
        case 'status': {
          await runtime.session.prompt('/wechat status')
          emit({ event: 'status-printed' })
          return
        }
        case 'prompt': {
          await runtime.session.prompt(String(command.text ?? ''))
          emit({ event: 'prompt-done' })
          return
        }
        case 'shutdown': {
          shuttingDown = true
          redirect.restore()
          await runtime.dispose()
          emit({ event: 'bye' })
          process.exit(0)
          return
        }
        default:
          emit({ event: 'error', message: `unknown command ${String(command.type)}` })
      }
    } catch (error) {
      emit({ event: 'command-failed', type: String(command.type), error: error instanceof Error ? error.message : String(error) })
    }
  }

  rl.on('line', line => {
    if (!line.trim() || shuttingDown) return
    void runCommand(line)
  })
  rl.on('close', () => {
    if (!shuttingDown) {
      void runtime.dispose().then(() => process.exit(0)).catch(() => process.exit(1))
    }
  })
}

main().catch(error => {
  emit({ event: 'fatal', error: error instanceof Error ? (error.stack ?? error.message) : String(error) })
  process.exit(1)
})
