import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'bun:test';

test('loads package extensions, applies filters, and renders the footer in isolation', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-extensions-loader-'));
  try {
    for (const directory of ['home', 'agent', 'project', 'tmp']) {
      mkdirSync(join(root, directory));
    }
    for (const file of [
      'agent/AGENTS.md',
      'agent/SYSTEM.md',
      'agent/APPEND_SYSTEM.md',
      'project/AGENTS.md',
    ]) {
      writeFileSync(join(root, file), 'This context must not be loaded.');
    }
    writeFileSync(
      join(root, 'agent/settings.json'),
      JSON.stringify({ extensions: ['./unexpected.ts'] }),
    );
    writeFileSync(
      join(root, 'agent/unexpected.ts'),
      'throw new Error("File-backed settings were loaded");',
    );

    const packageRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
    const runner = fileURLToPath(new URL('./fixtures/resource-loader.ts', import.meta.url));
    const result = spawnSync(process.execPath, [runner, packageRoot, root], {
      cwd: join(root, 'project'),
      env: {
        HOME: join(root, 'home'),
        TMPDIR: join(root, 'tmp'),
        PI_CODING_AGENT_DIR: join(root, 'agent'),
        PI_OFFLINE: '1',
      },
      encoding: 'utf8',
      timeout: 20_000,
      killSignal: 'SIGKILL',
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, 'Resource-loading and footer checks passed\n');
    assert.equal(result.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
