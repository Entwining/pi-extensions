import type { CustomEntry, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { JUDGE_SYSTEM } from './sandbox-judge-policy';

// Session entries, so a resumed, forked, or rewound session gives the judge
// the messages and decisions of its own branch. Pi records the user's message
// in the transcript only after skills expand, and with no mark of whether a
// person or an extension sent it.
export const USER_MESSAGE = 'sandbox-user-message';
export const DECLINED_COMMAND = 'sandbox-declined-command';

export type Judgment = {
  verdict: 'allow' | 'review';
  reason: string;
  // Why the model gave no usable verdict, when it did not.
  failure?: string;
};

const TURN_CHARS = 16_000;
const TURNS_CHARS = 64_000;
const DECLINED_KEPT = 20;
const DECLINED_CHARS = 2000;
const JUSTIFICATION_CHARS = 8000;
// A clipped command could hide what its middle does, so a longer one is not
// judged.
const COMMAND_CHARS = 32_000;
// Generous while the judge only shadows the dialog: the log keeps each
// judgment's time, which shows what a shorter limit would cut.
const JUDGE_TIMEOUT_MS = 60_000;

// The head and tail of a long text, where a message usually puts its request
// and its last word.
function clip(text: string, max: number) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} characters left out …]\n${text.slice(-tail)}`;
}

// A message's size as JSON text, which the budgets count: a character JSON
// escapes counts as up to six, so the kept conversation stays bounded.
const size = (text: string) => JSON.stringify(text).length;

function clipTurn(text: string) {
  let max = TURN_CHARS;
  let turn = clip(text, max);
  while (size(turn) > TURN_CHARS) {
    max = Math.floor((max * TURN_CHARS) / size(turn));
    turn = clip(text, max);
  }
  return turn;
}

// The first message, which often sets the task, then the newest whose JSON
// sizes fit the budget; a message left out is undefined.
export function keptMessages(texts: readonly string[]): (string | undefined)[] {
  const [first, ...rest] = texts.map(clipTurn);
  if (first === undefined) return [];
  let room = TURNS_CHARS - size(first);
  const newest: string[] = [];
  for (const turn of rest.toReversed()) {
    if (size(turn) > room) break;
    newest.unshift(turn);
    room -= size(turn);
  }
  return [first, ...Array<undefined>(rest.length - newest.length).fill(undefined), ...newest];
}

type Turn = { kind: 'user' | 'declined'; text: string; delivered?: boolean };

const text = (entry: CustomEntry) =>
  typeof entry.data === 'object' && entry.data !== null && 'text' in entry.data
    ? String(entry.data.text)
    : '';

const messageText = (content: string | readonly { type: string; text?: string }[]) =>
  typeof content === 'string'
    ? content
    : content.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : [])).join('');

// The user's typed messages and declined commands on the branch, each where
// it was typed or declined, so the judge can tell whether a message came
// after a refusal. Pi records a message after the input entry, without a link
// to it, and later handlers and skills can rewrite its text, so typed input
// counts once a user message delivers it: the newest with the same text, as
// when a withdrawn follow-up is sent again, or, when none matches, the only
// input waiting. Input typed before the delivered
// one is dropped, such as input that a handler handled or that a fork or
// rewind returned to the editor.
function history(branch: readonly SessionEntry[]) {
  const turns: Turn[] = [];
  let waiting: Turn[] = [];
  for (const entry of branch) {
    if (entry.type === 'message' && entry.message.role === 'user') {
      const delivered = messageText(entry.message.content);
      const turn =
        waiting.findLast((typed) => typed.text === delivered) ??
        (waiting.length === 1 ? waiting[0] : undefined);
      if (turn) {
        turn.delivered = true;
        waiting = waiting.slice(waiting.indexOf(turn) + 1);
      }
    } else if (entry.type === 'custom' && entry.customType === USER_MESSAGE) {
      const turn: Turn = { kind: 'user', text: text(entry) };
      turns.push(turn);
      waiting.push(turn);
    } else if (entry.type === 'custom' && entry.customType === DECLINED_COMMAND) {
      turns.push({ kind: 'declined', text: text(entry) });
    }
  }
  const users = turns.filter((turn) => turn.delivered);
  const kept = keptMessages(users.map((turn) => turn.text));
  const clipped = new Map(users.map((turn, index) => [turn, kept[index]]));
  const declined = new Set(turns.filter((turn) => turn.kind === 'declined').slice(-DECLINED_KEPT));
  const items: object[] = [];
  let leftOut = 0;
  for (const turn of turns) {
    if (turn.kind === 'user' && !turn.delivered) continue;
    if (turn.kind === 'declined') {
      if (declined.has(turn)) items.push({ declined: clip(turn.text, DECLINED_CHARS) });
      continue;
    }
    const message = clipped.get(turn);
    if (message === undefined) {
      leftOut++;
      continue;
    }
    if (leftOut > 0) items.push({ left_out: leftOut });
    leftOut = 0;
    items.push({ user: message });
  }
  return items;
}

type Escalation = { command: string; justification: string };

// One JSON document, so text inside a message or the command cannot pose as
// another field.
function judgePrompt(branch: readonly SessionEntry[], cwd: string, call: Escalation) {
  return JSON.stringify(
    {
      history: history(branch),
      cwd,
      command: call.command,
      justification: clip(call.justification, JUSTIFICATION_CHARS),
    },
    null,
    2,
  );
}

// The JSON value that ends the reply, a closing code fence aside: the
// shortest tail that parses. A model sometimes writes a sentence before its
// verdict; a reply with anything else after it does not parse.
function lastValue(text: string): unknown {
  const body = text.replace(/\s*(?:```\s*)?$/, '');
  let start = body.length;
  while (start > 0) {
    start = body.lastIndexOf('{', start - 1);
    if (start < 0) return undefined;
    try {
      return JSON.parse(body.slice(start));
    } catch {}
  }
  return undefined;
}

