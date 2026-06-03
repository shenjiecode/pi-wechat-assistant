# pi-wechat-assistant

把微信变成个人 pi TUI 的移动端入口。

这个扩展面向 **单个微信用户 ↔ 单个 pi TUI session** 的远程交互场景：你在微信里发文字、语音或图片，消息会进入当前 pi 会话；AI 的回复会发回微信。你在 TUI 里主动发起的消息，也会同步一条简短提示到微信，并把 AI 回复发回微信。

## 特性

- 📱 **个人微信端助手**：适合离开电脑后用微信远程继续操作同一个 pi 会话
- 🔐 **扫码登录**：终端显示二维码，微信扫码授权
- 🔄 **双向同步**：微信发起的消息在 TUI 可见；TUI 发起的消息和回复也会同步到微信
- 💬 **消息队列**：微信连续发送多条消息时会合并/排队处理
- 🖼️ **图片支持**：支持图片下载、解密、发送给模型分析
- 🧩 **图片批次合并**：连续发送多张图片时只回执一次，并在短暂等待后合并处理；如果补充文字则立即处理
- 🗣️ **语音支持**：使用微信侧语音转文字结果
- 🔒 **排他锁**：同一时间只有一个 TUI session 连接微信
- 📊 **状态栏**：TUI 底部显示微信连接状态和待处理消息数

## 快速开始

### 安装

```bash
pi install npm:pi-wechat-assistant
```

或从 GitHub 安装：

```bash
pi install git:github.com/shenjiecode/pi-wechat-assistant
```

### 使用

在 pi TUI 中执行：

```text
/wechat login
/wechat start
```

然后在微信中找到机器人，直接发消息即可。

## TUI 命令

所有命令统一使用 `/wechat` 加子命令：

| 命令 | 说明 |
| --- | --- |
| `/wechat login` | 扫码登录 |
| `/wechat login --force` | 强制重新扫码 |
| `/wechat start` | 启动微信桥接 |
| `/wechat stop` | 停止微信桥接并释放锁 |
| `/wechat status` | 查看连接状态和配置 |
| `/wechat config` | 查看图片相关配置 |
| `/wechat config image-wait <ms>` | 设置图片批量等待时间，默认 `8000` |
| `/wechat config image-max <MB>` | 设置单张图片大小上限，默认 `50` |
| `/wechat autostart` | 开关自动启动 |
| `/wechat logout` | 清除凭证并停止桥接 |

## 微信远程命令

微信里直接发文字/语音/图片就是正常对话。

常用远程命令：

| 命令 | 说明 |
| --- | --- |
| `/status` | 查看当前模型、上下文、队列和图片配置 |
| `/stop` | 停止当前生成 |
| `/model` | 查看可用模型 |
| `/model <名称>` | 切换模型 |
| `/config` | 查看图片配置 |
| `/help` | 显示帮助 |

仍保留高级命令：`/thinking`、`/tools`、`/compact`。

## 支持的消息类型

| 类型 | 支持情况 |
| --- | --- |
| 文字 | ✅ 支持 |
| 语音 | ✅ 使用微信语音转文字结果 |
| 图片 | ✅ 下载后发送给模型分析 |
| 引用回复 | ✅ 拼接引用文本 |
| 文件 | ❌ 暂不支持 |
| 视频 | ❌ 暂不支持 |

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PI_WECHAT_DEBUG` | 设为 `1` 开启调试日志 | 关闭 |
| `PI_WECHAT_DEBUG_FILE` | 调试日志路径 | `~/.pi/agent/wechat-assistant/debug.log` |
| `PI_WECHAT_IMAGE_BATCH_WAIT_MS` | 图片批量等待时间 | `8000` |
| `PI_WECHAT_IMAGE_MAX_BYTES` | 单张图片大小上限 | `52428800` |

### 配置文件

```text
~/.pi/agent/wechat-assistant/
├── credentials.json   # 登录凭证，权限 600
├── config.json        # 自动启动、图片限制等配置
└── session.lock       # 排他锁文件
```

`config.json` 示例：

```json
{
  "autoStart": true,
  "imageBatchWaitMs": 8000,
  "imageMaxBytes": 52428800
}
```

也可以用 TUI 命令修改：

```text
/wechat config image-wait 5000
/wechat config image-max 80
```

## 工作方式

```text
微信手机端  ⇄  pi TUI session  ⇄  AI 模型/工具
```

- 微信消息通过 iLink Bot API 长轮询获取
- 收到的微信消息通过 `pi.sendUserMessage()` 注入当前 TUI 会话，所以 TUI 侧能看到
- TUI 侧主动输入普通消息时，微信侧会收到一条“💻 TUI 发送：...”预览
- agent 结束后，最终 assistant 回复会按适合微信阅读的长度分段发回
- 连接是显式的：只有执行 `/wechat-start` 的 TUI session 会接管微信桥接

## 常见问题

### 微信没有回复？

1. 确认执行过 `/wechat start`
2. 执行 `/wechat status` 查看状态
3. 如果提示 session 过期，执行 `/wechat login --force` 重新扫码

### 提示“微信已被其他 pi 实例占用”？

说明另一个 TUI session 持有锁。请在那个 session 执行 `/wechat stop`，或确认进程已退出后再启动。

### 图片为什么没有马上处理？

为了支持“连续发多张图再补一句描述”的使用方式，图片会默认等待 8 秒进行合并。收到第一张图片会立即回执一次；如果期间你补充文字，会立即处理。

### 调试日志在哪里？

默认不写日志。设置 `PI_WECHAT_DEBUG=1` 后写入：

```text
~/.pi/agent/wechat-assistant/debug.log
```

## 开发

```bash
git clone https://github.com/shenjiecode/pi-wechat-assistant.git
cd pi-wechat-assistant
npm install
npm run typecheck

# 临时测试
pi -e ./index.ts
```

## License

MIT
