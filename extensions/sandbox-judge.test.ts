import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import {
  agentDir,
  cleanup,
  configPath,
  outside,
  prepare,
  start,
} from '../tests/fixtures/sandbox-extension';

const judgeConfig = join(agentDir, 'extensions', 'sandbox-judge.json');
const judgeLog = join(agentDir, 'extensions', 'sandbox-judge.jsonl');
const justification = 'Seatbelt denied the Mach service registration Chromium needs.';
const echo = { command: 'echo ran', unsandboxed: true, justification };

beforeEach(() => {
  prepare();
  rmSync(judgeConfig, { force: true });
  rmSync(judgeLog, { force: true });
});
afterAll(cleanup);

// The log is written once the judge answers, after the call returns.
async function logLines(count: number) {
  for (let wait = 0; wait < 100; wait++) {
    const lines = existsSync(judgeLog) ? readFileSync(judgeLog, 'utf8').trim().split('\n') : [];
    if (lines.length >= count) return lines.map((line) => JSON.parse(line));
    await Bun.sleep(10);
  }
  throw new Error(`${judgeLog} did not reach ${count} lines`);
}

async function shadowSession() {
  writeFileSync(judgeConfig, JSON.stringify({ mode: 'shadow' }));
  const session = start();
  await session.started;
  return session;
}

const judgedDocument = (session: ReturnType<typeof start>, index: number) => {
  const message = session.judge.requests[index]?.context.messages[0];
  return JSON.parse(typeof message?.content === 'string' ? message.content : '');
};

test('the shadow judge sees only the user’s typed words and decisions, in order, and the user still decides', async () => {
  const session = await shadowSession();
  await session.input('Run the visual regression tests.');
  await session.input('Also upload the screenshots.', 'extension');
  await session.input('Also delete the old screenshots.', 'rpc');
  const marker = join(outside, 'ran');
  const command = `touch '${marker}'`;

  // An allow does not skip the dialog, and a declined command does not run.
  expect(await session.bash({ command, unsandboxed: true, justification })).toContain(
    'was not approved',
  );
  expect(existsSync(marker)).toBe(false);
  expect(session.dialogs).toHaveLength(1);
  expect(judgedDocument(session, 0)).toEqual({
    history: [{ user: 'Run the visual regression tests.' }],
    cwd: expect.any(String),
    command,
    justification,
  });
  expect(session.judge.requests[0]?.context.systemPrompt).toContain(
    'outside the operating-system sandbox',
  );
  expect(session.judge.requests[0]?.options?.reasoning).toBe('high');
  expect(await logLines(1)).toEqual([
    expect.objectContaining({
      session: session.sessionId,
      toolCallId: 'fixture',
      model: 'test/judge',
      verdict: 'allow',
      answer: 'declined',
      ms: expect.any(Number),
    }),
  ]);

  session.judge.reply = '{"reason": "declined before", "verdict": "review"}';
  session.user.approves = true;
  await session.bash({ command, unsandboxed: true, justification });
  expect(existsSync(marker)).toBe(true);
  expect((await logLines(2))[1]).toEqual(
    expect.objectContaining({ verdict: 'review', reason: 'declined before', answer: 'approved' }),
  );
  await session.stop();
});

