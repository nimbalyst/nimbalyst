/**
 * OpenAI Codex app-server Protocol Adapter
 *
 * Drives `codex app-server --listen stdio://` directly via JSON-RPC v2, in
 * contrast to the SDK transport which spawns `codex exec --experimental-json`
 * for every turn.
 *
 * Why it exists: the app-server protocol's `item/started` and `item/completed`
 * notifications for `fileChange` items carry the full unified-diff text per
 * affected path, which lets us recover pre-edit content deterministically by
 * reverse-applying the hunks. The SDK exec stream strips this and only sends
 * `{path, kind}`, forcing host-side disk reads that race apply_patch.
 *
 * Architecture:
 *   - One codex app-server child process per session (createSession spawns,
 *     cleanupSession kills). Multiple turns reuse the same process.
 *   - JsonRpcClient handles framing (newline-delimited JSON) and routing.
 *   - sendMessage is an async generator: notifications are pushed onto an
 *     internal queue, the generator pulls and yields ProtocolEvents until
 *     `turn/completed` or `turn/failed` arrives.
 *   - Approval RPCs from codex (server -> client requests) are routed to a
 *     host-provided dispatcher so they flow through Nimbalyst's existing
 *     tool-permission system (mirrors Claude Code's canUseTool callback).
 *
 * Backed by Phase 0 spike findings; see
 * `nimbalyst-local/plans/codex-app-server-protocol-migration.md`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { buildDocumentAttachmentPromptText } from '../providers/codex/documentAttachmentPrompt';
import { describeCodexConfigError } from './codexConfigError';
import { reverseCodexPatch, type CodexPatchKind } from '../providers/codex/patchReverse';
import {
  AgentProtocol,
  ProtocolSession,
  SessionOptions,
  ProtocolMessage,
  ProtocolEvent,
  ToolResult,
} from './ProtocolInterface';
import { JsonRpcClient } from './codexAppServer/jsonRpcClient';
import {
  getCodexVendorPathEntries,
  resolveCodexBinaryPath,
} from './codexAppServer/codexAppServerBinary';
import { terminateOwnedProcessTree } from './processTreeTermination';
import type {
  AnyItem,
  ApprovalResponse,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  ErrorNotification,
  FileChangeChange,
  FileChangeItem,
  InitializeResponse,
  ItemCompletedNotification,
  ItemFileChangeRequestApprovalParams,
  ItemCommandExecutionRequestApprovalParams,
  ItemPermissionsRequestApprovalParams,
  ItemStartedNotification,
  McpElicitationResponse,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TokenUsage,
  TurnCompletedNotification,
  TurnStartParams,
  UserInputElement,
  WarningNotification,
} from './codexAppServer/types';

// ---- Dynamic tool surface (plumbed but unused in this milestone) ----

export interface DynamicToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
  namespace?: string;
  deferLoading?: boolean;
}

/**
 * Host-provided dispatcher for codex's server-to-client requests. Maps each
 * approval/elicitation/tool-call request to a Nimbalyst surface (the existing
 * tool-permission system, dialog system, etc.). Returns the response shape
 * codex expects for that method.
 */
