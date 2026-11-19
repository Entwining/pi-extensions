import type { FsWriteRestrictionConfig } from '@anthropic-ai/sandbox-runtime';
import type { PathEntry } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type PathRule = { entry: string; covers: (target: string) => boolean };
// `shielded` holds each deny entry's base directory: Seatbelt also refuses to
// create it or any of its ancestors.
export type WritePolicy = { allow: PathRule[]; deny: PathRule[]; shielded: string[] };

const within = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
};

// Pi's own expansion of a setting such as shellPath (normalizePath, which its
// package root does not export): on Windows a Git Bash, MSYS, Cygwin, or WSL
// drive path becomes a native one, then ~ and file:// are expanded.
export function expandPath(input: string): string {
  const windows = process.platform === 'win32';
  const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(input);
  const path =
    windows && drive && !input.includes('\\')
      ? `${drive[1]!.toUpperCase()}:\\${drive[2]?.replaceAll('/', '\\') ?? ''}`
      : input;
  if (path === '~' || path.startsWith('~/') || (windows && path.startsWith('~\\')))
    return join(homedir(), path.slice(2));
  return path.startsWith('file://') ? fileURLToPath(path) : path;
}

// Pi's own resolution for write and edit (resolveToCwd): its Unicode space set
// and a leading @ dropped before that expansion.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
export function resolveWriteTarget(input: string, cwd: string): string {
  const path = expandPath(input.replace(UNICODE_SPACES, ' ').replace(/^@/, ''));
  return followLinks(resolve(cwd, path));
}

// The file system writes through symbolic links, including dangling ones, and
// Seatbelt checks the final path. A link's target is resolved one component at
// a time, as the kernel does, so a `..` after another link leaves the
// directory that link reached.
export function followLinks(path: string, depth = 0): string {
  try {
    return realpathSync.native(path);
  } catch {
    if (depth > 40) throw new Error(`Too many symbolic links in ${path}`);
    const parent = dirname(path);
    if (parent === path) return path;
    const directory = followLinks(parent, depth);
    const leaf = join(directory, basename(path));
    if (!lstatSync(leaf, { throwIfNoEntry: false })?.isSymbolicLink()) return leaf;
    const target = readlinkSync(leaf);
    let current = isAbsolute(target) ? '/' : directory;
    for (const part of target.split('/')) {
      if (part === '..') current = dirname(current);
      else if (part && part !== '.') current = followLinks(join(current, part), depth + 1);
    }
    return current;
  }
}

// The OS sandbox cannot see writes made by Pi's own process, so the write and
// edit tools get the same allow and deny lists as a static check. Entries are
// read as Sandbox Runtime's Seatbelt profile reads them, with its own
// normalization, glob regexes, and anchors. A deny with glob characters also
// has the readings of a directory whose name holds those characters; the
// runtime takes them from the disk on every command, so the check does too.
// Where the check cannot reproduce Seatbelt exactly it denies: denies match
// case-insensitively, as APFS does, a deny glob always covers the path it
// names, and an allow glob covers only the paths it matches, not their
// contents.
export async function compileWritePolicy(
  config: FsWriteRestrictionConfig,
  mandatory: PathEntry[],
): Promise<WritePolicy> {
  const { denyGlobRegex, escapeRegexLiteral, globToRegex } =
    await import('@anthropic-ai/sandbox-runtime/dist/sandbox/glob-pattern.js');
  const { literalReadings } =
    await import('@anthropic-ai/sandbox-runtime/dist/sandbox/path-entries.js');
  const { containsGlobChars, normalizePathForSandbox } =
    await import('@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js');
  const cover = (entry: PathEntry, deny: boolean) => {
    const fold = (value: string) => (deny ? value.toLowerCase() : value);
    if (!entry.glob) return (target: string) => within(fold(target), fold(entry.path));
    const anchor = entry.anchor ?? '';
    const compile = deny ? denyGlobRegex : globToRegex;
    const tail = compile(entry.path.slice(anchor.length)).slice(1);
    const pattern = new RegExp(`^${escapeRegexLiteral(anchor)}${tail}`, deny ? 'i' : '');
    return (target: string) => pattern.test(target);
  };
  const literal = (path: string) => normalizePathForSandbox(path, { literal: true });
  // Spelled entries arrive as getFsWriteConfig() returns them, with a trailing
  // /** already removed, and the profile compiles them as they are.
  const spelled = (spelling: string, deny: boolean): PathRule => {
    const glob = containsGlobChars(spelling);
    const path = glob ? normalizePathForSandbox(spelling) : literal(spelling);
    const covers = cover({ glob, path }, deny);
    if (!glob || !deny) return { entry: spelling, covers };
    const named = cover({ glob: false, path: literal(spelling) }, true);
    const read = (target: string) =>
      literalReadings(spelling, 'deny').some((reading) => cover(reading, true)(target));
    return { entry: spelling, covers: (target) => covers(target) || named(target) || read(target) };
  };
  const marked = (path: string, deny: boolean): PathRule => ({
    entry: path,
    covers: cover({ glob: false, path: literal(path) }, deny),
  });
  // The runtime's entryBaseDir, which it does not export. Every reading of a
  // spelled deny counts, as above.
  const base = (entry: PathEntry) => {
    if (!entry.glob) return entry.path;
    if (entry.anchor) return entry.anchor;
    const prefix = entry.path.split(/[*?[\]]/)[0]!;
    return prefix.endsWith('/') ? prefix.slice(0, -1) || '/' : dirname(prefix);
  };
  const readings = (spelling: string): PathEntry[] => [
    { glob: false, path: literal(spelling) },
    ...(containsGlobChars(spelling)
      ? [
          { glob: true, path: normalizePathForSandbox(spelling) },
          ...literalReadings(spelling, 'deny'),
        ]
      : []),
  ];
  return {
    shielded: [
      ...config.denyWithinAllow.flatMap(readings).map(base),
      ...(config.literalDenyWithinAllow ?? []).map(literal),
      ...mandatory.map(base),
    ],
    allow: [
      ...config.allowOnly.map((entry) => spelled(entry, false)),
      ...(config.literalAllowOnly ?? []).map((path) => marked(path, false)),
    ],
    deny: [
      ...config.denyWithinAllow.map((entry) => spelled(entry, true)),
      ...(config.literalDenyWithinAllow ?? []).map((path) => marked(path, true)),
      ...mandatory.map((entry) => ({ entry: entry.path, covers: cover(entry, true) })),
    ],
  };
}

export function writeDenial(target: string, policy: WritePolicy): string | undefined {
  if (!policy.allow.some((rule) => rule.covers(target))) return 'it is outside every writable path';
  const denied = policy.deny.find((rule) => rule.covers(target));
  return denied && `it is protected by ${denied.entry}`;
}

// Pi's write tool creates the file and its missing parent directories, and the
// profile checks each creation, including the shielded paths.
export function writeToolDenial(target: string, policy: WritePolicy): string | undefined {
  const denial = writeDenial(target, policy);
  if (denial) return denial;
  for (let path = target; !existsSync(path); path = dirname(path)) {
    const shielded = policy.shielded.find((base) => within(base.toLowerCase(), path.toLowerCase()));
    const reason =
      (path !== target && writeDenial(path, policy)) ||
      (shielded && `creating it is protected by ${shielded}`);
    if (reason) return path === target ? reason : `Pi would first create ${path}, and ${reason}`;
  }
  return undefined;
}
