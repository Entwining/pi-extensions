import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { guard } from '../extensions/agent-guard';
import {
  agentDir,
  cleanup,
  config,
  configPath,
  manager,
  outside,
  prepare,
  project,
  root,
  run,
  start,
} from '../tests/fixtures/sandbox-extension';

beforeEach(prepare);
afterAll(cleanup);

test('protects the paths Pi loads or runs, both as spelled and after symbolic links', async () => {
  const repos = join(outside, 'repos');
  const worktrees = join(outside, 'worktrees');
  const otherPi = join(outside, 'other', '.pi');
  const allowWrite = [
    join(outside, 'later', 'new'),
    join(otherPi, 'settings.json'),
    `${repos}/**`,
    `${worktrees}/*/src/**`,
    { path: '~', literal: true },
  ];
  writeFileSync(
    configPath,
    JSON.stringify({ ...config, filesystem: { ...config.filesystem, allowWrite } }),
  );
  const settings = join(outside, 'settings.json');
  const skills = join(outside, 'skills');
  const bin = join(outside, 'bin');
  const relativeBin = join(outside, 'relative-bin');
  for (const dir of [skills, bin, relativeBin, repos, worktrees, otherPi])
    mkdirSync(dir, { recursive: true });
  symlinkSync(settings, join(agentDir, 'settings.json'));
  symlinkSync(skills, join(agentDir, 'skills'));
  symlinkSync(bin, join(outside, 'bin-link'));
  const path = process.env.PATH;
  // Node looks a relative PATH entry up from Pi's working directory, not the session's,
  // and an empty one names the working directory.
  process.env.PATH = `${join(outside, 'bin-link')}:${relative(process.cwd(), relativeBin)}::${path}`;
  const session = start();
  await session.started;
  process.env.PATH = path;
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
      // A glob or a path not created yet stands for its nearest existing directory.
      join(outside, '**', '.pi'),
      join(repos, '**', '.pi'),
      join(worktrees, '**', '.pi'),
      join(realpathSync(homedir()), '**', '.pi'),
      // An entry inside a project's .pi stands for that .pi.
      { path: otherPi, literal: true },
    ]),
  );
  expect(
    session.toolCall('write', { path: join(otherPi, 'settings.json'), content: '' })?.block,
  ).toBe(true);
  expect(await run(session.operations(), 'true')).toEqual({ exitCode: 0, output: '' });
  rmSync(join(agentDir, 'settings.json'));
  rmSync(join(agentDir, 'skills'));
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
