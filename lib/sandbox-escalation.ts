import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
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

export async function approveUnsandboxed(
  command: string,
  justification: string | undefined,
  ctx: Pick<ExtensionContext, 'cwd' | 'hasUI' | 'ui'>,
  signal: AbortSignal | undefined,
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
  if (approved !== true) {
    throw new Error('The command was not approved to run outside the sandbox, so it did not run.');
  }
}
