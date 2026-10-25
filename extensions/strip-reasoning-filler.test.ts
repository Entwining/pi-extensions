import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from '@earendil-works/pi-coding-agent';
import stripReasoningFiller from './strip-reasoning-filler';

let handler: ExtensionHandler<BeforeProviderRequestEvent, unknown>;
stripReasoningFiller({
  on: (_event: string, registered: typeof handler) => {
    handler = registered;
    return () => {};
  },
} as unknown as ExtensionAPI);
const context = { model: { id: 'deepseek/deepseek-v4.1-flash' } } as ExtensionContext;

test('applies to every DeepSeek model ID', async () => {
  const payload = { messages: [{ reasoning_details: [{ text: 'Hmm, important reasoning.' }] }] };
  expect(
    await handler({ type: 'before_provider_request', payload }, {
      model: { id: 'deepseek/deepseek-v4-pro-0813' },
    } as ExtensionContext),
  ).toEqual({ messages: [{ reasoning_details: [{ text: 'important reasoning.' }] }] });
});

test.each(['zai/glm-5.3', undefined])('leaves model %s untouched', async (id) => {
  const payload = { messages: [{ reasoning_details: [{ text: 'Hmm, important reasoning.' }] }] };
  expect(
    await handler({ type: 'before_provider_request', payload }, {
      model: id ? { id } : undefined,
    } as ExtensionContext),
  ).toBeUndefined();
});

test('deduplicates standalone filler across messages without mutating its input', async () => {
  const payload = {
    request_id: 'fixture',
    messages: [
      {
        reasoning_details: [
          {
            type: 'reasoning.text',
            id: 'one',
            text: 'Hmm, Let me do it.\n\nFirst useful thought.',
          },
        ],
      },
      {
        reasoning_details: [
          { type: 'reasoning.text', id: 'two', text: 'Let me do it.\n\nSecond useful thought.' },
        ],
      },
      {
        reasoning_details: [
          { type: 'reasoning.text', id: 'three', text: 'Let me do it.\n\nThird useful thought.' },
        ],
      },
      { role: 'user', content: 'Keep this message.' },
    ],
  };
  const original = structuredClone(payload);
  const result = await handler({ type: 'before_provider_request', payload }, context);
  expect(result).toEqual({
    ...payload,
    messages: [
      {
        reasoning_details: [
          { type: 'reasoning.text', id: 'one', text: 'Let me do it.\n\nFirst useful thought.' },
        ],
      },
      {
        reasoning_details: [{ type: 'reasoning.text', id: 'two', text: 'Second useful thought.' }],
      },
      {
        reasoning_details: [{ type: 'reasoning.text', id: 'three', text: 'Third useful thought.' }],
      },
      payload.messages[3],
    ],
  });
  expect(result).not.toBe(payload);
  expect(payload).toEqual(original);
});

test('preserves fenced code and repeated list items', async () => {
  const text = [
    '```text',
    'Hmm, Let me do it.',
    '',
    'Hmm, Let me do it.',
    '',
    'Hmm, Let me do it.',
    '```',
    '',
    '- Keep this step.',
    '- Keep this step.',
    '- Keep this step.',
  ].join('\n');
  const payload = { messages: [{ reasoning_details: [{ text }] }] };
  expect(await handler({ type: 'before_provider_request', payload }, context)).toEqual(payload);
});

test('recognizes fences opened and closed after list and quote markers', async () => {
  const fence = ['- 1. 2) + * >\t~~~text', '> Hmm, Let me do it.', '- 1. 2) + * >~~~'];
  const payload = {
    messages: [{ reasoning_details: [{ text: [...fence, 'Hmm, outside.'].join('\n') }] }],
  };
  expect(await handler({ type: 'before_provider_request', payload }, context)).toEqual({
    messages: [{ reasoning_details: [{ text: [...fence, 'outside.'].join('\n') }] }],
  });
});

test('treats a list marker without following whitespace as prose', async () => {
  const payload = {
    messages: [{ reasoning_details: [{ text: '-```\nHmm, important reasoning.' }] }],
  };
  expect(await handler({ type: 'before_provider_request', payload }, context)).toEqual({
    messages: [{ reasoning_details: [{ text: '-```\nimportant reasoning.' }] }],
  });
});

// A fence prefix that lets markers share whitespace backtracks exponentially when no fence
// follows. On Node, which Pi runs on, such a match blocks until it ends, so the deadline is
// enforced outside the process. Bun abandons a runaway match and reports no match, which
// hides the regression.
test('does not backtrack exponentially on long marker runs without a fence', () => {
  const text = ['> ', '>\t', '-  ', '-\t\t'].map((marker) => `${marker.repeat(64)}x`).join('\n');
  const payload = { messages: [{ reasoning_details: [{ text }] }] };
  const script = `
    const { default: stripReasoningFiller } = await import(${JSON.stringify(new URL('./strip-reasoning-filler.ts', import.meta.url).href)});
    stripReasoningFiller({
      on: (_event, handler) => console.log(JSON.stringify(handler(${JSON.stringify({ type: 'before_provider_request', payload })}, ${JSON.stringify(context)}))),
    });
  `;
  const result = spawnSync('node', ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 3_000,
    killSignal: 'SIGKILL',
  });
  expect(result).toMatchObject({ status: 0, stdout: `${JSON.stringify(payload)}\n` });
});

test('keeps meaningful standalone repetition below the filler threshold', async () => {
  const payload = {
    messages: [{ reasoning_details: [{ text: 'Keep this thought.\n\nKeep this thought.' }] }],
  };
  expect(await handler({ type: 'before_provider_request', payload }, context)).toEqual(payload);
});
