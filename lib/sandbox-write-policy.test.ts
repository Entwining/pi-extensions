import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, expect, test } from 'bun:test';
import { macGetMandatoryDenyEntries } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js';
import {
  compileWritePolicy,
  expandPath,
  resolveWriteTarget,
  writeDenial,
  writeToolDenial,
} from './sandbox-write-policy';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-sandbox-policy-test-')));
const project = join(root, 'project');
const outside = join(root, 'outside');
for (const dir of [project, outside]) mkdirSync(dir);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('resolves write targets as Pi does and through symbolic links', () => {
  symlinkSync(outside, join(project, 'link'));
  symlinkSync(join(outside, 'later.txt'), join(project, 'dangling'));
  symlinkSync('@inner', join(project, 'at-link'));
  mkdirSync(join(outside, 'inner'));
  symlinkSync(join(outside, 'inner'), join(project, 'inner-link'));
  symlinkSync('inner-link/../after-dots.txt', join(project, 'dots'));
  expect(resolveWriteTarget('link/a.txt', project)).toBe(join(outside, 'a.txt'));
  expect(resolveWriteTarget('dangling', project)).toBe(join(outside, 'later.txt'));
  // `..` leaves the directory the link before it reached, as the kernel resolves it.
  expect(resolveWriteTarget('dots', project)).toBe(join(outside, 'after-dots.txt'));
  // A link target is a path on disk, not tool input, so Pi's input rules do not apply to it.
  expect(resolveWriteTarget('at-link', project)).toBe(join(project, '@inner'));
  expect(resolveWriteTarget('@new/a.txt', project)).toBe(join(project, 'new', 'a.txt'));
  const space = (code: number) => `a${String.fromCodePoint(code)}b`;
  expect(resolveWriteTarget(space(0x00a0), project)).toBe(join(project, 'a b'));
  expect(resolveWriteTarget(space(0x1680), project)).toBe(join(project, space(0x1680)));
  expect(resolveWriteTarget(pathToFileURL(join(project, 'a b.txt')).href, '/')).toBe(
    join(project, 'a b.txt'),
  );
  expect(resolveWriteTarget('~/a.txt', project)).toBe(join(realpathSync(homedir()), 'a.txt'));
});

test('converts the shell paths Pi accepts on Windows as Pi does', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    expect(expandPath('/c/Program Files/Git/bin/bash.exe')).toBe(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    );
    expect(expandPath('/mnt/d/tools/bash.exe')).toBe('D:\\tools\\bash.exe');
    expect(expandPath('/usr/bin/bash')).toBe('/usr/bin/bash');
    expect(expandPath('~\\bash.exe')).toBe(join(homedir(), 'bash.exe'));
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
  expect(expandPath('/c/bash')).toBe('/c/bash');
});

test.each([
  { target: '/work/src/a.ts', denied: undefined },
  { target: '/elsewhere/a.ts', denied: 'outside every writable path' },
  { target: '/work/Secrets/a.ts', denied: 'protected by /work/secrets' },
  { target: '/work/pkg/Yarn.LOCK', denied: 'protected by /work/**/*.lock' },
  { target: '/work/lib/vendor/a.js', denied: 'protected by /work/**/vendor' },
  { target: '/work/.hidden/vendor/a.js', denied: 'protected by /work/**/vendor' },
  { target: '/work/[WIP]/a.ts', denied: 'protected by /work/[WIP]' },
  { target: '/build/out', denied: undefined },
  { target: '/build/out/a.js', denied: 'outside every writable path' },
  { target: '/lit*/a', denied: undefined },
  { target: '/lit1/a', denied: 'outside every writable path' },
  { target: join(homedir(), 'locked', 'a'), denied: 'protected by ~/locked' },
])('applies allow and deny entries to $target', async ({ target, denied }) => {
  const policy = await compileWritePolicy(
    {
      allowOnly: ['/work', '/build/o*', homedir()],
      denyWithinAllow: [
        '/work/secrets',
        '/work/**/*.lock',
        '/work/**/vendor',
        '/work/[WIP]',
        '~/locked',
      ],
      literalAllowOnly: ['/lit*'],
    },
    [],
  );
  const reason = writeDenial(target, policy);
  if (denied) expect(reason).toContain(denied);
  else expect(reason).toBeUndefined();
});

