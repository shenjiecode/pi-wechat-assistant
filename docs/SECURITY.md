# Security

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/SECURITY.zh.md)

This extension handles local login credentials, message-send credentials, conversation content and project files. Never include real tokens, account identifiers, private messages or unredacted logs in public issues or pull requests.

## Reporting a vulnerability

Use [Report a vulnerability](https://github.com/shenjiecode/pi-wechat-assistant/security/advisories/new) to submit a private report. Include the affected version, impact, and a minimal reproduction with fake credentials. Do not disclose exploit details or sensitive data in public issues.

Ordinary bugs without sensitive details can use the bug report template. Reports are welcome in any language; no translation is required.

## Verification limits

Automated tests cover sender validation, ownership, queueing and extension behavior with mocked services. Passing tests or Pi API type checks does not establish the security of the external WeChat service or prove successful delivery with a real account.
