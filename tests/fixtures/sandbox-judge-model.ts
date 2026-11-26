import type { Context } from '@earendil-works/pi-ai';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';

type JudgeOptions = NonNullable<
  Parameters<ExtensionToolContext['modelRegistry']['streamSimple']>[2]
>;

// A session model for the sandbox judge: its reply, or the error its call
// throws, whether it waits until the request is aborted, and the requests it
// received.
export function judgeModel() {
  const judge = {
    reply: '{"reason": "r", "verdict": "allow"}' as string | Error,
    holds: false,
    requests: [] as { model: unknown; context: Context; options: JudgeOptions }[],
  };
  const modelRegistry = {
    streamSimple: (model: unknown, context: Context, options: JudgeOptions) => {
      judge.requests.push({ model, context, options });
      return {
        result: async () => {
          if (judge.holds) {
            await new Promise((resolve) =>
              options.signal?.addEventListener('abort', resolve, { once: true }),
            );
            return { stopReason: 'aborted', content: [] };
          }
          if (judge.reply instanceof Error) throw judge.reply;
          return { stopReason: 'stop', content: [{ type: 'text', text: judge.reply }] };
        },
      };
    },
  };
  return { judge, modelRegistry };
}
