import { expect, test } from 'bun:test';
import { judgeEscalation, keptMessages, parseVerdict } from './sandbox-judge';

test.each([
  { reply: '{"reason": "a test run", "verdict": "allow"}', verdict: 'allow' },
  {
    reply: 'It runs the suite.\n```json\n{"reason": "r", "verdict": "allow"}\n```',
    verdict: 'allow',
  },
  { reply: '{"reason": "r", "verdict": "check", "check": []}', verdict: 'review' },
  // Anything after the verdict, or a second verdict, leaves it unsettled.
  { reply: '{"reason": "r", "verdict": "allow"} Actually, wait.', verdict: 'review' },
  {
    reply: 'First {"verdict": "review"}, then {"reason": "r", "verdict": "allow"}',
    verdict: 'review',
  },
  { reply: '', verdict: 'review' },
])('reads $reply as $verdict', ({ reply, verdict }) => {
  expect(parseVerdict(reply).verdict).toBe(verdict);
});

test('keeps the first message and the newest that fit, each clipped to its head and tail', () => {
  const long = `${'a'.repeat(20_000)}${'z'.repeat(10_000)}`;
  const kept = keptMessages(['Fix the build.', ...Array(10).fill(long), 'Do not push.']);
  expect(kept).toHaveLength(12);
  expect(kept[0]).toBe('Fix the build.');
  expect(kept[1]).toBeUndefined();
  expect(kept.at(-1)).toBe('Do not push.');
  const clipped = kept.at(-2)!;
  expect(JSON.stringify(clipped).length).toBeLessThanOrEqual(16_000);
  expect(clipped).toStartWith('a');
  expect(clipped).toEndWith('z');
  expect(clipped).toContain('characters left out');
  const sizes = kept.flatMap((text) => (text === undefined ? [] : [JSON.stringify(text).length]));
  expect(sizes.reduce((sum, size) => sum + size)).toBeLessThanOrEqual(64_000);
});

const judgeContext = (streamSimple: () => unknown) =>
  ({
    cwd: '/',
    model: { provider: 'test', id: 'judge' },
    sessionManager: { getBranch: () => [] },
    modelRegistry: { streamSimple },
  }) as unknown as Parameters<typeof judgeEscalation>[1];

test('does not judge a command it would have to clip', async () => {
  const ctx = judgeContext(() => {
    throw new Error('the model was asked');
  });
  const command = `echo ${'x'.repeat(40_000)}`;
  expect(await judgeEscalation({ command, justification: 'j' }, ctx, undefined)).toEqual({
    verdict: 'review',
    reason: 'command too long to judge whole',
    failure: 'command too long to judge whole',
  });
});

test('a reply cut short has not settled on a verdict', async () => {
  const ctx = judgeContext(() => ({
    result: async () => ({
      stopReason: 'length',
      content: [{ type: 'text', text: '{"reason": "r", "verdict": "allow"}' }],
    }),
  }));
  expect(await judgeEscalation({ command: 'ls', justification: 'j' }, ctx, undefined)).toEqual({
    verdict: 'review',
    reason: 'stopped: length',
    failure: 'stopped: length',
  });
});
