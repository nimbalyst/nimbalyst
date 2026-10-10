/**
 * Gemini agent provider, backed by the Antigravity language server.
 *
 * Not a `HeadlessCliAgentProvider` subclass. That base assumes one process per
 * turn streaming NDJSON on stdout; Antigravity is a long-lived local server
 * addressed over Connect-RPC, whose single relevant call --
 * `GetModelResponse({prompt, model}) -> {response}` -- is stateless, buffered,
 * and has no function-calling surface. `AntigravityToolLoopProtocol` supplies
 * the tool loop the transport lacks; this class is the host-facing half.
 *
 * Three consequences of that transport, each declared rather than assumed:
 *
 *   - **No provider session id.** The server keeps nothing between calls, so
 *     the whole conversation is re-rendered into one flat prompt per turn from
 *     the host's own message history. `getProviderSessionData` has nothing to
 *     return, and resuming a session is just re-seeding the loop.
 *   - **No usage numbers.** The response envelope carries only `response`.
 *     `contextReporting: 'none'` in `agentCapabilities.ts` follows from that --
 *     a percentage drawn from a token count we do not have would be a lying 0%
 *     (#914). Quota lives on a separate account-level RPC; see
 *     `AntigravityUsageMeter`.
 *   - **`'tool-args'` file fidelity, not `'structured'`.** Nimbalyst performs
 *     Gemini's writes itself, so an exact pre-edit baseline is free and this
 *     provider emits authoritative pre/post edit snapshots. It still stops
 *     short of `'structured'` because the toolset has no delete and no move:
 *     every removal is an opaque `rm` inside `run_command`. Declaring
 *     `'structured'` would switch the filesystem watcher off and make those
 *     removals vanish from the Files Edited sidebar. Same reasoning as
 *     `grok-build`, whose toolset is identical in this respect.
 *
 * Auth rides the user's existing Antigravity login. Nimbalyst stores no key for
 * it and reads no environment variable. That login is NOT on disk under
 * `~/.gemini` (which holds only onboarding state and config) -- on macOS it is
 * in the keychain, service `gemini`, account `antigravity`. Which is why
 * detection can answer "installed" but not "signed in"; see
 * `headlessAgentAvailability.ts`.
 */

import { BaseAgentProvider } from './BaseAgentProvider';
import { appendSessionDirective } from '../../prompt';
import {
  AntigravityServerManager,
  AntigravityVersionGateError,
} from './geminiAntigravity/AntigravityServerManager';
import { AntigravityToolLoopProtocol } from './geminiAntigravity/AntigravityToolLoopProtocol';
import {
  DEFAULT_GEMINI_MODEL_KEY,
  bareGeminiModelKey,
  discoverGeminiModels,
} from './geminiAntigravity/geminiAntigravityModels';
import type { ProviderSessionData } from './ProviderSessionManager';
import type {
  AgentToolDefinition,
  AIModel,
  AIProviderType,
  ChatAttachment,
  DocumentContext,
  Message,
  ProviderConfig,
  StreamChunk,
  ToolHandler,
} from '../types';

export const GEMINI_ANTIGRAVITY_PROVIDER: AIProviderType = 'antigravity-gemini-agent';

/**
 * Outcome of a host-executed tool call.
 *
 * `text` is what the model sees. `fileWrite` is present only when the call
 * actually wrote a file, and carries the content read immediately before the
 * write -- the baseline no watcher or snapshot cache can beat, because nothing
 * ran between the read and the write.
 */
export interface GeminiToolExecutionResult {
  text: string;
  fileWrite?: {
    absPath: string;
    /** `null` when the file did not exist -- a create, not an update. */
    beforeContent: string | null;
    afterContent: string;
  };
}

export interface GeminiToolExecutorArgs {
  sessionId: string;
  workspacePath?: string;
  name: string;
  args: Record<string, unknown>;
}

export type GeminiToolExecutor = (args: GeminiToolExecutorArgs) => Promise<GeminiToolExecutionResult>;

/** Server tuning the Electron main process reads out of settings. */
export interface GeminiServerConfig {
  overrideIdeVersion?: string;
  spawnPortCandidates?: number[];
}

interface SessionState {
  sessionId: string;
  workspacePath?: string;
  modelKey: string;
  toolLoop: AntigravityToolLoopProtocol;
  abortController: AbortController | null;
}

// run_command tuning. The command runs in this process with the session's
// workspace as cwd, bounded by a hard timeout and output caps.
const RUN_COMMAND_TIMEOUT_MS = 120_000;
const RUN_COMMAND_MAX_BUFFER = 4 * 1024 * 1024;
const RUN_COMMAND_MAX_OUTPUT = 48_000;

