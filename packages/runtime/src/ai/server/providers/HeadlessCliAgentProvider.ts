/**
 * Shared provider body for structured CLI agents (Grok ACP and Cursor's
 * per-turn NDJSON transport).
 *
 * The two providers differ only in their executable name, install
 * instructions, protocol adapter and system-prompt tool vocabulary. Everything
 * below — workspace preconditions, turn-level permission gating, raw-event
 * persistence, transcript adaptation, abort handling — is identical, and was
 * identical in `CopilotCLIProvider` before it too. Two more 600-line copies is
 * the shape that rots; a subclass hook per genuine difference is not.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BaseAgentProvider } from './BaseAgentProvider';
import { scrubProviderApiKeys } from '../providerApiKeyScrub';
import { buildUserMessageAddition } from './documentContextUtils';
import { describeUnusableWorkspacePath } from './workspacePreconditions';
import { buildClaudeCodeSystemPrompt } from '../../prompt';
import type {
  ProviderConfig,
  DocumentContext,
  StreamChunk,
  AIProviderType,
  ChatAttachment,
} from '../types';
import type { AgentProtocol, ProtocolEvent, ToolResult } from '../protocols/ProtocolInterface';
import type { FileChangeFidelity } from '../providerFileTracking';
import type { McpConfigService } from '../services/McpConfigService';
import {
  getMcpConfigService,
  isInternalMcpServerEnabled,
  areTrackerToolsEnabled,
  resolveTrackersWorkspacePath,
} from '../services/mcpServerConfig';
import type { MCPServerConfig } from '../../../types/MCPServerConfig';
import { safeJSONSerialize } from '../../../utils/serialization';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';

/** Loaders the Electron main process injects once at startup. */
export interface HeadlessCliEnvironmentLoaders {
  mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null;
  shellEnvironmentLoader: (() => Record<string, string> | null) | null;
  enhancedPathLoader: (() => string) | null;
  executablePathLoader: (() => string | null) | null;
}