export interface CodexAppServerHostBindings {
  /** Decide whether codex should be allowed to apply a file-change patch. */
  approveFileChange?: (params: ItemFileChangeRequestApprovalParams) => Promise<ApprovalResponse> | ApprovalResponse;
  /** Decide whether codex should be allowed to run a shell command. */
  approveCommandExecution?: (params: ItemCommandExecutionRequestApprovalParams) => Promise<ApprovalResponse> | ApprovalResponse;
  /** Decide an arbitrary codex permissions request. */
  approvePermissions?: (params: ItemPermissionsRequestApprovalParams) => Promise<ApprovalResponse> | ApprovalResponse;
  /** Handle an MCP elicitation prompt (MCP tool approval / form prompt). */
  handleMcpElicitation?: (params: unknown) => Promise<McpElicitationResponse> | McpElicitationResponse;
  /** Handle a tool-driven user-input prompt. */
  handleToolUserInput?: (params: unknown) => Promise<unknown> | unknown;
  /** Execute a host-registered dynamic tool. Phase 2 plumbing; no callers yet. */
  callDynamicTool?: (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse> | DynamicToolCallResponse;
}

export interface CodexAppServerProtocolOptions {
  apiKey?: string;
  /** Resolver for the codex binary path in packaged builds. Optional in dev. */
  resolveCodexPathOverride?: () => string | undefined;
  /** Host approvals/dynamic-tools dispatcher. */
  host?: CodexAppServerHostBindings;
  /** Optional client info to send in initialize. */
  clientInfo?: { name: string; version: string };
  /** Injectable exact-tree terminator for deterministic lifecycle tests. */
  terminateProcessTreeOverride?: (child: ChildProcessWithoutNullStreams) => void;
}

interface AppServerSessionRaw {
  child: ChildProcessWithoutNullStreams;
  client: JsonRpcClient;
  threadId: string;
  options: SessionOptions;
  initResponse: InitializeResponse;
  /** Per-session dynamic tools registered for codex to call back into. */
  dynamicTools: DynamicToolSpec[];
  /** Snapshot of any uncompleted turn for abort handling. */
  activeTurnId: string | null;
  /** stderr buffer for diagnostic surface on failure. */
  stderrTail: string[];
  /** Prevent duplicate cleanup from re-targeting a PID after it exits. */
  cleanupStarted: boolean;
}

function previewForLog(value: string | undefined, max = 300): string | undefined {
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function summarizeNotificationParams(
  method: string,
  paramsUnknown: unknown,
): Record<string, unknown> | undefined {
  const params = (paramsUnknown && typeof paramsUnknown === 'object')
    ? paramsUnknown as Record<string, unknown>
    : undefined;
  if (!params) return undefined;

  switch (method) {
    case 'error':
    case 'turn/failed': {
      const errorObj = params.error as { message?: string; codexErrorInfo?: string; additionalDetails?: unknown } | undefined;
      return {
        threadId: params.threadId,
        turnId: params.turnId,
        willRetry: params.willRetry,
        message: previewForLog(errorObj?.message),
        codexErrorInfo: previewForLog(errorObj?.codexErrorInfo),
        additionalDetails: errorObj?.additionalDetails,
      };
    }
    case 'warning': {
      return {
        threadId: params.threadId,
        turnId: params.turnId,
        message: previewForLog(params.message as string | undefined),
      };
    }
    case 'turn/completed': {
      const turn = params.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
      return {
        threadId: params.threadId,
        turnId: turn?.id ?? params.turnId,
        status: turn?.status,
        error: previewForLog(turn?.error?.message),
      };
    }
    case 'mcpServer/startupStatus/updated': {
      return {
        name: params.name,
        status: params.status,
        error: previewForLog((params.error as string | null | undefined) ?? undefined),
      };
    }
    default:
      return undefined;
  }
}

export class CodexAppServerProtocol implements AgentProtocol {
  readonly platform = 'codex-app-server';

  private apiKey: string;
  private readonly resolveCodexPathOverride: () => string | undefined;
  private readonly host: CodexAppServerHostBindings;
  private readonly clientInfo: { name: string; version: string };
  private readonly terminateProcessTree: (child: ChildProcessWithoutNullStreams) => void;

  constructor(options: CodexAppServerProtocolOptions = {}) {
    this.apiKey = options.apiKey ?? '';
    this.resolveCodexPathOverride = options.resolveCodexPathOverride ?? (() => undefined);
    this.host = options.host ?? {};
    this.clientInfo = options.clientInfo ?? { name: 'nimbalyst', version: '0.0.0' };
    this.terminateProcessTree = options.terminateProcessTreeOverride
      ?? ((child) => terminateOwnedProcessTree(child));
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /**
   * Spawn a new codex app-server child, complete the JSON-RPC handshake, and
   * start a fresh thread. Each `ProtocolSession` owns its child process.
   */
  async createSession(options: SessionOptions): Promise<ProtocolSession> {
    const raw = await this.spawnAndInit(options);
    const startParams = this.buildThreadStartParams(options);
    const startResponse = await raw.client.request<ThreadStartResponse>('thread/start', startParams);
    const threadId = startResponse?.thread?.id;
    if (!threadId) {
      this.killChild(raw);
      throw new Error('[CodexAppServer] thread/start did not return a thread id');
    }
    raw.threadId = threadId;
    // console.log('[CODEX][APPSERVER] thread started:', threadId);
    return {
      id: threadId,
      platform: this.platform,
      raw: raw as unknown as ProtocolSession['raw'],
    };
  }

  /**
   * Spawn a fresh codex app-server and resume an existing thread by id.
   *
   * Every resume spawns a fresh codex child (the previous one died with the
   * previous Nimbalyst process), so the new child has no MCP servers, no
   * sandbox config, no approval policy, etc. attached until we tell it. The
   * codex v2 ThreadResumeParams schema accepts the same configuration surface
   * as ThreadStartParams (minus `ephemeral`), so we forward everything we
   * pass on first start. Without this, resumed threads start with codex's
   * defaults and the agent sees zero MCP tools available -- breaking
   * `developer_git_commit_proposal`, AskUserQuestion, and every other
   * Nimbalyst-internal tool that ships through the nimbalyst MCP servers.
   */
  async resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    const raw = await this.spawnAndInit(options);
    const startParams = this.buildThreadStartParams(options);
    // ThreadResumeParams accepts the same surface as ThreadStartParams minus
    // `ephemeral`. Drop it and replace `model: null` with omission so codex
    // can fall back to the persisted thread's model when we have no override.
    const { ephemeral: _ephemeral, model, ...resumeBase } = startParams as ThreadStartParams & { ephemeral?: boolean };
    const resumeParams: Record<string, unknown> = {
      ...resumeBase,
      threadId: sessionId,
    };
    if (model !== null && model !== undefined) {
      resumeParams.model = model;
    }
    try {
      const resumeResponse = await raw.client.request<ThreadResumeResponse>('thread/resume', resumeParams);
      raw.threadId = resumeResponse?.thread?.id ?? sessionId;
      // console.log('[CODEX][APPSERVER] thread resumed:', raw.threadId);
      return { id: raw.threadId, platform: this.platform, raw: raw as unknown as ProtocolSession['raw'] };
    } catch (err) {
      console.warn('[CODEX][APPSERVER] thread/resume failed, falling back to thread/start:', err);
      this.killChild(raw);
      return this.createSession(options);
    }
  }

  /**
   * Codex's `thread/fork` does support forking, but for parity with the SDK
   * adapter (which currently treats fork as "new thread") we start a new
   * thread. Future work could plumb the real fork RPC through.
   */
  async forkSession(_sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    return this.createSession(options);
  }

  async *sendMessage(session: ProtocolSession, message: ProtocolMessage): AsyncIterable<ProtocolEvent> {
    const raw = this.assertRaw(session);
    // Prefer the per-message signal: `raw.options.abortSignal` is the signal
    // of the turn that CREATED the session, which is stale for every turn
    // that reuses the cached ProtocolSession (NIM-1607).
    const abortSignal = message.abortSignal
      ?? (raw.options as unknown as { abortSignal?: AbortSignal })?.abortSignal
      ?? (session.raw as { options?: { abortSignal?: AbortSignal } })?.options?.abortSignal;

    // Drain queue: notifications and one terminating turn event are pushed by
    // the JsonRpcClient handler; the generator below awaits them.
    const queue: Array<{ kind: 'event'; event: ProtocolEvent } | { kind: 'end' } | { kind: 'fail'; error: Error } | { kind: 'abort' }> = [];
    let waiters: Array<(v: unknown) => void> = [];
    const push = (entry: typeof queue[number]) => {
      queue.push(entry);
      const w = waiters;
      waiters = [];
      for (const r of w) r(undefined);
    };

    let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;
    let fullText = '';

    const unsubscribers: Array<() => void> = [];

    const onNotification = (method: string, params: unknown) => {
      try {
        this.dispatchNotification(method, params, push, raw, (delta) => { fullText += delta; }, (u) => { usage = u; });
      } catch (err) {
        push({ kind: 'fail', error: err instanceof Error ? err : new Error(String(err)) });
      }
    };
    // Capture the unsubscribe so the next turn on this same ProtocolSession does
    // not re-process notifications through this turn's handler. Without this,
    // sendSessionNamingReminder (which runs a second sendMessage on the same
    // session) would double-process every notification: duplicate raw_event,
    // duplicate tool_call from a single item/completed, duplicate completion.
    unsubscribers.push(raw.client.onNotification(onNotification));

    // Wake the pump on abort. Without this, a cancel that lands while we're
    // parked awaiting the next notification is never observed (the aborted
    // check in the loop only runs after an event arrives): turn/interrupt is
    // never sent, the generator never unwinds, and the session stays
    // 'running' forever (NIM-1607). The interrupt is fire-and-forget -- the
    // child may be dead (slept machine, hung codex), and the pump must end
    // regardless of whether codex ever responds.
    let interruptRequested = false;
    const requestInterrupt = () => {
      if (interruptRequested) return;
      interruptRequested = true;
      Promise.resolve(raw.client.request('turn/interrupt', { threadId: raw.threadId }))
        .catch((err) => console.warn('[CODEX][APPSERVER] turn/interrupt failed:', err));
    };
    const onAbort = () => {
      requestInterrupt();
      push({ kind: 'abort' });
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true });
        unsubscribers.push(() => abortSignal.removeEventListener('abort', onAbort));
      }
    }

