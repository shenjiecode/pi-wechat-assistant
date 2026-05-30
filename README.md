# pi-wechat-assistant

让你的微信成为 pi TUI 的移动端分身。

通过微信 iLink Bot 协议桥接，在手机上就能远程与电脑上运行着的 pi TUI 交互。连接后，微信和 TUI 共享同一个 pi 会话，两端都能操作、都能看到交互内容。

## 特性

- 📱 **移动端分身** — 微信 = 远程 TUI，随时随地操控 pi
- 🔐 **扫码登录** — 终端直接渲染二维码，扫一下就连接
- 💬 **双向同步** — TUI 和微信两端都能输入和看到回复
- 🔄 **消息队列** — 多条消息排队逐条处理，不会丢失
- ✅ **消息回执** — 收到消息立即回复"处理中"
- ⌨️ **输入态** — 微信端显示"正在输入..."
- 📝 **智能分段** — 利用 Markdown 结构智能分段 + 过滤语法，手机端阅读体验好
- 🗣️ **语音支持** — 支持语音消息（使用微信自带语音转文字）
- 🔒 **排他锁** — 同一时间只有一个 TUI 实例能连接微信
- 📊 **状态栏** — pi TUI 底部显示微信连接状态

## 快速开始

### 安装

```bash
pi install npm:pi-wechat-assistant
```

或从 GitHub 安装：

```bash
pi install git:github.com/sj-over9000/pi-wechat-assistant
```

### 使用

在 pi TUI 中执行：

```
/wechat-login        # 扫码登录
/wechat-start        # 启动桥接（本 TUI 成为微信分身）
```

然后在微信中找到机器人发消息即可。

## 命令

| 命令 | 说明 |
|------|------|
| `/wechat-login` | 扫码登录（加 `--force` 强制重新扫码） |
| `/wechat-start` | 启动微信桥接 |
| `/wechat-stop` | 停止微信桥接 |
| `/wechat-status` | 查看连接状态 |
| `/wechat-logout` | 清除凭证并停止桥接 |
| `/wechat-autostart` | 开关自动启动（默认关闭） |

## 支持的消息类型

| 类型 | 支持情况 |
|------|----------|
| 文字 | ✅ 完整支持 |
| 语音 | ✅ 使用微信自带语音转文字 |
| 引用回复 | ✅ 自动拼接引用内容 |
| 图片 | ❌ 回复"暂不支持" |
| 文件 | ❌ 回复"暂不支持" |
| 视频 | ❌ 回复"暂不支持" |

## 工作原理

```
┌─────────────┐     ┌──────────────────┐     ┌──────────┐
│  微信手机端  │ ←→  │  pi TUI session  │ ←→  │  AI 模型  │
│  (移动分身)  │     │  (共享会话)       │     │          │
└─────────────┘     └──────────────────┘     └──────────┘
```

- 微信消息通过 iLink Bot API 长轮询获取
- 消息注入当前 pi 会话，agent 处理完成后回复发回微信
- TUI 端正常操作不受影响，两端的交互都在同一个会话中
- 连接是显式的：只有执行了 `/wechat-start` 的 TUI 才会连接微信

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PI_WECHAT_DEBUG` | 设为 `1` 开启调试日志 | 关闭 |

### 存储位置

```
~/.pi/agent/wechat-assistant/
├── credentials.json   # 登录凭证（权限 600）
├── config.json        # 配置（自动启动等）
└── session.lock       # 排他锁文件
```

### 自动启动

执行 `/wechat-autostart` 开启后，pi 会话启动时如果已有有效凭证，会自动连接微信。

## 常见问题

### 为什么机器人没回复？

1. 检查 `/wechat-start` 是否已执行
2. 检查 `/wechat-status` 查看连接状态
3. 如果 Session 过期，重新执行 `/wechat-login`

### 提示"微信已被其他 pi 实例占用"

另一个 pi TUI 实例正在使用微信桥接。请先在那个实例中执行 `/wechat-stop`，或关闭那个实例。

### 二维码扫不了？

终端窗口太小可能导致二维码显示不全，尝试放大终端窗口或缩小字体。也可以使用通知中显示的二维码链接在浏览器中打开。

## 开发

```bash
git clone https://github.com/sj-over9000/pi-wechat-assistant.git
cd pi-wechat-assistant
npm install

# 临时测试
pi -e ./src/index.ts
```

## License

MIT
