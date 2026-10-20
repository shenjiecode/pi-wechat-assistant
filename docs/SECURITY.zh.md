# 安全说明

[English](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/SECURITY.md) | 简体中文

本扩展处理本地登录凭据、消息发送凭据、对话内容及项目文件。请勿在公开 issue 或 PR 中包含真实 token、账号标识、私人消息或未脱敏日志。

## 报告漏洞

请使用 [Report a vulnerability](https://github.com/shenjiecode/pi-wechat-assistant/security/advisories/new) 提交私密漏洞报告，并提供受影响版本、影响和使用虚构凭据的最小复现。不要在公开 issue 中披露利用细节或敏感数据。

不涉及敏感细节的普通问题可使用缺陷报告模板。可以使用任何语言提交，无需翻译。

## 验证边界

自动化测试覆盖发送方校验、锁归属、队列和使用模拟服务的扩展行为。测试或 Pi API 类型检查通过，不代表外部微信服务的安全性已得到验证，也不代表真实账号收发已成功。
