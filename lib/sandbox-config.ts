import { readFileSync } from 'node:fs';

export async function readPolicy(configPath: string) {
  const { SandboxRuntimeConfigSchema } = await import('@anthropic-ai/sandbox-runtime');
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot read ${configPath} (${error instanceof Error ? error.message : error}).`,
    );
  }
  const parsed = SandboxRuntimeConfigSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${configPath} is invalid: ${parsed.error.message}`);
  if (parsed.data.filesystem.disabled) {
    throw new Error(
      `${configPath} sets filesystem.disabled, which would let commands rewrite the policy itself. Start Pi with --no-sandbox to run commands without the sandbox.`,
    );
  }
  return parsed.data;
}