/** Merge the login shell and enhanced PATH, then scrub credentials for turns and model discovery. */
export function buildHeadlessChildEnvironment(loaders: HeadlessCliEnvironmentLoaders): Record<string, string> {
  let shellEnv: Record<string, string> | null = null;
  let enhancedPath: string | null = null;
  try {
    shellEnv = loaders.shellEnvironmentLoader?.() ?? null;
  } catch {
    // Continue without shell env rather than failing the turn.
  }
  try {
    enhancedPath = loaders.enhancedPathLoader?.() ?? null;
  } catch {
    // Continue without enhanced PATH.
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (shellEnv) Object.assign(env, shellEnv);
  if (enhancedPath) env.PATH = enhancedPath;
  return scrubProviderApiKeys(env);
}

export interface HeadlessCliAgentDescriptor {
  providerName: AIProviderType;
  displayName: string;
  description: string;
  /** Binary name as it appears on PATH. */
  executableName: string;
  /** Home-relative locations the vendor installer uses, in preference order. */
  homeRelativeInstallPaths: readonly string[];
  /** Shown when the binary cannot be found. */
  notInstalledMessage: string;
  /** Shown when the CLI reports it is not authenticated. */
  notLoggedInMessage: string;
  /**
   * Message shown when this transport cannot pause for per-tool approval and
   * the current workspace mode does not authorize the whole turn.
   */
  permissionModeMessage: string;
  /** Whether this transport can pause and round-trip per-tool approval. */
  supportsToolPermissions?: boolean;
}

export abstract class HeadlessCliAgentProvider extends BaseAgentProvider {
  protected readonly mcpConfigService: McpConfigService;

  private _initData: {
    model: string;
    mcpServerCount: number;
    isResumedSession: boolean;
  } | null = null;

  protected abstract readonly descriptor: HeadlessCliAgentDescriptor;
  protected abstract readonly protocol: AgentProtocol;

  /** Per-subclass static loader bundle, injected from the Electron main process. */
  protected abstract getLoaders(): HeadlessCliEnvironmentLoaders;

  /**
   * Declared file-change fidelity, when the subclass reports one. Drives both
   * the watcher's attribution mode and whether edit snapshots are emitted.
   */
  getFileChangeFidelity?(): FileChangeFidelity;

  /** Point the protocol adapter at the resolved executable and environment. */
  protected abstract configureProtocol(executablePath: string, env: Record<string, string> | null): void;

  constructor(loaders: HeadlessCliEnvironmentLoaders) {
    super();
    this.mcpConfigService = getMcpConfigService({
      mcpConfigLoader: loaders.mcpConfigLoader,
      claudeSettingsEnvLoader: null,
      shellEnvironmentLoader: loaders.shellEnvironmentLoader,
    });
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  getProviderName(): AIProviderType {
    return this.descriptor.providerName;
  }

  getName(): string {
    return this.descriptor.providerName;
  }

  getDisplayName(): string {
    return this.descriptor.displayName;
  }

  getDescription(): string {
    return this.descriptor.description;
  }

  getProviderSessionData(sessionId: string): any {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return { providerSessionId };
  }

  getInitData(): { model: string; mcpServerCount: number; isResumedSession: boolean } | null {
    return this._initData;
  }

  async cancelStream(_sessionId?: string): Promise<void> {
    this.abort();
  }

  cleanupSession(sessionId: string): void {
    this.sessions.deleteSession(sessionId);
  }

  /**
   * Locate the CLI without requiring it to be on the Electron process's PATH.
   *
   * A GUI-launched app has only `/usr/bin:/bin:/usr/sbin:/sbin`, which misses
   * every location either vendor installs to. Probing the known paths is what
   * keeps the settings panel and the provider from disagreeing.
   */
  protected resolveExecutable(): string | undefined {
    const loaders = this.getLoaders();
    const override = loaders.executablePathLoader?.();
    if (override) return override;

    const pathValue = loaders.enhancedPathLoader?.() || process.env.PATH;
    const home = os.homedir();
    const candidates: string[] = [];

    for (const relative of this.descriptor.homeRelativeInstallPaths) {
      candidates.push(path.join(home, ...relative.split('/')));
    }
    for (const entry of (pathValue ?? '').split(path.delimiter)) {
      const trimmed = entry.trim().replace(/^"(.*)"$/, '$1');
      if (trimmed) candidates.push(path.join(trimmed, this.descriptor.executableName));
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // Unreadable path: keep looking rather than failing detection.
      }
    }
    return undefined;
  }

  protected isInstalled(): boolean {
    const command = this.resolveExecutable() ?? this.descriptor.executableName;
    try {
      execFileSync(command, ['--version'], {
        stdio: 'pipe',
        timeout: 5000,
        env: this.buildChildEnvironment() ?? undefined,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build the child environment from the user's login shell plus the enhanced
   * PATH, then scrub provider API keys.
   *
   * The scrub is the `ANTHROPIC_API_KEY` rule from CLAUDE.md: Nimbalyst must
   * never let an unrelated key in the user's shell become an implicit billing
   * source. Vendor-specific keys (`CURSOR_API_KEY`, `XAI_API_KEY`) are scrubbed
   * for the same reason — the user's CLI login is the only credential these
   * providers are authorised to use.
   *
   * Cursor passes this map unchanged to its child. Grok's ACP spawn merges
   * it over `process.env` and must scrub again after that merge: absence here
   * cannot mask an inherited value there.
   */
  protected buildChildEnvironment(): Record<string, string> {
    return buildHeadlessChildEnvironment(this.getLoaders());
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    _messages?: any[],
    workspacePath?: string,
    attachments?: ChatAttachment[],
  ): AsyncIterableIterator<StreamChunk> {
    const unusableWorkspace = describeUnusableWorkspacePath(workspacePath);
    if (unusableWorkspace || !workspacePath) {
      yield { type: 'error', error: unusableWorkspace ?? 'No project folder is set for this session.' };
      return;
    }

    const systemPrompt = this.buildSystemPrompt(documentContext);
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, documentContext);

    if (sessionId && (systemPrompt || userMessageAddition)) {
      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: systemPrompt || null,
        userMessageAddition,
        attachments: [],
        timestamp: Date.now(),
      });
    }

    const prompt = messageWithContext;

    if (sessionId) {
      const metadataToLog: Record<string, unknown> = this.withPromptProvenanceMetadata(documentContext);
      if (documentContext?.mode) metadataToLog.mode = documentContext.mode;
      await this.logAgentMessageBestEffort(
        sessionId,
        'input',
        prompt,
        Object.keys(metadataToLog).length > 0 ? { metadata: metadataToLog } : undefined,
      );
    }

    const abortController = new AbortController();
    this.abortController = abortController;
    let fullText = '';
    let executablePath: string | undefined;

    try {
      const permission = this.requestTurnPermission(workspacePath, documentContext?.permissionsPath);
      if (permission.decision !== 'allow') {
        yield { type: 'error', error: permission.reason ?? 'Turn denied' };
        return;
      }

      executablePath = this.resolveExecutable();
      if (!executablePath && !this.isInstalled()) {
        yield { type: 'error', error: this.descriptor.notInstalledMessage };
        return;
      }
      this.configureProtocol(
        executablePath ?? this.descriptor.executableName,
        this.buildChildEnvironment(),
      );

      const mcpServers = await this.mcpConfigService.getMcpServersConfig({
        sessionId,
        workspacePath: documentContext?.mcpConfigWorkspacePath || workspacePath,
        profile: 'standard',
      });

      const existingSessionId = this.sessions.getSessionId(sessionId || '');
      const isResumedSession = !!existingSessionId;
      const resolvedModel = this.config?.model || this.getDefaultModelId();

      const sessionOptions = {
        workspacePath,
        model: resolvedModel,
        systemPrompt,
        mcpServers,
        permissionMode: permission.permissionMode ?? undefined,
        raw: { permissionsPath: documentContext?.permissionsPath },
      };
      const session = isResumedSession
        ? await this.protocol.resumeSession(existingSessionId, sessionOptions)
        : await this.protocol.createSession(sessionOptions);

      // Persist the provider session id before the turn runs. Both CLIs mint
      // the id up front precisely so a turn that dies early still leaves a
      // resumable session behind.
      if (sessionId && session.id && session.id !== existingSessionId) {
        this.sessions.captureSessionId(sessionId, session.id);
      }

      this._initData = {
        // A protocol that can observe the agent's model wins over the one we
        // asked for: reporting a model the agent did not run is worse than not
        // offering the choice at all.
        model: session.appliedModel ?? resolvedModel,
        mcpServerCount: session.deliveredMcpServerCount ?? 0,
        isResumedSession,
      };

      const transcriptAdapter = new AgentProtocolTranscriptAdapter(null, sessionId ?? '');
      transcriptAdapter.userMessage(
        prompt,
        documentContext?.mode === 'planning' ? 'planning' : 'agent',
        attachments as any,
      );

      for await (const event of this.protocol.sendMessage(session, {
        content: prompt,
        attachments,
        sessionId,
        mode: documentContext?.mode || 'agent',
        abortSignal: abortController.signal,
      })) {
        if (abortController.signal.aborted) {
          throw new Error('Operation cancelled');
        }

        if (sessionId) {
          try {
            await this.storeRawEventIfPresent(event, sessionId);
          } catch {
            // DB not available -- non-critical.
          }
        }

        // A provider that declares `'structured'` fidelity has the workspace
        // watcher's attribution switched OFF, so these chunks are the ONLY way
        // its edits reach the Files Edited sidebar and the diff view. Emitting
        // nothing here would make the edits silently vanish -- the failure the
        // whole transport choice was meant to avoid.
        for (const snapshot of this.buildEditSnapshots(event)) {
          yield snapshot;
        }

        for (const item of transcriptAdapter.processEvent(event)) {
          switch (item.kind) {
            case 'text':
              fullText += item.text;
              yield { type: 'text', content: item.text };
              break;
            case 'tool_call':
              yield { type: 'tool_call', toolCall: item.toolCall };
              break;
            case 'complete':
              if (sessionId && fullText) {
                await this.storeAssistantResponse(sessionId, fullText);
                await this.processTranscriptMessages(sessionId);
              }
              yield {
                type: 'complete',
                content: item.event.content,
                isComplete: true,
                usage: item.event.usage,
              };
              break;
            case 'error':
              yield { type: 'error', error: item.message };
              break;
            case 'raw_event':
            case 'reasoning':
            case 'unknown':
              break;
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbort = abortController.signal.aborted || /abort|cancel/i.test(errorMessage);
      if (!isAbort) {
        if (['E2BIG', 'ENAMETOOLONG'].includes((error as NodeJS.ErrnoException)?.code ?? '') || /\b(?:E2BIG|ENAMETOOLONG)\b/i.test(errorMessage)) {
          yield { type: 'error', error: `${this.descriptor.displayName} prompt was too large to start the CLI. Shorten the prompt or reduce the attached document context and try again.` };
        } else if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || /\bENOENT\b/i.test(errorMessage)) {
          yield { type: 'error', error: this.descriptor.notInstalledMessage };
        } else if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException)?.code ?? '') || /\b(?:EACCES|EPERM)\b/i.test(errorMessage)) {
          yield { type: 'error', error: `${this.descriptor.displayName} CLI was found at "${executablePath ?? this.descriptor.executableName}" but is not executable. Check its execution permissions or reinstall the CLI, then try again.` };
        } else if (/not logged in|not authenticated|unauthorized|forbidden/i.test(errorMessage)) {
          yield { type: 'error', error: this.descriptor.notLoggedInMessage, isAuthError: true };
        } else {
          yield { type: 'error', error: errorMessage };
        }
      }
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  /**
   * Turn a provider-reported file change into the pre/post edit snapshot
   * chunks `MessageStreamingHandler` writes as local-history tags.
   *
   * Only emitted for `'structured'` providers. A `'tool-args'` provider's
   * "before" text is the replaced *fragment* (Grok's `oldText`), not the
   * file's prior contents -- writing that as a baseline would render a diff
   * against a few lines of text and call it the whole file. Those providers
   * keep the watcher and the pre-edit tag path instead.
   */
  protected *buildEditSnapshots(event: ProtocolEvent): Generator<StreamChunk> {
    if (this.getFileChangeFidelity?.() !== 'structured') return;
    if (event.type !== 'tool_result') return;

    const result = event.toolResult?.result;
    if (!result || typeof result === 'string') return;
    const changes = (result as ToolResult).changes;
    if (!Array.isArray(changes) || changes.length === 0) return;

    const toolUseId = event.toolResult?.id
      ?? `${this.getProviderName()}-edit-${changes.length}`;
    const preEntries: Array<{ path: string; content: string; kind?: string }> = [];
    const postEntries: Array<{ path: string; content: string; kind?: string }> = [];

    for (const raw of changes) {
      const change = raw as {
        path?: unknown;
        kind?: unknown;
        beforeContent?: unknown;
        afterContent?: unknown;
      };
      if (typeof change.path !== 'string' || !change.path) continue;
      const kind = typeof change.kind === 'string' ? change.kind : 'update';

      // `beforeContent` is the provider's own record of the file before it
      // wrote. A missing one is not an empty file -- writing '' would render
      // an all-green diff -- so skip the pre-entry and let the baseline come
      // from history.
      if (typeof change.beforeContent === 'string') {
        preEntries.push({ path: change.path, content: change.beforeContent, kind });
      }
      // A delete has no post-state to record; the tag for its baseline is what
      // makes the removal reviewable.
      if (kind !== 'delete' && typeof change.afterContent === 'string') {
        postEntries.push({ path: change.path, content: change.afterContent, kind });
      }
    }

    if (preEntries.length > 0) {
      yield {
        type: 'pre_edit_snapshot',
        preEditSnapshot: {
          toolUseId,
          entries: preEntries,
          // The provider read the file itself before writing it. A
          // FileSnapshotCache lookup at this point can only be staler.
          authoritative: true,
        },
      };
    }
    if (postEntries.length > 0) {
      yield { type: 'post_edit_snapshot', postEditSnapshot: { toolUseId, entries: postEntries } };
    }
  }

  destroy(): void {
    const destroyable = this.protocol as { destroy?: () => void };
    destroyable.destroy?.();
    super.destroy();
  }

  protected abstract getDefaultModelId(): string;

  protected buildSystemPrompt(documentContext?: DocumentContext): string {
    return buildClaudeCodeSystemPrompt({
      hasSessionNaming: isInternalMcpServerEnabled(),
      toolReferenceStyle: 'codex',
      worktreePath: documentContext?.worktreePath,
      isVoiceMode: false,
      enableAgentTeams: false,
      trackersEnabled: areTrackerToolsEnabled(resolveTrackersWorkspacePath(documentContext)),
    });
  }

  /**
   * Gate the whole turn up front.
   *
   * Cursor cannot pause its one-shot headless turn for an approval. Grok ACP
   * can, so it only needs the trust-level gate here and handles risky tools via
   * `session/request_permission`.
   */
  private requestTurnPermission(
    workspacePath: string,
    permissionsPath?: string,
  ): { decision: 'allow' | 'deny'; reason?: string; permissionMode?: string | null } {
    const pathForTrust = permissionsPath || workspacePath;
    if (!pathForTrust || !BaseAgentProvider.trustChecker) {
      return { decision: 'allow' };
    }

    const trustStatus = BaseAgentProvider.trustChecker(pathForTrust);
    if (!trustStatus.trusted) {
      return {
        decision: 'deny',
        reason: `Workspace is not trusted. Please trust this workspace to use ${this.descriptor.displayName}.`,
      };
    }
    if (trustStatus.mode === 'bypass-all' || trustStatus.mode === 'allow-all') {
      return { decision: 'allow', permissionMode: trustStatus.mode };
    }
    if (this.descriptor.supportsToolPermissions) {
      return { decision: 'allow', permissionMode: trustStatus.mode };
    }
    return { decision: 'deny', reason: this.descriptor.permissionModeMessage };
  }

  private async processTranscriptMessages(sessionId: string): Promise<void> {
    try {
      if (TranscriptMigrationRepository.hasService()) {
        await TranscriptMigrationRepository.getService()
          .processNewMessages(sessionId, this.getProviderName());
      }
    } catch {
      // Best effort -- the session reload catches up via ensureUpToDate.
    }
  }

  private async storeAssistantResponse(sessionId: string, text: string): Promise<void> {
    // Stored in the Codex `item.completed` shape so the shared parser can turn
    // it into one canonical assistant_message rather than replaying deltas.
    const event = {
      type: 'item.completed',
      item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    };
    try {
      await this.logAgentMessage(
        sessionId,
        this.getProviderName(),
        'output',
        JSON.stringify(event),
        { eventType: 'item.completed' },
        false,
        undefined,
        true,
      );
    } catch {
      // Best effort.
    }
  }

  private async storeRawEventIfPresent(event: ProtocolEvent, sessionId: string): Promise<void> {
    if (event.type !== 'raw_event' || !event.metadata?.rawEvent) return;

    const { content, usedFallback } = safeJSONSerialize(event.metadata.rawEvent);
    const rawEventType = readRawEventType(event.metadata.rawEvent);

    await this.logAgentMessage(
      sessionId,
      this.getProviderName(),
      'output',
      usedFallback
        ? JSON.stringify({ type: rawEventType, valueType: typeof event.metadata.rawEvent, fallback: true })
        : content,
      { eventType: rawEventType, rawEventSerializationFallback: usedFallback },
      false,
      undefined,
      false,
    );
  }
}

function readRawEventType(rawEvent: unknown): string {
  if (rawEvent && typeof rawEvent === 'object') {
    const record = rawEvent as Record<string, unknown>;
    for (const key of ['type', 'method'] as const) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  return 'unknown';
}