test("applies sandbox-runtime's mandatory write denies beneath the working directory", async () => {
  const cwd = process.cwd();
  const config = { allowOnly: [cwd], denyWithinAllow: [] };
  const policy = await compileWritePolicy(config, macGetMandatoryDenyEntries(false));
  for (const path of [
    '.git/hooks/pre-commit',
    '.git/config',
    'nested/.bashrc',
    '.vscode/settings.json',
  ])
    expect(writeDenial(join(cwd, path), policy)).toContain('protected by');
  expect(writeDenial(join(cwd, 'src/index.ts'), policy)).toBeUndefined();
  const gitConfigAllowed = await compileWritePolicy(config, macGetMandatoryDenyEntries(true));
  expect(writeDenial(join(cwd, '.git/config'), gitConfigAllowed)).toBeUndefined();
});

test('reads a directory whose name holds glob characters as Sandbox Runtime does', async () => {
  const cwd = join(root, 'wip[1]');
  mkdirSync(join(cwd, 'sub'), { recursive: true });
  const policy = await compileWritePolicy(
    { allowOnly: [], literalAllowOnly: [cwd], denyWithinAllow: [join(cwd, '**', '.pi')] },
    [{ glob: true, path: join(cwd, '**', '.git', 'hooks', '**'), anchor: cwd }],
  );
  expect(writeDenial(join(cwd, 'sub', '.pi', 'a.ts'), policy)).toContain('protected by');
  expect(writeDenial(join(cwd, 'sub', '.git', 'hooks', 'pre-commit'), policy)).toContain(
    'protected by',
  );
  expect(writeDenial(join(cwd, 'sub', 'a.ts'), policy)).toBeUndefined();
});

test('compiles entries as getFsWriteConfig returns them and checks created directories', async () => {
  const descendants = await compileWritePolicy({ allowOnly: ['/x/**'], denyWithinAllow: [] }, []);
  expect(writeDenial('/x/a', descendants)).toBeUndefined();
  expect(writeDenial('/x', descendants)).toContain('outside every writable path');
  const file = join(project, 'new', 'a.txt');
  const policy = await compileWritePolicy(
    { allowOnly: [], denyWithinAllow: [], literalAllowOnly: [file, join(project, 'a.txt')] },
    [],
  );
  expect(writeToolDenial(file, policy)).toContain(`Pi would first create ${join(project, 'new')}`);
  expect(writeToolDenial(join(project, 'a.txt'), policy)).toBeUndefined();
});

test('refuses to create what Seatbelt shields on the way to a protected path', async () => {
  const policy = await compileWritePolicy(
    {
      allowOnly: [project],
      denyWithinAllow: [join(project, 'gen', 'locked.txt'), join(project, 'keys', '**', '*.pem')],
      literalDenyWithinAllow: [join(project, 'marked', 'locked.txt')],
    },
    [{ glob: false, path: join(project, 'repo', '.git', 'hooks') }],
  );
  for (const path of ['repo/.git', 'marked/other.txt'])
    expect(writeToolDenial(join(project, path), policy)).toContain('creating it is protected by');
  expect(writeToolDenial(join(project, 'gen', 'other.txt'), policy)).toContain(
    `Pi would first create ${join(project, 'gen')}, and creating it is protected by`,
  );
  // A glob's base directory is shielded too, and denies ignore case as APFS does.
  expect(writeToolDenial(join(project, 'Keys'), policy)).toContain('creating it is protected by');
  mkdirSync(join(project, 'gen'));
  expect(writeToolDenial(join(project, 'gen', 'other.txt'), policy)).toBeUndefined();
});
