# Contributing

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/CONTRIBUTING.zh.md)

Thank you for helping improve pi-wechat-assistant. For larger changes, open an issue describing the problem and proposed behavior before implementation.

## Development setup

Use Node.js 22.19+ (or 24) and npm for development; the current development Pi package requires it. CI runs the full checks on Linux and Windows with Node.js 20.19.0, 22, and 24. A separate Node.js 20.3.0 smoke check verifies compiled extension registration and text queue submission with a mocked client; it does not run a Pi host or verify real WeChat delivery. The selected Pi host may require a newer Node.js version.

```bash
git clone https://github.com/shenjiecode/pi-wechat-assistant.git
cd pi-wechat-assistant
git switch develop
npm ci
npm run check
```

Pi loads the TypeScript entry directly. No separate build step or generated `dist/` directory is needed to develop this extension.

## Branches and commits

Use a small two-branch workflow:

```text
feat/*, fix/*, docs/*, chore/* -> PR -> develop -> PR -> main -> vX.Y.Z
```

- `develop`: integrate daily work; start short-lived branches here and target it with normal PRs.
- `main`: stable release branch; changes arrive through PRs reviewed and merged by the maintainer.
- `feat/<topic>`: new features; `fix/<topic>`: bug fixes; `docs/<topic>`: documentation; `chore/<topic>`: tooling or maintenance. Use short, descriptive lowercase names.

```bash
git switch develop
git pull --ff-only
git switch -c feat/short-topic
```

Use commit subjects such as `feat: add image captions`, `fix: preserve message order`, or `docs: clarify setup`. Use `chore:` for tooling, `refactor:` for behavior-preserving code changes, and `test:` for tests. No scopes, commit hooks, or automated versioning are required.

Normal PRs may use **Squash and merge**. For `develop -> main`, use **Create a merge commit** to preserve the shared history of the long-lived branches. After a release merge, synchronize `main` back into `develop` before starting the next change. If a fix must start from `main`, submit it to `main` through a PR and then bring it back into `develop` as well.

```bash
git fetch origin
git switch develop
git merge --ff-only origin/main
git push origin develop
```

The fast-forward assumes `develop` has not advanced since the release PR. If it has, merge `main` into `develop` through a synchronization PR instead; do not reset or force-push either shared branch.

## Checks

| Command | Purpose |
| --- | --- |
| `npm run check` | Source types, architecture boundaries, tests, documentation links, and npm package contents |
| `npm run typecheck` | Check runtime TypeScript sources |
| `npm test` | Run all tests once |
| `npm run test:watch` | Watch tests while developing |
| `npm run typecheck:pi` | Check published Pi API declarations across eight versions |
| `npm run check:architecture` | Check domain boundaries, runtime cycles and type-only Pi imports |
| `npm run check:docs` | Verify documentation navigation and language-switch links |
| `npm run check:package` | Inspect the publish file list without creating an archive |

The compatibility check downloads published declarations on its first run and caches them under `node_modules/.cache/pi-wechat-compat/`. It does not replace installed dependencies or test real WeChat delivery.

For example, run a focused test with `npm test -- tests/messaging/message.test.ts`. Integration tests in `tests/integration/` load the public root entry with mocked Pi and WeChat dependencies.

## Code organization

See [Architecture](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/architecture.md) for directory responsibilities and runtime flow. Place tests in the matching domain directory; use `tests/integration/` for behavior spanning multiple modules.

Follow the existing style: TypeScript, ESM, two-space indentation, single quotes, and no semicolons. Use `.js` suffixes for relative TypeScript imports to match Node16 module resolution. Keep Pi imports type-only where possible so both supported package namespaces remain usable.

Keep changes focused. Add regression coverage for behavior changes, update both READMEs when user-facing instructions change, and avoid committing generated output, received files, credentials, or logs. Use `.editorconfig` for editor settings; formatting is not currently enforced by a formatter or linter.

Keep the English project overview in `README.md` and its Simplified Chinese translation in `README.zh.md`. Place detailed guides in `docs/`, with English in `name.md` and Chinese in `name.zh.md`. Keep language-switch links and both versions up to date. See the [documentation index](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/README.md).

## Issues and pull requests

Issues, pull requests, comments, and reviews are welcome in any language. No translation or bilingual submission is required. The English and Chinese template sections are optional alternatives; use either or write your own description. Be respectful and concise, and include reproduction steps, environment versions, and the checks you actually ran. Project documentation continues to use separate language files as described above.

Before opening a PR, run `npm run check` and `npm run typecheck:pi`. CI runs the main checks on Linux and Windows, and the Pi compatibility check on Linux with Node.js 22. Describe any manual verification separately from automated tests.

Use the existing bug report, feature request, and PR templates; an issue is optional for a small, clear change. Keep the PR focused and state its target branch, purpose, and validation.

`main` requires a PR and both CI checks: `check (ubuntu-latest, 22)` and `check (windows-latest, 22)`. The PR must be up to date with `main`. Required approving reviews are set to **0**: GitHub does not allow authors to approve their own PRs, so the sole maintainer inspects the diff and checks, then merges manually. Protection also applies to administrators; force pushes and branch deletion are disabled. Do not configure automatic merging on the maintainer's behalf.

For sensitive reports, see [Security](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/SECURITY.md).

CI also provides the `CI success` aggregate covering the full matrix, minimum runtime and production audit. The protection described above is the existing configuration; adding the workflow does not automatically make the aggregate required. The maintainer should configure it after a successful run. See [Maintenance](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/maintenance.md) for check boundaries and the real-WeChat acceptance checklist.

## Releases

1. Prepare the version and changelog through a PR to `develop`: update `package.json` and `package-lock.json` to the same version and add the matching `## [x.y.z]` section to `CHANGELOG.md`. `npm version <version> --no-git-tag-version` can update the version files without creating a tag.
2. Open `develop -> main`, verify CI, and have the maintainer merge it using **Create a merge commit**.
3. After an explicit release decision, fetch `main` and create an annotated tag on the release commit. The tag version must match the package and changelog. For example, for a release prepared as `0.6.1`:

   ```bash
   git switch main
   git pull --ff-only
   git tag -a v0.6.1 -m "Release v0.6.1"
   git push origin v0.6.1
   ```

4. The tag triggers the publish workflow. It verifies that the commit belongs to `main` and the tag matches the package version, runs checks, publishes to npm, and creates the GitHub Release from the changelog. A normal push to `main` or `develop` does not publish.
5. Synchronize `main` back into `develop` as described above. Keep published tags immutable; use a new version for subsequent releases.

Pushing tags and publishing require an explicit release decision. The manual publish workflow accepts an existing release tag and applies the same checks.
