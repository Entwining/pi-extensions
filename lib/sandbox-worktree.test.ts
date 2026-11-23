import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import {
  cleanup,
  config,
  configPath,
  manager,
  outside,
  prepare,
  project,
  start,
} from '../tests/fixtures/sandbox-extension';

beforeEach(prepare);
afterAll(cleanup);

const git = (...args: string[]) => {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
};

test('a linked worktree may write the shared Git directory except its hooks and config', async () => {
  const repo = join(outside, 'repo');
  const worktree = join(outside, 'worktree');
  const shared = join(repo, '.git');
  git('init', '-q', repo);
  git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git('-C', repo, 'worktree', 'add', '-q', worktree);
  // The session may start below the worktree's top.
  mkdirSync(join(worktree, 'src'));
  const session = start({}, {}, join(worktree, 'src'));
  await session.started;
  expect(manager.initialized?.filesystem.allowWrite).toContainEqual({
    path: shared,
    literal: true,
  });
  const write = (path: string) => session.toolCall('write', { path, content: '' });
  expect(write(join(shared, 'refs', 'heads', 'topic'))).toBeUndefined();
  expect(write(join(shared, 'worktrees', 'worktree', 'index'))).toBeUndefined();
  for (const path of [
    join(shared, 'hooks', 'pre-commit'),
    join(shared, 'config'),
    join(shared, 'refs', '.pi', 'settings.json'),
    join(repo, 'a'),
  ])
    expect(write(path)?.block).toBe(true);
  await session.stop();
  // A command can rewrite a working directory's .git file, but not the shared
  // directory's record of its worktrees, so a planted link opens nothing.
  const planted = join(outside, 'planted');
  const fake = join(outside, 'fake-git-dir');
  mkdirSync(planted);
  mkdirSync(fake);
  writeFileSync(join(fake, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(fake, 'commondir'), `${shared}\n`);
  writeFileSync(join(planted, '.git'), `gitdir: ${fake}\n`);
  const tricked = start({}, {}, planted);
  await tricked.started;
  expect(manager.initialized?.filesystem.allowWrite).toHaveLength(2);
  await tricked.stop();
  // So does a Git variable Pi inherited that names the worktree.
  process.env.GIT_DIR = join(shared, 'worktrees', 'worktree');
  process.env.GIT_WORK_TREE = worktree;
  const inherited = start({}, {}, project);
  await inherited.started;
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  expect(manager.initialized?.filesystem.allowWrite).toHaveLength(2);
  await inherited.stop();
  // A main checkout already holds its Git directory.
  const main = start({}, {}, repo);
  await main.started;
  expect(manager.initialized?.filesystem.allowWrite).toHaveLength(2);
  await main.stop();
  // allowGitConfig opens the shared config as Sandbox Runtime opens the working directory's.
  const filesystem = { ...config.filesystem, allowGitConfig: true };
  writeFileSync(configPath, JSON.stringify({ ...config, filesystem }));
  const open = start({}, {}, worktree);
  await open.started;
  expect(open.toolCall('write', { path: join(shared, 'config'), content: '' })).toBeUndefined();
  expect(open.toolCall('write', { path: join(shared, 'hooks', 'x'), content: '' })?.block).toBe(
    true,
  );
  await open.stop();
});
