import type { SessionOptions } from '../ProtocolInterface';
import type { JsonRpcClient } from './jsonRpcClient';
import { extractNotificationRouting } from './notificationDiagnostics';

export type CodexShellToolKind = 'shell' | 'patch' | 'mcp';
export interface CodexShellTrackingRegistration {
  command: string;
  env: Record<string, string>;
  toolCompleted(id: string): void;
  toolStarted?(id: string, kind: CodexShellToolKind): void;
  turnStarted?(id: string): void;
  unavailable?(): void;
  endTurn(): void;
  dispose(): void;
}
type Host = (sessionId: string, workspacePath: string) => Promise<CodexShellTrackingRegistration | undefined>;
let host: Host | undefined;
/** Electron supplies observation; runtime never imports Electron services. */
export function setCodexShellTrackingHost(value: Host | undefined): void {
  host = value;
}

/** PostToolUse is omitted on tool failure and some yielded shell completions. */
export function observeCodexShellTracking(
  client: JsonRpcClient,
  registration: CodexShellTrackingRegistration | undefined,
  getThreadId: () => string,
  getActiveTurnId?: () => string | null
): void {
  if (!registration) return;
  let activeTurn: string | undefined;
  const endedTurns = new Set<string>();
  client.onNotification((method, params) => {
    const threadId = getThreadId();
    const routing = extractNotificationRouting(params);
    if (!threadId || routing.threadId !== threadId) return;
    const turnId = routing.turnId;
    if (!turnId || endedTurns.has(turnId)) return;
    const expectedTurn = getActiveTurnId?.();
    if (expectedTurn && expectedTurn !== turnId) return;
    if (method === 'turn/started' && turnId) {
      if (activeTurn && activeTurn !== turnId) registration.endTurn();
      activeTurn = turnId;
      registration.turnStarted?.(turnId);
      return;
    }
    if (activeTurn && turnId && activeTurn !== turnId) return;
    if (method === 'turn/completed' || method === 'turn/failed') {
      if (turnId) {
        endedTurns.add(turnId);
        if (endedTurns.size > 128) endedTurns.delete(endedTurns.values().next().value!);
      }
      activeTurn = undefined;
      registration.endTurn();
      return;
    }
    if (method !== 'item/completed' && method !== 'item/started') return;
    const item = (params as { item?: Record<string, unknown> }).item;
    if (!item || typeof item.id !== 'string' || item.id.length > 256) return;
    if (!['mcpToolCall', 'fileChange', 'commandExecution'].includes(String(item.type))) return;
    if (!activeTurn && turnId) {
      activeTurn = turnId;
      registration.turnStarted?.(turnId);
    }
    if (method === 'item/started') {
      registration.toolStarted?.(item.id, item.type === 'mcpToolCall' ? 'mcp' : item.type === 'fileChange' ? 'patch' : 'shell');
      return;
    }
    if (!['completed', 'failed', 'declined'].includes(String(item.status))) return;
    // An exec call yielding a process handle is not process termination. Require
    // an exit code before retiring a shell window; MCP/patch completion is final.
    if (
      item.type === 'mcpToolCall' ||
      item.type === 'fileChange' ||
      (item.type === 'commandExecution' && typeof (item.exitCode ?? item.exit_code) === 'number')
    ) {
      registration.toolCompleted(item.id);
    }
  });
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
        {
          matcher,
          hooks: [{ type: 'command', command: registration.command, timeout: 5 }],
        },
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
