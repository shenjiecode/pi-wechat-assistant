# 贡献指南

感谢参与 pi-wechat-assistant。较大的行为变化请先在 issue 中描述问题与预期行为，再开始实现。

## 环境准备

- 运行时 Node.js >= 20.3；运行 Pi SDK 与 E2E 测试需要 Node.js >= 22.19（或 24），以开发版 Pi 的要求为准。
- Pi 基线：[`@earendil-works/pi-coding-agent >= 1.2.0`](https://github.com/earendil-works/pi)（peerDependency）；开发环境安装 1.6.x。
- Pi 直接加载 TypeScript 入口，无需构建步骤，也没有生成 `dist/` 目录。

```bash
git clone https://github.com/shenjiecode/pi-wechat-assistant.git
cd pi-wechat-assistant
git switch develop
npm ci
npm run check
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run check` | 类型检查 + 架构边界 + 测试 + 文档链接 + npm 发布文件列表 |
| `npm test` / `npm run test:watch` | 单元与集成测试（一次运行 / watch 模式） |
| `npm run test:e2e` | 近真机端到端测试（需 Node >= 22.19） |
| `npm run typecheck:pi` | Pi 1.2.0 / 1.4.0 发布 API 兼容检查 |
| `npm run audit:production` | 生产依赖漏洞审计 |
| `npm run check:architecture` | 领域边界与运行时循环检查 |
| `npm run check:docs` | 文档导航与语言切换链接检查 |
| `npm run check:package` | 不打包地检查发布文件列表 |

单测示例：`npm test -- tests/messaging/message.test.ts`；`tests/integration/` 用 mock 的 Pi/微信依赖加载公开入口。提交 PR 前运行 `npm run check` 与 `npm run typecheck:pi`。

## 分支与提交

```text
feat/*, fix/*, docs/*, chore/* -> PR -> develop -> PR -> main -> vX.Y.Z
```

- `develop`：日常集成分支；短分支从这里切出，普通 PR 指向它。
- `main`：稳定发布分支；只接受维护者评审后的 PR。
- 分支名示例：`feat/<topic>`、`fix/<topic>`、`docs/<topic>`、`chore/<topic>`，小写、简短。

提交说明使用 `feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:` 前缀，无 scope 要求。普通 PR 用 **Squash and merge**；`develop -> main` 用 **Create a merge commit** 保留共享历史。发版合并后把 `main` 同步回 `develop`（ff-only 或同步 PR），不要 reset/force-push 共享分支。

## 代码组织

目录职责与运行流程见[架构说明](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/architecture.md)。测试放在对应领域目录，跨模块行为放 `tests/integration/`。风格：TypeScript、ESM、两空格缩进、单引号、无分号，相对导入带 `.js` 后缀；Pi 导入尽量保持 type-only。

行为变化补充回归测试；用户可见的说明变化更新对应 README；不提交生成产物、接收文件、凭证或日志。

## 文档约定

- **用户指南**保持英文 + 简体中文双语：`README`、`docs/quickstart`、`docs/tutorial`、`docs/faq`、`docs/settings`、`docs/upgrading`、`docs/wechat-source`、`docs/model-errors`、`docs/SECURITY` 等，`name.md` 与 `name.zh.md` 相互链接、同步更新。
- **内部开发文档**只维护简体中文：`docs/architecture.md`、`docs/maintenance.md`、`docs/CONTRIBUTING.md`、`.github/CONTRIBUTING.md`，不创建 `.zh.md` 副本。
- 文档导航使用完整 GitHub URL（含 `docs/` 路径）；修改链接后运行 `npm run check:docs`。目录见[文档索引](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/README.md)。

## Issue 与 PR

任何语言均可，无需翻译。使用现有的 bug/feature/PR 模板；小而清晰的改动可以不开 issue。PR 保持聚焦，说明目标分支、目的与验证方式。`main` 要求 PR 且 CI 通过（`check (ubuntu-latest, 22)` 与 `check (windows-latest, 22)`）；必需批准数为 0，由维护者人工审查合并。

敏感问题见[安全说明](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/SECURITY.md)。

## 发布

1. 通过 PR 在 `develop` 上准备版本：`package.json` 与 `package-lock.json` 同版本，`CHANGELOG.md` 增加 `## [x.y.z]` 小节（`npm version <version> --no-git-tag-version` 可只改版本文件）。
2. 打开 `develop -> main`，确认 CI 后由维护者以 **Create a merge commit** 合并。
3. 显式决定发版后，在 `main` 上创建 annotated tag 并推送（tag 版本须与包和 changelog 一致），例如 `v1.0.0`：

   ```bash
   git switch main
   git pull --ff-only
   git tag -a v1.0.0 -m "Release v1.0.0"
   git push origin v1.0.0
   ```

4. tag 触发发布 workflow：校验提交属于 `main`、tag 与包版本一致，运行检查，发布 npm 并从 changelog 创建 GitHub Release。普通推送不发布。
5. 把 `main` 同步回 `develop`；已发布 tag 不可变，后续发版用新版本号。

发版前的真机冒烟与检查边界见[维护指南](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/maintenance.md)。
