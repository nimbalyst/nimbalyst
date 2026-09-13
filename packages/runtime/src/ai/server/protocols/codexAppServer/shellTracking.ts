import type { SessionOptions } from '../ProtocolInterface';
import type { JsonRpcClient } from './jsonRpcClient';

export interface CodexShellTrackingRegistration {
  command: string;
  env: Record<string, string>;
  endTurn(): void;
  dispose(): void;
}
type Host = (sessionId: string, workspacePath: string) => Promise<CodexShellTrackingRegistration | undefined>;
let host: Host | undefined;
/** Electron supplies observation; runtime never imports Electron services. */
export function setCodexShellTrackingHost(value: Host | undefined): void {
  host = value;
}

export async function prepareCodexShellTracking(options: SessionOptions) {
  const id = options.raw?.nimbalystSessionId;
  if (!host || typeof id !== 'string' || !id || !options.workspacePath) return undefined;
  const registration = await host(id, options.workspacePath);
  if (!registration) return undefined;
  const matcher = '^(Bash|apply_patch|mcp__.*)$';
  const group = `[{ matcher = ${JSON.stringify(
    matcher
  )}, hooks = [{ type = "command", command = ${JSON.stringify(registration.command)}, timeout = 5 }] }]`;
  return {
    registration,
    args: ['-c', `hooks.PreToolUse=${group}`, '-c', `hooks.PostToolUse=${group}`],
    async trust(client: JsonRpcClient): Promise<Record<string, unknown>> {
      const result = await client.request<{
        data: Array<{
          hooks: Array<{
            source: string;
            handlerType: string;
            command?: string;
            matcher?: string;
            eventName: string;
            key: string;
            currentHash: string;
            enabled: boolean;
          }>;
        }>;
      }>('hooks/list', { cwds: [options.workspacePath] });
      const hooks = result.data
        .flatMap((row) => row.hooks)
        .filter(
          (h) =>
            h.source === 'sessionFlags' &&
            h.handlerType === 'command' &&
            h.command === registration.command &&
            h.matcher === matcher &&
            h.enabled &&
            ['preToolUse', 'postToolUse'].includes(h.eventName)
        );
      if (new Set(hooks.map((h) => h.eventName)).size !== 2)
        throw new Error('Codex did not expose the two host shell hooks');
      // Trust only exact host-owned definitions, using hashes computed by the
      // installed Codex. Never bypass trust for user/project/plugin hooks or
      // persist changes to the user's global Codex configuration.
      const definition = [
        { matcher, hooks: [{ type: 'command', command: registration.command, timeout: 5 }] },
      ];
      return {
        hooks: {
          PreToolUse: definition,
          PostToolUse: definition,
          state: Object.fromEntries(hooks.map((h) => [h.key, { trusted_hash: h.currentHash }])),
        },
      };
    },
  };
}
