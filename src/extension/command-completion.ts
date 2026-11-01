// ============================================================================
// /wechat 参数补全（TUI 中按 Tab 补全子命令与参数）
// ============================================================================
//
// 补全项结构刻意与宿主 AutocompleteItem 一致（value/label/description），
// 这样不依赖任一版本的 pi-tui，也能通过 registerCommand 的
// getArgumentCompletions 交给宿主渲染。
//
// 宿主的 applyCompletion 会把“整个参数文本”替换成 item.value，因此这里的
// value 必须包含已完成的参数前缀，例如 `config ack on` 而不是 `on`。

export interface WechatCompletionItem {
  value: string
  label: string
  description?: string
}

interface SubcommandSpec {
  name: string
  description: string
  /** tokens：子命令之后已完成的参数；token：正在输入的参数。返回 null 表示该位置不补全。 */
  complete?: (tokens: string[], token: string) => WechatCompletionItem[] | null
}

const ON_OFF = ['on', 'off']

interface ConfigKeySpec {
  name: string
  description: string
  /** 可选值；缺省表示自由文本或数字，不参与补全。 */
  values?: string[]
}

const CONFIG_KEYS: ConfigKeySpec[] = [
  { name: 'show', description: '查看配置文本' },
  { name: 'ack', description: '收件回执通知', values: ON_OFF },
  { name: 'ack-text', description: '自定义文字回执（留空恢复默认）' },
  { name: 'image-ack-text', description: '自定义图片回执（留空恢复默认）' },
  { name: 'source', description: '微信来源标识与回复约定', values: ON_OFF },
  { name: 'bidirectional', description: '桌面与微信双向同步', values: ON_OFF },
  { name: 'auto-start', description: '新会话自动启动桥接', values: ON_OFF },
  { name: 'handoff', description: '其他会话持锁时的接管方式', values: ['ask', 'auto'] },
  { name: 'remote-tools', description: '微信端 /tools 修改本机权限', values: ON_OFF },
  { name: 'image-wait', description: '连发图片合并等待（毫秒）' },
  { name: 'image-max', description: '单张图片下载上限（MB）' },
]

const SUBCOMMANDS: SubcommandSpec[] = [
  {
    name: 'login',
    description: '扫码登录',
    complete: (tokens, token) => tokens.includes('--force')
      ? null
      : completeWith('login', tokens, [{ value: '--force', label: '--force', description: '强制重新扫码登录' }], token),
  },
  { name: 'start', description: '启动桥接' },
  { name: 'stop', description: '停止桥接' },
  { name: 'status', description: '查看状态' },
  {
    name: 'prompt',
    description: '微信回复模板：show | init | reload',
    complete: (tokens, token) => tokens.length > 0
      ? null
      : completeWith('prompt', tokens, [
        { value: 'show', label: 'show', description: '查看当前模板及路径' },
        { value: 'init', label: 'init', description: '创建用户模板（不覆盖已有文件）' },
        { value: 'reload', label: 'reload', description: '重新加载模板' },
      ], token),
  },
  {
    name: 'config',
    description: '打开设置窗口或读写单项配置',
    complete: (tokens, token) => completeConfig(tokens, token),
  },
  { name: 'logout', description: '清除凭证并停止桥接' },
  { name: 'autostart', description: '开关自动启动' },
  {
    name: 'remotetools',
    description: '微信端 /tools 开关（默认禁用）',
    complete: (tokens, token) => tokens.length > 0
      ? null
      : completeWith('remotetools', tokens, ON_OFF.map(value => ({ value, label: value })), token),
  },
]

function completeConfig(tokens: string[], token: string): WechatCompletionItem[] | null {
  if (tokens.length === 0) {
    return completeWith('config', tokens,
      CONFIG_KEYS.map(key => ({ value: key.name, label: key.name, description: key.description })), token)
  }
  if (tokens.length > 1) return null
  const key = CONFIG_KEYS.find(candidate => candidate.name === tokens[0])
  if (!key?.values) return null
  return completeWith('config', tokens, key.values.map(value => ({ value, label: value })), token)
}

/**
 * 过滤候选并把已完成的参数补回 value：宿主的 applyCompletion 会用 value
 * 覆盖整段参数文本，只给 `on` 会把 `/wechat config ack` 一起吃掉。
 */
function completeWith(
  subcommand: string,
  tokens: string[],
  items: WechatCompletionItem[],
  token: string,
): WechatCompletionItem[] | null {
  const filtered = pick(items, token)
  if (!filtered) return null
  return filtered.map(item => ({ ...item, value: [subcommand, ...tokens, item.value].join(' ') }))
}

/** 按前缀过滤；空 token 表示列出全部候选；没有候选时返回 null（宿主据此隐藏列表）。 */
function pick<T extends { label: string }>(items: T[], token: string): T[] | null {
  const needle = token.toLowerCase()
  const filtered = needle ? items.filter(item => item.label.toLowerCase().startsWith(needle)) : items
  return filtered.length > 0 ? filtered : null
}

/**
 * /wechat 的参数补全入口，直接交给 `pi.registerCommand` 的
 * `getArgumentCompletions`。`argumentPrefix` 是 `/wechat ` 之后的完整参数文本。
 */
export function getWechatArgumentCompletions(argumentPrefix: string): WechatCompletionItem[] | null {
  const raw = argumentPrefix ?? ''
  const words = raw.trim().split(/\s+/).filter(Boolean)
  // 结尾有空白表示上一个参数已完成，正在输入下一个（可能还是空的）参数。
  const typingNewToken = raw.length === 0 || /\s$/.test(raw)
  const token = typingNewToken ? '' : words[words.length - 1] ?? ''
  const completed = typingNewToken ? words : words.slice(0, -1)

  if (completed.length === 0) {
    return pick(SUBCOMMANDS.map(({ name, description }) => ({ value: name, label: name, description })), token)
  }
  const spec = SUBCOMMANDS.find(candidate => candidate.name === completed[0])
  if (!spec?.complete) return null
  return spec.complete(completed.slice(1), token)
}
