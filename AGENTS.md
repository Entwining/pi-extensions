# Repository instructions

This repository distributes one Pi Git package. Each production file in `extensions/` is independently selectable; [`package.json`](package.json) lists its entry points explicitly so tests and fixtures are never loaded as extensions.

## Runtime boundaries

- Import Pi APIs only through public package roots. Pi supplies its host packages at runtime, so keep them as `"*"` peers and pin the versions exercised by CI in `devDependencies`.
- [`agent-guard.ts`](extensions/agent-guard.ts) translates events and preserves failure-as-block behavior. Guard rules and the executable belong to [Agent Guard](https://github.com/Entwining/agent-guard); do not reproduce those rules here.
- The footer reuses Pi's `FooterComponent` through a partial session adapter because the extension context does not expose an `AgentSession`. Changes to that adapter need a real component render check; a type assertion does not verify its runtime contract.
- The reasoning workaround is limited to its exact model ID and provider payload. Preserve the stored transcript and code when changing replayed reasoning.

## Validation and delivery

Run `bun run check` before delivery. Keep tests beside their extension when they exercise its behavior; package discovery and cross-extension checks belong in `tests/`.

Use synthetic inputs. Loading tests must isolate the process home, agent directory, and project before importing Pi, because resource discovery also searches the home directory. Do not use live model credentials, transcripts, or user configuration in tests.

TypeScript checks production code and TypeScript tests. Derive narrower views from SDK-exported types with utilities such as `Pick` and `Parameters` instead of restating their method signatures. Keep partial test doubles and the footer's session adapter at their test or API boundary instead of adding replacement SDK declarations. A production assertion needs a local explanation of the SDK mismatch and a check of the runtime contract; a generic helper must not hide it. A non-null assertion needs a source invariant, such as a required regex capture, rather than an assumed external value.

The [Check workflow](.github/workflows/check.yml) checks pull requests and releases successful main-branch changes with semantic-release. Keep release credentials confined to the release step, and keep publishing in the same workflow: tags created with `GITHUB_TOKEN` do not trigger another workflow. Versions come from Git tags, not a second version file or a generated commit. Releases stay on `0.0.x`, including features and breaking changes, until the maintainer explicitly chooses `1.0.0`.

The [Renovate configuration](.github/renovate.json) maintains the lockfile and puts updates in one routine group that merges once pull-request checks pass. Give a dependency its own group, across update types, when it must move with other packages or its updates can need code changes or a separate revert. A dependency whose major updates no pull-request check exercises needs a rule that requires review. Keep Renovate's npm release age at least as long as the workflow's `--min-release-age` for every package outside its `--min-release-age-exclude` pattern, and keep that pattern equal to the exemption in Pi's `npmCommand`.
