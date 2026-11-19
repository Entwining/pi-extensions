# Using the extensions

## Inline skill invocation

`inline-skill-invocation.ts` completes and highlights `/skill-name` mentions inside interactive prompts. The first skill mentioned outside code is invoked through Pi's native [`/skill:name` command](https://pi.dev/docs/latest/skills#understand-how-skills-load). Other mentions are named to the model, which decides whether they request a skill. Existing leading Pi commands stay in place.

The extension replaces Pi's editor. Other extensions replacing the same component can affect its composition.

## Session footer

`session-id-footer.ts` inserts the session ID below the working directory. It retains Pi's footer statistics and extension statuses.

The extension replaces Pi's footer. Other extensions replacing the same component can affect its composition.

## Agent Guard

`agent-guard.ts` translates Pi shell, file, and search tool calls into Agent Guard events. It runs `/opt/homebrew/bin/agent-guard`. A call is blocked when the guard rejects it or cannot complete its check.

Agent Guard owns the rules and the [reason markers](https://github.com/Entwining/agent-guard/blob/main/docs/setup.md#reason-markers) in each block. This extension owns the Pi adapter. It requires Apple Silicon macOS and Agent Guard [installed through Homebrew](https://github.com/Entwining/agent-guard/blob/main/docs/setup.md#install).

Without Agent Guard, every guarded tool call is blocked. If you do not use it, [disable the extension with `pi config` or a package filter](setup.md#install).

## OS sandbox

`sandbox.ts` runs the `bash` tool and `!`/`!!` commands inside an OS sandbox built with [Sandbox Runtime](https://github.com/anthropics/sandbox-runtime) (Seatbelt, so macOS only), and blocks `write` and `edit` calls outside the same write policy. It also blocks Pi's `powershell` tool, which runs commands through an executor it cannot wrap. Pi and its extensions stay outside the sandbox.

`sandbox.ts` is on in every mode. The only way to turn it off is to start Pi with `--no-sandbox`; no tool or command in the session changes it. Project settings and extensions from a trusted project carry the same authority as your own: a project can filter this package's extensions or register its own `bash` tool, so the sandbox protects only sessions whose project configuration you trust. Within a session, it keeps commands from writing the paths that would change that configuration on a later start. Pi's argument parser takes the next word after an extension flag as its value, so put `--no-sandbox` before other options, not directly before the prompt. Pi turns a boolean extension flag on whenever it appears, even as `--no-sandbox=false`, so a launcher that keeps the sandbox on must leave the flag out.

The policy is read each time a session's sandbox starts (in RPC mode, twice for each new, resumed, forked, or cloned session) from `extensions/sandbox.json` in Pi's agent directory (`~/.pi/agent/extensions/sandbox.json`, or under `PI_CODING_AGENT_DIR`). An SDK host that passes another `agentDir` to `createAgentSession` still gets the policy and protections of that process-wide directory, because Pi does not tell extensions the session's own. Sandbox Runtime keeps one policy per process, so while one session in a host runs the sandbox, commands in another session of the same process are blocked, including a session that shares its resource loader or was opened from the same session file. A session releases the sandbox when it shuts down or is disposed, also while its sandbox is still starting. `--no-sandbox` applies to each session as it starts. Pi's own modes run one session at a time and finish its shutdown before the next one starts, provided an RPC client waits for one session switch to reply before sending the next; overlapping switches can leave the later sessions' commands blocked; a host that runs several sessions at once in one process meets these limits: sessions that share a resource loader use the shell settings and `--no-sandbox` value read by the latest start, two live sessions that share a session manager count as one, a session the host moves to another ID with `newSession()` keeps the sandbox after it is disposed, and a dispose without a shutdown while a sandbox starts blocks a session that starts on another loader before the stop finishes. The file holds [Sandbox Runtime settings](https://github.com/anthropics/sandbox-runtime#configuration), validated with the schema of the pinned `@anthropic-ai/sandbox-runtime` version. `network.allowedDomains`, `network.deniedDomains`, `filesystem.denyRead`, `filesystem.allowWrite`, and `filesystem.denyWrite` are required; an empty `allowedDomains` lets no domain through the proxy, while settings such as `network.allowLocalBinding` and `network.allowUnixSockets` still open local connections, and an empty `allowWrite` leaves only the paths below and Sandbox Runtime's defaults writable: `/tmp/claude`, plus `~/.npm/_logs` and `~/.claude/debug` unless `filesystem.denyRead` covers them and no `filesystem.allowRead` entry reopens them. `filesystem.disabled` is refused, because it would let commands rewrite the policy itself. Optional settings such as `network.allowUnixSockets` keep Sandbox Runtime's defaults when absent. Use absolute or `~` paths.

For each session the extension adds:

- write access to the session's working directory, after following symbolic links, and to a private temporary directory, which `TMPDIR` names inside commands;
- write denies, each as spelled and after following symbolic links, for Pi's agent directory and the project's `.pi` directory with the targets of the symbolic links directly inside them, the policy file, this package's directory, the Agent Guard program, and every directory on Pi's `PATH`;
- write denies for `.pi` directories below the working directory and below the nearest existing directory of every `filesystem.allowWrite` entry, so a glob or a path created later is covered too; when that directory lies inside a project's `.pi`, the whole `.pi` is denied instead; and for Sandbox Runtime's built-in denies (Git hooks and config, shell startup files, editor settings) in the working directory.

The wrapper that applies the sandbox runs in `/bin/sh`, which reads no startup files for a command, and starts Sandbox Runtime's `env` as `/usr/bin/env` rather than looking it up on `PATH`; the shell Pi is set to use, with its startup files, runs inside the sandbox.

Pi and its extensions start programs from `PATH` outside the sandbox, so commands cannot install programs there, such as with `cargo install` or `npm install -g`. A relative or empty `PATH` entry names a directory in the working directory, which then becomes read-only as well. A program whose files live in a directory that `filesystem.allowWrite` keeps writable, such as a global npm package under a writable tool directory, can still be changed by commands, so keep the programs Pi and its extensions run out of writable directories.

Extensions that Pi loads from another writable path, such as a local package inside the working directory or another project whose `.pi` is a symbolic link to a writable directory, are not protected.

`write` and `edit` run in Pi's process, so the extension checks their target, after following symbolic links, against the same allow and deny lists before the call runs, including Seatbelt's refusal to create the ancestors of a protected path. Where that check cannot reproduce Seatbelt exactly it denies. Reads by Pi's own tools are not restricted.

If the file is missing or invalid, or the sandbox cannot start, `bash`, `!` commands, `write`, and `edit` fail with the reason instead of running unsandboxed. Seatbelt cannot be nested on macOS, so starting Pi from a command that already runs inside Seatbelt, such as another agent's sandboxed shell, blocks commands in the same way; `--no-sandbox` then leaves them to the outer sandbox.

## DeepSeek reasoning

`strip-reasoning-filler.ts` removes interjections and repeated standalone filler from replayed reasoning for DeepSeek models. It modifies the request copy and preserves the recorded transcript. The reasoning extension does nothing for other models.

The workaround depends on the provider's `reasoning_details` format. Disable or remove it when that workaround is no longer needed.
