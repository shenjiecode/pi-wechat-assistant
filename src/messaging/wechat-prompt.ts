import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getStateDir } from '../bridge/state-storage.js'
const DEFAULT_PROMPT_URL = new URL('../../prompts/wechat.md', import.meta.url)

export function getWechatPromptPath(): string {
  return path.join(getStateDir(), 'wechat-prompt.md')
}

export class WechatPrompt {
  private template: string | null = null
  private origin: '内置模板' | '用户模板' = '内置模板'

  constructor(readonly userPath = getWechatPromptPath()) {}

  get source(): string { return this.origin }

  get rules(): string | null { return this.template }

  async load(): Promise<void> {
    let template: string
    let origin: typeof this.origin
    try {
      template = await fs.readFile(this.userPath, 'utf8')
      origin = '用户模板'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      template = await fs.readFile(DEFAULT_PROMPT_URL, 'utf8')
      origin = '内置模板'
    }
    // A failed reload leaves the last valid system rules intact.
    this.template = template.replace(/^\uFEFF/, '').trim()
    this.origin = origin
  }

  clear(): void { this.template = null }

  async init(): Promise<void> {
    const template = await fs.readFile(DEFAULT_PROMPT_URL, 'utf8')
    await fs.mkdir(path.dirname(this.userPath), { recursive: true, mode: 0o700 })
    await fs.writeFile(this.userPath, template, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  }
}
