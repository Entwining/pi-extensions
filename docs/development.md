# Development

Use the Bun version declared in `package.json`:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`check` runs formatting, lint, strict TypeScript, and tests. Tests use synthetic inputs; those that load the package through Pi or run semantic-release do so in an isolated home, without your settings, credentials, or model requests. Agent Guard's rule tests belong to [its own repository](https://github.com/Entwining/agent-guard).

Try a local checkout with [`pi -e .`](https://pi.dev/docs/latest/packages#install-and-manage-packages). Disable the installed copy first so the same extensions are not registered twice.

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). After checks pass on `main`, [semantic-release](https://github.com/semantic-release/semantic-release) publishes the next `0.0.x` tag and its release notes: fixes, features, and breaking changes all release a patch until `1.0.0`, while documentation and maintenance commits do not release. To retry an interrupted release, run the [Check workflow](../.github/workflows/check.yml) manually on `main`. [AGENTS.md](../AGENTS.md) records the runtime, test, release, and dependency constraints to preserve when changing the package.
