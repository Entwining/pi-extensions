import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import {
  cleanup,
  manager,
  outside,
  prepare,
  privateTmp,
  project,
  start,
} from '../tests/fixtures/sandbox-extension';

beforeEach(prepare);
afterAll(cleanup);

test('runs a bash call outside the sandbox only after the user approves that command', async () => {
  const session = start();
  await session.started;
  const wrapped: string[] = [];
  manager.wrap = (command) => (wrapped.push(command), command);
  const marker = join(outside, 'unsandboxed');
  const command = `touch '${marker}'; printf %s "$TMPDIR"`;
  const justification = 'The sandbox denied the socket the command needs.';
  const call = { command, unsandboxed: true, justification };
  expect(await session.bash({ command, unsandboxed: true, justification: ' ' })).toContain(
    'needs a justification',
  );
  session.user.hasUI = false;
  expect(await session.bash(call)).toContain('no interactive UI');
  session.user.hasUI = true;
  expect(await session.bash(call)).toContain('was not approved');
  expect(existsSync(marker)).toBe(false);
  expect(wrapped).toEqual([]);
  expect(session.dialogs).toEqual([
    expect.stringMatching(
      new RegExp([command, project, justification].map((part) => RegExp.escape(part)).join('[^]*')),
    ),
  ]);
  session.user.approves = true;
  const output = await session.bash(call);
  expect(existsSync(marker)).toBe(true);
  expect(output).not.toBe(privateTmp());
  expect(wrapped).toEqual([]);
  // Without the request, commands keep running in the sandbox.
  expect(await session.bash({ command: 'printf %s "$TMPDIR"' })).toBe(privateTmp());
  expect(session.dialogs).toHaveLength(2);
  await session.stop();
});

test('asks about the command as it will run, with nothing the terminal would act on', async () => {
  const session = start({}, { shellCommandPrefix: 'export PREFIXED=1' });
  await session.started;
  expect(await session.bash({ command: 'printf %s "$PREFIXED"' })).toBe('1');
  // Each would otherwise look like other text or act on the terminal.
  const command = 'true # \u001b[8mhidden\u202e\r\t\\x0d\u{e0001}';
  const justification = 'Why\u001b[2K\nDirectory: /elsewhere';
  expect(await session.bash({ command, unsandboxed: true, justification })).toContain(
    'was not approved',
  );
  expect(session.dialogs[0]).toContain(
    'Command:\n  export PREFIXED=1\n  true # \\x1b[8mhidden\\u{202e}\\x0d\\x09\\\\x0d\\u{e0001}\nDirectory:\n',
  );
  expect(session.dialogs[0]).toContain('Reason:\n  Why\\x1b[2K\n  Directory: /elsewhere\n');
  for (const char of ['\u001b', '\u202e', '\r', '\t', '\u{e0001}'])
    expect(session.dialogs[0]).not.toContain(char);
  // Only a true answer approves: Pi passes an RPC client's answer on unchecked.
  session.user.approves = 'yes' as unknown as boolean;
  expect(await session.bash({ command: 'true', unsandboxed: true, justification: 'x' })).toContain(
    'was not approved',
  );
  await session.stop();
});
