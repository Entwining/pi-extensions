import { cleanupSessionResources } from '@earendil-works/pi-ai';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import {
  cleanup,
  manager,
  outside,
  prepare,
  privateTmp,
  project,
  run,
  start,
} from '../tests/fixtures/sandbox-extension';

beforeEach(prepare);
afterAll(cleanup);

// A directory the session cannot delete must not keep its policy in force.
const lockCache = (tmp: string) => {
  mkdirSync(join(tmp, 'cache', 'locked'), { recursive: true });
  chmodSync(join(tmp, 'cache', 'locked'), 0o000);
  chmodSync(join(tmp, 'cache'), 0o555);
};

test('a repeated session start replaces the running sandbox', async () => {
  const session = start();
  await session.started;
  const first = privateTmp();
  writeFileSync(join(project, 'data'), '', { mode: 0o644 });
  mkdirSync(join(first, 'cache', 'locked'), { recursive: true });
  linkSync(join(project, 'data'), join(first, 'cache', 'locked', 'data'));
  lockCache(first);
  const wrapped: string[] = [];
  manager.wrap = (command) => (wrapped.push(command), command);
  const before = manager.resets;
  await session.restart();
  expect(manager.resets).toBe(before + 1);
  expect(privateTmp()).not.toBe(first);
  expect(existsSync(first)).toBe(false);
  // A command may still run, so its directories are made writable inside the
  // sandbox, and a file linked from elsewhere keeps its mode.
  expect(wrapped.some((command) => command.includes(`find '${first}' -type d`))).toBe(true);
  expect(statSync(join(project, 'data')).mode & 0o777).toBe(0o644);
  await session.stop();
  expect(existsSync(privateTmp())).toBe(false);
});

test('cleans up after a session whose working directory is gone', async () => {
  const gone = join(outside, 'gone');
  mkdirSync(gone);
  const session = start({}, {}, gone);
  await session.started;
  const tmp = privateTmp();
  lockCache(tmp);
  rmSync(gone, { recursive: true });
  await session.stop();
  expect(existsSync(tmp)).toBe(false);
});

test('opens tools only after the self-test, and a shutdown during the start stops the sandbox', async () => {
  let release = () => {};
  const selfTest = new Promise<void>((resolve) => (release = resolve));
  manager.wrap = async (command) => (await selfTest, command);
  const session = start();
  while (!manager.initialized) await Bun.sleep(1);
  expect(session.toolCall('write', { path: 'notes.txt', content: '' })?.reason).toContain(
    'has not finished starting',
  );
  const stopped = session.stop();
  release();
  await Promise.all([session.started, stopped]);
  expect(existsSync(privateTmp())).toBe(false);
  await expect(run(session.operations(), 'true')).rejects.toThrow('The session has ended.');
});

test('fails closed for a second session while another in the process runs the sandbox', async () => {
  const first = start();
  await first.started;
  const resets = manager.resets;
  const second = start();
  await second.started;
  expect(second.notices.join('\n')).toContain('already runs the sandbox');
  await expect(run(second.operations(), 'true')).rejects.toThrow('already runs the sandbox');
  expect(manager.resets).toBe(resets);
  // The failed start leaves the first session's turn alone.
  const third = start();
  await third.started;
  expect(third.notices.join('\n')).toContain('already runs the sandbox');
  expect(await run(first.operations(), 'true')).toEqual({ exitCode: 0, output: '' });
  await first.stop();
  const next = start();
  await next.started;
  expect(await run(next.operations(), 'true')).toEqual({ exitCode: 0, output: '' });
  await next.stop();
});

test('a second session of the same loaded copy fails closed and leaves the first running', async () => {
  const first = start();
  await first.started;
  const second = first.another();
  await second.started;
  expect(second.notices.join('\n')).toContain('already runs the sandbox');
  await expect(run(second.operations(), 'true')).rejects.toThrow('already runs the sandbox');
  expect(second.toolCall('write', { path: 'notes.txt', content: '' })?.block).toBe(true);
  await second.stop();
  // The failed start leaves the first session's turn alone.
  const other = start();
  await other.started;
  expect(other.notices.join('\n')).toContain('already runs the sandbox');
  expect(await run(first.operations(), 'true')).toEqual({ exitCode: 0, output: '' });
  expect(first.toolCall('write', { path: 'notes.txt', content: '' })).toBeUndefined();
  await first.stop();
  const next = first.another();
  await next.started;
  expect(await run(next.operations(), 'true')).toEqual({ exitCode: 0, output: '' });
  await next.stop();
});

test('a session opened again from the same transcript fails closed and leaves the first running', async () => {
  const first = start();
  await first.started;
  const tmp = privateTmp();
  const resets = manager.resets;
  const copy = first.another(first.sessionId);
  await copy.started;
  expect(copy.notices.join('\n')).toContain('already runs the sandbox');
  await expect(run(copy.operations(), 'true')).rejects.toThrow('already runs the sandbox');
  await copy.stop();
  // Disposing such a session in another loaded copy reports the same ID.
  const other = start({}, {}, project, first.sessionId);
  await other.started;
  expect(other.notices.join('\n')).toContain('already runs the sandbox');
  other.dispose();
  await Bun.sleep(1);
  expect(manager.resets).toBe(resets);
  expect(existsSync(tmp)).toBe(true);
  expect(await run(first.operations(), 'true')).toEqual({ exitCode: 0, output: '' });
  await first.stop();
});

test('a session disposed without a shutdown gives the sandbox back', async () => {
  const session = start();
  await session.started;
  const tmp = privateTmp();
  cleanupSessionResources('another-session');
  // The callback stops a session asynchronously.
  await Bun.sleep(1);
  expect(await run(session.operations(), 'true')).toEqual({ exitCode: 0, output: '' });
  session.dispose();
  // The next session waits for the disposed one to stop.
  const next = start();
  await next.started;
  expect(next.notices).toEqual([]);
  expect(existsSync(tmp)).toBe(false);
  await next.stop();
});

test('a session disposed while its sandbox starts stops it once it is up', async () => {
  let release = () => {};
  const selfTest = new Promise<void>((resolve) => (release = resolve));
  manager.wrap = async (command) => (await selfTest, command);
  const session = start();
  while (!manager.initialized) await Bun.sleep(1);
  const tmp = privateTmp();
  session.dispose();
  release();
  await session.started;
  await Bun.sleep(1);
  const next = start();
  await next.started;
  expect(next.notices).toEqual([]);
  expect(existsSync(tmp)).toBe(false);
  await next.stop();
});

test('a failed stop after a dispose is reported rather than left unhandled', async () => {
  const session = start();
  await session.started;
  manager.resetError = new Error('reset failed');
  const errors: unknown[][] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  session.dispose();
  await Bun.sleep(1);
  console.error = consoleError;
  expect(errors.flat()).toContain(manager.resetError);
});

test('a start that fails after taking the sandbox gives it back', async () => {
  manager.wrap = () => 'exit 1';
  await start().started;
  manager.wrap = (command) => command;
  const next = start();
  await next.started;
  expect(next.notices).toEqual([]);
  await next.stop();
});