    // Start the turn. Errors from the request itself are surfaced as fail.
    const turnInput = await this.buildInput(message);
    let turnStartResultId: string | null = null;
    try {
      const turnStart = await raw.client.request<{ turn?: { id?: string } }>('turn/start', {
        threadId: raw.threadId,
        input: turnInput,
      } as TurnStartParams);
      turnStartResultId = turnStart?.turn?.id ?? null;
      raw.activeTurnId = turnStartResultId;
    } catch (err) {
      const baseMsg = err instanceof Error ? err.message : String(err);
      yield {
        type: 'error',
        error: appendStderrTail(baseMsg, raw),
      };
      return;
    }

    // Pump events until we see the terminating queue entry.
    try {
      while (true) {
        if (abortSignal?.aborted) {
          requestInterrupt();
        }
        while (queue.length === 0) {
          await new Promise<void>((resolve) => waiters.push(() => resolve()));
        }
        const entry = queue.shift()!;
        if (entry.kind === 'abort') {
          // Cancelled turn: unwind silently -- no complete (the turn didn't
          // finish) and no error (the caller asked for this).
          return;
        }
        if (entry.kind === 'event') {
          yield entry.event;
          continue;
        }
        if (entry.kind === 'fail') {
          yield { type: 'error', error: appendStderrTail(entry.error.message, raw) };
          return;
        }
        if (entry.kind === 'end') {
          yield {
            type: 'complete',
            content: fullText,
            usage: usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          };
          return;
        }
      }
    } finally {
      for (const unsub of unsubscribers) {
        try { unsub(); } catch { /* noop */ }
      }
      raw.activeTurnId = null;
    }
  }

  abortSession(session: ProtocolSession): void {
    const raw = this.assertRaw(session);
    if (raw.activeTurnId && raw.threadId) {
      raw.client.notify('turn/interrupt', { threadId: raw.threadId });
    }
  }

  cleanupSession(session: ProtocolSession): void {
    const raw = (session.raw as unknown as AppServerSessionRaw | undefined);
    if (!raw) return;
    this.killChild(raw);
  }

  // ---- internals ----

  private assertRaw(session: ProtocolSession): AppServerSessionRaw {
    const raw = session.raw as unknown as AppServerSessionRaw | undefined;
    if (!raw || !raw.client || !raw.child) {
      throw new Error('[CodexAppServer] session has no live child process');
    }
    return raw;
  }

  private killChild(raw: AppServerSessionRaw): void {
    if (raw.cleanupStarted) return;
    raw.cleanupStarted = true;
    try { raw.client.close('cleanup'); } catch { /* noop */ }
    this.terminateProcessTree(raw.child);
  }

  private async spawnAndInit(options: SessionOptions): Promise<AppServerSessionRaw> {
    const binary = resolveCodexBinaryPath(this.resolveCodexPathOverride);
    const env = this.buildEnv(options, binary);
    const cwd = options.workspacePath || process.cwd();
    // console.log('[CODEX][APPSERVER] spawning child:', {
    //   binary,
    //   cwd,
    //   helperPathEntries: getCodexVendorPathEntries(binary),
    // });
    const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stderrTail: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail.push(chunk);
      console.warn('[CODEX][APPSERVER][stderr]', previewForLog(chunk.trim(), 800));
      // Keep the last ~16KB for diagnostics.
      while (stderrTail.length > 0 && stderrTail.join('').length > 16 * 1024) {
        stderrTail.shift();
      }
    });
    const client = new JsonRpcClient(child, {
      logger: {
        log: (m, ...a) => console.log('[CODEX][APPSERVER]', m, ...a),
        warn: (m, ...a) => console.warn('[CODEX][APPSERVER]', m, ...a),
      },
    });
    this.wireServerRequestHandlers(client);
    let initResponse: InitializeResponse;
    try {
      initResponse = await client.request<InitializeResponse>('initialize', {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: true },
      });
      client.notify('initialized', {});
    } catch (err) {
      try { client.close('init failed'); } catch { /* noop */ }
      this.terminateProcessTree(child);
      const tail = stderrTail.join('').slice(-2000);
      const rawError = `${err instanceof Error ? err.message : String(err)}${tail ? `\nstderr tail: ${tail}` : ''}`;
      const configHint = describeCodexConfigError(rawError);
      throw new Error(`[CodexAppServer] initialize failed: ${rawError}${configHint ? `\n\n${configHint}` : ''}`);
    }
    return {
      child,
      client,
      threadId: '',
      options,
      initResponse,
      dynamicTools: this.extractDynamicTools(options),
      activeTurnId: null,
      stderrTail,
      cleanupStarted: false,
    };
  }

  private extractDynamicTools(options: SessionOptions): DynamicToolSpec[] {
    const raw = options.raw?.codexDynamicTools;
    if (!Array.isArray(raw)) return [];
    return raw.filter((t): t is DynamicToolSpec => !!t && typeof (t as { name?: unknown }).name === 'string');
  }

  private buildEnv(options: SessionOptions, binaryPath?: string): NodeJS.ProcessEnv {
    const baseEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) baseEnv[k] = v;
    }
    const rawEnv = options.raw?.codexEnv;
    if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
      for (const [k, v] of Object.entries(rawEnv as Record<string, string>)) {
        baseEnv[k] = v;
      }
    }
    const extraPathEntries = binaryPath ? getCodexVendorPathEntries(binaryPath) : [];
    if (extraPathEntries.length > 0) {
      const existingPath = baseEnv.PATH ?? baseEnv.Path ?? '';
      const existingEntries = existingPath
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean);
      const mergedPath = Array.from(new Set([...extraPathEntries, ...existingEntries])).join(path.delimiter);
      baseEnv.PATH = mergedPath;
      delete baseEnv.Path;
    }
    if (this.apiKey) baseEnv.CODEX_API_KEY = this.apiKey;
    return baseEnv;
  }

  /**
   * Map our SessionOptions onto ThreadStartParams. Mirrors the SDK adapter's
   * `buildThreadOptions` so behavior is preserved across transports.
   */
  private buildThreadStartParams(options: SessionOptions): ThreadStartParams {
    const sandbox: ThreadStartParams['sandbox'] =
      options.permissionMode === 'bypass-all' ? 'danger-full-access' : 'workspace-write';

    const effortLevel = options.raw?.effortLevel as string | undefined;
    const reasoningEffortRaw = effortLevel === 'max' ? 'xhigh' : (effortLevel ?? 'high');

    const systemPrompt = (options.raw?.systemPrompt as string | undefined) ?? options.systemPrompt;
    const additionalDirectories = Array.isArray(options.raw?.additionalDirectories)
      ? (options.raw?.additionalDirectories as unknown[]).filter(
          (entry): entry is string => typeof entry === 'string' && entry.length > 0,
        )
      : [];

    // The free-form `config` object accepts the same dotted-path TOML overrides
    // the SDK transport sends as `--config` flags. We pass through the
    // existing host-computed overrides (which include `mcp_servers`,
    // `model_reasoning_effort`, network access, web_search, etc.) unchanged.
    const config: Record<string, unknown> = {
      ...(options.raw?.codexConfigOverrides as Record<string, unknown> | undefined ?? {}),
      // Reasoning effort always sets; the host's override map may also set it
      // but a literal here is fine since codex resolves these later.
      model_reasoning_effort: reasoningEffortRaw,
    };

    return {
      model: options.model ?? null,
      sandbox,
      cwd: options.workspacePath,
      approvalPolicy: 'never', // Nimbalyst routes approvals via host bindings; we never want codex to block waiting on stdin
      ephemeral: false,
      developerInstructions: systemPrompt,
      config,
      ...(additionalDirectories.length > 0
        ? { config: { ...config, additional_writable_roots: additionalDirectories } }
        : {}),
    };
  }

  private async buildInput(message: ProtocolMessage): Promise<UserInputElement[]> {
    const elements: UserInputElement[] = [{ type: 'text', text: message.content }];
    for (const attachment of message.attachments ?? []) {
      if (!attachment.filepath) continue;
      if (attachment.type === 'document') {
        elements.push({ type: 'text', text: await buildDocumentAttachmentPromptText(attachment) });
      } else if (attachment.type === 'image') {
        elements.push({ type: 'localImage', path: attachment.filepath });
      }
    }
    return elements;
  }

  /**
   * Register handlers for codex's server-to-client requests. Each handler
   * delegates to the host bindings (Nimbalyst's permission system, dialog
   * surface, etc.). Defaults are intentionally permissive to mirror today's
   * `approvalPolicy: 'never'` behavior in the SDK transport.
   */
  private wireServerRequestHandlers(client: JsonRpcClient): void {
    const deny: ApprovalResponse = { decision: 'denied' };
    const allow: ApprovalResponse = { decision: 'approved' };

    client.setServerRequestHandler('item/fileChange/requestApproval', async (raw) => {
      const params = raw as ItemFileChangeRequestApprovalParams;
      if (this.host.approveFileChange) return this.host.approveFileChange(params);
      // No host binding: with approvalPolicy=never codex should not call us here.
      // Default-allow keeps things flowing if codex changes that contract.
      console.warn('[CODEX][APPSERVER] approveFileChange called with no host binding; default allow');
      return allow;
    });

    client.setServerRequestHandler('item/commandExecution/requestApproval', async (raw) => {
      const params = raw as ItemCommandExecutionRequestApprovalParams;
      if (this.host.approveCommandExecution) return this.host.approveCommandExecution(params);
      console.warn('[CODEX][APPSERVER] approveCommandExecution called with no host binding; default deny');
      return deny;
    });

    client.setServerRequestHandler('item/permissions/requestApproval', async (raw) => {
      const params = raw as ItemPermissionsRequestApprovalParams;
      if (this.host.approvePermissions) return this.host.approvePermissions(params);
      return deny;
    });

    client.setServerRequestHandler('applyPatchApproval', async (raw) => {
      // Legacy method-name path; treat it the same as the structured one.
      if (this.host.approveFileChange) {
        return this.host.approveFileChange(raw as ItemFileChangeRequestApprovalParams);
      }
      return allow;
    });

    client.setServerRequestHandler('execCommandApproval', async (raw) => {
      if (this.host.approveCommandExecution) {
        return this.host.approveCommandExecution(raw as ItemCommandExecutionRequestApprovalParams);
      }
      return deny;
    });

    client.setServerRequestHandler('mcpServer/elicitation/request', async (raw) => {
      if (this.host.handleMcpElicitation) return this.host.handleMcpElicitation(raw);
      // No host binding: auto-accept, mirroring this transport's permissive
      // exec/file defaults (approvalPolicy: 'never'). Returning `null` fails
      // codex's deserializer ("invalid type: null, expected struct
      // McpServerElicitationRequestResponse") and codex then reports every
      // nimbalyst MCP tool call as "user rejected MCP tool call" (#797).
      const autoAccept: McpElicitationResponse = { action: 'accept', content: null, _meta: null };
      return autoAccept;
    });

    client.setServerRequestHandler('item/tool/requestUserInput', async (raw) => {
      if (this.host.handleToolUserInput) return this.host.handleToolUserInput(raw);
      return null;
    });

    client.setServerRequestHandler('item/tool/call', async (raw) => {
      const params = raw as DynamicToolCallParams;
      if (this.host.callDynamicTool) {
        const result = await this.host.callDynamicTool(params);
        return result;
      }
      return { isError: true, content: [{ type: 'text', text: `dynamic tool ${params.tool} not registered on host` }] };
    });
  }

  /**
   * Translate a single codex notification into zero or more `ProtocolEvent`s.
   * Pushed entries terminate with either `{kind:'end'}` (turn/completed) or
   * `{kind:'fail',error}` (turn/failed).
   */
  private dispatchNotification(
    method: string,
    paramsUnknown: unknown,
    push: (entry: { kind: 'event'; event: ProtocolEvent } | { kind: 'end' } | { kind: 'fail'; error: Error }) => void,
    raw: AppServerSessionRaw,
    appendText: (delta: string) => void,
    setUsage: (u: { input_tokens: number; output_tokens: number; total_tokens: number }) => void,
  ): void {
    const params = paramsUnknown as Record<string, unknown> | undefined;
    const summary = summarizeNotificationParams(method, paramsUnknown);
    void summary;
    // if (summary) {
    //   console.log('[CODEX][APPSERVER] notification:', method, summary);
    // }
    // Emit a raw_event for every notification so transcript persistence has a
    // complete log, just like the SDK adapter does for SDK events.
    push({
      kind: 'event',
      event: {
        type: 'raw_event',
        metadata: { transport: 'app-server', method, params },
      },
    });

    switch (method) {
      case 'item/started': {
        const n = params as unknown as ItemStartedNotification;
        this.handleItemStarted(n, push);
        return;
      }
      case 'item/completed': {
        const n = params as unknown as ItemCompletedNotification;
        this.handleItemCompleted(n, push, appendText);
        return;
      }
      case 'item/agentMessage/delta': {
        const delta = (params?.delta as string) || '';
        if (delta) {
          appendText(delta);
          push({ kind: 'event', event: { type: 'text', content: delta, metadata: { transport: 'app-server', itemId: params?.itemId } } });
        }
        return;
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const delta = (params?.delta as string) || '';
        if (delta) {
          push({ kind: 'event', event: { type: 'reasoning', content: delta, metadata: { transport: 'app-server', method, itemId: params?.itemId } } });
        }
        return;
      }
      case 'thread/tokenUsage/updated': {
        const usage = params?.usage as TokenUsage | undefined;
        const normalized = normalizeUsage(usage);
        if (normalized) setUsage(normalized);
        return;
      }
      case 'turn/completed': {
        const n = params as unknown as TurnCompletedNotification;
        const usage = normalizeUsage(n.usage);
        if (usage) setUsage(usage);
        if (n.turn?.status === 'failed') {
          const msg = n.turn?.error?.message ?? 'turn failed';
          push({ kind: 'fail', error: new Error(msg) });
        } else {
          push({ kind: 'end' });
        }
        return;
      }
      case 'turn/failed':
      case 'error': {
        const n = params as unknown as ErrorNotification;
        const msg = n?.error?.message ?? 'codex app-server error';
        push({ kind: 'fail', error: new Error(msg) });
        return;
      }
      case 'warning': {
        const n = params as unknown as WarningNotification;
        console.warn('[CODEX][APPSERVER] warning:', n?.message);
        return;
      }
      case 'mcpServer/startupStatus/updated': {
        // Informational only.
        return;
      }
      case 'thread/started': {
        // threadId is already captured from thread/start response. Nothing to do.
        return;
      }
      default: {
        // Unknown notifications are preserved via the raw_event above. Don't spam logs.
        return;
      }
    }
  }

  private handleItemStarted(
    n: ItemStartedNotification,
    push: (entry: { kind: 'event'; event: ProtocolEvent }) => void,
  ): void {
    const item = n.item;
    if (!item) return;

    if (item.type === 'fileChange') {
      // Emit a synthetic "pre-edit baselines computed" event so the host's
      // SessionFileTracker can use it before the patch is on disk. The
      // diff-based reverse is best-effort and only meaningful for the host;
      // we attach it on the tool_call metadata.
      const fileItem = item as FileChangeItem;
      const baselines = this.computeBaselines(fileItem.changes);
      push({
        kind: 'event',
        event: {
          type: 'tool_call',
          toolCall: {
            id: fileItem.id,
            // Use the SDK-transport tool name so the renderer's special-case
            // routing in RichTranscriptView picks the main-enriched file_change
            // renderer. The 'apply_patch' label would fall
            // through to the generic EditToolResultCard path, which expects
            // {old_string,new_string} or {content} fields that the codex
            // change shape ({path, kind, diff}) does not provide.
            name: 'file_change',
            arguments: {
              changes: fileItem.changes,
            },
          },
          metadata: {
            transport: 'app-server',
            stage: 'started',
            fileChangeBaselines: baselines,
            threadId: n.threadId,
            turnId: n.turnId,
            itemId: fileItem.id,
            method: 'item/started',
          },
        },
      });
      return;
    }

    if (item.type === 'mcpToolCall') {
      // Emit an in-flight tool_call (no result yet) the moment codex enters
      // the MCP tool. Custom widgets like the GitCommitConfirmation and the
      // AskUserQuestion flow render off `tool_call_started`; without this
      // event the MCP tool blocks on the user's response while the widget --
      // which can't render until the canonical event lands -- never appears.
      // Mirrors the SDK adapter's `codexEventParser.ts:199-225` behavior of
      // surfacing mcp_tool_call on item.started with no `result` field.
      const mcp = item as AnyItem & {
        server: string;
        tool: string;
        arguments?: unknown;
      };
      if (!mcp.server || !mcp.tool) return;
      push({
        kind: 'event',
        event: {
          type: 'tool_call',
          toolCall: {
            id: (mcp as { id?: string }).id,
            name: `mcp__${mcp.server}__${mcp.tool}`,
            arguments: mcp.arguments as Record<string, unknown> | undefined,
          },
          metadata: {
            transport: 'app-server',
            stage: 'started',
            threadId: n.threadId,
            turnId: n.turnId,
            itemId: (mcp as { id?: string }).id,
            method: 'item/started',
          },
        },
      });
      return;
    }

    if (this.isGenericToolLikeItem(item)) {
      push({
        kind: 'event',
        event: {
          type: 'tool_call',
          toolCall: {
            id: (item as { id?: string }).id,
            name: item.type,
            arguments: this.buildGenericToolLikeArguments(item),
          },
          metadata: {
            transport: 'app-server',
            stage: 'started',
            threadId: n.threadId,
            turnId: n.turnId,
            itemId: (item as { id?: string }).id,
            method: 'item/started',
          },
        },
      });
      return;
    }

    // commandExecution etc. continue to surface only on item/completed by
    // default unless they need a started-stage widget race fix.
  }

  private handleItemCompleted(
    n: ItemCompletedNotification,
    push: (entry: { kind: 'event'; event: ProtocolEvent }) => void,
    appendText: (delta: string) => void,
  ): void {
    const item = n.item;
    if (!item) return;
    switch (item.type) {
      case 'agentMessage': {
        // Final message text is also delivered piecemeal via deltas; surface
        // the completion explicitly so callers can flush state.
        const text = (item as AnyItem & { text?: string }).text ?? '';
        if (text) {
          // We've already accumulated deltas; do NOT re-emit text here to avoid
          // duplicate accumulation. Callers reading the `complete` event get
          // the full text.
          appendText(''); // no-op, keeps reference live
        }
        return;
      }
      case 'reasoning': {
        const text = (item as AnyItem & { text?: string }).text ?? '';
        if (text) {
          push({ kind: 'event', event: { type: 'reasoning', content: text, metadata: { transport: 'app-server', itemId: (item as { id?: string }).id } } });
        }
        return;
      }
      case 'fileChange': {
        const fileItem = item as FileChangeItem;
        push({
          kind: 'event',
          event: {
            type: 'tool_call',
            toolCall: {
              id: fileItem.id,
              // Use the SDK-transport tool name so the renderer's special-case
            // routing in RichTranscriptView picks the main-enriched file_change
            // renderer. The 'apply_patch' label would fall
            // through to the generic EditToolResultCard path, which expects
            // {old_string,new_string} or {content} fields that the codex
            // change shape ({path, kind, diff}) does not provide.
            name: 'file_change',
              arguments: { changes: fileItem.changes },
              result: this.fileChangeResult(fileItem),
            },
            metadata: {
              transport: 'app-server',
              stage: 'completed',
              fileChangeBaselines: this.computeBaselines(fileItem.changes),
              threadId: n.threadId,
              turnId: n.turnId,
              itemId: fileItem.id,
              method: 'item/completed',
            },
          },
        });
        return;
      }
      case 'mcpToolCall': {
        const mcp = item as AnyItem & {
          server: string;
          tool: string;
          arguments?: unknown;
          result?: unknown;
          error?: { message: string };
          status: string;
        };
        push({
          kind: 'event',
          event: {
            type: 'tool_call',
            toolCall: {
              id: (mcp as { id?: string }).id,
              // Match the canonical Claude-Code MCP tool name format
              // (`mcp__<server>__<tool>`) so the provider's session-naming
              // detection, AskUserQuestion router, and widget routing all see
              // the same shape across transports. The persisted-row parser
              // (CodexAppServerRawParser) already uses this format.
              name: `mcp__${mcp.server}__${mcp.tool}`,
              arguments: mcp.arguments as Record<string, unknown> | undefined,
              result: mcp.error
                ? ({ success: false, error: mcp.error.message } as ToolResult)
                : ({ success: mcp.status === 'completed', result: mcp.result } as ToolResult),
            },
            metadata: { transport: 'app-server', threadId: n.threadId, turnId: n.turnId, itemId: (mcp as { id?: string }).id },
          },
        });
        return;
      }
      case 'commandExecution': {
        const cmd = item as AnyItem & {
          command: string;
          aggregated_output?: string;
          exit_code?: number;
          status: string;
        };
        push({
          kind: 'event',
          event: {
            type: 'tool_call',
            toolCall: {
              id: (cmd as { id?: string }).id,
              name: 'command_execution',
              arguments: { command: cmd.command },
              result: {
                success: cmd.status === 'completed',
                command: cmd.command,
                exit_code: cmd.exit_code,
                output: cmd.aggregated_output,
              } as ToolResult,
            },
            metadata: { transport: 'app-server', threadId: n.threadId, turnId: n.turnId, itemId: (cmd as { id?: string }).id },
          },
        });
        return;
      }
      default: {
        if (this.isGenericToolLikeItem(item)) {
          push({
            kind: 'event',
            event: {
              type: 'tool_call',
              toolCall: {
                id: (item as { id?: string }).id,
                name: item.type,
                arguments: this.buildGenericToolLikeArguments(item),
                result: this.buildGenericToolLikeResult(item),
              },
              metadata: {
                transport: 'app-server',
                threadId: n.threadId,
                turnId: n.turnId,
                itemId: (item as { id?: string }).id,
                method: 'item/completed',
              },
            },
          });
          return;
        }

        // userMessage / todoList / error -- preserved by raw_event.
        return;
      }
    }
  }

  private isGenericToolLikeItem(item: AnyItem): item is AnyItem & { id: string; type: string } {
    if (!item || typeof item !== 'object') return false;
    if (typeof item.id !== 'string' || !item.id) return false;
    if (typeof item.type !== 'string' || !item.type) return false;
    return !new Set([
      'userMessage',
      'agentMessage',
      'reasoning',
      'todoList',
      'error',
      'fileChange',
      'mcpToolCall',
      'commandExecution',
    ]).has(item.type);
  }

  private buildGenericToolLikeArguments(item: AnyItem): Record<string, unknown> {
    const record = item as Record<string, unknown>;
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined) continue;
      if (['id', 'type', 'status', 'result', 'error', 'aggregated_output', 'exit_code', 'text', 'content', 'items'].includes(key)) {
        continue;
      }
      args[key] = value;
    }
    return args;
  }

  private buildGenericToolLikeResult(item: AnyItem): ToolResult | string {
    const record = item as Record<string, unknown>;
    const error = record.error as { message?: string } | undefined;
    if (error?.message) {
      return { success: false, error: error.message } as ToolResult;
    }
    if (record.result !== undefined) {
      return {
        success: record.status === 'completed',
        result: record.result,
      } as ToolResult;
    }
    if (typeof record.aggregated_output === 'string' || typeof record.exit_code === 'number') {
      return {
        success: record.status === 'completed',
        output: record.aggregated_output,
        exit_code: record.exit_code,
      } as ToolResult;
    }

    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined) continue;
      if (['id', 'type', 'status', 'text', 'content', 'items'].includes(key)) continue;
      summary[key] = value;
    }
    return {
      success: record.status === 'completed',
      result: summary,
    } as ToolResult;
  }

  private fileChangeResult(item: FileChangeItem): ToolResult {
    return {
      success: item.status === 'completed',
      status: item.status,
      changes: item.changes,
    };
  }

  /**
   * Pre-compute pre-edit baselines for each change in a file_change item by
   * reverse-applying the diff. For `update` kinds we cannot synchronously
   * read post-edit content here without going async; the host computes the
   * actual pre-edit via the same `reverseCodexPatch` helper when consuming
   * the chunk (it knows when to read disk). For `add` and `delete` the
   * result is fully determined by the diff alone.
   *
   * This metadata gives the host an early, cheap path for add/delete cases
   * and a complete diff payload to feed `reverseCodexPatch` on update cases.
   */
  private computeBaselines(changes: FileChangeChange[]): Array<{ path: string; kind: CodexPatchKind; diff: string; preEditContent: string | null | 'requires-post-edit-content' }> {
    return changes.map((change) => {
      const kind = change.kind.type as CodexPatchKind;
      if (kind === 'add') {
        return { path: change.path, kind, diff: change.diff, preEditContent: null };
      }
      if (kind === 'delete') {
        const r = reverseCodexPatch(change.diff, null, 'delete');
        return { path: change.path, kind, diff: change.diff, preEditContent: r.ok ? r.preEditContent : null };
      }
      // 'update' needs post-edit content read by the host.
      return { path: change.path, kind, diff: change.diff, preEditContent: 'requires-post-edit-content' };
    });
  }
}

// Append the captured codex stderr tail to a fail message so users see the
// binary's own diagnostics (e.g. plugin discovery / auth retry loops) instead
// of an opaque "Reconnecting..." or "turn failed" string.
function appendStderrTail(msg: string, raw: { stderrTail: string[] }): string {
  const tail = raw.stderrTail.join('').slice(-2000).trim();
  return tail ? `${msg}\nstderr tail: ${tail}` : msg;
}

function normalizeUsage(u: TokenUsage | undefined): { input_tokens: number; output_tokens: number; total_tokens: number } | undefined {
  if (!u) return undefined;
  const input = u.input_tokens ?? u.inputTokens ?? 0;
  const output = u.output_tokens ?? u.outputTokens ?? 0;
  const total = u.total_tokens ?? u.totalTokens ?? input + output;
  if (input === 0 && output === 0 && total === 0) return undefined;
  return { input_tokens: input, output_tokens: output, total_tokens: total };
}
