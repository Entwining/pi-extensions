import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import type {
  AgentSession,
  ExtensionContext,
  ExtensionUIContext,
  ReadonlyFooterDataProvider,
  Theme,
} from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';

const [packageRoot, root] = process.argv.slice(2);
if (!packageRoot || !root) throw new Error('Expected package and isolation directory paths');

Object.defineProperty(globalThis, 'fetch', {
  value: () => {
    throw new Error('Network calls are forbidden in the resource-loading test');
  },
});

const { DefaultResourceLoader, FooterComponent, SessionManager, SettingsManager, initTheme } =
  await import('@earendil-works/pi-coding-agent');
const { stripTerminalSequences, visibleWidth } = await import('@earendil-works/pi-tui');
const hooks = new Map([
  ['agent-guard.ts', ['tool_call']],
  ['inline-skill-invocation.ts', ['context', 'input', 'session_start']],
  ['session-id-footer.ts', ['session_start']],
  ['strip-reasoning-filler.ts', ['before_provider_request']],
]);
const cases = [
  { source: packageRoot, expected: [...hooks.keys()] },
  {
    source: { source: packageRoot, extensions: ['extensions/session-id-footer.ts'] },
    expected: ['session-id-footer.ts'],
  },
  { source: { source: packageRoot, extensions: [] }, expected: [] },
];

for (const { source, expected } of cases) {
  const loader = new DefaultResourceLoader({
    cwd: join(root, 'project'),
    agentDir: join(root, 'agent'),
    settingsManager: SettingsManager.inMemory({ packages: [source] }, { projectTrusted: false }),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: '',
    appendSystemPrompt: [],
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings ?? [], []);
  assert.deepEqual(
    result.extensions.map((entry) => basename(entry.resolvedPath)).sort(),
    [...expected].sort(),
  );
  for (const entry of result.extensions) {
    assert.equal(entry.sourceInfo.baseDir, packageRoot);
    assert.equal(entry.sourceInfo.source, packageRoot);
    assert.equal(entry.sourceInfo.origin, 'package');
    assert.deepEqual([...entry.handlers.keys()].sort(), hooks.get(basename(entry.resolvedPath)));
  }
  assert.deepEqual(loader.getSkills(), { skills: [], diagnostics: [] });
  assert.deepEqual(loader.getPrompts(), { prompts: [], diagnostics: [] });
  assert.deepEqual(loader.getThemes(), { themes: [], diagnostics: [] });
  assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
  assert.equal(loader.getSystemPrompt(), undefined);
  assert.deepEqual(loader.getAppendSystemPrompt(), []);

  if (typeof source === 'string') {
    initTheme('dark', false);
    const sessionManager = SessionManager.inMemory(join(root, 'project'));
    sessionManager.appendSessionInfo('Fixture session');
    sessionManager.appendUsage('completion', 'fixture', 'synthetic-model', {
      input: 1200,
      output: 23,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1223,
      cost: { input: 0.1, output: 0.023, cacheRead: 0, cacheWrite: 0, total: 0.123 },
    });
    type FooterFactory = NonNullable<Parameters<ExtensionUIContext['setFooter']>[0]>;
    let factory: FooterFactory | undefined;
    let autoCompact = true;
    result.runtime.getSettings = () => ({ compaction: { enabled: autoCompact } });
    const model = {
      id: 'synthetic-model',
      provider: 'fixture',
      contextWindow: 10000,
      reasoning: true,
    };
    const context = {
      sessionManager,
      model,
      thinkingLevel: 'high',
      getContextUsage: () => ({ tokens: 1234, contextWindow: 10000, percent: 12.34 }),
      modelRegistry: {
        isUsingOAuth: () => true,
        getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
      },
      ui: {
        setFooter: (value: FooterFactory | undefined) => {
          factory = value;
        },
      },
    } as unknown as ExtensionContext;
    const footerData: ReadonlyFooterDataProvider = {
      getGitBranch: () => 'fixture-branch',
      getExtensionStatuses: () => new Map([['fixture', 'review-ready']]),
      getAvailableProviderCount: () => 2,
      onBranchChange: () => () => {},
    };
    const extension = result.extensions.find(
      (entry) => basename(entry.resolvedPath) === 'session-id-footer.ts',
    );
    const start = extension?.handlers.get('session_start')?.[0];
    assert(start);
    await start({ type: 'session_start' }, context);
    assert(factory);
    const footer = factory(
      {} as TUI,
      { fg: (_color: string, text: string) => text } as Theme,
      footerData,
    );
    const nativeFooter = new FooterComponent(
      {
        sessionManager,
        model,
        state: context,
        getContextUsage: context.getContextUsage,
        modelRuntime: { isUsingSubscription: () => true },
      } as unknown as AgentSession,
      footerData,
    );
    const wide = footer.render(200).map(stripTerminalSequences);
    assert.equal(wide[1], sessionManager.getSessionId());
    assert(wide.join('\n').includes('↑1.2k ↓23 $0.123 (sub) 12.3%/10k (auto)'));
    assert(wide.join('\n').includes('synthetic-model • high'));
    assert(wide.join('\n').includes('Fixture session'));
    assert.equal(wide.at(-1), 'review-ready');
    for (const width of [200, 8]) {
      const lines = footer.render(width).map(stripTerminalSequences);
      assert.deepEqual(
        [...lines.slice(0, 1), ...lines.slice(2)],
        nativeFooter.render(width).map(stripTerminalSequences),
      );
      assert(lines.every((line) => visibleWidth(line) <= width));
      if (width === 8) assert(lines[1]?.endsWith('...'));
    }
    autoCompact = false;
    nativeFooter.setAutoCompactEnabled(false);
    const manual = footer.render(200).map(stripTerminalSequences);
    assert(!manual.join('\n').includes('(auto)'));
    assert.deepEqual(
      [...manual.slice(0, 1), ...manual.slice(2)],
      nativeFooter.render(200).map(stripTerminalSequences),
    );
  }
}

console.log('Resource-loading and footer checks passed');
