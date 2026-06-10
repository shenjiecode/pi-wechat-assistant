<h1 align="center">pi-wechat-assistant</h1>

<p align="center">
  <strong>A personal WeChat assistant for pi TUI</strong><br>
  Turn WeChat into your mobile remote for a single pi session.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-wechat-assistant"><img src="https://img.shields.io/npm/v/pi-wechat-assistant?color=blue" alt="npm"></a>
  <a href="https://github.com/shenjiecode/pi-wechat-assistant/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20.3-339933" alt="Node">
</p>

<p align="center">
  <a href="#english">English</a> · <a href="#中文">中文</a> · <a href="#日本語">日本語</a> · <a href="#한국어">한국어</a>
</p>

---

<a id="english"></a>

## What is this?

**pi-wechat-assistant** is a [pi](https://github.com/earendil-works/pi-coding-agent) extension that connects **one WeChat user** to **one pi TUI session**. It is not a generic chatbot bridge or a multi-session orchestrator — it is a personal assistant that lets you continue your pi conversation from WeChat when you step away from your computer.

Messages you send on WeChat are injected into the active pi session; AI replies are sent back to WeChat. Messages you type in TUI are also previewed on WeChat, keeping both sides in sync.

> **One WeChat user ↔ One pi TUI session.** That's the whole scope.

## Features

- 📱 **Personal assistant** — designed for a single user continuing a single pi session from WeChat
- 🔐 **QR code login** — scan with WeChat to authorize
- 🔄 **Two-way sync** — WeChat ↔ TUI messages are visible on both sides
- 🖼️ **Image support** — download, decrypt, and send images to the model for analysis
- 📁 **File support** — receive files from WeChat, save to project directory; send project files back
- 🗣️ **Voice support** — uses WeChat's built-in speech-to-text
- 💬 **Message queuing & batching** — consecutive messages are merged; multiple images wait for a text supplement
- 🔒 **Exclusive lock** — only one TUI session can hold the WeChat connection at a time
- 📊 **Status bar** — shows WeChat connection status and pending message count in TUI

## Quick Start

### Install

```bash
pi install npm:pi-wechat-assistant
```

Or from GitHub:

```bash
pi install git:github.com/shenjiecode/pi-wechat-assistant
```

### Usage

In the pi TUI:

```
/wechat login
/wechat start
```

Then open WeChat, find the bot, and start messaging.

## TUI Commands

All commands use `/wechat` with a subcommand:

| Command | Description |
| --- | --- |
| `/wechat login` | Scan QR code to log in |
| `/wechat login --force` | Force re-scan |
| `/wechat start` | Start the WeChat connection |
| `/wechat stop` | Stop and release the lock |
| `/wechat status` | Show connection status and config |
| `/wechat config` | View image-related settings |
| `/wechat config image-wait <ms>` | Set batch wait time (default `8000`) |
| `/wechat config image-max <MB>` | Set per-image size limit (default `50`) |
| `/wechat autostart` | Toggle auto-start on session begin |
| `/wechat logout` | Clear credentials and stop |

## WeChat Remote Commands

Send text, voice, or images on WeChat to chat normally. Additional commands:

| Command | Description |
| --- | --- |
| `/status` | Model, context usage, queue, config |
| `/stop` | Abort current generation |
| `/model` | List available models |
| `/model <name>` | Switch model |
| `/config` | View image config |
| `/name <name>` | Set session name |
| `/session` | Show session details |
| `/help` | Show help |

Advanced: `/thinking`, `/tools`, `/compact`.

## Supported Message Types

| Type | Status |
| --- | --- |
| Text | ✅ |
| Voice | ✅ (WeChat speech-to-text) |
| Image | ✅ (downloaded and sent to model) |
| Quote reply | ✅ (quoted text prepended) |
| File | ✅ (saved to project directory) |
| Video | ❌ Not supported |

## Configuration

### Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `PI_WECHAT_DEBUG` | Set to `1` to enable debug logging | Off |
| `PI_WECHAT_DEBUG_FILE` | Debug log file path | `~/.pi/agent/wechat-assistant/debug.log` |
| `PI_WECHAT_IMAGE_BATCH_WAIT_MS` | Batch wait time for images | `8000` |
| `PI_WECHAT_IMAGE_MAX_BYTES` | Per-image size limit | `52428800` (50 MB) |

### Config Files

```
~/.pi/agent/wechat-assistant/
├── credentials.json   # Login credentials (mode 600)
├── config.json        # Auto-start, image limits
└── session.lock       # Exclusive lock file
```

`config.json` example:

```json
{
  "autoStart": true,
  "imageBatchWaitMs": 8000,
  "imageMaxBytes": 52428800
}
```

## Architecture

```
WeChat  ⇄  pi TUI session  ⇄  AI model + tools
```

- WeChat messages are fetched via iLink Bot API long polling
- Incoming messages are injected into the active pi session via `pi.sendUserMessage()`
- When you type in TUI, a preview is sent to WeChat
- AI replies are delivered incrementally (per `message_end`) and finalized on `agent_end`
- Only the TUI session that runs `/wechat start` holds the connection

## FAQ

**WeChat not responding?** Run `/wechat status` to check. If the session expired, run `/wechat login --force`.

**"Already occupied by another pi instance"?** Another TUI session holds the lock. Run `/wechat stop` in that session.

**Why aren't images processed immediately?** Images wait up to 8 seconds for batching — so you can send multiple images and add a text description. The first image gets an acknowledgment immediately; if you send text during the wait, processing starts right away.

## Development

```bash
git clone https://github.com/shenjiecode/pi-wechat-assistant.git
cd pi-wechat-assistant
npm install
npm run typecheck

# Quick test
pi -e ./src/index.ts
```

## Releasing

```bash
npm version patch   # updates package.json, commits, and tags
git push --follow-tags   # triggers CI → npm publish + GitHub Release
```

## License

[MIT](LICENSE)

---
---

<a id="中文"></a>

## 这是什么？

**pi-wechat-assistant** 是一个 [pi](https://github.com/earendil-works/pi-coding-agent) 扩展，将**一个微信用户**连接到**一个 pi TUI 会话**。它不是一个通用聊天机器人桥接，也不是多会话编排器——它是一个个人助手，让你离开电脑后可以通过微信继续和同一个 pi 会话交互。

你在微信里发的消息会被注入当前 pi 会话，AI 的回复会发回微信。你在 TUI 里输入的消息也会在微信端显示预览，保持两边同步。

> **一个微信用户 ↔ 一个 pi TUI 会话。** 这就是全部的定位。

## 特性

- 📱 **个人助手** — 为单用户远程操控单个 pi 会话设计
- 🔐 **扫码登录** — 微信扫码授权
- 🔄 **双向同步** — 微信 ↔ TUI 消息在两边都可见
- 🖼️ **图片支持** — 下载、解密、发送给模型分析
- 📁 **文件支持** — 从微信接收文件保存到项目目录；发送项目文件回微信
- 🗣️ **语音支持** — 使用微信内置语音转文字
- 💬 **消息排队与合并** — 连续消息自动合并；多张图片等待文字补充后一起处理
- 🔒 **排他锁** — 同一时间只有一个 TUI 会话持有微信连接
- 📊 **状态栏** — TUI 底部显示微信连接状态和待处理消息数

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

```
/wechat login
/wechat start
```

然后打开微信找到机器人，直接发消息即可。

## TUI 命令

| 命令 | 说明 |
| --- | --- |
| `/wechat login` | 扫码登录 |
| `/wechat login --force` | 强制重新扫码 |
| `/wechat start` | 启动微信连接 |
| `/wechat stop` | 停止并释放锁 |
| `/wechat status` | 查看连接状态和配置 |
| `/wechat config` | 查看图片相关设置 |
| `/wechat config image-wait <ms>` | 设置图片批量等待时间，默认 `8000` |
| `/wechat config image-max <MB>` | 设置单张图片大小上限，默认 `50` |
| `/wechat autostart` | 开关自动启动 |
| `/wechat logout` | 清除凭证并停止 |

## 微信远程命令

微信里直接发文字/语音/图片就是正常对话。额外命令：

| 命令 | 说明 |
| --- | --- |
| `/status` | 查看模型、上下文、队列、配置 |
| `/stop` | 停止当前生成 |
| `/model` | 查看可用模型 |
| `/model <名称>` | 切换模型 |
| `/config` | 查看图片配置 |
| `/name <名称>` | 设置会话名称 |
| `/session` | 查看会话详情 |
| `/help` | 显示帮助 |

高级命令：`/thinking`、`/tools`、`/compact`。

## 支持的消息类型

| 类型 | 状态 |
| --- | --- |
| 文字 | ✅ |
| 语音 | ✅（微信语音转文字） |
| 图片 | ✅（下载后发送给模型分析） |
| 引用回复 | ✅（拼接引用文本） |
| 文件 | ✅（保存到项目目录） |
| 视频 | ❌ 暂不支持 |

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PI_WECHAT_DEBUG` | 设为 `1` 开启调试日志 | 关闭 |
| `PI_WECHAT_DEBUG_FILE` | 调试日志路径 | `~/.pi/agent/wechat-assistant/debug.log` |
| `PI_WECHAT_IMAGE_BATCH_WAIT_MS` | 图片批量等待时间 | `8000` |
| `PI_WECHAT_IMAGE_MAX_BYTES` | 单张图片大小上限 | `52428800`（50 MB） |

### 配置文件

```
~/.pi/agent/wechat-assistant/
├── credentials.json   # 登录凭证（权限 600）
├── config.json        # 自动启动、图片限制
└── session.lock       # 排他锁文件
```

## 架构

```
微信  ⇄  pi TUI 会话  ⇄  AI 模型 + 工具
```

- 微信消息通过 iLink Bot API 长轮询获取
- 收到的消息通过 `pi.sendUserMessage()` 注入当前 pi 会话
- TUI 输入时微信端会收到预览
- AI 回复增量发送（每条 `message_end` 即发），`agent_end` 时补发遗漏
- 只有执行 `/wechat start` 的 TUI 会话持有连接

## 常见问题

**微信没有回复？** 执行 `/wechat status` 检查状态。Session 过期则执行 `/wechat login --force`。

**提示"已被其他 pi 实例占用"？** 另一个 TUI 会话持有锁，在那个会话执行 `/wechat stop`。

**图片为什么不马上处理？** 图片默认等待 8 秒用于批量合并，方便你连发多张图再补描述。收到第一张图会立即回执，期间发文字则立即开始处理。

## 开发

```bash
git clone https://github.com/shenjiecode/pi-wechat-assistant.git
cd pi-wechat-assistant
npm install
npm run typecheck

# 快速测试
pi -e ./src/index.ts
```

## 发版

```bash
npm version patch   # 更新 package.json、提交、打 tag
git push --follow-tags   # 触发 CI → npm 发布 + GitHub Release
```

## 许可证

[MIT](LICENSE)

---
---

<a id="日本語"></a>

## これは何？

**pi-wechat-assistant** は [pi](https://github.com/earendil-works/pi-coding-agent) の拡張機能で、**1人のWeChatユーザー**を**1つのpi TUIセッション**に接続します。汎用チャットボットブリジでも、マルチセッションオーケストレーターでもありません。パソコンから離れている間、WeChatから同じpiセッションの会話を続けるためのパーソナルアシスタントです。

WeChatで送信したメッセージは現在のpiセッションに注入され、AIの返信がWeChatに送り返されます。TUIで入力したメッセージもWeChat側にプレビューが表示され、両側を同期します。

> **1人のWeChatユーザー ↔ 1つのpi TUIセッション。** それがこのプロジェクトのスコープです。

## 特徴

- 📱 **パーソナルアシスタント** — 単一ユーザーが単一のpiセッションをWeChatからリモート操作するために設計
- 🔐 **QRコードログイン** — WeChatでスキャンして認証
- 🔄 **双方向同期** — WeChat ↔ TUIのメッセージが両側で閲覧可能
- 🖼️ **画像対応** — ダウンロード、復号、モデルに送信して分析
- 📁 **ファイル対応** — WeChatからファイルを受信してプロジェクトディレクトリに保存、プロジェクトファイルをWeChatに送信
- 🗣️ **音声対応** — WeChat内蔵の音声認識を利用
- 💬 **メッセージキューイング＆バッチ処理** — 連続メッセージの自動マージ、複数画像はテキスト補完を待ってから一括処理
- 🔒 **排他ロック** — 同時に1つのTUIセッションのみWeChat接続を保持
- 📊 **ステータスバー** — TUI下部にWeChat接続状態と保留メッセージ数を表示

## クイックスタート

### インストール

```bash
pi install npm:pi-wechat-assistant
```

またはGitHubから：

```bash
pi install git:github.com/shenjiecode/pi-wechat-assistant
```

### 使い方

pi TUIで以下を実行：

```
/wechat login
/wechat start
```

WeChatでボットを見つけて、メッセージを送るだけです。

## TUIコマンド

| コマンド | 説明 |
| --- | --- |
| `/wechat login` | QRコードをスキャンしてログイン |
| `/wechat login --force` | 強制的に再スキャン |
| `/wechat start` | WeChat接続を開始 |
| `/wechat stop` | 停止してロックを解放 |
| `/wechat status` | 接続状態と設定を表示 |
| `/wechat config` | 画像関連設定を表示 |
| `/wechat config image-wait <ms>` | バッチ待機時間を設定（デフォルト `8000`） |
| `/wechat config image-max <MB>` | 画像サイズ上限を設定（デフォルト `50`） |
| `/wechat autostart` | セッション開始時の自動起動を切替 |
| `/wechat logout` | 認証情報をクリアして停止 |

## WeChatリモートコマンド

WeChatでテキスト、音声、画像を送るだけで通常の会話になります。追加コマンド：

| コマンド | 説明 |
| --- | --- |
| `/status` | モデル、コンテキスト使用量、キュー、設定 |
| `/stop` | 現在の生成を中止 |
| `/model` | 利用可能なモデル一覧 |
| `/model <名前>` | モデル切替 |
| `/config` | 画像設定を表示 |
| `/name <名前>` | セッション名を設定 |
| `/session` | セッション詳細を表示 |
| `/help` | ヘルプを表示 |

上級者向け：`/thinking`、`/tools`、`/compact`。

## 対応メッセージタイプ

| タイプ | 状態 |
| --- | --- |
| テキスト | ✅ |
| 音声 | ✅（WeChat音声認識） |
| 画像 | ✅（ダウンロード後モデルに送信） |
| 引用返信 | ✅（引用テキストを付加） |
| ファイル | ✅（プロジェクトディレクトリに保存） |
| 動画 | ❌ 未対応 |

## 設定

### 環境変数

| 変数 | 説明 | デフォルト |
| --- | --- | --- |
| `PI_WECHAT_DEBUG` | `1` でデバッグログ有効 | オフ |
| `PI_WECHAT_DEBUG_FILE` | デバッグログパス | `~/.pi/agent/wechat-assistant/debug.log` |
| `PI_WECHAT_IMAGE_BATCH_WAIT_MS` | 画像バッチ待機時間 | `8000` |
| `PI_WECHAT_IMAGE_MAX_BYTES` | 画像サイズ上限 | `52428800`（50 MB） |

### 設定ファイル

```
~/.pi/agent/wechat-assistant/
├── credentials.json   # ログイン認証情報（権限 600）
├── config.json        # 自動起動、画像制限
└── session.lock       # 排他ロックファイル
```

## アーキテクチャ

```
WeChat  ⇄  pi TUIセッション  ⇄  AIモデル + ツール
```

- WeChatメッセージはiLink Bot APIのロングポーリングで取得
- 受信メッセージは `pi.sendUserMessage()` で現在のpiセッションに注入
- TUIで入力するとWeChat側にプレビューが送信
- AI返信は増分的に送信（`message_end` ごと）、`agent_end` で残りを補完
- `/wechat start` を実行したTUIセッションのみが接続を保持

## FAQ

**WeChatから返信がない？** `/wechat status` で状態を確認。セッション期限切れなら `/wechat login --force` を実行。

**「他のpiインスタンスが使用中」と表示？** 別のTUIセッションがロックを保持中。そのセッションで `/wechat stop` を実行。

**画像がすぐに処理されない？** バッチ処理のため最大8秒待機。複数画像を連続送信後、テキストで補足できます。最初の画像は即座に確認応答、待機中にテキストを送ると即時処理。

## 開発

```bash
git clone https://github.com/shenjiecode/pi-wechat-assistant.git
cd pi-wechat-assistant
npm install
npm run typecheck

# クイックテスト
pi -e ./src/index.ts
```

## リリース

```bash
npm version patch   # package.jsonを更新、コミット、タグ作成
git push --follow-tags   # CI → npm公開 + GitHub Release をトリガー
```

## ライセンス

[MIT](LICENSE)

---
---

<a id="한국어"></a>

## 이것은 무엇인가요?

**pi-wechat-assistant**는 [pi](https://github.com/earendil-works/pi-coding-agent) 확장 기능으로, **1명의 WeChat 사용자**를 **1개의 pi TUI 세션**에 연결합니다. 범용 챗봇 브릿지도, 멀티 세션 오케스트레이터도 아닙니다. 컴퓨터를 떠나 있는 동안 WeChat에서 동일한 pi 세션 대화를 이어갈 수 있게 해주는 개인 어시스턴트입니다.

WeChat에서 보낸 메시지는 현재 pi 세션에 주입되고, AI 응답이 WeChat으로 돌아옵니다. TUI에서 입력한 메시지도 WeChat 측에 미리보기가 표시되어 양쪽을 동기화합니다.

> **1명의 WeChat 사용자 ↔ 1개의 pi TUI 세션.** 그것이 이 프로젝트의 전체 범위입니다.

## 특징

- 📱 **개인 어시스턴트** — 단일 사용자가 WeChat에서 단일 pi 세션을 원격 조작하도록 설계
- 🔐 **QR 코드 로그인** — WeChat으로 스캔하여 인증
- 🔄 **양방향 동기화** — WeChat ↔ TUI 메시지가 양쪽에서 표시
- 🖼️ **이미지 지원** — 다운로드, 복호화, 모델에 전송하여 분석
- 📁 **파일 지원** — WeChat에서 파일을 수신하여 프로젝트 디렉토리에 저장, 프로젝트 파일을 WeChat으로 전송
- 🗣️ **음성 지원** — WeChat 내장 음성 인식 활용
- 💬 **메시지 큐잉 & 배치** — 연속 메시지 자동 병합, 여러 이미지는 텍스트 보충을 대기 후 일괄 처리
- 🔒 **배타적 잠금** — 동시에 하나의 TUI 세션만 WeChat 연결 유지
- 📊 **상태 표시줄** — TUI 하단에 WeChat 연결 상태와 대기 메시지 수 표시

## 빠른 시작

### 설치

```bash
pi install npm:pi-wechat-assistant
```

또는 GitHub에서:

```bash
pi install git:github.com/shenjiecode/pi-wechat-assistant
```

### 사용법

pi TUI에서 실행:

```
/wechat login
/wechat start
```

WeChat에서 봇을 찾아 메시지를 보내기만 하면 됩니다.

## TUI 명령어

| 명령어 | 설명 |
| --- | --- |
| `/wechat login` | QR 코드 스캔하여 로그인 |
| `/wechat login --force` | 강제 재스캔 |
| `/wechat start` | WeChat 연결 시작 |
| `/wechat stop` | 중지 및 잠금 해제 |
| `/wechat status` | 연결 상태 및 설정 표시 |
| `/wechat config` | 이미지 관련 설정 표시 |
| `/wechat config image-wait <ms>` | 배치 대기 시간 설정 (기본값 `8000`) |
| `/wechat config image-max <MB>` | 이미지 크기 제한 설정 (기본값 `50`) |
| `/wechat autostart` | 세션 시작 시 자동 시작 전환 |
| `/wechat logout` | 자격 증명 지우기 및 중지 |

## WeChat 원격 명령어

WeChat에서 텍스트, 음성, 이미지를 보내면 일반 대화입니다. 추가 명령어:

| 명령어 | 설명 |
| --- | --- |
| `/status` | 모델, 컨텍스트 사용량, 큐, 설정 |
| `/stop` | 현재 생성 중단 |
| `/model` | 사용 가능한 모델 목록 |
| `/model <이름>` | 모델 전환 |
| `/config` | 이미지 설정 표시 |
| `/name <이름>` | 세션 이름 설정 |
| `/session` | 세션 상세 정보 |
| `/help` | 도움말 표시 |

고급: `/thinking`, `/tools`, `/compact`.

## 지원 메시지 유형

| 유형 | 상태 |
| --- | --- |
| 텍스트 | ✅ |
| 음성 | ✅ (WeChat 음성 인식) |
| 이미지 | ✅ (다운로드 후 모델에 전송) |
| 인용 답장 | ✅ (인용 텍스트 추가) |
| 파일 | ✅ (프로젝트 디렉토리에 저장) |
| 동영상 | ❌ 미지원 |

## 설정

### 환경 변수

| 변수 | 설명 | 기본값 |
| --- | --- | --- |
| `PI_WECHAT_DEBUG` | `1`로 설정 시 디버그 로그 활성화 | 꺼짐 |
| `PI_WECHAT_DEBUG_FILE` | 디버그 로그 경로 | `~/.pi/agent/wechat-assistant/debug.log` |
| `PI_WECHAT_IMAGE_BATCH_WAIT_MS` | 이미지 배치 대기 시간 | `8000` |
| `PI_WECHAT_IMAGE_MAX_BYTES` | 이미지 크기 제한 | `52428800` (50 MB) |

### 설정 파일

```
~/.pi/agent/wechat-assistant/
├── credentials.json   # 로그인 자격 증명 (권한 600)
├── config.json        # 자동 시작, 이미지 제한
└── session.lock       # 배타적 잠금 파일
```

## 아키텍처

```
WeChat  ⇄  pi TUI 세션  ⇄  AI 모델 + 도구
```

- WeChat 메시지는 iLink Bot API 롱 폴링으로 가져옴
- 수신 메시지는 `pi.sendUserMessage()` 로 현재 pi 세션에 주입
- TUI에서 입력하면 WeChat 측에 미리보기 전송
- AI 응답은 증분 전송 (`message_end` 마다), `agent_end` 에서 나머지 보완
- `/wechat start` 를 실행한 TUI 세션만 연결 유지

## FAQ

**WeChat에서 응답이 없음?** `/wechat status` 로 상태 확인. 세션 만료 시 `/wechat login --force` 실행.

**"다른 pi 인스턴스가 사용 중" 표시?** 다른 TUI 세션이 잠금을 유지 중. 해당 세션에서 `/wechat stop` 실행.

**이미지가 바로 처리되지 않는 이유?** 배치 처리를 위해 최대 8초 대기. 여러 이미지 연속 전송 후 텍스트로 보충 가능. 첫 이미지는 즉시 확인 응답, 대기 중 텍스트 전송 시 즉시 처리.

## 개발

```bash
git clone https://github.com/shenjiecode/pi-wechat-assistant.git
cd pi-wechat-assistant
npm install
npm run typecheck

# 빠른 테스트
pi -e ./src/index.ts
```

## 릴리스

```bash
npm version patch   # package.json 업데이트, 커밋, 태그 생성
git push --follow-tags   # CI → npm 게시 + GitHub Release 트리거
```

## 라이선스

[MIT](LICENSE)
