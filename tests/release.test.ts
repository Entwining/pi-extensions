import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'bun:test';

test('keeps pre-1.0 releases on the patch line with native release plugins', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-extensions-release-'));
  try {
    for (const directory of ['home', 'tmp']) mkdirSync(join(root, directory));
    const runner = fileURLToPath(new URL('./fixtures/release.mjs', import.meta.url));
    const result = spawnSync('node', [runner, root], {
      env: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        TMPDIR: join(root, 'tmp'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ALLOW_PROTOCOL: 'file',
        GIT_TERMINAL_PROMPT: '0',
        NO_COLOR: '1',
      },
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Release checks passed\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
