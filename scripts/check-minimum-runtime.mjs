import assert from 'node:assert/strict'
import extension from '../dist/index.js'
import { MessageQueue } from '../dist/src/bridge/queue.js'

// No session_start: do not read user credentials, acquire locks, or use WeChat.
const commands = new Map()
const events = new Map()
extension({
  registerCommand(name, command) { commands.set(name, command) },
  on(name, handler) { events.set(name, handler); return () => {} },
})
assert.equal(typeof commands.get('wechat')?.handler, 'function')
assert.equal(typeof events.get('session_start'), 'function')
assert.equal(typeof events.get('session_shutdown'), 'function')

const submissions = []
const receipts = []
const client = {
  async sendText(user, text) { receipts.push({ user, text }) },
  async startTyping() {},
  async stopTyping() {},
}
const queue = new MessageQueue(
  () => client, () => true, () => true, () => undefined,
  () => process.cwd(), (content) => submissions.push(content), () => {},
)
try {
  queue.enqueue({
    messageId: 'smoke', userId: 'test-user', text: 'hello', type: 'text',
    imageUrls: [], raw: {}, contextToken: 'test-token', timestamp: new Date(),
  })
  // Let the asynchronous drain and receipt finish without network activity.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(submissions.length, 1)
  assert.match(submissions[0], /hello/)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].user, 'test-user')
} finally {
  queue.reset()
}
console.log(`Runtime smoke check passed on ${process.version}; real Pi/WeChat delivery is not exercised.`)