const VERDICT_FIELD = /"verdict"\s*:\s*"([^"\\]*)"/g;

// Only a reply that ends with a JSON object answering `allow` allows, and one
// that states different verdicts along the way has not settled on one.
export function parseVerdict(text: string): Judgment {
  const reply = lastValue(text);
  if (typeof reply !== 'object' || reply === null)
    return { verdict: 'review', reason: 'unparsed reply', failure: 'unparsed reply' };
  const stated = new Set(Array.from(text.matchAll(VERDICT_FIELD), (match) => match[1]));
  if (stated.size > 1) {
    const failure = `conflicting verdicts: ${[...stated].join(', ')}`;
    return { verdict: 'review', reason: failure, failure };
  }
  const verdict = 'verdict' in reply ? reply.verdict : undefined;
  const reason = 'reason' in reply ? reply.reason : undefined;
  return {
    verdict: verdict === 'allow' ? 'allow' : 'review',
    reason: typeof reason === 'string' ? reason : `verdict ${String(verdict)}`,
  };
}

type JudgeContext = Pick<
  ExtensionContext,
  'cwd' | 'model' | 'modelRegistry' | 'sessionManager' | 'thinkingLevel'
>;

// Asks the session's model in a context of its own, through the session's
// provider and its authentication, so the request takes the route the session
// does. Never rejects: anything but a usable verdict is a review.
export async function judgeEscalation(
  call: Escalation,
  ctx: JudgeContext,
  signal: AbortSignal | undefined,
): Promise<Judgment> {
  const review = (failure: string): Judgment => ({ verdict: 'review', reason: failure, failure });
  if (call.command.length > COMMAND_CHARS) return review('command too long to judge whole');
  const { model } = ctx;
  if (!model) return review('no model selected');
  const deadline = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
  try {
    const reply = await ctx.modelRegistry
      .streamSimple(
        model,
        {
          systemPrompt: JUDGE_SYSTEM,
          messages: [
            {
              role: 'user',
              content: judgePrompt(ctx.sessionManager.getBranch(), ctx.cwd, call),
              timestamp: Date.now(),
            },
          ],
        },
        {
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
          reasoning: ctx.thinkingLevel === 'off' ? undefined : ctx.thinkingLevel,
        },
      )
      .result();
    if (reply.stopReason === 'aborted') return review(deadline.aborted ? 'timeout' : 'aborted');
    if (reply.stopReason === 'error') return review(`error: ${reply.errorMessage ?? 'unknown'}`);
    // A reply cut short, such as at the output limit, has not settled on a verdict.
    if (reply.stopReason !== 'stop') return review(`stopped: ${reply.stopReason}`);
    return parseVerdict(
      reply.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
    );
  } catch (error) {
    return review(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