function clampCommandOutput(text: string): string {
  return text.length <= RUN_COMMAND_MAX_OUTPUT
    ? text
    : `${text.slice(0, RUN_COMMAND_MAX_OUTPUT)}\n\n[output truncated at ${RUN_COMMAND_MAX_OUTPUT} characters]`;
}

export class GeminiAntigravityProvider extends BaseAgentProvider {
  private static toolExecutor: GeminiToolExecutor | null = null;
  private static serverConfigLoader: (() => GeminiServerConfig) | null = null;

  private readonly sessionStates = new Map<string, SessionState>();
  private readonly server: AntigravityServerManager;

  constructor(deps?: { server?: AntigravityServerManager }) {
    super();
    this.server = deps?.server ?? AntigravityServerManager.shared();
  }

  getProviderName(): AIProviderType {
    return GEMINI_ANTIGRAVITY_PROVIDER;
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
    // Apply configuration but do NOT start the server: spawning is deferred to
    // the first real turn, so opening settings or a model picker never fires up
    // a ~120MB language server.
    const serverConfig = GeminiAntigravityProvider.serverConfigLoader?.();
    if (serverConfig) this.server.configure(serverConfig);
  }

  /**
   * Nothing to return: the language server holds no session state, so there is
   * no provider-side id to persist alongside the Nimbalyst session row.
   */
  getProviderSessionData(_sessionId: string): ProviderSessionData | null {
    return null;
  }

  registerToolHandler(_handler: ToolHandler): void {
    // Tools are executed through the injected `toolExecutor` (host-side, with
    // the workspace jail the host owns), not through the runtime tool-handler
    // surface. Kept so the class satisfies `AIProvider`.
  }

  abort(): void {
    for (const state of this.sessionStates.values()) {
      state.abortController?.abort();
      state.toolLoop.abort();
    }
    super.abort();
  }

