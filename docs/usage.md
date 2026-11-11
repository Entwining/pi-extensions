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

## DeepSeek reasoning

`strip-reasoning-filler.ts` removes interjections and repeated standalone filler from replayed reasoning for DeepSeek models. It modifies the request copy and preserves the recorded transcript. The reasoning extension does nothing for other models.

The workaround depends on the provider's `reasoning_details` format. Disable or remove it when that workaround is no longer needed.
