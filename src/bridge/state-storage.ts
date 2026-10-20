import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const STATE_DIR = path.join(os.homedir(), '.pi', 'agent', 'wechat-assistant')
export function getStateDir(): string { return STATE_DIR }

export async function ensureStateDir(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 })
  // mkdir 的 mode 不会修改已有目录；尽力收紧旧安装的状态目录权限。
  await fs.chmod(STATE_DIR, 0o700).catch(() => {})
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    // 旧版本创建的文件可能权限较宽；读取时顺手收紧，不因 chmod 失败影响启动。
    await fs.chmod(filePath, 0o600).catch(() => {})
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureStateDir()
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  // writeFile 的 mode 不会修改已有文件。
  await fs.chmod(filePath, 0o600)
}

export async function deleteFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch {
    // ignore
  }
}