  destroy(): void {
    this.abort();
    this.sessionStates.clear();
    super.destroy();
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: Message[],
    workspacePath?: string,
    _attachments?: ChatAttachment[],
    tools?: AgentToolDefinition[],
    systemPrompt?: string,
  ): AsyncIterableIterator<StreamChunk> {
    if (!sessionId) {
      yield { type: 'error', error: 'Gemini requires a session id.' };
      return;
    }

    // The host hands a tool-loop provider its whole system prompt (persona) and
    // does not include the session directive; it is appended here, frozen.
    const turnSystemPrompt = appendSessionDirective(systemPrompt ?? '', await this.getSessionDirective(sessionId));

    const state = this.resolveSession(sessionId, workspacePath, documentContext);
    const abortController = new AbortController();
    state.abortController = abortController;
    this.abortController = abortController;

    // Re-seed the loop from the host's canonical history. The turn's own user
    // message is appended by run(), so a trailing duplicate of it is dropped
    // rather than sent twice.
    if (messages && messages.length > 0) {
      const prior = [...messages];
      const last = prior[prior.length - 1];
      if (last?.role === 'user' && typeof last.content === 'string'
        && last.content.trim() === message.trim()) {
        prior.pop();
      }
      state.toolLoop.seedHistory(prior);
    }

    await this.logAgentMessageBestEffort(sessionId, 'input', message, {
      metadata: {
        role: 'user',
        timestamp: Date.now(),
        model: state.modelKey,
        documentContext,
      },
    });

    let finalText = '';
    let sawText = false;
    let toolCallSeq = 0;
    // The tool loop reports a call and its result as two separate steps keyed
    // only by tool name, so the id minted on the call is held here until the
    // matching result arrives. It becomes the chunk's `toolUseId`, which is
    // what file attribution and pre-edit history tags correlate on.
    const pendingCalls = new Map<string, { id: string; name: string; args: Record<string, unknown> }>();

    try {
      for await (const step of state.toolLoop.run(
        message,
        turnSystemPrompt,
        (tools ?? []) as Array<{ type: 'function'; function: { name: string } }>,
        (name, args) => this.executeTool(state, name, args),
        undefined,
        abortController.signal,
      )) {
        if (abortController.signal.aborted) break;

        if (step.type === 'tool_call') {
          const id = `agy-${Date.now()}-${toolCallSeq++}`;
          pendingCalls.set(step.name, { id, name: step.name, args: step.args });
          yield { type: 'tool_call', toolCall: { id, name: step.name, arguments: step.args } };
        } else if (step.type === 'tool_result') {
          const pending = pendingCalls.get(step.name);
          if (!pending) {
            // No id to attribute a write to. Drop any buffered snapshot rather
            // than letting it ride along to the NEXT tool's id, which would
            // pin one tool's file change onto an unrelated call in the diff
            // view. Losing the snapshot degrades to watcher attribution;
            // mis-attributing it is a wrong answer stated confidently.
            this.pendingEditSnapshots.length = 0;
            continue;
          }
          // Emit the edit snapshots BEFORE the terminal tool_call chunk. That
          // chunk closes the attribution window, and a snapshot arriving after
          // it would tag a file the host has stopped associating with the call.
          for (const snapshot of this.drainEditSnapshots(pending.id)) {
            yield snapshot;
          }
          await this.logAgentMessageBestEffort(
            sessionId,
            'output',
            JSON.stringify({ name: step.name, result: step.result, args: pending.args }),
            // `toolUseId` is what makes a reloaded transcript agree with the
            // live one: without it the parser has to mint a synthetic id, and
            // the reloaded tool card is a different event from the streamed
            // one. Rows written before this existed have none, which is why
            // `GeminiAntigravityRawParser` still has a synthetic fallback.
            { metadata: { role: 'tool', timestamp: Date.now(), toolUseId: pending.id } },
          );
          yield {
            type: 'tool_call',
            toolCall: {
              id: pending.id,
              name: pending.name,
              arguments: pending.args,
              result: step.result,
            },
          };
          pendingCalls.delete(step.name);
        } else if (step.type === 'text') {
          finalText = step.content;
          sawText = true;
          // Always surface something: an empty assistant turn would otherwise
          // leave the transcript with no assistant message at all for the turn.
          yield {
            type: 'text',
            content: finalText.trim().length === 0 ? '(model returned no text)' : finalText,
          };
        } else if (step.type === 'complete') {
          const persisted = finalText.trim().length === 0
            ? (sawText ? '(model returned no text)' : '(no model response)')
            : finalText;
          await this.logAgentMessageBestEffort(sessionId, 'output', persisted, {
            metadata: { role: 'assistant', timestamp: Date.now(), model: state.modelKey },
          });
          yield { type: 'complete', content: persisted, isComplete: true };
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (/not found at |Install Antigravity/i.test(errorMessage)) {
        yield { type: 'error', error: GeminiAntigravityProvider.NOT_INSTALLED_MESSAGE };
      } else if (error instanceof AntigravityVersionGateError) {
        // The server enforces a supported-build floor and Antigravity has
        // raised it. The underlying message names the flag, which is no use to
        // anyone; say what to actually do. Updating Antigravity is the fix, and
        // the settings key is the escape hatch for someone who cannot wait for
        // a Nimbalyst release.
        yield { type: 'error', error: GeminiAntigravityProvider.VERSION_GATE_MESSAGE };
      } else if (/not logged in|unauthorized|forbidden|HTTP 401|HTTP 403/i.test(errorMessage)) {
        yield {
          type: 'error',
          error: GeminiAntigravityProvider.NOT_SIGNED_IN_MESSAGE,
          isAuthError: true,
        };
      } else {
        yield { type: 'error', error: errorMessage };
      }
    } finally {
      state.abortController = null;
      if (this.abortController === abortController) this.abortController = null;
      this.pendingEditSnapshots.length = 0;
    }
  }

  // --- Tool execution ------------------------------------------------------

  /**
   * Edit snapshots produced by the current turn's writes, drained onto the
   * stream when the write's tool result comes back. Buffered rather than
   * yielded inline because the executor is a plain callback the tool loop
   * awaits -- it has no channel back onto the generator.
   */
  private readonly pendingEditSnapshots: Array<{
    beforeContent: string | null;
    afterContent: string;
    absPath: string;
  }> = [];

  private async executeTool(
    state: SessionState,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (name === 'run_command') {
      return this.runCommand(state.workspacePath, args);
    }
    const executor = GeminiAntigravityProvider.toolExecutor;
    if (!executor) {
      return `Error: "${name}" cannot run -- no tool executor is installed for this provider.`;
    }
    const result = await executor({
      sessionId: state.sessionId,
      workspacePath: state.workspacePath,
      name,
      args,
    });
    if (result.fileWrite) this.pendingEditSnapshots.push(result.fileWrite);
    return result.text;
  }

  /**
   * Turn this turn's buffered writes into the pre/post snapshot chunks
   * `MessageStreamingHandler` writes as local-history entries.
   *
   * `authoritative: true` is earned, not asserted: `beforeContent` was read
   * inside the write path microseconds before the write, so a FileSnapshotCache
   * lookup at this point can only be staler. A `null` before-content means the
   * file did not exist, and an empty-string baseline is the correct one for a
   * create -- unlike the `'structured'` providers, which must skip the entry
   * because they cannot distinguish "no baseline recorded" from "empty file".
   */
  private *drainEditSnapshots(toolUseId: string): Generator<StreamChunk> {
    if (this.pendingEditSnapshots.length === 0) return;
    const writes = this.pendingEditSnapshots.splice(0, this.pendingEditSnapshots.length);
    yield {
      type: 'pre_edit_snapshot',
      preEditSnapshot: {
        toolUseId,
        entries: writes.map((w) => ({
          path: w.absPath,
          content: w.beforeContent ?? '',
          kind: w.beforeContent === null ? 'add' : 'update',
        })),
        authoritative: true,
      },
    };
    yield {
      type: 'post_edit_snapshot',
      postEditSnapshot: {
        toolUseId,
        entries: writes.map((w) => ({
          path: w.absPath,
          content: w.afterContent,
          kind: w.beforeContent === null ? 'add' : 'update',
        })),
      },
    };
  }

  /**
   * Run a shell command in the session's workspace and return stdout/stderr/exit
   * code as text for the model. Bounded by a timeout and output caps; cwd is
   * pinned to the workspace so a bare relative path cannot escape it.
   *
   * Unlike the other tools this does not go through the host executor, because
   * it needs nothing the host owns beyond a working directory. Note it runs
   * from Nimbalyst's own process rather than the extension utility process it
   * used to live in -- `exec` is async and the child is what dies on a bad
   * command, so a runaway cannot block the event loop, but the timeout and the
   * output caps are what keep it bounded and neither is optional.
   */
  private async runCommand(
    workspacePath: string | undefined,
    args: Record<string, unknown>,
  ): Promise<string> {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) return 'Error: run_command requires a non-empty "command" string.';
    if (!workspacePath) {
      return 'Error: run_command needs an open workspace; none is bound to this session.';
    }
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
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
        return clampCommandOutput(
          `$ ${command}\n[command timed out after ${RUN_COMMAND_TIMEOUT_MS / 1000}s]`,
        );
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

  // --- Session state -------------------------------------------------------

  private resolveSession(
    sessionId: string,
    workspacePath: string | undefined,
    documentContext: DocumentContext | undefined,
  ): SessionState {
    const modelKey = bareGeminiModelKey(
      this.config.model ?? (documentContext as { model?: string } | undefined)?.model,
    );
    const existing = this.sessionStates.get(sessionId);
    if (existing) {
      if (workspacePath) existing.workspacePath = workspacePath;
      if (existing.modelKey !== modelKey) {
        existing.modelKey = modelKey;
        existing.toolLoop.setModelKey(modelKey);
      }
      return existing;
    }
    const state: SessionState = {
      sessionId,
      workspacePath,
      modelKey,
      toolLoop: new AntigravityToolLoopProtocol({ modelKey, server: this.server }),
      abortController: null,
    };
    this.sessionStates.set(sessionId, state);
    return state;
  }

  // --- Static injection (Electron main process, at startup) ----------------

  static setToolExecutor(executor: GeminiToolExecutor | null): void {
    GeminiAntigravityProvider.toolExecutor = executor;
  }

  static setServerConfigLoader(loader: (() => GeminiServerConfig) | null): void {
    GeminiAntigravityProvider.serverConfigLoader = loader;
  }

  // --- Detection and catalog ----------------------------------------------

  static readonly NOT_INSTALLED_MESSAGE =
    'Antigravity is not installed. Install it from https://antigravity.google, '
    + 'sign in once, then try again — Nimbalyst uses that login and stores no key of its own.';

  static readonly NOT_SIGNED_IN_MESSAGE =
    'Antigravity is installed but not signed in. Open Antigravity and sign in to '
    + 'your Google account, then try again.';

  static readonly VERSION_GATE_MESSAGE =
    'Antigravity rejected this build as out of date. Update Antigravity to its '
    + 'latest version and try again. (If you need to keep the current version, '
    + 'set a newer `overrideIdeVersion` on the Gemini provider in ai-settings.)';

  /** True when the Antigravity language server binary is present. */
  static isInstalled(): boolean {
    return AntigravityServerManager.isInstalled();
  }

  /** Path the install is expected at, for the settings panel to show. */
  static installPath(): string {
    return AntigravityServerManager.binaryPath();
  }

  static getDefaultModel(): string {
    return `${GEMINI_ANTIGRAVITY_PROVIDER}:${DEFAULT_GEMINI_MODEL_KEY}`;
  }

  /**
   * The model catalog, discovered from the language server when it is already
   * running and falling back to a short seed list otherwise. See
   * `geminiAntigravityModels.ts` for why discovery never spawns the server.
   */
  static async getModels(): Promise<AIModel[]> {
    const models = await discoverGeminiModels(AntigravityServerManager.shared());
    return models.map((m) => ({
      id: `${GEMINI_ANTIGRAVITY_PROVIDER}:${m.key}`,
      name: m.displayName,
      provider: GEMINI_ANTIGRAVITY_PROVIDER,
    }));
  }
}
