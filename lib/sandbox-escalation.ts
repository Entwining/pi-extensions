import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DECLINED_COMMAND, USER_MESSAGE, judgeEscalation, type Judgment } from './sandbox-judge';
import { POLICY_SOURCE } from './sandbox-judge-policy';
import { Type } from 'typebox';

export const escalationParameters = {
  unsandboxed: Type.Optional(
    Type.Boolean({
      description:
        'Run this command outside the OS sandbox, only after the sandbox blocked it. The user must approve the exact command first.',
    }),
  ),
  justification: Type.Optional(
    Type.String({
      description:
        'Required with unsandboxed: why the command must run outside the sandbox, such as the denial it hit. Shown to the user.',
    }),
  ),
};

export const escalationGuideline =
  'If the OS sandbox blocks a bash command the task needs (such as Operation not permitted on a path or socket), retry that command with unsandboxed: true and a justification naming the denial; the user approves or declines each such command.';

// The terminal would act on control and formatting characters other than a
// newline, or show them like other text, so a command could hide part of
// itself. When a field holds any, every field shows them as escapes and
// doubles its backslashes, which keeps different texts apart.
const hidden = /(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const escaped = (text: string) =>
  text.replace(/(?!\n)[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => {
    if (char === '\\') return '\\\\';
    // A match is one code point.
    const code = char.codePointAt(0)!.toString(16);
    return code.length > 2 ? `\\u{${code}}` : `\\x${code.padStart(2, '0')}`;
  });
// Each line of a field is indented, so a field cannot pass for another's label.
const indented = (text: string) => text.replaceAll(/^/gm, '  ');

// `asking` runs when the dialog opens, with the justification it shows.
// Resolves to the user's answer.
async function approveUnsandboxed(
  command: string,
  justification: string | undefined,
  ctx: Pick<ExtensionContext, 'cwd' | 'hasUI' | 'ui'>,
  signal: AbortSignal | undefined,
  asking?: (justification: string) => void,
) {
  if (!justification?.trim()) {
    throw new Error(
      'A command outside the sandbox needs a justification to show the user, so it did not run.',
    );
  }
  if (!ctx.hasUI) {
    throw new Error(
      'Running a command outside the sandbox needs the user to approve it, and this session has no interactive UI to ask, so it did not run.',
    );
  }
  asking?.(justification);
  const escapes = [command, ctx.cwd, justification].some((field) => hidden.test(field));
  const show = (field: string) => indented(escapes ? escaped(field) : field);
  const approved = await ctx.ui.confirm(
    'Run this command outside the sandbox?',
    [
      `Command:\n${show(command)}`,
      `Directory:\n${show(ctx.cwd)}`,
      `Reason:\n${show(justification)}`,
      ...(escapes
        ? [
            '\nControl and formatting characters are shown as \\x or \\u{} escapes, and each backslash as \\\\.',
          ]
        : []),
      '\nIt runs with your full permissions. If it already ran inside the sandbox, that attempt may have left partial changes.',
    ].join('\n'),
    { signal },
  );
  // In RPC mode Pi passes on the client's answer without checking its type.
  return approved === true;
}

// The shadow mode judges each request while the user still answers the
// dialog, so the log can show how the judge would have answered before any
// mode acts on it.
function readJudgeMode(path: string): 'shadow' | undefined {
  if (!existsSync(path)) return undefined;
  const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isDeepStrictEqual(config, { mode: 'shadow' }))
    throw new Error(`${path} must hold exactly {"mode": "shadow"}.`);
  return 'shadow';
}

type ApprovalContext = Pick<
  ExtensionContext,
  'cwd' | 'hasUI' | 'ui' | 'model' | 'modelRegistry' | 'sessionManager' | 'thinkingLevel'
>;
type Owner = ExtensionContext['sessionManager'];

// Wraps the dialog for commands outside the sandbox. In a session that
// `extensions/sandbox-judge.json` in Pi's agent directory puts in shadow mode,
// the judge answers each request the dialog asks about, and the verdict, the
// user's answer, and the time the judge took go to `sandbox-judge.jsonl`
// beside it, where sandboxed commands cannot write. The judge sees only
// requests from a session whose sandbox `runs`: one made because the sandbox
// could not start stays the user's alone.
export function escalationApproval(
  pi: Pick<ExtensionAPI, 'appendEntry' | 'on'>,
  agentDir: string,
  runs: (owner: Owner) => boolean,
) {
  const configPath = join(agentDir, 'extensions', 'sandbox-judge.json');
  const logPath = join(agentDir, 'extensions', 'sandbox-judge.jsonl');
  const shadowed = new WeakSet<Owner>();
  // Answered requests whose judgment is still running, by session, each with
  // the write of its log line.
  const pending = new Map<AbortController, { owner: Owner; finish: (verdict: Judgment) => void }>();

  // Only the user's typed messages carry their authority; an extension's or an
  // RPC client's do not. Skills expand after every input handler has run, but
  // each handler receives the text earlier ones returned, so this package
  // loads sandbox.ts before inline-skill-invocation.ts, which rewrites input.
  pi.on('input', (event, ctx) => {
    if (event.source === 'interactive' && shadowed.has(ctx.sessionManager))
      pi.appendEntry(USER_MESSAGE, { text: event.text });
  });

  return {
    start(ctx: Pick<ExtensionContext, 'sessionManager' | 'ui'>) {
      shadowed.delete(ctx.sessionManager);
      try {
        if (readJudgeMode(configPath)) shadowed.add(ctx.sessionManager);
      } catch (error) {
        ctx.ui.notify(
          `The sandbox judge is off because ${configPath} could not be read: ${error instanceof Error ? error.message : error}`,
          'warning',
        );
      }
    },

    async approve(
      command: string,
      justification: string | undefined,
      ctx: ApprovalContext,
      signal: AbortSignal | undefined,
      { toolCallId, prefix }: { toolCallId: string; prefix: string | undefined },
    ) {
      let judged:
        | {
            line: object;
            started: number;
            owner: Owner;
            judgment: Promise<Judgment>;
            stopped: AbortController;
          }
        | undefined;
      // A dialog that fails, or that the call's abort closes, is not the user's answer.
      let answer: 'approved' | 'declined' | 'aborted' | 'failed' = 'failed';
      try {
        const approved = await approveUnsandboxed(command, justification, ctx, signal, (shown) => {
          // An aborted call's dialog closes before the user can answer.
          if (signal?.aborted || !runs(ctx.sessionManager) || !shadowed.has(ctx.sessionManager))
            return;
          const started = Date.now();
          // Read while the dialog opens: the session may be replaced before it closes.
          const line = {
            at: new Date(started).toISOString(),
            session: ctx.sessionManager.getSessionId(),
            toolCallId,
            policy: POLICY_SOURCE,
            model: ctx.model && `${ctx.model.provider}/${ctx.model.id}`,
            thinking: ctx.thinkingLevel,
            ...(prefix ? { prefix } : {}),
          };
          const stopped = new AbortController();
          const judgment = judgeEscalation(
            { command, justification: shown },
            ctx,
            signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal,
          );
          judged = { line, started, owner: ctx.sessionManager, judgment, stopped };
        });
        answer = approved ? 'approved' : signal?.aborted ? 'aborted' : 'declined';
      } finally {
        if (judged) {
          const { line, started, owner, judgment, stopped } = judged;
          if (answer === 'declined') pi.appendEntry(DECLINED_COMMAND, { text: command });
          // Writes the line once: with the verdict, or when the session ends first.
          const finish = (verdict: Judgment) => {
            if (!pending.delete(stopped)) return;
            const ms = Date.now() - started;
            try {
              appendFileSync(logPath, `${JSON.stringify({ ...line, answer, ...verdict, ms })}\n`);
            } catch (error) {
              console.error(`Writing ${logPath} failed:`, error);
            }
          };
          pending.set(stopped, { owner, finish });
          void judgment.then(finish);
        }
      }
      if (answer !== 'approved') {
        throw new Error(
          'The command was not approved to run outside the sandbox, so it did not run.',
        );
      }
    },

    // Pi can exit as soon as shutdown handlers finish, without waiting for
    // the provider, so the session's unfinished judgments are logged at once.
    stop(owner: Owner) {
      for (const [stopped, judged] of pending) {
        if (judged.owner !== owner) continue;
        judged.finish({ verdict: 'review', reason: 'session ended', failure: 'session ended' });
        stopped.abort();
      }
    },
  };
}
