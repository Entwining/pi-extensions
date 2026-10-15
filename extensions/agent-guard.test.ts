import * as childProcess from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';

const pass: SpawnSyncReturns<string> = {
  pid: 1,
  output: [null, '', ''],
  stdout: '',
  stderr: '',
  status: 0,
  signal: null,
};
const spawn = spyOn(childProcess, 'spawnSync').mockReturnValue(pass);
const { default: agentGuard } = await import('./agent-guard');
let handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>;
agentGuard({
  on: (_event: string, registered: typeof handler) => {
    handler = registered;
    return () => {};
  },
} as unknown as ExtensionAPI);
const context = { cwd: '/synthetic-project' } as ExtensionContext;

beforeEach(() => {
  spawn.mockClear();
  spawn.mockReturnValue(pass);
});
afterAll(() => spawn.mockRestore());

test.each([
  {
    toolName: 'bash',
    input: { command: 'pwd' },
    expected: { tool_name: 'Bash', tool_input: { command: 'pwd' } },
  },
  {
    toolName: 'read',
    input: { path: 'source.ts' },
    expected: { tool_name: 'read', tool_input: { file_path: 'source.ts' } },
  },
  {
    toolName: 'edit',
    input: { path: 'source.ts', oldText: 'a', newText: 'b' },
    expected: { tool_name: 'edit', tool_input: { file_path: 'source.ts' } },
  },
  {
    toolName: 'write',
    input: { path: 'source.ts', content: 'fixture' },
    expected: { tool_name: 'write', tool_input: { file_path: 'source.ts' } },
  },
  {
    toolName: 'grep',
    input: { path: 'src', glob: '*.ts', pattern: 'fixture' },
    expected: { tool_name: 'Grep', tool_input: { path: 'src', glob: '*.ts' } },
  },
  {
    toolName: 'find',
    input: { path: 'src', pattern: '*.ts' },
    expected: { tool_name: 'Grep', tool_input: { path: 'src' } },
  },
  {
    toolName: 'ls',
    input: { path: 'src' },
    expected: { tool_name: 'Read', tool_input: { file_path: 'src' } },
  },
  { toolName: 'ls', input: {}, expected: { tool_name: 'Read', tool_input: { file_path: '.' } } },
])('maps $toolName into the shared guard protocol', async ({ toolName, input, expected }) => {
  expect(
    await handler({ type: 'tool_call', toolCallId: 'fixture', toolName, input }, context),
  ).toBeUndefined();
  expect(spawn).toHaveBeenCalledWith(
    '/opt/homebrew/bin/agent-guard',
    ['--runtime', 'pi'],
    expect.objectContaining({
      input: JSON.stringify({ ...expected, cwd: context.cwd }),
      encoding: 'utf8',
    }),
  );
});

test('preserves a guard rejection reason', async () => {
  spawn.mockReturnValue({ ...pass, status: 2, stderr: '  Protected input\n' });
  expect(
    await handler(
      { type: 'tool_call', toolCallId: 'fixture', toolName: 'bash', input: { command: 'pwd' } },
      context,
    ),
  ).toEqual({ block: true, reason: 'Protected input' });
});

test.each([
  {
    outcome: 'an executable that cannot start',
    // Node and Bun return no output streams here, unlike the declared result type.
    result: {
      ...pass,
      output: null,
      stdout: undefined,
      stderr: undefined,
      status: null,
      error: new Error('spawnSync agent-guard ENOENT'),
    } as unknown as SpawnSyncReturns<string>,
    failure: '(spawnSync agent-guard ENOENT)',
  },
  {
    outcome: 'a guard check that timed out',
    result: {
      ...pass,
      status: null,
      signal: 'SIGTERM' as const,
      error: new Error('spawnSync agent-guard ETIMEDOUT'),
    },
    failure: '(spawnSync agent-guard ETIMEDOUT)',
  },
  {
    outcome: 'an exit outside the guard protocol',
    result: { ...pass, status: 1, stderr: 'unmarked crash output' },
    failure: '(exit 1)',
  },
  {
    outcome: 'a guard killed by a signal',
    result: { ...pass, status: null, signal: 'SIGSEGV' as const },
    failure: '(signal SIGSEGV)',
  },
])('marks $outcome as an unavailable guard', async ({ result, failure }) => {
  spawn.mockReturnValue(result);
  const blocked = await handler(
    { type: 'tool_call', toolCallId: 'fixture', toolName: 'read', input: { path: 'source.ts' } },
    context,
  );
  expect(blocked?.block).toBe(true);
  expect(blocked?.reason).toStartWith('[error:agent-guard/guard_unavailable] ');
  expect(blocked?.reason).toContain(failure);
});

test('leaves unrelated extension tools to their owner', async () => {
  expect(
    await handler(
      { type: 'tool_call', toolCallId: 'fixture', toolName: 'custom_tool', input: {} },
      context,
    ),
  ).toBeUndefined();
  expect(spawn).not.toHaveBeenCalled();
});
