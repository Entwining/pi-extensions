import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import {
  agentDir,
  cleanup,
  config,
  configPath,
  manager,
  outside,
  prepare,
  privateTmp,
  project,
  root,
  run,
  setPlatform,
  start,
} from '../tests/fixtures/sandbox-extension';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
beforeEach(prepare);
afterAll(cleanup);

test('wraps commands with a private TMPDIR and keeps file tools inside the write policy', async () => {
  const session = start();
  await session.started;
  expect(session.tools.map((tool) => [tool.name, tool.defaultActive])).toEqual([['bash', false]]);
  expect(manager.initialized?.filesystem.allowWrite).toEqual([
    { path: project, literal: true },
    { path: expect.stringContaining('pi-sandbox-'), literal: true },
  ]);
  const tmp = privateTmp();
  // The project is not the process's working directory, so the runtime's own
  // Git and shell denies, anchored there, must be repeated for the project.
  expect(manager.initialized?.filesystem.denyWrite).toEqual(
    expect.arrayContaining([
      join(project, 'locked'),
      { path: agentDir, literal: true },
      { path: configPath, literal: true },
      { path: packageRoot, literal: true },
      { path: join(project, '.pi'), literal: true },
      join(project, '*', '.pi'),
      { path: join(project, '.git', 'hooks'), literal: true },
      join(project, '**', '.git', 'hooks', '**'),
    ]),
  );
  expect(manager.initialized?.network.allowUnixSockets).toEqual([tmp]);
  const result = await run(session.operations(), 'printf %s "$TMPDIR"; test -d "$TMPDIR"');
  expect(result).toEqual({ exitCode: 0, output: tmp });
  // Node's fetch ignores the sandbox proxy without it, also when Pi runs without it.
  const proxyEnv = process.env.NODE_USE_ENV_PROXY;
  delete process.env.NODE_USE_ENV_PROXY;
  expect(await run(session.operations(), 'printf %s "$NODE_USE_ENV_PROXY"')).toEqual({
    exitCode: 0,
    output: '1',
  });
  if (proxyEnv !== undefined) process.env.NODE_USE_ENV_PROXY = proxyEnv;
  // The shell that starts the wrapper runs before Seatbelt applies, so it must
  // not read a startup file that commands can write.
  const startup = join(outside, 'startup');
  process.env.BASH_ENV = startup;
  writeFileSync(startup, `touch ${join(outside, 'startup-ran')}`);
  await run(session.operations(), 'true');
  delete process.env.BASH_ENV;
  expect(existsSync(join(outside, 'startup-ran'))).toBe(false);
  // Nor may it look up the wrapper's env in the command's directory, which an
  // empty PATH entry names.
  writeFileSync(join(project, 'env'), `#!/bin/sh\ntouch '${join(outside, 'env-ran')}'\n`, {
    mode: 0o755,
  });
  const path = process.env.PATH;
  process.env.PATH = `:${path}`;
  expect(await run(session.operations(), 'echo ran')).toEqual({ exitCode: 0, output: 'ran\n' });
  process.env.PATH = path;
  rmSync(join(project, 'env'));
  expect(existsSync(join(outside, 'env-ran'))).toBe(false);

  expect(session.toolCall('write', { path: 'notes.txt', content: '' })).toBeUndefined();
  expect(
    session.toolCall('write', { path: 'node_modules/pkg/.pi/settings.json', content: '' }),
  ).toBeUndefined();
  for (const path of [
    join(outside, 'notes.txt'),
    'locked/notes.txt',
    configPath,
    '.pi/settings.json',
    'sub/.pi/extensions/a.ts',
    '.hidden/.git/hooks/pre-commit',
  ]) {
    expect(session.toolCall('write', { path, content: '' })?.reason).toContain(
      'sandbox write policy blocks',
    );
  }
  expect(session.toolCall('edit', { path: '.git/config', edits: [] })?.block).toBe(true);
  expect(session.toolCall('powershell', { command: 'Get-Date' })?.block).toBe(true);
  expect(session.toolCall('read', { path: join(outside, 'notes.txt') })).toBeUndefined();

  const before = manager.resets;
  await session.stop();
  expect(manager.resets).toBe(before + 1);
  await expect(run(session.operations(), 'true')).rejects.toThrow('The session has ended.');
});

