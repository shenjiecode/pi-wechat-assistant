<p align="center">
  <img src="https://raw.githubusercontent.com/shenjiecode/pi-wechat-assistant/main/assets/logo.png" alt="pi-wechat-assistant logo" width="112" height="112">
</p>

<h1 align="center">pi-wechat-assistant</h1>

<p align="center">在微信里继续你的 pi 对话。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-wechat-assistant"><img src="https://img.shields.io/npm/v/pi-wechat-assistant?color=blue" alt="npm version"></a>
  <a href="https://github.com/shenjiecode/pi-wechat-assistant/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20.3-339933" alt="Node.js >=20.3">
</p>

<p align="center">
  <strong>中文</strong> · <a href="https://github.com/shenjiecode/pi-wechat-assistant/blob/main/README.md">English</a> ·
  <a href="https://www.npmjs.com/package/pi-wechat-assistant">npm</a> ·
  <a href="https://pi.dev/packages/pi-wechat-assistant">pi.dev</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/shenjiecode/pi-wechat-assistant/main/assets/cover.png" alt="微信连接 pi 终端" width="640">
</p>

[pi](https://github.com/earendil-works/pi) 的微信扩展：将一个微信用户连接到一个运行中的 pi 会话，在手机上发任务、看回复、传文件。

### 支持什么

- **双向同步**：微信消息进入 pi；可选同步新的电脑端输入和 AI 回复（默认关闭），不重发历史记录。
- **文字、图片和文件**：支持引用文字及微信语音转写；图片交给模型分析，文件保存到项目的 `.pi-wechat-files/`。AI 可将项目内文件和图片发回微信。
- **适合微信阅读**：保留完整链接、代码分块发送；需要选择时用文字提问，回复规则可自定义。
- **双会话交接**：在新会话确认后（或将持锁接管方式设为自动、跳过确认），等待旧桥接停止再接管，不中止旧会话的 AI 任务。
- **按需启用**：只在桥接启动后提供发送工具；停止后禁止新发送。

### 安装与开始使用

需要 Node.js **≥20.3.0**，以及已配置可用模型的 pi。

```bash
pi install npm:pi-wechat-assistant
```

重新打开 pi，在 TUI 输入：

```text
/wechat login
```

用微信扫码确认，登录成功后会自动尝试启动桥接。随后从微信发送消息即可。登录凭据会保存，以后通常只需 `/wechat start`。

也可安装 GitHub 主分支：

```bash
pi install git:github.com/shenjiecode/pi-wechat-assistant
```

### 常用操作

| 命令 | 用途 |
| --- | --- |
| `/wechat start` / `/wechat stop` | 启动 / 停止本会话的桥接 |
| `/wechat status` | 查看运行状态、锁归属和发送结果 |
| `/wechat config` | 配置窗口：常用开关、图片预设、回复模板 |
| `/wechat config ack off` | 关闭收件回执通知；用 `on` 开启，也可在配置窗口自定义文字内容 |
| `/wechat config bidirectional off` | 只回传微信任务回复；用 `on` 恢复双向同步 |
| `/wechat prompt show` / `init` / `reload` | 查看 / 导出 / 重载回复模板 |
| `/wechat login --force` | 登录凭据失效时重新扫码 |
| `/wechat logout` | 停止桥接并清除本地登录凭据 |

微信里输入 `/help` 查看远程命令。常用的有 `/status`、`/model` 和 `/stop`；其中 **微信 `/stop` 取消当前 AI 任务，电脑端 `/wechat stop` 停止桥接**。

配置及可选回复模板位于 `~/.pi/agent/wechat-assistant/`。运行期间加入固定的条件式微信系统规则，微信消息本身只附 `[微信]` 来源标识。

- [配置项、默认值与生效范围](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/settings.zh.md)
- [回复模板、消息格式与工具兼容](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/wechat-source.zh.md)
- [完整文档目录](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/README.zh.md)

### 使用边界

- 电脑上的 pi 必须保持运行；同一份本地账号状态只允许一个桥接持锁。自动交接需要双方都使用 0.4.4 或更新版本，旧版需手动停止。
- **保存登录不等于始终可以主动发消息。** 持续遇到 `ret=-2` 时，先从微信发一条消息，再重试；`/wechat status` 可查看最近发送结果。
- 纯文件消息只保存并确认收到；需要 AI 处理时再发文字说明。电脑端输入的图片仅同步数量提示，不自动转发图片本体。暂不支持视频。
- 仅接收扫码绑定用户的消息。微信 `/tools` 默认关闭；发送工具只允许项目目录内的文件，单个发送文件上限 50 MB。

已完成 Windows 开发测试及 Linux 双会话交接验证；API 类型兼容检查覆盖 pi 0.73.1、0.78.0、0.84.0、0.84.4、0.99.2、1.1.0、1.2.0。

### 参与开发

开发环境、检查命令与提交约定见[贡献指南](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/CONTRIBUTING.zh.md)；目录职责与运行流程见[架构说明](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/architecture.zh.md)。安全问题请参阅[安全说明](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/SECURITY.zh.md)。

---

[MIT License](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/LICENSE) · [更新记录](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/CHANGELOG.md)
