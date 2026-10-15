import {
  type AgentSession,
  type ExtensionAPI,
  FooterComponent,
} from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';

export default function sessionIdFooter(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setFooter((_tui, theme, footerData) => {
      const baseFooter = new FooterComponent(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- Pi requires AgentSession but exposes only footer fields and a read-only view of the live session manager.
        {
          sessionManager: ctx.sessionManager,
          get model() {
            return ctx.model;
          },
          state: ctx,
          getContextUsage: () => ctx.getContextUsage(),
          modelRuntime: {
            isUsingSubscription: (provider: string) => {
              const model = ctx.model;
              return (
                model !== undefined &&
                ctx.modelRegistry.isUsingOAuth(model) &&
                ctx.modelRegistry.getProvider(provider)?.auth.oauth?.isSubscription === true
              );
            },
          },
        } as unknown as AgentSession,
        footerData,
      );

      return {
        invalidate() {
          baseFooter.invalidate();
        },
        render(width: number): string[] {
          baseFooter.setAutoCompactEnabled(pi.getSettings().compaction?.enabled !== false);
          const lines = baseFooter.render(width);
          const sessionLine = truncateToWidth(
            theme.fg('dim', ctx.sessionManager.getSessionId()),
            width,
            theme.fg('dim', '...'),
          );
          return [...lines.slice(0, 1), sessionLine, ...lines.slice(1)];
        },
      };
    });
  });
}