test('lets commands use sockets in the private TMPDIR as well as those the policy allows', async () => {
  const network = { ...config.network, allowUnixSockets: ['/var/run/example.sock'] };
  writeFileSync(configPath, JSON.stringify({ ...config, network }));
  // As long as a macOS per-user temporary directory in /var/folders.
  const tmpEnv = process.env.TMPDIR;
  process.env.TMPDIR = join(root, 'T'.repeat(60));
  mkdirSync(process.env.TMPDIR, { recursive: true });
  const session = start();
  await session.started;
  if (tmpEnv === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = tmpEnv;
  expect(manager.initialized?.network.allowUnixSockets).toEqual([
    '/var/run/example.sock',
    privateTmp(),
  ]);
  // Tools bind sockets in directories of their own there, as a cargo cache
  // wrapper does, and macOS refuses a socket path of 104 bytes or more.
  const socket = join(privateTmp(), 'mbx-session-cAjTKA', 'cache-agent.sock');
  expect(Buffer.byteLength(socket)).toBeLessThan(104);
  await session.stop();
});

test.each([
  { problem: 'a missing config', setup: () => rmSync(configPath), message: 'Cannot read' },
  {
    problem: 'an invalid config',
    setup: () => writeFileSync(configPath, JSON.stringify({ network: {} })),
    message: 'is invalid',
  },
  {
    problem: 'a nested sandbox',
    setup: () => {
      manager.wrap = () =>
        'echo "sandbox-exec: sandbox_apply: Operation not permitted" >&2; exit 71';
    },
    message: 'does not allow a nested one',
  },
  { problem: 'Linux', setup: () => setPlatform('linux'), message: 'supports only macOS' },
  {
    problem: 'a disabled file system policy',
    setup: () => {
      const filesystem = { ...config.filesystem, disabled: true };
      writeFileSync(configPath, JSON.stringify({ ...config, filesystem }));
    },
    message: 'sets filesystem.disabled',
  },
])('fails closed on $problem', async ({ setup, message }) => {
  setup();
  const session = start();
  await session.started;
  expect(session.notices.join('\n')).toContain(message);
  await expect(run(session.operations(), 'echo should-not-run')).rejects.toThrow(message);
  expect(session.toolCall('write', { path: 'notes.txt', content: '' })?.reason).toContain(message);
});

test('--no-sandbox leaves commands and file tools to Pi in the sessions started with it', async () => {
  const flags = { 'no-sandbox': true };
  const session = start(flags);
  await session.started;
  expect(manager.initialized).toBeUndefined();
  expect(session.operations()).toBeUndefined();
  expect(
    session.toolCall('write', { path: join(outside, 'notes.txt'), content: '' }),
  ).toBeUndefined();
  expect(session.toolCall('powershell', { command: 'Get-Date' })).toBeUndefined();
  expect(session.notices.join('\n')).toContain('--no-sandbox');
  // Commands already run outside, so a request to leave the sandbox needs no approval.
  expect(await session.bash({ command: 'echo ran', unsandboxed: true })).toBe('ran\n');
  expect(session.dialogs).toEqual([]);
  // An SDK host can clear the flag for the next session of the same loaded copy.
  flags['no-sandbox'] = false;
  const next = session.another();
  await next.started;
  expect(await run(next.operations(), 'true')).toEqual({ exitCode: 0, output: '' });
  expect(manager.initialized).toBeDefined();
  expect(next.toolCall('write', { path: join(outside, 'notes.txt'), content: '' })?.block).toBe(
    true,
  );
  expect(session.operations()).toBeUndefined();
  await next.stop();
  // So can a repeated start of the same session.
  await session.restart();
  expect(await run(session.operations(), 'true')).toEqual({ exitCode: 0, output: '' });
  await session.stop();
});

test('blocks a write whose missing parent directory the policy does not allow', async () => {
  const file = join(outside, 'made', 'a.txt');
  const filesystem = { ...config.filesystem, allowWrite: [file] };
  writeFileSync(configPath, JSON.stringify({ ...config, filesystem }));
  const session = start();
  await session.started;
  expect(session.toolCall('write', { path: file, content: '' })?.reason).toContain(
    `Pi would first create ${join(outside, 'made')}`,
  );
  await session.stop();
});
