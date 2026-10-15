import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import semanticRelease from 'semantic-release';

const root = process.argv[2];
assert(root, 'Expected an isolation directory');
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const configPath = join(packageRoot, '.releaserc.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const analyzer = config.plugins.find((entry) => entry[0] === '@semantic-release/commit-analyzer');
assert(analyzer, 'Expected configured analyzer options');
const logger = { log() {} };
const commit = (message) => ({ hash: '1234567890abcdef', message });
const cases = [
  ['feat: add an extension', 'patch'],
  ['fix: repair an extension', 'patch'],
  ['perf: reduce rendering work', 'patch'],
  ['feat!: change the extension API', 'patch'],
  ['docs!: change the configuration contract', 'patch'],
  ['fix: change the API\n\nBREAKING CHANGE: remove the old option', 'patch'],
  ['fix: change the API\n\nBREAKING-CHANGE: remove the old option', 'patch'],
  ['docs: explain installation', null],
  ['chore: update tooling', null],
];
for (const [message, expected] of cases) {
  const actual = await analyzeCommits(analyzer[1], {
    cwd: packageRoot,
    commits: [commit(message)],
    logger,
  });
  assert.equal(actual, expected, message);
}

const project = join(root, 'project');
const remote = join(root, 'remote.git');
const git = (args, cwd = project) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
git(['init', '--initial-branch=main', project], root);
git(['config', 'user.name', 'Release fixture']);
git(['config', 'user.email', 'release-fixture@example.invalid']);
writeFileSync(join(project, 'fixture.txt'), 'Initial release\n');
git(['add', 'fixture.txt']);
git(['commit', '-m', 'feat: add the fixture']);
git(['tag', 'v0.0.1']);
writeFileSync(join(project, 'fixture.txt'), 'Changed interface\n');
git(['add', 'fixture.txt']);
git(['commit', '-m', 'feat(api)!: replace the fixture interface']);
git(['clone', '--bare', project, remote], root);
git(['remote', 'add', 'origin', remote]);
copyFileSync(configPath, join(project, '.releaserc.json'));
symlinkSync(join(packageRoot, 'node_modules'), join(project, 'node_modules'), 'dir');

const result = await semanticRelease(
  {
    dryRun: true,
    ci: false,
    repositoryUrl: pathToFileURL(remote).href,
    plugins: config.plugins.filter((entry) => entry[0] !== '@semantic-release/github'),
  },
  { cwd: project, env: process.env },
);
assert(result, 'Expected a release after the seeded tag');
assert.equal(result.lastRelease.version, '0.0.1');
assert.equal(result.nextRelease.type, 'patch');
assert.equal(result.nextRelease.version, '0.0.2');
assert.equal(result.nextRelease.gitTag, 'v0.0.2');
assert.match(result.nextRelease.notes, /BREAKING CHANGES/);
assert.match(result.nextRelease.notes, /replace the fixture interface/);
assert.equal(git(['tag', '--list']), 'v0.0.1');
assert.equal(git(['tag', '--list'], remote), 'v0.0.1');
console.log('Release checks passed');
