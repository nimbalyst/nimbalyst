/**
 * Backend module entry point for the gemini-antigravity extension.
 *
 * Compiled to dist/agent.js. The host loads this with a Node CommonJS require
 * (or ESM import, depending on SDK version) and calls the default export's
 * `activate(ctx)` once, then drives sessions through the returned API.
 *
 * Phase-4 proposal resolutions:
 *   Q1 -- single default export with activate(ctx).
 *   Q2 -- raw audit goes through ctx.services.logRaw; no DB import here.
 *   Q4 -- createSession / resumeSession / sendMessage / abortSession /
 *         cleanupSession lifecycle.
 *   Q6 -- sendMessage returns AsyncIterable<ProtocolEvent>.
 *   Q7 -- tool execution goes through ctx.services.toolExecutor (provider-
 *         private), NOT host.requestPermission. The host injects the
 *         executor at activate() time and the same instance is reused for
 *         every session this module owns.
 *
 * Renderer-side leftovers:
 *   The original src/AntigravityAgentProvider.ts and src/AntigravityToolLoop
 *   Protocol.ts files have been deleted in Phase 5. The renderer-side keeps
 *   only the settings panel. The protocol is owned here.
 */

/// <reference path="./types.d.ts" />

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AntigravityServerManager } from './ServerManager';
import { AntigravityUsageMeter } from './UsageMeter';
import { AntigravityToolLoopProtocol } from './ToolLoopProtocol';

// -------------------------------------------------------------------------
// Per-session state
// -------------------------------------------------------------------------

interface SessionState {
  sessionId: string;
  workspacePath?: string;
  modelKey: string;
  systemPrompt: string;
  tools: BackendOpenAITool[];
  documentContext?: unknown;
  toolLoop: AntigravityToolLoopProtocol;
  abortController: AbortController | null;
}

const DEFAULT_MODEL_KEY = 'gemini-3-flash-agent';

/**
 * Read-only dev tool names. Calls with these names route to the host's
 * `devToolExecutor` channel (gated on workspace-files) instead of the
 * meta-agent orchestration channel `toolExecutor` (gated on db-write). A
 * standard session only ever receives dev tools, and a meta-agent session only
 * orchestration tools, so this routing is unambiguous per session. Keep in sync
 * with the host's DEV_AGENT_TOOL_NAMES (devAgentTools.ts).
 */
const DEV_AGENT_TOOL_NAMES = new Set<string>(['read_file', 'list_files', 'search_files', 'write_file']);

/**
 * Strip a provider prefix like "antigravity-gemini-agent:gemini-3-flash-agent"
 * down to the stable model key. Mirrors the renderer-side logic so the host
 * can hand us either form.
 */
function extractModelKey(raw: string | undefined): string {
  if (!raw) return DEFAULT_MODEL_KEY;
  return raw.includes(':') ? raw.split(':').slice(1).join(':') : raw;
}

/**
 * Read overrideIdeVersion + spawnPortCandidates with the following precedence:
 *   1. ctx.config (manifest + user settings merged)
 *   2. <extensionPath>/antigravity-backend-config.json (operator escape hatch)
 *   3. baked-in defaults (handled by ServerManager itself).
 *
 * The config-file path exists so that operators can bump the supported-build
 * floor without rebuilding the extension when Antigravity ships a new
 * required version. The file is read once at activate() time; subsequent
 * edits require an extension reload.
 */
