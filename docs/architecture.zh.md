# 架构说明

[English](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/architecture.md) | 简体中文

## 仓库结构

```text
index.ts                       Pi 扩展公开入口
src/
  extension/                   Pi 生命周期、命令与界面
  bridge/                      状态、锁归属与消息队列
  wechat/                      iLink 接口、客户端、媒体与类型
  messaging/                   回复格式、来源与提示词
  shared/                      常量、日志与公共辅助函数
tests/
  bridge/                      桥接模块测试
  extension/                   命令与状态测试
  integration/                 扩展生命周期与同步测试
  messaging/                   格式与提示词测试
  shared/                      辅助函数测试
  wechat/                      客户端与发送方校验测试
prompts/                       随包发布的默认回复模板
docs/                          用户与开发文档
scripts/                       兼容性与打包检查
assets/                        标志与包封面
.github/                       CI、发布工作流与协作模板
```

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `extension/index.ts` | 注册 Pi 事件与工具，协调桥接生命周期和轮次状态 |
| `extension/commands.ts`, `remote-commands.ts` | 桥接生命周期命令与微信命令 |
| `extension/config-commands.ts`, `config-menu.ts` | 配置及模板命令、对话框与等待任务结束的协调 |
| `extension/send-tools.ts` | 发送工具注册、文件校验与实时桥接状态检查 |
| `extension/model-failure.ts`, `status.ts` | Pi 失败事件兼容及状态展示 |
| `bridge/auth.ts` | 登录凭据与锁操作入口；保留兼容导出 |
| `bridge/config.ts`, `config-values.ts` | 配置缓存与持久化、回执默认文案、图片配置取值及命令数值校验 |
| `bridge/transport-state.ts` | 游标、已见消息 ID，以及串行化、节流的上下文凭据持久化 |
| `bridge/state-storage.ts` | 公共状态目录与 JSON 文件权限、读写辅助函数 |
| `bridge/bridge-lock.ts`, `bridge-ownership.ts` | 检查归属、获取与释放锁、协调交接 |
| `bridge/queue.ts` | 批处理入站消息、准备附件并提交 Pi 请求 |
| `wechat/api.ts`, `client.ts` | iLink 请求、轮询、发送及消息发送凭据 |
| `wechat/media.ts`, `security.ts`, `types.ts` | 媒体处理、绑定用户校验与协议类型 |
| `messaging/` | 格式化出站文字、标记消息来源并加载回复规则 |
| `shared/` | 不依赖领域模块的小型公共辅助函数 |

微信客户端通过 `bridge/transport-state.ts` 持久化传输状态，不再依赖登录或配置代码。运行时直接从 `bridge/config.ts` 导入配置；`auth.ts` 保留的旧导出指向同一份缓存。配置命令使用精简的依赖接口，生命周期协调仍留在扩展入口。发送工具读取实时客户端和运行状态，并在异步校验后再次检查。

配置保留原 JSON 路径、字段、未知字段、进程内缓存及写入成功后更新缓存的语义。读取不会补写默认值或执行迁移；显式 `false` 和零值保持有效，图片 JSON 配置优先于环境变量回退。队列原有图片配置导出保留为兼容包装。配置测试使用隔离目录，覆盖重载、保存失败、默认值、校验及传输状态隔离。

## 运行流程

1. 根入口加载 `src/extension/index.ts`，由它注册 Pi 命令、事件和桥接工具。

2. 启动桥接时加载本地状态并获取锁归属。微信客户端轮询 iLink，校验绑定发送方后将消息交给队列。

3. 队列合并消息、准备附件后向 Pi 提交请求；消息模块提供来源标识与回复规则。

4. Pi 事件驱动回复经过格式化器和微信客户端发送。桌面输入是否同步由双向同步设置决定，默认关闭。

5. 停止或交接时收尾桥接工作并释放锁归属。跨会话交接有专门的文件系统测试，集成测试覆盖扩展事件行为。

## 发布包与本地状态

`package.json` 保持 `index.ts` 同时作为包入口和 Pi 扩展入口。Pi 直接加载 TypeScript，npm 的 `files` 白名单发布运行时源码、提示词、文档和资源。`npm run check:package` 检查 npm 实际文件列表，包括全部源码和默认回复模板。移动提示词加载器时，必须同步维护相对于 `import.meta.url` 的模板路径。

账号状态保存在 `~/.pi/agent/wechat-assistant/`，收到的文件保存在当前项目的 `.pi-wechat-files/`。这些是运行时数据，不属于仓库资源。测试使用模拟依赖或 `node_modules/.cache/` 下的临时目录。

开发命令和发布检查见[贡献指南](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/CONTRIBUTING.zh.md)。
