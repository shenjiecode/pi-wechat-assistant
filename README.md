<p align="center">
  <img src="https://raw.githubusercontent.com/shenjiecode/pi-wechat-assistant/main/assets/logo.png" alt="pi-wechat-assistant logo" width="112" height="112">
</p>

<h1 align="center">pi-wechat-assistant</h1>

<p align="center">Continue your pi conversation from WeChat.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-wechat-assistant"><img src="https://img.shields.io/npm/v/pi-wechat-assistant?color=blue" alt="npm version"></a>
  <a href="https://github.com/shenjiecode/pi-wechat-assistant/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20.3-339933" alt="Node.js >=20.3">
</p>

<p align="center">
  <a href="https://github.com/shenjiecode/pi-wechat-assistant/blob/main/README.zh.md">中文</a> · <strong>English</strong> ·
  <a href="https://www.npmjs.com/package/pi-wechat-assistant">npm</a> ·
  <a href="https://pi.dev/packages/pi-wechat-assistant">pi.dev</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/shenjiecode/pi-wechat-assistant/main/assets/cover.png" alt="WeChat connected to pi" width="640">
</p>

A WeChat extension for [pi](https://github.com/earendil-works/pi): send tasks, read replies, and exchange files with a running pi session from your phone.

### Features

- **Text, images, and files:** send tasks and images to pi; receive replies and project files in WeChat.
- **Readable replies:** full links, code chunks, and customizable reply rules and receipt notifications.
- **Optional desktop sync:** mirror new desktop input and AI replies, without replaying history.
- **Session handoff:** move the active WeChat connection between pi sessions.

### Install and start

Requires Node.js **≥20.3.0**, a working pi model configuration, and the Node.js version required by your installed pi host.

Run in your system terminal:

```bash
pi install npm:pi-wechat-assistant
```

Reopen pi, then run in its terminal UI:

```text
/wechat login
```

Scan and confirm in WeChat. Login attempts to start the bridge automatically; send a message and check that an AI reply returns. Later sessions normally need only `/wechat start`.

### Everyday use

| In pi | Purpose |
| --- | --- |
| `/wechat start` / `/wechat stop` | Start / stop this session’s bridge |
| `/wechat status` | Check running state and send results |
| `/wechat config` | Configure mirroring, receipts, images, and reply templates |

In WeChat, send `/help` for remote commands. **WeChat `/stop` cancels the AI task; pi `/wechat stop` stops the bridge.**

Keep the computer and pi running. Only the bound WeChat user is accepted, and one bridge can own the shared local account state at a time. Desktop mirroring is off by default. File-only messages are saved; follow with text to request processing. See the FAQ for sending limits and troubleshooting.

### Guides

- [Quick start](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/quickstart.md): setup and your first verified reply.
- [Upgrading](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/upgrading.md): update, restart, and preserve settings.
- [FAQ and troubleshooting](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.md): login, missing replies, session handoff, and files.
- [Settings](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/settings.md) · [All documentation](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/README.md)

### Contributing

See [Contributing](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/CONTRIBUTING.md) for setup and checks, [Architecture](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/architecture.md) for code organization, and [Security](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/SECURITY.md) for sensitive reports.

---

[MIT License](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/LICENSE) · [Changelog](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/CHANGELOG.md)