function resolveServerConfig(ctx: BackendActivateContext): {
  overrideIdeVersion?: string;
  spawnPortCandidates?: number[];
} {
  const out: { overrideIdeVersion?: string; spawnPortCandidates?: number[] } = {};

  // 1. ctx.config (host delivers identity/config under runtimeContext; fall
  //    back to the flat shape for forward/backward compatibility)
  const cfg = ctx.runtimeContext?.config ?? ctx.config ?? {};
  if (typeof cfg.overrideIdeVersion === 'string' && cfg.overrideIdeVersion.length > 0) {
    out.overrideIdeVersion = cfg.overrideIdeVersion;
  }
  if (Array.isArray(cfg.spawnPortCandidates) && cfg.spawnPortCandidates.length > 0) {
    out.spawnPortCandidates = (cfg.spawnPortCandidates as unknown[])
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
  }

  // 2. config file in extension dir, if either field is still unset
  if (!out.overrideIdeVersion || !out.spawnPortCandidates) {
    try {
      const extensionPath = ctx.runtimeContext?.extensionPath ?? ctx.extensionPath ?? '';
      const configPath = path.join(extensionPath, 'antigravity-backend-config.json');
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw) as {
          overrideIdeVersion?: unknown;
          spawnPortCandidates?: unknown;
        };
        if (
          !out.overrideIdeVersion
          && typeof parsed.overrideIdeVersion === 'string'
          && parsed.overrideIdeVersion.length > 0
        ) {
          out.overrideIdeVersion = parsed.overrideIdeVersion;
        }
        if (
          !out.spawnPortCandidates
          && Array.isArray(parsed.spawnPortCandidates)
          && parsed.spawnPortCandidates.length > 0
        ) {
          out.spawnPortCandidates = parsed.spawnPortCandidates
            .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
        }
      }
    } catch (err) {
      (ctx.runtimeContext?.logger ?? ctx.logger)?.warn?.(
        '[antigravity-backend] failed to read antigravity-backend-config.json:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  return out;
}

const execAsync = promisify(exec);

// run_command tuning. The Gemini agent runs shell commands locally in this
// backend, which already holds native-code privilege (it spawns the Antigravity
// language server). cwd is pinned to the session workspace and the call is
// bounded by a hard timeout and output caps.
const RUN_COMMAND_TIMEOUT_MS = 120_000;
const RUN_COMMAND_MAX_BUFFER = 4 * 1024 * 1024;
const RUN_COMMAND_MAX_OUTPUT = 48_000;

function clampCommandOutput(text: string): string {
  return text.length <= RUN_COMMAND_MAX_OUTPUT
    ? text
    : `${text.slice(0, RUN_COMMAND_MAX_OUTPUT)}\n\n[output truncated at ${RUN_COMMAND_MAX_OUTPUT} characters]`;
}

/**
 * Execute a shell command in the workspace and return stdout/stderr/exit code
 * as text for the model. Runs in THIS backend process (not via the host broker):
 * the module already has native-code consent, cwd is the session workspace, and
 * the call is bounded by a timeout and output caps.
 */
async function runCommand(
  workspacePath: string | undefined,
  args: Record<string, unknown>,
): Promise<string> {
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) return 'Error: run_command requires a non-empty "command" string.';
  if (!workspacePath) return 'Error: run_command needs an open workspace; none is bound to this session.';
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workspacePath,
      timeout: RUN_COMMAND_TIMEOUT_MS,
      maxBuffer: RUN_COMMAND_MAX_BUFFER,
      windowsHide: true,
    });
    const body =
      [stdout ? `stdout:\n${stdout}` : '', stderr ? `stderr:\n${stderr}` : '']
        .filter(Boolean)
        .join('\n\n') || '(no output)';
    return clampCommandOutput(`$ ${command}\nexit code: 0\n\n${body}`);
  } catch (err: unknown) {
    const e = err as {
      code?: number; killed?: boolean; signal?: string;
      stdout?: string; stderr?: string; message?: string;
    };
    if (e.killed && e.signal === 'SIGTERM') {
      return clampCommandOutput(`$ ${command}\n[command timed out after ${RUN_COMMAND_TIMEOUT_MS / 1000}s]`);
    }
    const parts = [
      `$ ${command}`,
      `exit code: ${typeof e.code === 'number' ? e.code : 'unknown'}`,
      e.stdout ? `stdout:\n${e.stdout}` : '',
      e.stderr ? `stderr:\n${e.stderr}` : (e.message ? `error: ${e.message}` : ''),
    ].filter(Boolean);
    return clampCommandOutput(parts.join('\n\n'));
  }
}

/**
 * Build a session-scoped tool executor that uses the host's private channel
 * (Q7). The session ID and workspace path are captured at session-create time
 * so each per-turn invocation knows where it came from without the model
 * needing to remember.
 */
function makeSessionExecutor(
  ctx: BackendActivateContext,
  session: SessionState,
): (name: string, args: Record<string, unknown>) => Promise<unknown> {
  return async (name, args) => {
    // run_command executes locally in this backend (native-code privilege is
    // already granted at module start); cwd is the session's workspace.
    if (name === 'run_command') {
      return runCommand(session.workspacePath, args);
    }
    // Read/write dev tools go through the workspace-files-gated host channel;
    // the host pins the jail to its bound workspace, so no path is sent.
    if (DEV_AGENT_TOOL_NAMES.has(name)) {
      return ctx.services.devToolExecutor({ name, args });
    }
    return ctx.services.toolExecutor({
      sessionId: session.sessionId,
      workspacePath: session.workspacePath,
      name,
      args,
    });
  };
}

