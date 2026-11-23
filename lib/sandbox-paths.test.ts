import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { getDefaultWritePaths } from '@anthropic-ai/sandbox-runtime';
import { guard } from '../extensions/agent-guard';
import {
  agentDir,
  cleanup,
  config,
  configPath,
  manager,
  outside,
  prepare,
  privateTmp,
  project,
  root,
  run,
  start,
} from '../tests/fixtures/sandbox-extension';

beforeEach(prepare);
afterAll(cleanup);

test('protects the paths Pi loads or runs, both as spelled and after symbolic links', async () => {
  const settings = join(outside, 'settings.json');
  const skills = join(outside, 'skills');
  const bin = join(outside, 'bin');
  const relativeBin = join(outside, 'relative-bin');
  for (const dir of [skills, bin, relativeBin]) mkdirSync(dir, { recursive: true });
  symlinkSync(settings, join(agentDir, 'settings.json'));
  symlinkSync(skills, join(agentDir, 'skills'));
  symlinkSync(bin, join(outside, 'bin-link'));
  // Starting the sandbox runs no program found on PATH, which may be the project's.
  const gitRan = join(outside, 'git-ran');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ntouch '${gitRan}'\n`, { mode: 0o755 });
  const path = process.env.PATH;
  // Node looks a relative PATH entry up from Pi's working directory, not the session's,
  // and an empty one names the working directory.
  process.env.PATH = `${join(outside, 'bin-link')}:${relative(process.cwd(), relativeBin)}::${path}`;
  const session = start();
  await session.started;
  process.env.PATH = path;
  expect(existsSync(gitRan)).toBe(false);
  expect(session.notices).toEqual([]);
  expect(manager.initialized?.filesystem.denyWrite).toEqual(
    expect.arrayContaining([
      { path: settings, literal: true },
      { path: skills, literal: true },
      { path: join(outside, 'bin-link'), literal: true },
      { path: bin, literal: true },
      { path: relativeBin, literal: true },
      { path: project, literal: true },
      { path: guard, literal: true },
    ]),
  );
  expect(await run(session.operations(), 'true')).toEqual({ exitCode: 0, output: '' });
  rmSync(join(agentDir, 'settings.json'));
  rmSync(join(agentDir, 'skills'));
  await session.stop();
});

test('protects .pi at the top of every writable directory and directly inside it', async () => {
  // Not created yet, with glob characters in its name.
  const fresh = join(outside, 'fresh[1]');
  // A file now, which commands may replace with a directory.
  const built = join(outside, 'out.js');
  const repos = join(outside, 'repos');
  const worktrees = join(outside, 'worktrees');
  const otherPi = join(outside, 'other', '.pi');
  for (const dir of [repos, join(worktrees, 'w', 'src'), otherPi])
    mkdirSync(dir, { recursive: true });
  writeFileSync(built, '');
  const allowWrite = [
    { path: fresh, literal: true },
    { path: built, literal: true },
    `${repos}/**`,
    `${worktrees}/*/src/**`,
    // Its fixed part does not exist yet.
    `${project}/packages/*/src/**`,
    join(otherPi, 'settings.json'),
  ];
  const filesystem = { ...config.filesystem, allowWrite };
  writeFileSync(configPath, JSON.stringify({ ...config, filesystem }));
  const session = start();
  await session.started;
  // Sandbox Runtime adds writable directories of its own, as far as they exist on this host.
  const defaults = getDefaultWritePaths()
    .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    .map((dir) => realpathSync(dir));
  expect(manager.initialized?.filesystem.denyWrite).toEqual(
    expect.arrayContaining([
      ...defaults.flatMap((dir) => [
        { path: join(dir, '.pi'), literal: true },
        join(dir, '*', '.pi'),
      ]),
      // The static check allows nothing inside a glob, so the denies show what it matches.
      join(worktrees, '*', 'src', '.pi'),
      join(worktrees, '*', 'src', '*', '.pi'),
      join(project, '?ackages', '*', 'src', '*', '.pi'),
    ]),
  );
  const denial = (path: string) => session.toolCall('write', { path, content: '' })?.reason;
  expect(denial(join(project, 'packages', 'README.md'))).toBeUndefined();
  expect(denial(built)).toBeUndefined();
  rmSync(built);
  mkdirSync(built);
  for (const dir of [fresh, built, repos, privateTmp()]) {
    expect(denial(join(dir, 'x', 'y', '.pi', 'settings.json'))).toBeUndefined();
    expect(denial(join(dir, '.pi', 'settings.json'))).toContain('protected by');
    expect(denial(join(dir, 'x', '.pi', 'settings.json'))).toContain('protected by');
  }
  // An entry inside a project's .pi stands for that .pi.
  expect(denial(join(otherPi, 'settings.json'))).toContain('protected by');
  await session.stop();
});

test('allows writes in a working directory reached through a symbolic link', async () => {
  const link = join(root, 'project-link');
  symlinkSync(project, link);
  const session = start({}, {}, link);
  await session.started;
  expect(manager.initialized?.filesystem.allowWrite[0]).toEqual({ path: project, literal: true });
  expect(session.toolCall('write', { path: 'notes.txt', content: '' })).toBeUndefined();
  await session.stop();
});

test('runs the shellPath Pi resolved inside the sandbox, from any working directory', async () => {
  const shell = join(outside, 'relative-shell');
  writeFileSync(shell, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
  symlinkSync(shell, join(outside, 'shell-link'));
  for (const shellPath of [
    relative(process.cwd(), shell),
    // Pi expands a file:// shellPath.
    pathToFileURL(join(outside, 'shell-link')).href,
  ]) {
    const session = start({}, { shellPath });
    await session.started;
    expect(await run(session.operations(), 'true')).toEqual({ exitCode: 0, output: '' });
    expect(isAbsolute(manager.shell!)).toBe(true);
    await session.stop();
  }
});
