/**
 * Module side of `ctx.services.terminals`: turns broker calls and broker
 * events into `BackendCommandTerminal` handles.
 *
 * Runs inside the backend runtime (utility process or worker), bundled into
 * `extensionBackendBootstrap`. It must stay free of imports other than types:
 * anything it pulled in would be loaded outside Electron main.
 *
 * Two timing gaps are covered here so a module never loses the start of a log:
 * - a command can print or exit before the response to `create` has been
 *   handled, so events for a terminal with no handle yet are held while a
 *   create is in flight;
 * - a module subscribes with `onOutput` only after it has the handle, so
 *   output is kept (bounded) until the first subscriber takes it.
 */
import type {
  BackendCommandTerminal,
  BackendTerminalExit,
  BackendTerminalOutputChunk,
  BackendTerminalsService,
} from '@nimbalyst/extension-sdk';

export interface BackendTerminalsClientTransport {
  /** One `terminals` broker call. Rejects when the permission is not granted. */
  call: (op: string, args: unknown) => Promise<unknown>;
  /** Subscribe to the host's output and exit broker events. */
  onOutput: (handler: (payload: unknown) => void) => unknown;
  onExit: (handler: (payload: unknown) => void) => unknown;
}

/** Output kept for a terminal nobody has subscribed to yet. */
export const TERMINAL_BACKLOG_MAX_CHARS = 256 * 1024;

interface TerminalHandleState {
  outputHandlers: Set<(chunk: BackendTerminalOutputChunk) => void>;
  exitHandlers: Set<(exit: BackendTerminalExit) => void>;
  /** Chunks received before the first `onOutput` subscriber; null once one has taken them. */
  backlog: BackendTerminalOutputChunk[] | null;
  backlogChars: number;
  exit?: BackendTerminalExit;
}

type TerminalWireEvent =
  | { kind: 'output'; chunk: BackendTerminalOutputChunk }
  | { kind: 'exit'; exit: BackendTerminalExit };

export function createBackendTerminalsClient(
  transport: BackendTerminalsClientTransport
): BackendTerminalsService {
  const handles = new Map<string, TerminalHandleState>();
  const early = new Map<string, TerminalWireEvent[]>();
  let pendingCreates = 0;

  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // A subscriber error must not break delivery to the others.
    }
  };

  const apply = (state: TerminalHandleState, event: TerminalWireEvent): void => {
    if (event.kind === 'exit') {
      if (state.exit) return;
      state.exit = event.exit;
      for (const handler of state.exitHandlers) safely(() => handler(event.exit));
      return;
    }
    if (state.backlog) {
      state.backlog.push(event.chunk);
      state.backlogChars += event.chunk.data.length;
      while (state.backlogChars > TERMINAL_BACKLOG_MAX_CHARS && state.backlog.length > 1) {
        state.backlogChars -= state.backlog.shift()!.data.length;
      }
      return;
    }
    for (const handler of state.outputHandlers) safely(() => handler(event.chunk));
  };

  const route = (terminalId: unknown, event: TerminalWireEvent): void => {
    if (typeof terminalId !== 'string') return;
    const state = handles.get(terminalId);
    if (state) {
      apply(state, event);
    } else if (pendingCreates > 0) {
      const held = early.get(terminalId) ?? [];
      held.push(event);
      early.set(terminalId, held);
    }
  };

  transport.onOutput((payload) => {
    const p = payload as { terminalId?: unknown; data?: unknown; cursor?: unknown } | null;
    if (typeof p?.data !== 'string' || typeof p.cursor !== 'number') return;
    route(p.terminalId, { kind: 'output', chunk: { data: p.data, cursor: p.cursor } });
  });
  transport.onExit((payload) => {
    const p = payload as { terminalId?: unknown; exitCode?: unknown; signal?: unknown } | null;
    route(p?.terminalId, {
      kind: 'exit',
      exit: {
        exitCode: typeof p?.exitCode === 'number' ? p.exitCode : -1,
        ...(typeof p?.signal === 'number' && p.signal > 0 ? { signal: p.signal } : {}),
      },
    });
  });

  return {
    createCommandTerminal: async (options) => {
      pendingCreates += 1;
      let created: { terminalId: string; pid: number };
      try {
        created = (await transport.call('create', options)) as { terminalId: string; pid: number };
      } finally {
        pendingCreates -= 1;
        if (pendingCreates === 0 && early.size > 0) {
          // Queued so the adoption just below runs first. What is left then
          // belongs to terminals no create claimed.
          queueMicrotask(() => {
            if (pendingCreates === 0) early.clear();
          });
        }
      }

      const { terminalId, pid } = created;
      const state: TerminalHandleState = {
        outputHandlers: new Set(),
        exitHandlers: new Set(),
        backlog: [],
        backlogChars: 0,
      };
      handles.set(terminalId, state);
      for (const event of early.get(terminalId) ?? []) apply(state, event);
      early.delete(terminalId);

      const terminal: BackendCommandTerminal = {
        id: terminalId,
        pid,
        onOutput: (handler) => {
          const backlog = state.backlog;
          state.backlog = null;
          state.backlogChars = 0;
          state.outputHandlers.add(handler);
          for (const chunk of backlog ?? []) safely(() => handler(chunk));
          return () => {
            state.outputHandlers.delete(handler);
          };
        },
        onExit: (handler) => {
          if (state.exit) {
            const exit = state.exit;
            safely(() => handler(exit));
            return () => {};
          }
          state.exitHandlers.add(handler);
          return () => {
            state.exitHandlers.delete(handler);
          };
        },
        kill: async (signal) => {
          await transport.call('kill', { terminalId, signal });
        },
        stop: async (stopOptions) =>
          (await transport.call('stop', { terminalId, graceMs: stopOptions?.graceMs })) as Awaited<
            ReturnType<BackendCommandTerminal['stop']>
          >,
        read: async (readOptions) =>
          (await transport.call('read', { terminalId, ...(readOptions ?? {}) })) as Awaited<
            ReturnType<BackendCommandTerminal['read']>
          >,
        reveal: async () => {
          await transport.call('reveal', { terminalId });
        },
        setStatus: async (tone) => {
          await transport.call('setStatus', { terminalId, tone });
        },
        dispose: async () => {
          await transport.call('dispose', { terminalId });
          handles.delete(terminalId);
        },
      };
      return terminal;
    },
  };
}