// -------------------------------------------------------------------------
// Default export: activate(ctx)
// -------------------------------------------------------------------------

async function activate(ctx: BackendActivateContext): Promise<{ methods: BackendModuleApi }> {
  const log = ctx.runtimeContext?.logger ?? ctx.logger ?? console;
  const extensionId = ctx.runtimeContext?.extensionId ?? ctx.extensionId;

  // Apply host-provided config to the shared ServerManager. We don't ensureRunning()
  // here -- spawn is deferred until the first sendMessage, so opening the settings
  // panel doesn't fire up the language server.
  const serverConfig = resolveServerConfig(ctx);
  AntigravityServerManager.shared().configure(serverConfig);

  log.info?.(
    `[antigravity-backend] activated extensionId=${extensionId} ` +
    `overrideIdeVersion=${serverConfig.overrideIdeVersion ?? '(default)'} ` +
    `ports=${serverConfig.spawnPortCandidates ? serverConfig.spawnPortCandidates.join(',') : '(default)'}`,
  );

  const sessions = new Map<string, SessionState>();

  // Usage meter shares the singleton ServerManager. getUsageSnapshot() below
  // reads it WITHOUT spawning: if no endpoint is live yet, it returns an
  // unavailable result rather than firing up the language server.
  const usageMeter = new AntigravityUsageMeter(AntigravityServerManager.shared());

  function getOrThrow(sessionId: string): SessionState {
    const s = sessions.get(sessionId);
    if (!s) {
      throw new Error(`[antigravity-backend] session ${sessionId} is not created`);
    }
    return s;
  }

  function buildSessionState(input: CreateSessionInput | ResumeSessionInput): SessionState {
    const modelKey = extractModelKey(input.model);
    const toolLoop = new AntigravityToolLoopProtocol({ modelKey });
    return {
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      modelKey,
      systemPrompt: input.systemPrompt ?? '',
      tools: input.tools ?? [],
      documentContext: input.documentContext,
      toolLoop,
      abortController: null,
    };
  }

  const api: BackendModuleApi = {
    async createSession(input: CreateSessionInput): Promise<void> {
      // If the host re-creates a session under the same id, drop the previous
      // one cleanly. The Q4 lifecycle leaves it to the host whether
      // re-creation is allowed, but we tolerate it here defensively so we
      // never leak a stale tool loop.
      const existing = sessions.get(input.sessionId);
      if (existing) {
        existing.abortController?.abort();
        existing.toolLoop.abort();
      }
      const session = buildSessionState(input);
      session.toolLoop.reset();
      sessions.set(input.sessionId, session);
    },

    async resumeSession(input: ResumeSessionInput): Promise<void> {
      const existing = sessions.get(input.sessionId);
      if (existing) {
        existing.abortController?.abort();
        existing.toolLoop.abort();
      }
      const session = buildSessionState(input);
      const history = input.history ?? [];
      if (history.length > 0) {
        session.toolLoop.seedHistory(history);
      } else {
        session.toolLoop.reset();
      }
      sessions.set(input.sessionId, session);
    },

    async *sendMessage(input: SendMessageInput): AsyncIterable<ProtocolEvent> {
      const session = getOrThrow(input.sessionId);

      // Per-turn overrides win over session defaults.
      const tools = input.tools ?? session.tools;
      const systemPrompt = input.systemPrompt ?? session.systemPrompt;

      // Per-turn history override: re-seed the tool loop. The host typically
      // hands us the full prior canonical history on resume; we deduplicate
      // by NOT pushing the inbound user message again (the tool loop appends
      // it explicitly inside run()). Mirrors the renderer-side behavior of
      // popping a trailing duplicate user turn.
      if (input.history && input.history.length > 0) {
        const prior = [...input.history];
        const lastPrior = prior[prior.length - 1];
        if (
          lastPrior
          && lastPrior.role === 'user'
          && typeof lastPrior.content === 'string'
          && lastPrior.content.trim() === input.message.trim()
        ) {
          prior.pop();
        }
        session.toolLoop.seedHistory(prior);
      }

      // Raw audit (Q2): log the user message before we start streaming. The
      // host's logRaw is fire-and-forget from our point of view; we don't
      // await it on the hot path beyond the synchronous portion.
      try {
        await ctx.services.logRaw(
          session.sessionId,
          'inbound',
          input.message,
          {
            role: 'user',
            timestamp: Date.now(),
            model: session.modelKey,
            documentContext: input.documentContext ?? session.documentContext,
          },
        );
      } catch (err) {
        log.warn?.('[antigravity-backend] logRaw(user) failed:', err);
      }

      session.abortController = new AbortController();
      const ctrl = session.abortController;
      const executor = makeSessionExecutor(ctx, session);

      let finalText = '';
      let toolCallSeq = 0;
      let sawText = false;
      const lastToolResult = new Map<string, { id: string; name: string; args: Record<string, unknown> }>();

      try {
        for await (const step of session.toolLoop.run(
          input.message,
          systemPrompt,
          tools,
          executor,
        )) {
          if (ctrl.signal.aborted) break;

          if (step.type === 'tool_call') {
            const id = `agy-${Date.now()}-${toolCallSeq++}`;
            lastToolResult.set(step.name, { id, name: step.name, args: step.args });
            yield {
              type: 'tool_call',
              toolCall: {
                id,
                name: step.name,
                arguments: step.args,
              },
            };
          } else if (step.type === 'tool_result') {
            const pending = lastToolResult.get(step.name);
            if (pending) {
              // Raw audit for the tool turn. The result is whatever the
              // tool returned; the host decides how to persist it.
              try {
                await ctx.services.logRaw(
                  session.sessionId,
                  'outbound',
                  JSON.stringify({ name: step.name, result: step.result, args: pending.args }),
                  {
                    role: 'tool',
                    timestamp: Date.now(),
                  },
                );
              } catch (err) {
                log.warn?.('[antigravity-backend] logRaw(tool) failed:', err);
              }
              yield {
                type: 'tool_call',
                toolCall: {
                  id: pending.id,
                  name: pending.name,
                  arguments: pending.args,
                  result: step.result,
                },
              };
              lastToolResult.delete(step.name);
            }
          } else if (step.type === 'text') {
            finalText = step.content;
            sawText = true;
            // Mirror the renderer-side fix for empty text turns: always
            // yield SOMETHING so the host's stream pipeline registers the
            // assistant response. The placeholder text is what the user
            // sees AND what the host persists.
            const renderedText =
              finalText.trim().length === 0 ? '(model returned no text)' : finalText;
            yield { type: 'text', content: renderedText };
          } else if (step.type === 'complete') {
            const persistedText =
              finalText.trim().length === 0
                ? (sawText ? '(model returned no text)' : '(no model response)')
                : finalText;

            // Raw audit for the assistant turn happens here, AFTER the model
            // has finished producing its full response. The host correlates
            // by sessionId + timestamp ordering.
            try {
              await ctx.services.logRaw(
                session.sessionId,
                'outbound',
                persistedText,
                {
                  role: 'assistant',
                  timestamp: Date.now(),
                  model: session.modelKey,
                },
              );
            } catch (err) {
              log.warn?.('[antigravity-backend] logRaw(assistant) failed:', err);
            }

            yield { type: 'complete', content: persistedText, isComplete: true };
          }
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const errMessage = err instanceof Error ? err.message : String(err);
        yield { type: 'error', error: errMessage };
      } finally {
        session.abortController = null;
      }
    },

    abortSession(sessionId: string): void {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.abortController?.abort();
      session.toolLoop.abort();
    },

    cleanupSession(sessionId: string): void {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.abortController?.abort();
      session.toolLoop.abort();
      sessions.delete(sessionId);
    },

    async getUsageSnapshot(): Promise<UsageSnapshotResult> {
      // Read-only. Never spawn: if the language server isn't already running,
      // report unavailable so the usage chip degrades to a muted state instead
      // of starting the server from a background poll.
      if (AntigravityServerManager.shared().currentEndpoint() === null) {
        return { available: false, error: 'Gemini server not started yet' };
      }
      try {
        const snapshot = await usageMeter.getSnapshot();
        return { available: true, snapshot };
      } catch (err) {
        return {
          available: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  // The privileged backend bootstrap dispatches RPCs via `loaded.api.methods`,
  // so the lifecycle methods must be returned under a `methods` key (not as a
  // flat object). Without this wrapper no methods register and every
  // createSession / sendMessage RPC fails with "Unknown method".
  return { methods: api };
}

export default { activate };
export { activate };