test('typed input counts once a user message delivers it, where it was typed', async () => {
  const session = await shadowSession();
  await session.input('Fix the build.');
  session.typed('Delete the release branch.');
  await session.input('Publish the docs.');
  // A fork or rewind to that message leaves its input entry as the branch's leaf.
  session.entries.pop();
  await session.input('Preview the docs.');
  // A skill expands the delivered text, so the only input waiting is its source.
  session.typed('/skill:review the docs');
  session.deliver('The review skill, expanded.');
  // Follow-ups queued while the agent works, delivered one at a time.
  session.typed('Check first.');
  session.typed('Then publish.');
  session.deliver('Check first.');
  await session.bash(echo);
  const before = [
    { user: 'Fix the build.' },
    { user: 'Preview the docs.' },
    { user: '/skill:review the docs' },
    { user: 'Check first.' },
  ];
  expect(judgedDocument(session, 0).history).toEqual(before);

  // Typed before the refusal, so it does not lift it.
  session.deliver('Then publish.');
  session.user.approves = true;
  await session.bash(echo);
  expect(judgedDocument(session, 1).history).toEqual([
    ...before,
    { user: 'Then publish.' },
    { declined: 'echo ran' },
  ]);

  // A follow-up queued before a refusal, withdrawn, and sent again after it.
  session.typed('Retry it.');
  session.user.approves = false;
  await session.bash(echo);
  session.typed('Retry it.');
  session.deliver('Retry it.');
  await session.bash(echo);
  expect(judgedDocument(session, 3).history.slice(-2)).toEqual([
    { declined: 'echo ran' },
    { user: 'Retry it.' },
  ]);
  await session.stop();
});

test('a failed judge leaves the dialog and the command as they were', async () => {
  const session = await shadowSession();
  session.judge.reply = new Error('provider unavailable');
  session.user.approves = true;
  expect(await session.bash(echo)).toBe('ran\n');
  expect(await logLines(1)).toEqual([
    expect.objectContaining({
      verdict: 'review',
      failure: 'error: provider unavailable',
      answer: 'approved',
    }),
  ]);
  await session.stop();
});

test('only the user’s answer counts as a decision', async () => {
  const session = await shadowSession();
  // An aborted call's dialog closes before the user can answer, so it is not judged.
  expect(await session.bash(echo, AbortSignal.abort())).toContain('was not approved');
  expect(session.judge.requests).toEqual([]);

  session.user.dialogFails = true;
  expect(await session.bash(echo)).toContain('The dialog failed.');
  expect(await logLines(1)).toEqual([expect.objectContaining({ answer: 'failed' })]);
  session.user.dialogFails = false;
  await session.bash(echo);
  expect(judgedDocument(session, 1).history).toEqual([]);
  await session.stop();
});

test.each(['stop', 'dispose'] as const)(
  'a session’s %s logs its own unfinished judgments at once',
  async (end) => {
    const session = await shadowSession();
    session.judge.holds = true;
    session.user.approves = true;
    expect(await session.bash(echo)).toBe('ran\n');
    const other = session.another();
    await other.started;
    await other.stop();
    expect(existsSync(judgeLog)).toBe(false);
    // An SDK host can dispose a session without a shutdown event.
    if (end === 'stop') await session.stop();
    else session.dispose();
    expect(await logLines(1)).toEqual([
      expect.objectContaining({ answer: 'approved', verdict: 'review', failure: 'session ended' }),
    ]);
  },
);

test.each([
  { setup: () => {}, notice: undefined, why: 'without a judge config' },
  {
    setup: () => writeFileSync(judgeConfig, JSON.stringify({ mode: 'auto' })),
    notice: 'must hold exactly {"mode": "shadow"}',
    why: 'with another judge mode',
  },
  {
    setup: () => writeFileSync(judgeConfig, JSON.stringify({ mode: 'shadow', enabled: false })),
    notice: 'must hold exactly {"mode": "shadow"}',
    why: 'with a judge config that says more',
  },
  {
    // The sandbox cannot start, so a request stays the user's alone.
    setup: () => {
      writeFileSync(judgeConfig, JSON.stringify({ mode: 'shadow' }));
      rmSync(configPath);
    },
    notice: 'Cannot read',
    why: 'when the sandbox does not run',
  },
])('asks the user alone $why', async ({ setup, notice }) => {
  setup();
  const session = start();
  await session.started;
  await session.input('Run the tests.');
  session.user.approves = true;
  expect(await session.bash(echo)).toBe('ran\n');
  expect(session.dialogs).toHaveLength(1);
  expect(session.judge.requests).toEqual([]);
  expect(existsSync(judgeLog)).toBe(false);
  if (notice) expect(session.notices.join('\n')).toContain(notice);
  await session.stop();
});
