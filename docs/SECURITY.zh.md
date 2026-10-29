# 安全说明

[English](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/SECURITY.md) | 简体中文

本扩展处理本地登录凭据、消息发送凭据、对话内容及项目文件。请勿在公开 issue 或 PR 中包含真实 token、账号标识、私人消息或未脱敏日志。

## 报告漏洞

请使用 [Report a vulnerability](https://github.com/shenjiecode/pi-wechat-assistant/security/advisories/new) 提交私密漏洞报告，并提供受影响版本、影响和使用虚构凭据的最小复现。不要在公开 issue 中披露利用细节或敏感数据。

不涉及敏感细节的普通问题可使用缺陷报告模板。可以使用任何语言提交，无需翻译。

## 验证边界

日常使用应选择仍在维护的最新 Pi 宿主。历史 API 兼容性检查不代表旧宿主没有安全公告。本扩展的生产依赖与开发/宿主依赖分别审计，见[维护指南](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/maintenance.zh.md)。

调试日志需要主动开启。当前调用点避免记录消息正文、附件密钥和完整报错，日志轮转保留一个备份；升级不会清洗旧版本留下的日志。分享前仍应检查片段；`/wechat status`、宿主和服务商输出属于其他来源，仍可能带有私人信息。

自动化测试覆盖发送方校验、锁归属、队列和使用模拟服务的扩展行为。测试或 Pi API 类型检查通过，不代表外部微信服务的安全性已得到验证，也不代表真实账号收发已成功。
