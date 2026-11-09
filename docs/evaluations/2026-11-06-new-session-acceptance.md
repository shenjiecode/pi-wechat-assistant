# Remote /new: validation and real-account acceptance

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/evaluations/2026-11-06-new-session-acceptance.zh.md)

Initial record: 2026-11-06; release decision: 2026-11-09. Feature: [PR #49](https://github.com/shenjiecode/pi-wechat-assistant/pull/49), reviewed implementation `e54f170`, including development Pi 1.5.0 from #50. The delivered candidate was `d9cadfb` on `codex/release-v0.6.6`.

## Maintainer acceptance and release decision

On 2026-11-09, after receiving the candidate for testing on another computer, the maintainer confirmed that real-device testing was complete and explicitly requested the new release. This confirmation satisfies the maintainer's release gate for v0.6.6. The tested device/environment, exact checkout and individual checklist observations were not supplied; the rows below are therefore marked as not individually reported, rather than inferred to have passed. The automated evidence below and the earlier local QR attempt remain separate evidence. Final preparation changes only release metadata and documentation, with no runtime changes to the delivered candidate.

## Completed checks

| Evidence | Result and scope |
| --- | --- |
| [GitHub CI run 42185776048](https://github.com/shenjiecode/pi-wechat-assistant/actions/runs/42185776048) | All 10 jobs passed for `e54f170`, including Linux/Windows matrices, minimum-runtime checks, production audit and aggregate result. |
| Windows and WSL Ubuntu / Node 24.19.0 | All 365 tests passed, with source types, architecture, documentation and package checks. |
| Node 20.19.0 | 363 extension tests passed. The two real-Pi-SDK tests are explicitly excluded because development Pi 1.5.0 requires Node >=22.19.0. They remain enabled on supported Node versions; this is not a claim that Pi 1.5.0 runs on Node 20. |
| Real Pi SDK session replacement | Both auto-start settings passed, including cancellation, old-history preservation, empty new context, continued messaging, repeated replacement and stable process listener counts. WeChat transport and model responses were simulated. |
| Published Pi API checks | All eight listed versions passed: 0.73.1, 0.78.0, 0.84.0, 0.84.4, 0.99.2, 1.1.0, 1.2.0 and 1.4.0. These are declaration checks, not eight real-account runs. |
| Full dependency audit | Zero findings in the reviewed dependency tree. |

The agent's local real-account attempt on 2026-11-06 did **not** complete: the isolated bridge QR code expired; no WeChat credentials were obtained and no test messages were sent. Desktop WeChat being logged in did not establish bridge login or delivery. The maintainer stopped that attempt and subsequently confirmed their own real-device testing as recorded above. SDK tests and fixed model responses are not real-WeChat/real-model acceptance. The following instructions and checklist are retained for reproducibility and future tests.

## Prepare the other computer

Use Node >=22.19.0 and the candidate's locked Pi 1.5.0, plus a real model/provider account. Use a dedicated test OS account or a clean environment with no existing bridge credentials. Do not copy, overwrite, delete or force-refresh production credentials. Do not run another receiver for the same WeChat bot/account concurrently.

The extension stores bridge state under the OS user's `.pi/agent/wechat-assistant` directory. `-ne`, `-e`, and `--session-dir` **do not isolate those credentials**. If the current account already has production bridge state, choose a dedicated test account before continuing. The fresh test account may need its own model login/API-key configuration; do not put secrets in commands, screenshots or the results report.

PowerShell, in that test account:

```powershell
git clone --branch codex/release-v0.6.6 --single-branch https://github.com/shenjiecode/pi-wechat-assistant.git C:\codes\projects\pi-wechat-assistant-acceptance
Set-Location C:\codes\projects\pi-wechat-assistant-acceptance
git rev-parse HEAD
node --version
npm ci
.\node_modules\.bin\pi.cmd --version
New-Item -ItemType Directory -Force C:\codes\projects\pi-wechat-acceptance-sessions | Out-Null
.\node_modules\.bin\pi.cmd -ne -e .\index.ts --session-dir C:\codes\projects\pi-wechat-acceptance-sessions
```

These options were checked against the installed Pi 1.5.0 CLI documentation: `-ne` disables discovered, configured and built-in extensions, while explicit `-e` paths still load; `--session-dir` selects session storage. Thus this run loads the candidate explicitly without an installed duplicate. Do not add `--no-session`, because history persistence is part of the test. Use Pi's model/login UI to choose a working real model, then run `/wechat login` and scan the fresh QR code. Do not use `--force` against an existing production login.

Record candidate SHA, extension version, Pi version, Node version, OS, model/provider (no secrets), date and whether observations came from desktop WeChat or a phone. A successful desktop-only test is not phone-side acceptance.

## Test steps and results to fill in

Only use disposable example text and files. Keep the terminal open. Wait for each task to finish and for the `/new` success reply before sending the next task, except during the deliberate busy-state test.

| Step | Action and expected evidence | Result |
| --- | --- | --- |
| Baseline | In Pi, set `/wechat config auto-start off`, then `/wechat start`. From WeChat send `Acceptance OLD-1106: reply with this marker`. Receive a real model reply. Send `/session`; record the old ID and locate its JSONL file in the dedicated session directory. | Not individually reported |
| New session with auto-start off | After idle, hash the old session file as described below, then send `/new` from WeChat. Receive a success confirmation with a different ID, without scanning again. Before any new model prompt, send `/session`: user/assistant history counts should be zero. The old file still exists with the same hash. | Not individually reported |
| Continued messages | Send `Acceptance NEW-1106: reply with this marker`. Receive exactly one final reply and find the new exchange in the new session. The old conversation must not appear in the new context. Retained system/project instructions are expected; asking the model whether it remembers is not sufficient proof of empty context. | Not individually reported |
| Repeat | After idle, send `/new` again, then a different test marker after confirmation. ID changes again and replies continue, with no historical replay. | Not individually reported |
| Auto-start on | In Pi set `/wechat config auto-start on`; retain the desired handoff choice if prompted. Repeat `/new` and a test message. Exactly one bridge remains active and the reply arrives. | Not individually reported |
| Busy refusal | Ask the real model to run a harmless approximately 15-second wait command. While the terminal visibly shows the task running, send `/new`. Expect an explicit busy/pending refusal and unchanged session ID; after the task finishes, `/new` succeeds. A request sent after the task finishes does not test this case. | Not individually reported |
| Pending file refusal | Send a small disposable text file from WeChat without instructions. After its save acknowledgement, send `/new`: expect refusal and unchanged ID. Send instructions to read/summarize the file; after completion, `/new` succeeds. | Not individually reported |
| Cancellation and retry | Use the one-shot cancellation helper below in a separate test run. First `/new` returns cancellation with the same ID and working bridge; the second `/new` succeeds. | Not individually reported |
| Stop/restart recovery | In Pi run `/wechat stop`, then `/wechat start`; send a fresh WeChat marker and receive its reply without old-message replay. If an actual creation/restart error occurs, record it as failure, inspect `/wechat status`, and recover with `/wechat start`; a later recovery does not turn the failed case into a pass. | Not individually reported |

For history evidence, locate the exact old JSONL file by its recorded session ID. In a second PowerShell window, after the baseline turn is complete and before `/new`:

```powershell
$oldSessionPath = 'C:\codes\projects\pi-wechat-acceptance-sessions\<actual-old-session-file>.jsonl'
$oldSessionHash = (Get-FileHash -LiteralPath $oldSessionPath -Algorithm SHA256).Hash
```

After `/new` succeeds:

```powershell
Test-Path -LiteralPath $oldSessionPath
(Get-FileHash -LiteralPath $oldSessionPath -Algorithm SHA256).Hash -eq $oldSessionHash
```

Both results should be `True`. Record the new `/session` counts before sending its first normal prompt. Inspect only these disposable test histories; do not attach personal session files.

## Deterministic cancellation without mocking WeChat or the model

Ordinary `/new` does not necessarily show a cancellation dialog. To exercise host cancellation, save this helper as `C:\codes\projects\pi-wechat-cancel-once.ts`. It uses the documented `session_before_switch` event and cancels the first new-session request in that extension instance:

```typescript
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function cancelOnce(pi: ExtensionAPI) {
  let pending = true
  pi.on('session_before_switch', event => {
    if (event.reason === 'new' && pending) {
      pending = false
      return { cancel: true }
    }
  })
}
```

Stop/exit the previous candidate Pi cleanly, then launch from the same candidate directory:

```powershell
.\node_modules\.bin\pi.cmd -ne -e .\index.ts -e C:\codes\projects\pi-wechat-cancel-once.ts --session-dir C:\codes\projects\pi-wechat-acceptance-sessions
```

Run `/wechat start`, record the ID, and perform the cancellation/retry row through real WeChat. The helper resets after session replacement, so remove its `-e` argument on the next normal launch. Do not include this helper in the published extension. Record that host cancellation was deliberately injected; transport and model still must be real.

## Finish and hand off

Stop the test bridge with `/wechat stop` and exit Pi. Leave production state untouched. Fill in each row with **Pass / Fail / Not run**, actual observations and sanitized evidence. Include any skipped device or scenario, not just successes. Report the tested candidate SHA; if code changes after testing, assess whether affected cases must be repeated. For future releases, record maintainer acceptance separately from automated results. The v0.6.6 release decision is recorded above.
