# Pi Extensions

Extensions for [Pi](https://pi.dev/) that add inline skill invocation, session IDs in the footer, Agent Guard checks, and a DeepSeek reasoning workaround. Each extension can be enabled independently.

## Invoke skills inside a prompt

Type `/skill-name` inside an interactive prompt to complete and highlight a skill mention. The [first mention outside code invokes the skill through Pi](docs/usage.md#inline-skill-invocation). Other mentions are named to the model, which decides whether to use them.

## Identify the session

The [session footer](docs/usage.md#session-footer) adds the session ID below the working directory. It keeps Pi's statistics and extension statuses.

## Check tool calls with Agent Guard

The [Agent Guard adapter](docs/usage.md#agent-guard) checks shell, file, and search tool calls before they run. A rejected or failed check blocks the call. [Agent Guard](https://github.com/Entwining/agent-guard) owns the rules.

## Filter replayed DeepSeek reasoning

The [reasoning workaround](docs/usage.md#deepseek-reasoning) removes interjections and repeated standalone filler from the request copy. It preserves the recorded transcript. It applies only to DeepSeek models.

## Install

```sh
pi install git:github.com/Entwining/pi-extensions
```

This loads every extension in the package. The Agent Guard adapter requires Apple Silicon macOS and Agent Guard installed through Homebrew. Without it, every guarded tool call is blocked; [disable that extension or select only the extensions you need](docs/setup.md#install).

[Updates follow the default branch unless you pin a Git tag or commit](docs/setup.md#update). The package is distributed through Git, not npm.

## Limits

The editor and footer extensions replace parts of Pi's terminal UI. Other extensions replacing the same components can affect their composition. The reasoning workaround depends on the provider's `reasoning_details` format.

## Development

Contributors [run the repository checks and try changes in a local Pi session](docs/development.md). [AGENTS.md](AGENTS.md) defines the runtime, test, release, and dependency constraints for changes.

Pi Extensions is released under the [MIT License](LICENSE).
