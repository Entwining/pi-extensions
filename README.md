# Pi Extensions

Extensions for [Pi](https://pi.dev/) that add inline skill invocation, session IDs in the footer, an [Agent Guard](https://github.com/Entwining/agent-guard) check of tool calls, and a model-specific reasoning workaround. Each extension can be enabled independently.

## Extensions

| Extension                                                             | Behavior                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`agent-guard.ts`](extensions/agent-guard.ts)                         | Translates Pi shell, file, and search tool calls into Agent Guard events and runs `/opt/homebrew/bin/agent-guard`. A call is blocked when the guard rejects it or cannot complete its check. Agent Guard owns the rules and the [reason markers](https://github.com/Entwining/agent-guard/blob/main/docs/setup.md#reason-markers) in each block; this extension owns the Pi adapter. |
| [`inline-skill-invocation.ts`](extensions/inline-skill-invocation.ts) | Completes and highlights `/skill-name` mentions inside interactive prompts. The first skill mentioned outside code is invoked through Pi's native [`/skill:name` command](https://pi.dev/docs/latest/skills#understand-how-skills-load); other mentions are named to the model, which decides whether they request a skill. Existing leading Pi commands stay in place.              |
| [`session-id-footer.ts`](extensions/session-id-footer.ts)             | Inserts the session ID below the working directory while retaining Pi's footer statistics and extension statuses.                                                                                                                                                                                                                                                                    |
| [`strip-reasoning-filler.ts`](extensions/strip-reasoning-filler.ts)   | Removes interjections and repeated standalone filler from replayed reasoning for `deepseek/deepseek-v4.1-flash`. It modifies the request copy, preserves the recorded transcript, and depends on the provider's `reasoning_details` format. Disable or remove it when that workaround is no longer needed.                                                                           |

The editor and footer extensions replace parts of Pi's terminal UI. Other extensions replacing the same components can affect their composition. The reasoning extension does nothing for other model IDs.

## Install

Install the package from Git:

```sh
pi install git:github.com/Entwining/pi-extensions
```

This loads all four extensions. `agent-guard.ts` requires Apple Silicon macOS and Agent Guard [installed through Homebrew](https://github.com/Entwining/agent-guard/blob/main/docs/setup.md#install); without it, every guarded tool call is blocked. If you do not use Agent Guard, disable that extension with [`pi config`](https://pi.dev/docs/latest/packages#select-package-resources) or a package filter.

Pi's [package filters](https://pi.dev/docs/latest/packages#select-package-resources) select extensions in `~/.pi/agent/settings.json`. For example, this entry loads only inline skill invocation and the session footer:

```json
{
  "packages": [
    {
      "source": "git:github.com/Entwining/pi-extensions",
      "extensions": ["extensions/inline-skill-invocation.ts", "extensions/session-id-footer.ts"]
    }
  ]
}
```

Keep your other package entries when editing settings. Run [`/reload`](https://pi.dev/docs/latest/slash-commands) after changing the selected extensions.

## Update

```sh
pi update git:github.com/Entwining/pi-extensions
```

The unversioned source follows the repository's default branch. To select a release, append its Git tag to the source, such as `git:github.com/Entwining/pi-extensions@v0.0.1`; [Pi preserves configured tags and commits](https://pi.dev/docs/latest/packages#choose-a-source) during updates. Each version's changes are listed in [GitHub Releases](https://github.com/Entwining/pi-extensions/releases). The package is distributed only through Git, not npm.

## Development

Use the Bun version declared in `package.json`:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`check` runs formatting, lint, strict TypeScript, and tests. Tests use synthetic inputs; those that load the package through Pi or run semantic-release do so in an isolated home, without your settings, credentials, or model requests. Agent Guard's rule tests belong to [its own repository](https://github.com/Entwining/agent-guard).

Try a local checkout with [`pi -e .`](https://pi.dev/docs/latest/packages#install-and-manage-packages). Disable the installed copy first so the same extensions are not registered twice.

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). After checks pass on `main`, [semantic-release](https://github.com/semantic-release/semantic-release) publishes the next `0.0.x` tag and its release notes: fixes, features, and breaking changes all release a patch until `1.0.0`, while documentation and maintenance commits do not release. To retry an interrupted release, run the [Check workflow](.github/workflows/check.yml) manually on `main`. [AGENTS.md](AGENTS.md) records the runtime, test, release, and dependency constraints to preserve when changing the package.

## License

[MIT](LICENSE)
