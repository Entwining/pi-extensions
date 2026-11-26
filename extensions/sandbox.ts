import { registerSessionResourceCleanup } from '@earendil-works/pi-ai';
import {
  createBashToolDefinition,
  createLocalBashOperations,
  getAgentDir,
  isToolCallEventType,
  type BashOperations,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import {
  escalationApproval,
  escalationGuideline,
  escalationParameters,
} from '../lib/sandbox-escalation';
import { removeTree } from '../lib/sandbox-paths';
import { quote, runInSandbox, startSandbox, type Sandbox } from '../lib/sandbox-session';
import { expandPath, resolveWriteTarget, writeToolDenial } from '../lib/sandbox-write-policy';
import { guard } from './agent-guard';

type Holder = { stopping?: Promise<unknown> };
// A session is told apart by its session manager: an SDK host can open two
// sessions from one transcript, and both then report its session ID.
type Owner = ExtensionContext['sessionManager'];

// Sandbox Runtime keeps one policy per process, and an initialize before the
// previous one is reset keeps the old policy, so the sessions of an SDK host
// take turns. The holder is on globalThis so every loaded copy sees it.
const runtimeOwner = Symbol.for('pi-extensions/sandbox');
// Pi makes a session's context throw once the session is replaced or disposed.
const isStale = (ctx: ExtensionContext) => {
  try {
    void ctx.sessionManager;
    return false;
  } catch {
    return true;
  }
};

export default function sandbox(pi: ExtensionAPI) {
  const holder: Holder = {};
  const release = () => {
    if (Reflect.get(globalThis, runtimeOwner) === holder)
      Reflect.deleteProperty(globalThis, runtimeOwner);
  };
  const configPath = join(getAgentDir(), 'extensions', 'sandbox.json');
  const approval = escalationApproval(pi, getAgentDir(), (owner) => active?.owner === owner);
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  let settings: { shellPath?: string; shellCommandPrefix?: string } = {};
  let shellPath: string | undefined;
  // One loaded copy serves every session that shares its resource loader, and
  // an SDK host can set --no-sandbox for some of them only.
  const unsandboxed = new WeakSet<Owner>();
  // Only one of those sessions can hold the sandbox.
  let active: (Sandbox & { owner: Owner; forget: () => void }) | undefined;
  const failures = new WeakMap<Owner, string>();
  let lifecycle = Promise.resolve();
  const unavailable = (owner?: Owner) =>
    `The OS sandbox for commands is unavailable, so Pi blocks this call: ${(owner && failures.get(owner)) ?? 'The sandbox has not finished starting.'} Commands stay blocked until the user fixes this and restarts Pi, or restarts it with --no-sandbox; until then a bash call runs outside the sandbox only if the user approves it.`;
  // Session starts and shutdowns run one at a time, so a shutdown that arrives
  // while a sandbox is starting stops that sandbox once it is up.
  const serially = (step: () => Promise<void>) =>
    (lifecycle = lifecycle.catch(() => {}).then(step));
  const stop = async () => {
    const stopping = active;
    active = undefined;
    if (!stopping) return;
    stopping.forget();
    // Only directories: a file in the tree can be a hard link to one outside
    // it. The session's working directory may be gone by now.
    const makeWritable = () =>
      runInSandbox(stopping, `find ${quote(stopping.tmp)} -type d -exec chmod u+rwx {} \\;`, '/', {
        onData: () => {},
        timeout: 30,
      });
    const stopped = removeTree(stopping.tmp, makeWritable).finally(() =>
      // Until reset runs, Sandbox Runtime keeps this session's policy for the next one.
      stopping.manager.reset(),
    );
    holder.stopping = stopped;
    try {
      await stopped;
    } finally {
      holder.stopping = undefined;
      release();
    }
  };
  const end = (owner: Owner) => {
    approval.stop(owner);
    return serially(async () => {
      failures.set(owner, 'The session has ended.');
      if (active?.owner === owner) await stop();
    });
  };

  const local = (): BashOperations => createLocalBashOperations({ shellPath });
  const operationsFor = (owner?: Owner): BashOperations => ({
    async exec(...args) {
      if (owner && unsandboxed.has(owner)) return local().exec(...args);
      if (!active || active.owner !== owner) throw new Error(unavailable(owner));
      return runInSandbox(active, ...args);
    },
  });
  const bashFor = (operations: BashOperations) =>
    createBashToolDefinition(process.cwd(), { operations });
  const bash = bashFor(operationsFor());

  pi.registerFlag('no-sandbox', {
    description: 'Run bash commands without the OS sandbox',
    type: 'boolean',
    default: false,
  });
  pi.registerTool({
    ...bash,
    parameters: Type.Object({ ...bash.parameters.properties, ...escalationParameters }),
    promptGuidelines: [...(bash.promptGuidelines ?? []), escalationGuideline],
    // Pi runs this after every tool_call handler, Agent Guard's included, has
    // passed the call, so the dialog shows the command as it will run.
    async execute(toolCallId, { unsandboxed: requested, justification, ...params }, ...rest) {
      const [signal, , ctx] = rest;
      const owner = ctx.sessionManager;
      // Pi applies shellCommandPrefix only to the built-in bash tool this one replaces.
      const prefix = settings.shellCommandPrefix;
      const call = { ...params, command: prefix ? `${prefix}\n${params.command}` : params.command };
      if (!requested || unsandboxed.has(owner))
        return bashFor(operationsFor(owner)).execute(toolCallId, call, ...rest);
      await approval.approve(call.command, justification, ctx, signal, { toolCallId, prefix });
      return bashFor(local()).execute(toolCallId, call, ...rest);
    },
    // Registering a tool otherwise activates it, which would give bash to a
    // session whose tool selection leaves it out. Pi's default selection names
    // bash, so this definition stays active there.
    defaultActive: false,
  });
  pi.on('user_bash', (_event, ctx) =>
    unsandboxed.has(ctx.sessionManager)
      ? undefined
      : { operations: operationsFor(ctx.sessionManager) },
  );

  pi.on('tool_call', (event, ctx) => {
    const owner = ctx.sessionManager;
    if (unsandboxed.has(owner)) return;
    // Pi's powershell tool runs commands through its own executor, which this
    // sandbox does not wrap.
    if (event.toolName === 'powershell') {
      return {
        block: true,
        reason:
          'The OS sandbox covers only bash, so Pi blocks powershell. Use bash, or ask the user to restart Pi with --no-sandbox.',
      };
    }
    if (!isToolCallEventType('write', event) && !isToolCallEventType('edit', event)) return;
    if (active?.owner !== owner) return { block: true, reason: unavailable(owner) };
    let target = event.input.path;
    let reason;
    try {
      target = resolveWriteTarget(target, ctx.cwd);
      reason = writeToolDenial(target, active.policy);
    } catch (error) {
      reason = `its path could not be resolved (${error instanceof Error ? error.message : error})`;
    }
    if (!reason) return;
    return {
      block: true,
      reason: `The sandbox write policy blocks ${event.toolName} on ${target} because ${reason}. Write inside the working directory or another writable path; the policy in ${configPath} cannot be changed from this session.`,
    };
  });

  const start = async (ctx: ExtensionContext) => {
    const owner = ctx.sessionManager;
    failures.delete(owner);
    unsandboxed.delete(owner);
    let holds = false;
    let forget = () => {};
    try {
      if (active && active.owner !== owner) {
        throw new Error('Another Pi session in this process already runs the sandbox.');
      }
      // Pi's RPC mode starts each replacement session (new, resumed, forked, or
      // cloned) twice without a shutdown in between, and Sandbox Runtime ignores
      // another initialize until reset, so a running sandbox is stopped first.
      await stop();
      settings = pi.getSettings();
      shellPath = settings.shellPath && expandPath(settings.shellPath);
      if (pi.getFlag('no-sandbox') === true) {
        unsandboxed.add(owner);
        ctx.ui.notify('Sandbox off (--no-sandbox): commands run with full permissions.', 'warning');
        ctx.ui.setStatus('sandbox', 'sandbox off');
        return;
      }
      // On Linux, Sandbox Runtime drops write denies that are globs, such as
      // the one for .pi directories one level down, so the policy cannot be applied.
      if (process.platform !== 'darwin') {
        throw new Error(`The sandbox supports only macOS, not ${process.platform}.`);
      }
      // While the context is live: a session disposed while its sandbox starts makes it throw.
      approval.start(ctx);
      // A session that ended without a shutdown hands over once it has stopped.
      await Reflect.get(globalThis, runtimeOwner)?.stopping;
      if (Reflect.get(globalThis, runtimeOwner)) {
        throw new Error('Another Pi session in this process already runs the sandbox.');
      }
      Reflect.set(globalThis, runtimeOwner, holder);
      holds = true;
      // An SDK host can dispose a session without a shutdown event, also while
      // its sandbox starts. The stop then follows the start.
      const sessionId = owner.getSessionId();
      forget = registerSessionResourceCleanup((id) => {
        if (id !== sessionId || !isStale(ctx)) return;
        end(owner).catch((error) =>
          console.error(`Stopping the sandbox of disposed session ${id} failed:`, error),
        );
      });
      const started = await startSandbox({
        cwd: ctx.cwd,
        configPath,
        agentDir: getAgentDir(),
        packageRoot,
        programs: [guard],
        shellPath,
      });
      // Tools see the sandbox only once its self-test has passed.
      active = { ...started, owner, forget };
    } catch (error) {
      forget();
      if (holds) release();
      failures.set(owner, error instanceof Error ? error.message : String(error));
      ctx.ui.notify(unavailable(owner), 'error');
      ctx.ui.setStatus('sandbox', 'sandbox unavailable: commands blocked');
    }
  };

  pi.on('session_start', (_event, ctx) => serially(() => start(ctx)));
  pi.on('session_shutdown', (_event, ctx) => end(ctx.sessionManager));
}
