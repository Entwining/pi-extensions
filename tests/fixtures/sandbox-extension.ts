import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';
import * as runtime from '@anthropic-ai/sandbox-runtime';
import { removeTrailingGlobSuffix } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js';
import { cleanupSessionResources } from '@earendil-works/pi-ai';
import type {
  BashOperations,
  ExtensionAPI,
  ExtensionToolContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
  UserBashEventResult,
} from '@earendil-works/pi-coding-agent';
import { quote } from '../../lib/sandbox-session';

// Drives the sandbox extension in an isolated agent directory. The OS sandbox
// itself is exercised against real Seatbelt outside the test suite; here the
// manager stands in so the adapter's own contract runs on any host.
export const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-sandbox-test-')));
export const agentDir = join(root, 'agent');
export const project = join(root, 'project');
export const outside = join(root, 'outside');
process.env.PI_CODING_AGENT_DIR = agentDir;
export const configPath = join(agentDir, 'extensions', 'sandbox.json');
export const config = {
  network: { allowedDomains: ['example.com'], deniedDomains: [] },
  filesystem: { denyRead: [], allowWrite: [], denyWrite: [join(project, 'locked')] },
};
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
export const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { value });

export const manager = {
  wrap: (command: string): string | Promise<string> => command,
  initialized: undefined as runtime.SandboxRuntimeConfig | undefined,
  shell: undefined as string | undefined,
  resets: 0,
  resetError: undefined as Error | undefined,
};
// On macOS Sandbox Runtime drops a trailing /** from spelled entries.
const spelled = (entries: runtime.FilesystemPathEntry[] = []) =>
  entries.flatMap((entry) => (typeof entry === 'string' ? [removeTrailingGlobSuffix(entry)] : []));
const marked = (entries: runtime.FilesystemPathEntry[] = []) =>
  entries.flatMap((entry) => (typeof entry === 'string' ? [] : [entry.path]));
mock.module('@anthropic-ai/sandbox-runtime', () => ({
  ...runtime,
  SandboxManager: {
    initialize: async (value: runtime.SandboxRuntimeConfig) => {
      manager.initialized = value;
    },
    // Like Sandbox Runtime, the command starts with env. The inner shell is sh,
    // which reads no startup file, because nothing here applies Seatbelt.
    wrapWithSandbox: async (command: string, shell: string) => {
      manager.shell = shell;
      return `env /bin/sh -c ${quote(await manager.wrap(command))}`;
    },
    getFsWriteConfig: () => ({
      allowOnly: spelled(manager.initialized?.filesystem.allowWrite),
      denyWithinAllow: spelled(manager.initialized?.filesystem.denyWrite),
      literalAllowOnly: marked(manager.initialized?.filesystem.allowWrite),
      literalDenyWithinAllow: marked(manager.initialized?.filesystem.denyWrite),
    }),
    reset: async () => {
      manager.resets++;
      if (manager.resetError) throw manager.resetError;
    },
  },
}));
const { default: sandbox } = await import('../../extensions/sandbox');

// Each test file's cleanup removes the tree, so the next file's tests make it again.
export function prepare() {
  for (const dir of [join(agentDir, 'extensions'), project, outside])
    mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config));
  manager.wrap = (command) => command;
  manager.initialized = undefined;
  manager.shell = undefined;
  manager.resetError = undefined;
  // A test that fails before stopping its session must not block the next one.
  Reflect.deleteProperty(globalThis, Symbol.for('pi-extensions/sandbox'));
  setPlatform('darwin');
}

export function cleanup() {
  Object.defineProperty(process, 'platform', platform);
  rmSync(root, { recursive: true, force: true });
}

type Handler = (event: unknown, ctx: ExtensionToolContext) => unknown;
let sessions = 0;
export function start(
  flags: Record<string, boolean> = {},
  settings: { shellPath?: string; shellCommandPrefix?: string } = {},
  cwd = project,
  sessionId?: string,
) {
  const handlers = new Map<string, Handler>();
  const tools: ToolDefinition[] = [];
  sandbox({
    registerFlag: () => {},
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    getFlag: (name: string) => flags[name],
    getSettings: () => settings,
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI);
  // A session of this loaded copy, as when an SDK host shares one resource loader.
  const session = (sessionId = `session-${++sessions}`) => {
    const notices: string[] = [];
    const dialogs: string[] = [];
    // The user's answer to a confirmation dialog, and whether the mode has dialogs.
    const user = { hasUI: true, approves: false };
    const sessionManager = { getSessionId: () => sessionId, getSessionFile: () => undefined };
    const ui = {
      notify: (text: string) => notices.push(text),
      setStatus: () => {},
      confirm: async (title: string, message: string) => {
        dialogs.push(`${title}\n${message}`);
        return user.approves;
      },
    };
    // As in Pi, a disposed session's context throws.
    let disposed = false;
    const live = <T>(value: T) => {
      if (disposed) throw new Error('This extension ctx is stale');
      return value;
    };
    const ctx = {
      get cwd() {
        return live(cwd);
      },
      get sessionManager() {
        return live(sessionManager);
      },
      get ui() {
        return live(ui);
      },
      get hasUI() {
        return live(user.hasUI);
      },
    } as unknown as ExtensionToolContext;
    const call = (event: string, payload: unknown) => handlers.get(event)?.(payload, ctx);
    return {
      sessionId,
      notices,
      dialogs,
      user,
      tools,
      started: Promise.resolve(call('session_start', { type: 'session_start' })),
      restart: async () => call('session_start', { type: 'session_start' }),
      stop: async () => call('session_shutdown', { type: 'session_shutdown' }),
      dispose: () => {
        disposed = true;
        cleanupSessionResources(sessionId);
      },
      another: (id?: string) => session(id),
      // The output of the registered bash tool, or the error it reports to the model.
      bash: async (params: Record<string, unknown>) => {
        try {
          const result = await tools[0]!.execute('fixture', params, undefined, undefined, ctx);
          return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
        } catch (error) {
          return `error: ${error instanceof Error ? error.message : error}`;
        }
      },
      operations: () =>
        (call('user_bash', { type: 'user_bash' }) as UserBashEventResult | undefined)?.operations,
      toolCall: (toolName: string, input: Record<string, unknown>) =>
        call('tool_call', {
          type: 'tool_call',
          toolCallId: 'fixture',
          toolName,
          input,
        } as ToolCallEvent) as ToolCallEventResult | undefined,
    };
  };
  return session(sessionId);
}

export async function run(operations: BashOperations | undefined, command: string) {
  let output = '';
  const result = await operations?.exec(command, project, { onData: (data) => (output += data) });
  return { exitCode: result?.exitCode, output };
}

// The last writable entry unless a linked worktree's Git directory follows it.
export const privateTmp = () =>
  (manager.initialized!.filesystem.allowWrite.at(-1) as { path: string }).path;
