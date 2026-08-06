// ============================================================================
// 测试: 安全边界纯函数
// ============================================================================

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  areRemoteToolsAllowed,
  getAssistantTextFromMessageEnd,
  isAuthorizedWeChatSender,
  isDuplicateMessageId,
  MAX_RECENT_MESSAGE_IDS,
  recordProcessedMessageId,
  validateProjectFilePath,
} from '../src/security.js'

describe('微信用户绑定', () => {
  it('only accepts the user ID from QR-login credentials', () => {
    expect(isAuthorizedWeChatSender('bound-user', 'bound-user')).toBe(true)
    expect(isAuthorizedWeChatSender('other-user', 'bound-user')).toBe(false)
    expect(isAuthorizedWeChatSender(undefined, 'bound-user')).toBe(false)
    expect(isAuthorizedWeChatSender('bound-user', '')).toBe(false)
  })
})

describe('消息重放窗口', () => {
  it('identifies processed message IDs and caps the retained IDs at 500', () => {
    let ids: string[] = []
    for (let i = 0; i < MAX_RECENT_MESSAGE_IDS + 5; i++) ids = recordProcessedMessageId(ids, `message-${i}`)

    expect(ids).toHaveLength(MAX_RECENT_MESSAGE_IDS)
    expect(ids[0]).toBe('message-5')
    expect(ids.at(-1)).toBe(`message-${MAX_RECENT_MESSAGE_IDS + 4}`)
    expect(isDuplicateMessageId(new Set(ids), 'message-5')).toBe(true)
    expect(isDuplicateMessageId(new Set(ids), 'message-0')).toBe(false)
  })
})

describe('current-turn assistant reply selection', () => {
  it('uses only message_end messages, supports multiple replies and skips tool calls', () => {
    const restoredHistory = [
      { role: 'assistant', content: 'old reply must not be sent again' },
      { role: 'assistant', content: 'another old reply' },
    ]
    const currentMessageEndEvents = [
      { role: 'assistant', content: [{ type: 'toolCall', name: 'write_file' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'new reply one' }, { type: 'toolCall', name: 'send_file' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'new reply two' }] },
    ]

    const sent = currentMessageEndEvents.map(getAssistantTextFromMessageEnd).filter((text): text is string => text !== null)
    expect(sent).toEqual(['new reply one', 'new reply two'])
    expect(restoredHistory.map(getAssistantTextFromMessageEnd)).toEqual([
      'old reply must not be sent again',
      'another old reply',
    ])
    // The bridge intentionally never passes restoredHistory to the sender; only the event list above is eligible.
  })
})

describe('send-to-WeChat path validation', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('allows a normal project file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-wechat-security-'))
    tempDirs.push(root)
    const project = path.join(root, 'project')
    await mkdir(project)
    await writeFile(path.join(project, 'report.txt'), 'safe')

    const result = await validateProjectFilePath('report.txt', project)
    expect(result.allowed).toBe(true)
    if (result.allowed) expect(path.basename(result.resolvedPath)).toBe('report.txt')
  })

  it('rejects a file outside the project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-wechat-security-'))
    tempDirs.push(root)
    const project = path.join(root, 'project')
    const outside = path.join(root, 'secret.txt')
    await mkdir(project)
    await writeFile(outside, 'secret')

    await expect(validateProjectFilePath(outside, project)).resolves.toMatchObject({ allowed: false })
  })

  it('rejects an in-project symlink that points outside the project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-wechat-security-'))
    tempDirs.push(root)
    const project = path.join(root, 'project')
    const outside = path.join(root, 'secret.txt')
    await mkdir(project)
    await writeFile(outside, 'secret')
    await symlink(outside, path.join(project, 'linked-secret.txt'))

    await expect(validateProjectFilePath('linked-secret.txt', project)).resolves.toMatchObject({ allowed: false })
  })
})

describe('remote /tools opt-in', () => {
  it('requires Ubuntu, Linux, and an explicit environment opt-in', () => {
    expect(areRemoteToolsAllowed({ platform: 'linux', osRelease: 'NAME="Ubuntu"', env: { PI_WECHAT_ALLOW_REMOTE_TOOLS: '1' } })).toBe(true)
    expect(areRemoteToolsAllowed({ platform: 'darwin', osRelease: 'NAME="Ubuntu"', env: { PI_WECHAT_ALLOW_REMOTE_TOOLS: '1' } })).toBe(false)
    expect(areRemoteToolsAllowed({ platform: 'linux', osRelease: 'NAME="Debian"', env: { PI_WECHAT_ALLOW_REMOTE_TOOLS: '1' } })).toBe(false)
    expect(areRemoteToolsAllowed({ platform: 'linux', osRelease: 'NAME="Ubuntu"', env: {} })).toBe(false)
  })
})
