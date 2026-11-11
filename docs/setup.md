# Install and update

## Install

Install the package from Git:

```sh
pi install git:github.com/Entwining/pi-extensions
```

This loads every extension listed in the package. `agent-guard.ts` requires Apple Silicon macOS and Agent Guard [installed through Homebrew](https://github.com/Entwining/agent-guard/blob/main/docs/setup.md#install); without it, every guarded tool call is blocked. If you do not use Agent Guard, disable that extension with [`pi config`](https://pi.dev/docs/latest/packages#select-package-resources) or a package filter.

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
