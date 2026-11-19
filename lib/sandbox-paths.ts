import type { FilesystemPathEntry } from '@anthropic-ai/sandbox-runtime';
import type { PathEntry } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { followLinks } from './sandbox-write-policy';

export const literal = (path: string): FilesystemPathEntry => ({ path, literal: true });

// A command can leave directories it made read-only, such as a module cache,
// and can still be running. The caller makes them writable inside the sandbox,
// where a symbolic link swapped in cannot carry the change out.
export async function removeTree(path: string, makeWritable: () => Promise<unknown>) {
  const remove = () => rmSync(path, { recursive: true, force: true });
  try {
    remove();
  } catch {
    await makeWritable();
    remove();
  }
}

// Sandbox Runtime keeps the spelling of a link that leaves its own tree, so a
// protected path is passed both as spelled and after its symbolic links.
const protect = (path: string) => {
  const final = followLinks(path);
  return final === path ? [literal(path)] : [literal(path), literal(final)];
};
const linkTargets = (directory: string) =>
  existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isSymbolicLink())
        .map((entry) => literal(followLinks(join(directory, entry.name))))
    : [];

type Session = {
  agentDir: string;
  configPath: string;
  packageRoot: string;
  programs: string[];
  cwd: string;
  sessionCwd: string;
  processCwd: string;
  allowWrite: FilesystemPathEntry[];
  mandatory: PathEntry[];
};

// Each protected path holds code or settings that run outside the sandbox, now
// or on a later start, so writing it would widen the sandbox. Known paths are
// passed as literals so that glob characters in a directory name cannot widen
// or narrow them.
export async function protectedPaths(session: Session): Promise<FilesystemPathEntry[]> {
  const { normalizePathForSandbox, removeTrailingGlobSuffix } =
    await import('@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js');
  // Allow entries as Sandbox Runtime reads them: ~ expanded and a trailing /** dropped.
  const writable = session.allowWrite.map((entry) =>
    typeof entry === 'string'
      ? normalizePathForSandbox(removeTrailingGlobSuffix(entry))
      : normalizePathForSandbox(entry.path, { literal: true }),
  );
  // Everything an entry can match, including a glob or a path created later,
  // lies below its nearest existing directory. Seatbelt also refuses to create
  // the directory a glob deny starts from.
  const directoryOf = (path: string) => {
    let dir = path;
    while (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) dir = dirname(dir);
    return dir;
  };
  // Programs started for the session resolve relative paths against its
  // working directory, and Pi's process against its own.
  const fromEither = (path: string) => [
    resolve(session.cwd, path),
    resolve(session.processCwd, path),
  ];
  // An empty PATH entry names the working directory.
  const programDirs = process.env.PATH?.split(delimiter).flatMap(fromEither);
  return [
    // Pi loads settings, resources, and extensions from these directories and
    // follows the symbolic links in them.
    ...[session.agentDir, join(session.cwd, '.pi')].flatMap((dir) => [
      ...protect(dir),
      ...linkTargets(dir),
    ]),
    ...protect(session.configPath),
    ...protect(session.packageRoot),
    // This package's extensions start these programs outside the sandbox.
    ...session.programs.flatMap(protect),
    // Pi and its extensions find programs here and run them outside the sandbox.
    ...[...new Set(programDirs)].flatMap(protect),
    // A project under any writable directory may be one Pi trusts, and a
    // writable directory inside a project's .pi would open that .pi itself.
    ...[...new Set([...writable.map(directoryOf), session.sessionCwd])].map((root) => {
      const parts = root.split(sep);
      const pi = parts.indexOf('.pi');
      return pi < 0 ? join(root, '**', '.pi') : literal(parts.slice(0, pi + 1).join(sep));
    }),
    // sandbox-runtime anchors its built-in denies (Git hooks and config, shell
    // startup files) at process.cwd(), which Pi keeps when a session runs in
    // another directory, so they are repeated for the session's.
    ...session.mandatory.map((entry) => {
      const path = join(session.sessionCwd, relative(session.processCwd, entry.path));
      return entry.glob ? path : literal(path);
    }),
  ];
}
