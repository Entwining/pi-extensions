import type { FilesystemPathEntry } from '@anthropic-ai/sandbox-runtime';
import type { PathEntry } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path';
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

// The repository's shared Git directory when the directory is in a linked
// worktree that the shared directory records, because commands can rewrite
// the worktree's .git file to name any directory.
export function linkedGitDir(cwd: string) {
  // Git variables inherited from Pi's environment would name another repository.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'].includes(name),
    ),
  );
  // This runs before the sandbox applies, so it must not be a program that a
  // project directory on PATH supplies.
  const result = spawnSync(
    '/usr/bin/git',
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
    { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (result.status !== 0) return undefined;
  const [top, own, dir] = result.stdout
    .trim()
    .split('\n')
    .map((path) => followLinks(path));
  if (!top || !own || !dir || own !== join(dir, 'worktrees', basename(own))) return undefined;
  try {
    // Git writes the link relative to its own directory when
    // worktree.useRelativePaths is set.
    const recorded = resolve(own, readFileSync(join(own, 'gitdir'), 'utf8').trim());
    return followLinks(recorded) === join(top, '.git') ? dir : undefined;
  } catch {
    return undefined;
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
  const {
    containsGlobChars,
    getDefaultWritePaths,
    globPatternBaseDir,
    normalizePathForSandbox,
    removeTrailingGlobSuffix,
  } = await import('@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js');
  // Writable directories as Sandbox Runtime reads them, including its own.
  const roots = [
    ...session.allowWrite.map((entry) => {
      if (typeof entry !== 'string')
        return { path: normalizePathForSandbox(entry.path, { literal: true }), pattern: false };
      const spelling = removeTrailingGlobSuffix(entry);
      return { path: normalizePathForSandbox(spelling), pattern: containsGlobChars(spelling) };
    }),
    ...getDefaultWritePaths().map((path) => ({
      path: normalizePathForSandbox(path, { literal: true }),
      pattern: false,
    })),
  ];
  // Sandbox Runtime also reads a deny pattern as the names on disk it spells,
  // but a directory created later is not on disk yet. Glob syntax has no
  // escape character, but a set of one character matches only that character.
  const globText = (text: string) => text.replace(/[*?[]/g, (char) => `[${char}]`);
  // Seatbelt refuses to create the directory a deny starts from, or any
  // directory above it, so a directory created later is matched from its
  // nearest existing one, the parent of a file included.
  const directoryOf = (path: string) => {
    let dir = path;
    while (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) dir = dirname(dir);
    return dir;
  };
  // Pi loads a project's .pi when it starts in that project. Checkouts sit
  // at the top of a writable directory or one level below it, such as a
  // worktree under a worktrees directory; a deeper .pi, such as one a package
  // ships into a dependency tree, stays writable so commands can remove it.
  const projectPi = ({ path, pattern }: { path: string; pattern: boolean }) => {
    const parts = path.split(sep);
    const pi = parts.indexOf('.pi');
    // A writable directory inside a project's .pi would open that .pi itself.
    if (pi >= 0) {
      const top = parts.slice(0, pi + 1).join(sep);
      return [pattern ? top : literal(top)];
    }
    if (!pattern && statSync(path, { throwIfNoEntry: false })?.isDirectory())
      return [literal(join(path, '.pi')), join(path, '*', '.pi')];
    // A glob, or a path that may become a directory later, even if it is a
    // file now, is matched as a pattern. Where the pattern's fixed part does
    // not exist, `?` takes the first missing name's first character out of
    // it, so that directory can still be created.
    const fixed = pattern ? globPatternBaseDir(path) || sep : path;
    const dir = directoryOf(fixed);
    const escape = pattern ? (text: string) => text : globText;
    const spelled =
      dir === fixed ? path : join(escape(dir), `?${escape(relative(dir, path).slice(1))}`);
    return [join(spelled, '.pi'), join(spelled, '*', '.pi')];
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
    ...roots.flatMap(projectPi),
    // sandbox-runtime anchors its built-in denies (Git hooks and config, shell
    // startup files) at process.cwd(), which Pi keeps when a session runs in
    // another directory, so they are repeated for the session's.
    ...session.mandatory.map((entry) => {
      const path = join(session.sessionCwd, relative(session.processCwd, entry.path));
      return entry.glob ? path : literal(path);
    }),
  ];
}
