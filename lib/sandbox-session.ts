import {
  createLocalBashOperations,
  getShellConfig,
  type BashOperations,
} from '@earendil-works/pi-coding-agent';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPolicy } from './sandbox-config';
import { linkedGitDir, literal, protectedPaths } from './sandbox-paths';
import { compileWritePolicy, type WritePolicy } from './sandbox-write-policy';

type Runtime = typeof import('@anthropic-ai/sandbox-runtime');
export type Sandbox = {
  manager: Runtime['SandboxManager'];
  shell: string;
  tmp: string;
  policy: WritePolicy;
};
type ExecArgs = Parameters<BashOperations['exec']>;

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
// The wrapper's command runs in this shell before Seatbelt applies. Started as
// sh to run a command, it reads no startup file, and macOS keeps it read-only.
const outerShell = createLocalBashOperations({ shellPath: '/bin/sh' });

export async function runInSandbox(sandbox: Sandbox, ...[command, cwd, options]: ExecArgs) {
  // sandbox-runtime sets TMPDIR to its shared /tmp/claude in front of the
  // inner shell, so the session's private directory is exported inside it.
  // Node's fetch reads the proxy variables, through which Sandbox Runtime
  // allows network access, only with NODE_USE_ENV_PROXY set, and Sandbox
  // Runtime sets that only on Windows.
  const inner = `export TMPDIR=${quote(sandbox.tmp)} NODE_USE_ENV_PROXY=1\n${command}`;
  const wrapped = await sandbox.manager.wrapWithSandbox(
    inner,
    sandbox.shell,
    undefined,
    options.signal,
  );
  // Sandbox Runtime starts its command with `env`, which the outer shell would
  // otherwise look up on PATH, relative to the command's directory. Should
  // that start change, the self-test fails.
  return outerShell.exec(`/usr/bin/${wrapped}`, cwd, options);
}

type Start = {
  cwd: string;
  configPath: string;
  agentDir: string;
  packageRoot: string;
  programs: string[];
  shellPath: string | undefined;
};

// Starts Sandbox Runtime with the policy file and the session's own paths, and
// returns the sandbox once a command has run in it.
export async function startSandbox(session: Start): Promise<Sandbox> {
  const runtime: Runtime = await import('@anthropic-ai/sandbox-runtime');
  const { macGetMandatoryDenyEntries } =
    await import('@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js');
  const config = await readPolicy(session.configPath);
  // Resolved where Pi checked that it exists, so the inner shell is the same
  // file whatever directory a command runs in.
  const shell = resolve(getShellConfig(session.shellPath).shell);
  // Not under tmpdir(): macOS limits a Unix socket path to 104 bytes, and the
  // per-user temporary directory in /var/folders leaves too little of that
  // for tools that bind sockets in directories of their own inside TMPDIR.
  const tmp = realpathSync(mkdtempSync('/tmp/pi-sandbox-'));
  const manager = runtime.SandboxManager;
  try {
    const sessionCwd = realpathSync(session.cwd);
    const mandatory = macGetMandatoryDenyEntries(config.filesystem.allowGitConfig);
    // A linked worktree keeps its index and refs in the repository's shared
    // Git directory. Its hooks and config stay denied, as Sandbox Runtime
    // denies them in a working directory's own .git.
    const shared = linkedGitDir(sessionCwd);
    const allowWrite = [
      ...config.filesystem.allowWrite,
      literal(sessionCwd),
      literal(tmp),
      ...(shared ? [literal(shared)] : []),
    ];
    const denyWrite = await protectedPaths({
      ...session,
      sessionCwd,
      processCwd: realpathSync(process.cwd()),
      allowWrite,
      mandatory,
    });
    const sharedDeny = shared
      ? [
          literal(join(shared, 'hooks')),
          ...(config.filesystem.allowGitConfig ? [] : [literal(join(shared, 'config'))]),
        ]
      : [];
    await manager.initialize({
      ...config,
      network: {
        ...config.network,
        // Tools such as tsx bind their IPC sockets in TMPDIR.
        allowUnixSockets: [...(config.network.allowUnixSockets ?? []), tmp],
      },
      filesystem: {
        ...config.filesystem,
        allowWrite,
        denyWrite: [...config.filesystem.denyWrite, ...denyWrite, ...sharedDeny],
      },
    });
    const sandbox: Sandbox = {
      manager,
      shell,
      tmp,
      policy: await compileWritePolicy(manager.getFsWriteConfig(), mandatory),
    };
    let output = '';
    const probe = await runInSandbox(sandbox, 'true', session.cwd, {
      onData: (data) => (output += data.toString()),
      timeout: 30,
    });
    if (probe.exitCode !== 0) {
      throw new Error(
        output.includes('sandbox_apply: Operation not permitted')
          ? 'Pi runs inside another OS sandbox, which does not allow a nested one (sandbox_apply: Operation not permitted). With --no-sandbox, commands rely on that outer sandbox alone.'
          : `The sandbox self-test exited with code ${probe.exitCode}: ${output.trim()}`,
      );
    }
    return sandbox;
  } catch (error) {
    // The caller holds the sandbox, so no other session's policy is reset.
    await manager.reset();
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}
