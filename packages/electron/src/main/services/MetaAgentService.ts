import path from 'path';
import { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { safeHandle } from '../utils/ipcRegistry';
import { ClaudeCodeProvider, OpenAICodexProvider, OpenAICodexACPProvider, SessionManager } from '@nimbalyst/runtime/ai/server';
import type { AIProviderType } from '@nimbalyst/runtime/ai/server/types';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import { AISessionsRepository, AgentMessagesRepository, SessionFilesRepository } from '@nimbalyst/runtime';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { getDefaultAIModel } from '../utils/store';
import { toMillis } from '../utils/timestampUtils';
import { createWorktreeStore } from './WorktreeStore';
import { GitWorktreeService } from './GitWorktreeService';
import { database as databaseWorker } from '../database/PGLiteDatabaseWorker';
import { getDatabase } from '../database/initialize';
import { gitRefWatcher } from '../file/GitRefWatcher';
import { AIService } from './ai/AIService';
import {
  startMetaAgentServer,
  setMetaAgentToolFns,
  shutdownMetaAgentServer,
} from '../mcp/metaAgentServer';
import { computeNotificationSignature } from './metaAgentNotificationSignature';
import { extractMessageText, extractUserPrompts } from './metaAgentMessageText';
import { ClaudeCliLauncherConfig } from './ai/claudeCliLauncherSingleton';

type SessionStatusValue = 'idle' | 'running' | 'waiting_for_input' | 'error' | 'interrupted';
type PromptType = 'permission_request' | 'ask_user_question_request' | 'exit_plan_mode_request';

interface PendingInteractivePrompt {
  id: string;
  promptId: string;
  promptType: PromptType;
  createdAt: number;
  content: Record<string, any>;
}

interface SessionResultData {
  sessionId: string;
  title: string;
  provider: string;
  model: string | null;
  status: SessionStatusValue;
  lastActivity: number | null;
  originalPrompt: string | null;
  userPrompts: string[];
  lastResponse: string | null;
  /** Full final assistant response (large cap), for get_session_result so the
   *  meta-agent can synthesize from the child's real work, not a 500-char stub.
   *  The notification preview deliberately uses lastResponse, not this. */
  fullResponse: string | null;
  recentMessages: Array<{ direction: 'input' | 'output'; text: string }>;
  editedFiles: string[];
  pendingPrompt: PendingInteractivePrompt | null;
  errorMessage?: string | null;
  createdAt: number;
  updatedAt: number;
  worktreeId?: string | null;
}

interface CreateChildSessionArgs {
  title?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  useWorktree?: boolean;
  worktreeId?: string;
}

function normalizeStoredChildModelIdentifier(
  provider: string | null | undefined,
  model: string | null | undefined
): string | null {
  if (!model) {
    return null;
  }

  if (provider === 'claude-code' || model.startsWith('claude-code:')) {
    const parsed = ModelIdentifier.parse(model);
    if (provider === 'claude-code' && parsed.provider !== 'claude-code') {
      throw new Error(`Claude Agent child sessions require a claude-code:* model identifier. Received: ${model}`);
    }
    return parsed.combined;
  }

  return model;
}

interface SpawnSessionArgs {
  title?: string;
  prompt: string;
  useWorktree?: boolean;
  model?: string;
  /**
   * When true and `model` is not explicitly set, the new session uses the
   * caller's model instead of the global app default. Ignored if `model` is
   * provided explicitly.
   */
  inheritModel?: boolean;
  /**
   * If false (the default for /launch-new-session), the parent will not receive
   * `[Child Session Update]` notifications when the spawned session completes,
   * errors, or waits for input. Use this for fire-and-forget hand-offs where the
   * parent is just kicking off work to escape a long context.
   */
  notifyOnComplete?: boolean;
  /**
   * When true, the new session is created at the top level — no parent, no
   * workstream container, no shared files-edited or tabs with the caller.
   * Use for fix-and-commit-separately work that should not pollute the
   * caller's workstream.
   */
  isolated?: boolean;
}

export class MetaAgentService {
  private static instance: MetaAgentService | null = null;
  private starting: Promise<void> | null = null;
  private started = false;
  private serverPort: number | null = null;
  private aiService: AIService | null = null;
  private sessionManager: SessionManager | null = null;
  private unsubscribeStateListener: (() => void) | null = null;
  private notificationSignatures = new Map<string, string>();
  private ipcHandlersRegistered = false;

  private constructor() {}

  public static getInstance(): MetaAgentService {
    if (!MetaAgentService.instance) {
      MetaAgentService.instance = new MetaAgentService();
    }
    return MetaAgentService.instance;
  }

  public getPort(): number | null {
    return this.serverPort;
  }

  private shouldBypassChildAgentExecutionForTests(): boolean {
    return (
      process.env.PLAYWRIGHT === '1' ||
      process.env.PLAYWRIGHT_TEST === 'true' ||
      process.env.NODE_ENV === 'test'
    );
  }

  private async persistSyntheticInputMessage(sessionId: string, prompt: string): Promise<void> {
    await AgentMessagesRepository.create({
      sessionId,
      source: 'nimbalyst-meta-agent',
      direction: 'input',
      content: prompt,
      createdAt: new Date(),
      searchable: true,
    });
  }

  public async start(aiService: AIService): Promise<void> {
    if (this.started) {
      return;
    }

    if (this.starting) {
      await this.starting;
      return;
    }

    this.starting = (async () => {
      this.aiService = aiService;
      this.sessionManager = new SessionManager();
      await this.sessionManager.initialize();

      setMetaAgentToolFns({
        listWorktrees: (_metaSessionId, workspaceId) =>
          this.listWorktreesJson(workspaceId),
        createSession: (metaSessionId, workspaceId, args) =>
          this.createChildSession(metaSessionId, workspaceId, args),
        spawnSession: (callerSessionId, workspaceId, args) =>
          this.spawnSession(callerSessionId, workspaceId, args),
        getSessionStatus: (_metaSessionId, workspaceId, targetSessionId) =>
          this.getSessionStatusJson(targetSessionId, workspaceId),
        getSessionResult: (_metaSessionId, workspaceId, targetSessionId) =>
          this.getSessionResultJson(targetSessionId, workspaceId),
        sendPrompt: (_metaSessionId, workspaceId, targetSessionId, prompt) =>
          this.sendPromptToSession(targetSessionId, workspaceId, prompt),
        respondToPrompt: (_metaSessionId, workspaceId, args) =>
          this.respondToPrompt(workspaceId, args),
        listSpawnedSessions: (metaSessionId, workspaceId) =>
          this.listSpawnedSessionsJson(metaSessionId, workspaceId),
      });

      const result = await startMetaAgentServer();
      this.serverPort = result.port;
      console.log(`[MetaAgentService] MCP server started on port ${result.port}`);

      ClaudeCodeProvider.setMetaAgentServerPort(result.port);
      OpenAICodexProvider.setMetaAgentServerPort(result.port);
      OpenAICodexACPProvider.setMetaAgentServerPort(result.port);
      ClaudeCliLauncherConfig.setMetaAgentServerPort(result.port);

      this.unsubscribeStateListener = getSessionStateManager().subscribe((event) => {
        // NIM-6 follow-up: dedup signatures only describe one turn; clear them
        // when a child becomes active again so two distinct turns whose final
        // text happens to match (e.g. "done", "ok") still each notify the
        // parent.
        if (event.type === 'session:started' || event.type === 'session:streaming') {
          this.notificationSignatures.delete(event.sessionId);
          return;
        }
        if (event.type === 'session:completed' || event.type === 'session:error' || event.type === 'session:waiting' || event.type === 'session:interrupted') {
          void this.handleChildSessionEvent(event.sessionId, event.type);
        }
      });

      this.registerIpcHandlers();
      this.started = true;
    })();

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  public async shutdown(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.unsubscribeStateListener?.();
    this.unsubscribeStateListener = null;
    this.notificationSignatures.clear();
    await shutdownMetaAgentServer();
    ClaudeCodeProvider.setMetaAgentServerPort(null);
    OpenAICodexProvider.setMetaAgentServerPort(null);
    OpenAICodexACPProvider.setMetaAgentServerPort(null);
    ClaudeCliLauncherConfig.setMetaAgentServerPort(null);
    this.serverPort = null;
    this.started = false;
  }

  /**
   * Launch a sibling session in the same workstream from a user-triggered
   * action prompt (the Actions dropdown in the AI composer). This is the
   * non-MCP entry point: unlike `spawnSession` (called from the meta-agent
   * MCP server), this is invoked from a human IPC and returns a typed
   * result, not stringified JSON.
   *
   * Workstream/worktree/model resolution mirrors `spawnSession` exactly:
   * - sibling under the parent's workstream (creating the container if needed)
   * - inherit parent's worktree unless `useWorktree=true`
   * - explicit `model` wins; otherwise inherit caller's model
   *
   * When `autoSubmit=true` the prompt is queued and processing starts; when
   * `autoSubmit=false` the session is created with no queued prompt so the
   * renderer can prefill the draft input for the user to edit before sending.
   */
  public async launchActionSession(
    parentSessionId: string,
    workspaceId: string,
    args: {
      prompt: string;
      title?: string;
      model?: string;
      autoSubmit: boolean;
      useWorktree?: boolean;
    }
  ): Promise<{
    sessionId: string;
    workstreamId: string | null;
    worktreeId: string | null;
    promotedParent: boolean;
    queuedInitialPrompt: boolean;
  }> {
    if (!args?.prompt?.trim()) {
      throw new Error('prompt is required');
    }

    const parent = await AISessionsRepository.get(parentSessionId);
    if (!parent || parent.workspacePath !== workspaceId) {
      throw new Error(`Parent session ${parentSessionId} not found in this workspace`);
    }

    const resolved = await this.resolveOrCreateWorkstream(parent, workspaceId);
    const workstreamId = resolved.workstreamId;

    const inheritedWorktreeId =
      !args.useWorktree && parent.worktreeId ? parent.worktreeId : undefined;

    // Explicit model wins; otherwise inherit caller's model (e.g. keep "opus"
    // on "opus") rather than dropping to the global default.
    const effectiveModel = args.model ?? parent.model ?? undefined;

    // Pass prompt only when autoSubmit is true; createChildSessionInternal
    // queues + triggers only when a prompt is supplied. For prefill mode we
    // omit it so nothing runs until the user hits Send in the new session.
    const childResult = await this.createChildSessionInternal(parentSessionId, workspaceId, {
      title: args.title,
      prompt: args.autoSubmit ? args.prompt : undefined,
      useWorktree: !!args.useWorktree,
      worktreeId: inheritedWorktreeId,
      model: effectiveModel,
      parentSessionIdOverride: workstreamId,
    });

    // Always fire-and-forget for human-triggered launches — the user can
    // watch the new session themselves; no need to surface child-completion
    // notifications back to the originating session.
    await AISessionsRepository.updateMetadata(childResult.sessionId, {
      metadata: { notifyParent: false },
    });

    return {
      sessionId: childResult.sessionId,
      workstreamId,
      worktreeId: childResult.worktreeId ?? null,
      promotedParent: resolved.promotedParent,
      queuedInitialPrompt: childResult.queuedInitialPrompt,
    };
  }

  private registerIpcHandlers(): void {
    if (this.ipcHandlersRegistered) {
      return;
    }

    safeHandle('meta-agent:list-spawned-sessions', async (_event, metaSessionId: string, workspaceId: string) => {
      try {
        const sessions = await this.getSpawnedSessions(metaSessionId, workspaceId);
        return { success: true, sessions };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), sessions: [] };
      }
    });

    if (process.env.PLAYWRIGHT === '1' || process.env.PLAYWRIGHT_TEST === 'true' || process.env.NODE_ENV === 'test') {
      safeHandle('meta-agent:get-server-port', async () => {
        return { success: true, port: this.serverPort };
      });
    }

    this.ipcHandlersRegistered = true;
  }

  private async createChildSession(
    metaSessionId: string,
    workspaceId: string,
    args: CreateChildSessionArgs
  ): Promise<string> {
    const result = await this.createChildSessionInternal(metaSessionId, workspaceId, args);
    return JSON.stringify(result, null, 2);
  }

  private async createChildSessionInternal(
    metaSessionId: string,
    workspaceId: string,
    args: CreateChildSessionArgs & { parentSessionIdOverride?: string | null }
  ): Promise<{
    sessionId: string;
    title: string;
    provider: string;
    model: string;
    worktreeId: string | null;
    worktreePath: string | null;
    worktreeMode: 'existing' | 'new' | 'none';
    createdBySessionId: string;
    queuedInitialPrompt: boolean;
    parentSessionId: string | null;
  }> {
    if (!this.aiService) {
      throw new Error('AI service not initialized');
    }
    if (args.useWorktree && args.worktreeId) {
      throw new Error('useWorktree and worktreeId cannot be combined');
    }

    // Defense-in-depth: a child-completion notification (built in
    // buildNotificationMessage) starts literally with '[Child Session Update]'.
    // If such text is ever re-ingested as a spawn prompt/title, the derived
    // title recurses into '[Child Session Update] Session: "[Child Session
    // Update]..."'. Refuse outright so an update notification can never become
    // a new child session.
    const CHILD_UPDATE_PREFIX = '[Child Session Update]';
    const promptHead = args.prompt?.trim() ?? '';
    const titleHead = args.title?.trim() ?? '';
    if (promptHead.startsWith(CHILD_UPDATE_PREFIX) || titleHead.startsWith(CHILD_UPDATE_PREFIX)) {
      throw new Error(
        'Refusing to spawn a child session from a child-completion notification ' +
        '(prompt/title begins with "[Child Session Update]").'
      );
    }

    // Inherit the calling session's provider+model as the primary fallback so a
    // non-Claude parent (Gemini, OpenAI-Codex, LM Studio, etc.) spawning a child
    // via the meta-agent tools without an explicit model does NOT silently land
    // on the hardcoded Opus default and bill the user's Anthropic pool. Only fall
    // through to getDefaultAIModel() / the last-resort default when the parent
    // session cannot be loaded (orphan call) or carries no usable provider+model.
    // An explicit args.provider/args.model still wins; that is what they are for.
    let parentProvider: string | null = null;
    let parentModel: string | null = null;
    let parentExists = false;
    let parentAgentRole: string | null = null;
    let parentSessionType: string | null = null;
    try {
      const parentSession = await AISessionsRepository.get(metaSessionId);
      if (parentSession) {
        parentExists = true;
        parentProvider = parentSession.provider ?? null;
        parentModel = normalizeStoredChildModelIdentifier(parentProvider, parentSession.model ?? null);
        parentAgentRole = parentSession.agentRole ?? null;
        parentSessionType = parentSession.sessionType ?? null;
      }
    } catch {
      // Best-effort lookup; fall through to the hardcoded default below.
    }

    const defaultModel =
      parentModel
      || normalizeStoredChildModelIdentifier(null, getDefaultAIModel())
      || 'claude-code:opus';
    // For an explicit model, the model's own "provider:" prefix is
    // authoritative (e.g. a claude-code parent launching an
    // "openai-codex:gpt-5.5" action). Only fall back to the parent's provider
    // for a bare, prefix-less variant; passing the parent provider for a
    // self-describing identifier wrongly trips the claude-code mismatch guard.
    const explicitModelProvider =
      args.provider
      ?? (args.model?.includes(':') ? ModelIdentifier.tryParse(args.model)?.provider ?? null : null)
      ?? parentProvider;
    const explicitModel = normalizeStoredChildModelIdentifier(explicitModelProvider, args.model ?? null);
    const model = explicitModel || defaultModel;
    const parsed = ModelIdentifier.tryParse(model);
    const provider = (args.provider ||
      parsed?.provider ||
      parentProvider ||
      'claude-code') as AIProviderType;
    const normalizedModel =
      explicitModel || parentModel || ModelIdentifier.getDefaultModelId(provider);

    const callerProvidedTitle = !!args.title?.trim();
    const title = (args.title || this.deriveTitleFromPrompt(args.prompt) || 'Meta Task').trim();

    let worktreeId: string | null = null;
    let worktreePath: string | null = null;

    const db = getDatabase();
    if ((args.useWorktree || args.worktreeId) && !db) {
      throw new Error('Database not initialized');
    }
    const worktreeStore = db ? createWorktreeStore(db) : null;

    if (args.worktreeId) {
      if (!worktreeStore) {
        throw new Error('Worktree store not initialized');
      }

      const existingWorktree = await worktreeStore.get(args.worktreeId);
      if (!existingWorktree) {
        throw new Error(`Worktree ${args.worktreeId} not found`);
      }
      if (existingWorktree.projectPath !== workspaceId) {
        throw new Error(`Worktree ${args.worktreeId} does not belong to this workspace`);
      }
      if (existingWorktree.isArchived) {
        throw new Error(`Worktree ${args.worktreeId} is archived`);
      }

      worktreeId = existingWorktree.id;
      worktreePath = existingWorktree.path;
    } else if (args.useWorktree) {
      if (!worktreeStore) {
        throw new Error('Worktree store not initialized');
      }

      const gitWorktreeService = new GitWorktreeService();
      const [dbNames, filesystemNames, branchNames] = await Promise.all([
        worktreeStore.getAllNames(),
        Promise.resolve(gitWorktreeService.getExistingWorktreeDirectories(workspaceId)),
        gitWorktreeService.getAllBranchNames(workspaceId),
      ]);
      const existingNames = new Set<string>();
      for (const name of dbNames) existingNames.add(name);
      for (const name of filesystemNames) existingNames.add(name);
      for (const name of branchNames) existingNames.add(name);
      const finalName = gitWorktreeService.generateUniqueWorktreeName(existingNames);
      const worktree = await gitWorktreeService.createWorktree(workspaceId, { name: finalName });
      await worktreeStore.create(worktree);
      gitRefWatcher.start(worktree.path).catch((error: Error) => {
        console.error('[MetaAgentService] Failed to start GitRefWatcher for meta-agent worktree:', error);
      });
      worktreeId = worktree.id;
      worktreePath = worktree.path;
    }

    // Backstop: cap the TOTAL number of children a single parent can ever spawn.
    // Without this, a feedback loop can create unbounded children. The prior
    // in-flight-only count (status running / waiting_for_input) did NOT bound
    // SEQUENTIAL re-spawning: a completion-wakeup re-drives the parent, a weak
    // model spawns another child, the child settles in milliseconds, so the
    // in-flight count stays ~0 and the cap never fires. Counting ALL children
    // ever created by this parent (regardless of status, non-archived) bounds
    // that runaway. A normal 3-child spawn is unaffected. Mirrors the
    // created_by_session_id query in getSpawnedSessions.
    const TOTAL_SPAWN_CAP = 15;
    const { rows: totalRows } = await databaseWorker.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ai_sessions
       WHERE workspace_id = $1
         AND created_by_session_id = $2
         AND (is_archived = FALSE OR is_archived IS NULL)`,
      [workspaceId, metaSessionId]
    );
    const totalCount = Number(totalRows[0]?.count ?? '0');
    if (totalCount >= TOTAL_SPAWN_CAP) {
      throw new Error(
        `Meta-agent spawn cap reached (${TOTAL_SPAWN_CAP} total children spawned by this parent); refusing to spawn more`
      );
    }

    // One-time promotion of the spawning parent to agent_role='meta-agent'.
    // The renderer META AGENT group requires the PARENT session to carry
    // agentRole='meta-agent'. The native Meta Agent button sets this at create
    // time; a plain chat session (e.g. a Gemini parent) that spawns children
    // via the meta-agent tools is still agentRole='standard', so its children
    // render flat. Promote the genuine human-facing parent here. Never promote
    // a workstream container (sessionType='workstream') -- that row is the
    // grouping container, not the human-facing parent, and createChildSession
    // Internal is always called with the original parent id, not the workstream
    // id (resolveOrCreateWorkstream passes the container via
    // parentSessionIdOverride only). The sessionType guard is the safeguard for
    // the edge where the parent id is itself a workstream container.
    // NOTE: This promotion is now inert. Spawn tools are gated on
    // agentRole==='meta-agent' at the extension-agent branch in
    // MessageStreamingHandler, so the only sessions that can reach this code
    // are already meta-agents; the parentAgentRole!=='meta-agent' branch never
    // fires for them. Kept as a defensive no-op (and to preserve renderer
    // grouping behavior for any non-extension caller path). Distinct from the
    // workstream promotedParent logic in resolveOrCreateWorkstream.
    if (parentExists && parentAgentRole !== 'meta-agent' && parentSessionType !== 'workstream') {
      await AISessionsRepository.updateMetadata(metaSessionId, { agentRole: 'meta-agent' });
    }

    const sessionId = randomUUID();
    await AISessionsRepository.create({
      id: sessionId,
      provider,
      model: normalizedModel,
      title,
      workspaceId,
      worktreeId: worktreeId ?? undefined,
      agentRole: 'standard',
      createdBySessionId: metaSessionId,
      parentSessionId: args.parentSessionIdOverride ?? null,
      // When the meta-agent (or any caller of spawn_session) supplies an
      // explicit title, treat the session as already named so the out-of-band
      // SDK title generator (see ClaudeCodeProvider.runTitleGeneration) does
      // not clobber it via updateTitleIfNotNamed.
      hasBeenNamed: callerProvidedTitle,
    } as any);

    const initialPrompt = args.prompt?.trim();
    const shouldBypassExecution = this.shouldBypassChildAgentExecutionForTests();

    if (initialPrompt) {
      if (shouldBypassExecution) {
        await this.persistSyntheticInputMessage(sessionId, initialPrompt);
      } else {
        await this.aiService.queuePromptForSession(sessionId, initialPrompt);
      }
    }

    const newChildParentId = args.parentSessionIdOverride ?? null;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('sessions:refresh-list', {
          workspacePath: workspaceId,
          sessionId,
        });
        if (worktreeId) {
          window.webContents.send('worktree:session-created', { sessionId, worktreeId });
        }
        // The general `sessions:refresh-list` only updates `sessionRegistryAtom`.
        // Workstream surfaces (tab strip, left tree) also read per-parent atoms
        // (`sessionChildrenAtom`, `workstreamStateAtom`) that the registry
        // refresh does not touch, so we send a targeted event so listeners can
        // patch those without re-fetching everything.
        if (newChildParentId) {
          window.webContents.send('sessions:child-added', {
            workspacePath: workspaceId,
            parentSessionId: newChildParentId,
            childSessionId: sessionId,
          });
        }
      }
    }

    if (initialPrompt && !shouldBypassExecution) {
      await this.aiService.triggerQueuedPromptProcessingForSession(sessionId, worktreePath || workspaceId);
    }

    return {
      sessionId,
      title,
      provider,
      model: normalizedModel,
      worktreeId,
      worktreePath,
      worktreeMode: args.worktreeId ? 'existing' : args.useWorktree ? 'new' : 'none',
      createdBySessionId: metaSessionId,
      queuedInitialPrompt: !!initialPrompt,
      parentSessionId: args.parentSessionIdOverride ?? null,
    };
  }

  private async spawnSession(
    parentSessionId: string,
    workspaceId: string,
    args: SpawnSessionArgs
  ): Promise<string> {
    if (!args?.prompt?.trim()) {
      throw new Error('prompt is required');
    }

    const parent = await AISessionsRepository.get(parentSessionId);
    if (!parent || parent.workspacePath !== workspaceId) {
      throw new Error(`Parent session ${parentSessionId} not found in this workspace`);
    }

    const isolated = args.isolated === true;

    // Sibling mode: resolve (or create) a workstream container so the new
    // session shares files-edited, tabs, and workstream overview with the
    // caller. Isolated mode skips this entirely — the new session is a
    // top-level row with no parent, intended for fix-and-commit work that
    // should not pollute the caller's workstream.
    let workstreamId: string | null = null;
    let promotedParent = false;
    if (!isolated) {
      const resolved = await this.resolveOrCreateWorkstream(parent, workspaceId);
      workstreamId = resolved.workstreamId;
      promotedParent = resolved.promotedParent;
    }

    // Inherit the caller's worktree by default. spawn_session means "continue
    // work in the same checkout I'm in"; without this, a child created from a
    // worktree-resident parent silently lands in the project root and any edits
    // it makes go to the wrong tree. Skip inheritance only when the caller
    // explicitly asked for a brand-new worktree (useWorktree=true).
    const inheritedWorktreeId =
      !args.useWorktree && parent.worktreeId ? parent.worktreeId : undefined;

    // Resolve effective model: explicit `model` wins; otherwise `inheritModel`
    // copies the caller's model so the new session keeps the same provider/model
    // (e.g. opus stays on opus). Falling through to undefined lets
    // createChildSessionInternal use the global default.
    const effectiveModel =
      args.model ?? (args.inheritModel ? parent.model ?? undefined : undefined);

    const childResult = await this.createChildSessionInternal(parentSessionId, workspaceId, {
      title: args.title,
      prompt: args.prompt,
      useWorktree: !!args.useWorktree,
      worktreeId: inheritedWorktreeId,
      model: effectiveModel,
      parentSessionIdOverride: workstreamId,
    });

    // Default is fire-and-forget: kicking off work in a fresh session is the
    // common /launch-new-session use case (escape a long parent context).
    const notifyOnComplete = args.notifyOnComplete === true;
    if (!notifyOnComplete) {
      await AISessionsRepository.updateMetadata(childResult.sessionId, {
        metadata: { notifyParent: false },
      });
    }

    return JSON.stringify({
      ...childResult,
      isolated,
      workstreamId,
      promotedParent,
      notifyOnComplete,
    }, null, 2);
  }

  private async resolveOrCreateWorkstream(
    parent: { id: string; title?: string; provider: string; model?: string | null; sessionType?: string; parentSessionId?: string | null; worktreeId?: string | null },
    workspaceId: string
  ): Promise<{ workstreamId: string | null; promotedParent: boolean }> {
    // A worktree IS the workstream — the worktree row in the `worktrees` table is the
    // container, and every session inside it is a flat sibling keyed by `worktree_id`.
    // Never wrap a worktree-resident session in a `session_type='workstream'` row;
    // that produces a forbidden third layer (worktree → workstream → session) and
    // confuses every grouping derivation (worktreeGroupsData, FilesEditedSidebar,
    // the workstream tab strip). Hard rule: two layers max.
    if (parent.worktreeId) {
      return { workstreamId: null, promotedParent: false };
    }

    if (parent.parentSessionId) {
      return { workstreamId: parent.parentSessionId, promotedParent: false };
    }

    if (parent.sessionType === 'workstream') {
      return { workstreamId: parent.id, promotedParent: false };
    }

    const workstreamId = randomUUID();
    const workstreamTitle = (parent.title && parent.title.trim()) ? parent.title : 'Workstream';

    await AISessionsRepository.create({
      id: workstreamId,
      provider: parent.provider,
      model: parent.model ?? undefined,
      title: workstreamTitle,
      workspaceId,
      sessionType: 'workstream',
    });

    // Tag the workstream container in metadata so existing renderer code that
    // relies on metadata.isWorkstreamRoot continues to work.
    await AISessionsRepository.updateMetadata(workstreamId, {
      metadata: { isWorkstreamRoot: true },
    });

    // Reparent the original session under the new workstream container.
    await AISessionsRepository.updateMetadata(parent.id, {
      parentSessionId: workstreamId,
    });

    // Tell the renderer the original session is now a child of the workstream
    // so per-parent atoms (sessionChildrenAtom, workstreamStateAtom) get
    // patched alongside the registry refresh that fires below.
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('sessions:child-added', {
          workspacePath: workspaceId,
          parentSessionId: workstreamId,
          childSessionId: parent.id,
        });
      }
    }

    // SyncedSessionStore is now the single push path: the create() above pushes
    // title/provider/model/sessionType for the new workstream, and the
    // updateMetadata() above pushes the reparented child's parentSessionId.
    // Both reach iOS via the index channel without needing an explicit
    // pushChange here.

    return { workstreamId, promotedParent: true };
  }

  private async listWorktreesJson(workspaceId: string): Promise<string> {
    const db = getDatabase();
    if (!db) {
      throw new Error('Database not initialized');
    }

    const worktreeStore = createWorktreeStore(db);
    const worktrees = await worktreeStore.list(workspaceId);
    const summaries = await Promise.all(
      worktrees.map(async (worktree) => {
        const sessionIds = await worktreeStore.getWorktreeSessions(worktree.id);
        return {
          id: worktree.id,
          name: worktree.name,
          displayName: worktree.displayName || null,
          path: worktree.path,
          branch: worktree.branch,
          baseBranch: worktree.baseBranch,
          sessionCount: sessionIds.length,
          createdAt: worktree.createdAt,
          updatedAt: worktree.updatedAt ?? null,
        };
      })
    );

    return JSON.stringify(summaries, null, 2);
  }

  private async getSessionStatusJson(sessionId: string, workspaceId: string): Promise<string> {
    const row = await this.getSessionStatusRow(sessionId, workspaceId);
    if (!row) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const status = row.status || 'idle';
    const result: Record<string, unknown> = {
      sessionId: row.id,
      title: row.title || 'Untitled Session',
      status,
      lastActivity: toMillis(row.last_activity),
      updatedAt: toMillis(row.updated_at),
      provider: row.provider,
      model: row.model || null,
      createdBySessionId: row.created_by_session_id || null,
      agentRole: row.agent_role || 'standard',
      waitingForInput: status === 'waiting_for_input',
    };

    return JSON.stringify(result, null, 2);
  }

  private async getSessionResultJson(sessionId: string, workspaceId: string): Promise<string> {
    const data = await this.buildSessionResultData(sessionId, workspaceId);
    return JSON.stringify(data, null, 2);
  }

  private async sendPromptToSession(sessionId: string, workspaceId: string, prompt: string): Promise<string> {
    if (!this.aiService) {
      throw new Error('AI service not initialized');
    }
    if (!prompt?.trim()) {
      throw new Error('prompt is required');
    }

    const session = await AISessionsRepository.get(sessionId);
    if (!session || session.workspacePath !== workspaceId) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const normalizedPrompt = prompt.trim();
    const shouldBypassExecution = this.shouldBypassChildAgentExecutionForTests();
    const statusRow = await this.getSessionStatusRow(sessionId, workspaceId);
    const statusBeforeQueue = (statusRow?.status || 'idle') as SessionStatusValue;

    if (shouldBypassExecution) {
      await this.persistSyntheticInputMessage(sessionId, normalizedPrompt);
      return JSON.stringify({
        sessionId,
        queuedPromptId: null,
        prompt: normalizedPrompt,
        statusBeforeQueue,
        processingTriggered: false,
        bypassedExecutionForTest: true,
      }, null, 2);
    }

    const queued = await this.aiService.queuePromptForSession(sessionId, normalizedPrompt);
    const status = (statusRow?.status || 'idle') as SessionStatusValue;
    const processingTriggered = status === 'idle' || status === 'interrupted' || status === 'error';

    if (processingTriggered) {
      await this.aiService.triggerQueuedPromptProcessingForSession(
        sessionId,
        session.worktreePath || session.workspacePath || workspaceId
      );
    }

    return JSON.stringify({
      sessionId,
      queuedPromptId: queued.id,
      prompt: queued.prompt,
      statusBeforeQueue: status,
      processingTriggered,
    }, null, 2);
  }

  private async respondToPrompt(workspaceId: string, args: {
    sessionId: string;
    promptId: string;
    promptType: PromptType;
    response: Record<string, unknown>;
  }): Promise<string> {
    if (!this.aiService) {
      throw new Error('AI service not initialized');
    }

    const session = await AISessionsRepository.get(args.sessionId);
    if (!session || session.workspacePath !== workspaceId) {
      throw new Error(`Session ${args.sessionId} not found`);
    }

    const result = await this.aiService.respondToInteractivePrompt({
      sessionId: args.sessionId,
      promptId: args.promptId,
      promptType: args.promptType,
      response: args.response,
      respondedBy: 'desktop',
    });

    if (!result.success) {
      throw new Error(result.error || 'Failed to respond to prompt');
    }

    return JSON.stringify({
      sessionId: args.sessionId,
      promptId: args.promptId,
      promptType: args.promptType,
      success: true,
    }, null, 2);
  }

  private async listSpawnedSessionsJson(metaSessionId: string, workspaceId: string): Promise<string> {
    const sessions = await this.getSpawnedSessions(metaSessionId, workspaceId);
    return JSON.stringify(sessions, null, 2);
  }

  private async getSpawnedSessions(metaSessionId: string, workspaceId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await databaseWorker.query<any>(
      `SELECT id, title, provider, model, status, last_activity, created_at, updated_at, worktree_id, agent_role, created_by_session_id
       FROM ai_sessions
       WHERE workspace_id = $1
         AND created_by_session_id = $2
         AND (is_archived = FALSE OR is_archived IS NULL)
       ORDER BY created_at DESC`,
      [workspaceId, metaSessionId]
    );

    const sessions: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const data = await this.buildSessionResultData(row.id, workspaceId, {
        title: row.title || 'Untitled Session',
        provider: row.provider,
        model: row.model || null,
        status: row.status || 'idle',
        lastActivity: toMillis(row.last_activity),
        createdAt: toMillis(row.created_at)!,
        updatedAt: toMillis(row.updated_at)!,
        worktreeId: row.worktree_id || null,
      }, false);
      sessions.push({
        sessionId: data.sessionId,
        title: data.title,
        provider: data.provider,
        model: data.model,
        status: data.status,
        lastActivity: data.lastActivity,
        originalPrompt: data.originalPrompt,
        lastResponse: data.lastResponse,
        editedFiles: data.editedFiles,
        pendingPrompt: data.pendingPrompt,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        worktreeId: data.worktreeId || null,
      });
    }

    return sessions;
  }

  private async handleChildSessionEvent(sessionId: string, eventType: 'session:completed' | 'session:error' | 'session:waiting' | 'session:interrupted'): Promise<void> {
    try {
      if (!this.aiService) {
        return;
      }

      const session = await AISessionsRepository.get(sessionId);
      if (!session || session.agentRole === 'meta-agent' || !session.createdBySessionId || !session.workspacePath) {
        return;
      }

      // Honor fire-and-forget: spawn_session sets metadata.notifyParent=false on
      // the child for /launch-new-session-style hand-offs where the parent does
      // not want to receive [Child Session Update] follow-up prompts.
      const childMetadata = (session.metadata as Record<string, unknown> | undefined) ?? undefined;
      if (childMetadata && childMetadata.notifyParent === false) {
        return;
      }

      const metaSession = await AISessionsRepository.get(session.createdBySessionId);
      if (!metaSession?.workspacePath) {
        return;
      }

      // NIM-6: session:completed fires on every turn idle, not only on terminal
      // completion. If the child still has more prompts queued AFTER the one
      // that just finished, this idle is a between-turn pause -- another
      // session:completed will follow once the queue drains. Suppress it; the
      // parent will be notified on the genuinely terminal idle (queue empty).
      //
      // The just-finished prompt is still in `executing` status at the moment
      // session:completed fires (MessageStreamingHandler marks it `completed`
      // only after endSession returns). So we count only `pending` rows --
      // counting `executing` would include the current turn itself and
      // suppress every notification, including the final terminal one.
      //
      // The other event types (error/waiting/interrupted) are always
      // meaningful and pass through.
      if (eventType === 'session:completed') {
        const { rows: pendingRows } = await databaseWorker.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM queued_prompts
           WHERE session_id = $1 AND status = 'pending'`,
          [sessionId]
        );
        const pendingCount = Number(pendingRows[0]?.count ?? '0');
        if (pendingCount > 0) {
          return;
        }
      }

      const metaStatusRow = await this.getSessionStatusRow(metaSession.id, metaSession.workspacePath);
      const metaStatus = (metaStatusRow?.status || 'idle') as SessionStatusValue;

      const result = await this.buildSessionResultData(sessionId, session.workspacePath, undefined, false);

      // NIM-6: real dedup gate. Drop notifications whose semantic content is
      // identical to the last one delivered for this child. The previous code
      // mixed in an always-incrementing counter, which made every signature
      // unique and the dedup useless. The signature is reset on
      // session:started/session:streaming (see start()), so it only collapses
      // duplicates within a single child turn -- not across turns.
      const signature = computeNotificationSignature(eventType, result);
      if (this.notificationSignatures.get(sessionId) === signature) {
        return;
      }
      this.notificationSignatures.set(sessionId, signature);

      if (result.pendingPrompt?.promptType === 'exit_plan_mode_request') {
        await this.ensurePlanTrackerItem(session.workspacePath, sessionId, result);
      }

      const notification = this.buildNotificationMessage(eventType, result);
      await this.aiService.queuePromptForSession(session.createdBySessionId, notification);

      // Do not auto-re-drive the parent when THIS child settle was an error.
      // The [Child Session Update] notification above is still queued for
      // visibility, but re-triggering the parent's queue on every error settle
      // spins the meta-agent wakeup loop with no backoff (an antigravity 429
      // child settles instantly into 'error' every cycle). Native children
      // settle 'session:completed', so this gate is a no-op for them.
      if (eventType !== 'session:error' && (metaStatus === 'idle' || metaStatus === 'interrupted' || metaStatus === 'error')) {
        await this.aiService.triggerQueuedPromptProcessingForSession(metaSession.id, metaSession.workspacePath);
      }
    } catch (error) {
      console.error(`[MetaAgentService] handleChildSessionEvent failed for session ${sessionId} (${eventType}):`, error);
    }
  }

  private buildNotificationMessage(
    eventType: 'session:completed' | 'session:error' | 'session:waiting' | 'session:interrupted',
    result: SessionResultData
  ): string {
    const lines = [
      '[Child Session Update]',
      `Session: "${result.title}" (${result.sessionId})`,
      `Status: ${result.status}`,
      `Event: ${eventType}`,
    ];

    if (result.originalPrompt) {
      lines.push(`Original task: ${result.originalPrompt}`);
    }
    if (result.recentMessages.length > 0) {
      lines.push('Recent messages:');
      for (const message of result.recentMessages) {
        const label = message.direction === 'input' ? 'User' : 'Assistant';
        lines.push(`- ${label}: ${message.text}`);
      }
    } else if (result.lastResponse) {
      lines.push(`Last response: ${result.lastResponse}`);
    }
    if (result.editedFiles.length > 0) {
      lines.push('Files modified:');
      for (const filePath of result.editedFiles) {
        lines.push(`- ${filePath}`);
      }
    }
    if (result.pendingPrompt) {
      lines.push('');
      lines.push(`ACTION REQUIRED: This session is blocked on an interactive prompt.`);
      lines.push(`Use respond_to_prompt with these arguments:`);
      lines.push(`  sessionId: "${result.sessionId}"`);
      lines.push(`  promptId: "${result.pendingPrompt.promptId}"`);
      lines.push(`  promptType: "${result.pendingPrompt.promptType}"`);

      if (result.pendingPrompt.promptType === 'ask_user_question_request') {
        const questions = result.pendingPrompt.content?.questions;
        if (Array.isArray(questions)) {
          lines.push('  Questions:');
          for (const q of questions) {
            const questionText = q.question || q.text || JSON.stringify(q);
            lines.push(`    - ${questionText}`);
            if (Array.isArray(q.options)) {
              for (const opt of q.options) {
                const label = typeof opt === 'string' ? opt : opt.label || opt.value || JSON.stringify(opt);
                lines.push(`      * ${label}`);
              }
            }
          }
        }
        lines.push(`  response format: { "answers": { "<question text>": "<your answer>" } }`);
      } else if (result.pendingPrompt.promptType === 'permission_request') {
        const toolName = result.pendingPrompt.content?.toolName || result.pendingPrompt.content?.request?.tool || 'unknown';
        lines.push(`  Tool requesting permission: ${toolName}`);
        lines.push(`  response: { "decision": "allow", "scope": "session" }`);
      } else if (result.pendingPrompt.promptType === 'exit_plan_mode_request') {
        if (result.pendingPrompt.content?.planFilePath) {
          lines.push(`  Plan file: ${result.pendingPrompt.content.planFilePath}`);
        }
        lines.push(`  response: { "approved": true }`);
      }
    }
    if (result.errorMessage) {
      lines.push(`Error: ${result.errorMessage}`);
    }
    return lines.join('\n');
  }

  private async buildSessionResultData(
    sessionId: string,
    workspaceId: string,
    prefetchedSession?: { title: string; provider: string; model: string | null; status: string; lastActivity: number | null; createdAt: number; updatedAt: number; worktreeId: string | null },
    // Skip the heavier full-turn extract when the caller only needs preview
    // fields (the list and notification paths discard fullResponse).
    includeFullResponse: boolean = true
  ): Promise<SessionResultData> {
    let sessionTitle: string;
    let sessionProvider: string;
    let sessionModel: string | null;
    let sessionStatus: SessionStatusValue;
    let sessionLastActivity: number | null;
    let sessionCreatedAt: number;
    let sessionUpdatedAt: number;
    let sessionWorktreeId: string | null;

    if (prefetchedSession) {
      sessionTitle = prefetchedSession.title;
      sessionProvider = prefetchedSession.provider;
      sessionModel = prefetchedSession.model;
      sessionStatus = prefetchedSession.status as SessionStatusValue;
      sessionLastActivity = prefetchedSession.lastActivity;
      sessionCreatedAt = prefetchedSession.createdAt;
      sessionUpdatedAt = prefetchedSession.updatedAt;
      sessionWorktreeId = prefetchedSession.worktreeId;
    } else {
      const session = await AISessionsRepository.get(sessionId);
      if (!session || session.workspacePath !== workspaceId) {
        throw new Error(`Session ${sessionId} not found`);
      }
      const statusRow = await this.getSessionStatusRow(sessionId, workspaceId);
      sessionTitle = session.title || 'Untitled Session';
      sessionProvider = session.provider;
      sessionModel = session.model || null;
      sessionStatus = (statusRow?.status || 'idle') as SessionStatusValue;
      sessionLastActivity = toMillis(statusRow?.last_activity);
      sessionCreatedAt = session.createdAt;
      sessionUpdatedAt = session.updatedAt;
      sessionWorktreeId = session.worktreeId || null;
    }

    const messages = await AgentMessagesRepository.list(sessionId, { limit: 500 });
    const userPrompts = extractUserPrompts(messages);
    const recentMessages = this.extractRecentMessages(messages, 3);
    const pendingPrompt = await this.getPendingInteractivePrompt(sessionId);

    let editedFiles: string[] = [];
    try {
      const fileLinks = await SessionFilesRepository.getFilesBySession(sessionId, 'edited');
      editedFiles = fileLinks.map((file: any) => this.stripWorkspacePath(file.filePath, workspaceId));
    } catch {
      editedFiles = [];
    }

    return {
      sessionId,
      title: sessionTitle,
      provider: sessionProvider,
      model: sessionModel,
      status: sessionStatus,
      lastActivity: sessionLastActivity,
      originalPrompt: userPrompts[0] || null,
      userPrompts,
      lastResponse: this.extractLastAgentResponse(messages),
      fullResponse: includeFullResponse ? this.extractLastAgentTurn(messages, 50000) : null,
      recentMessages,
      editedFiles,
      pendingPrompt,
      errorMessage: this.extractErrorMessage(messages),
      createdAt: sessionCreatedAt,
      updatedAt: sessionUpdatedAt,
      worktreeId: sessionWorktreeId,
    };
  }

  private async getPendingInteractivePrompt(sessionId: string): Promise<PendingInteractivePrompt | null> {
    // Interactive prompts are persisted in three different formats:
    // 1. AskUserQuestion:  { type: "nimbalyst_tool_use", name: "AskUserQuestion", id: "...", input: { questions } }
    // 2. ToolPermission:   { type: "nimbalyst_tool_use", name: "ToolPermission", id: "...", input: { requestId, toolName, ... } }
    // 3. ExitPlanMode:     { type: "exit_plan_mode_request", status: "pending", requestId: "..." }
    const { rows } = await databaseWorker.query<{
      id: string;
      content: string;
      created_at: Date;
    }>(
      `SELECT id, content, created_at
       FROM ai_agent_messages
       WHERE session_id = $1
         AND (hidden = FALSE OR hidden IS NULL)
         AND (
           (content LIKE '%"type":"exit_plan_mode_request"%' AND content LIKE '%"status":"pending"%')
           OR (content LIKE '%"type":"nimbalyst_tool_use"%' AND content LIKE '%"name":"AskUserQuestion"%')
           OR (content LIKE '%"type":"nimbalyst_tool_use"%' AND content LIKE '%"name":"ToolPermission"%')
         )
       ORDER BY created_at ASC`,
      [sessionId]
    );

    for (const row of rows) {
      try {
        const content = JSON.parse(row.content);

        // Handle nimbalyst_tool_use format (AskUserQuestion and ToolPermission)
        if (content.type === 'nimbalyst_tool_use') {
          const promptId = content.id || content.input?.requestId;
          if (!promptId) {
            continue;
          }

          // Check if there's already a response for this prompt
          const escapedPromptId = this.escapeLikePattern(promptId);
          const { rows: resultRows } = await databaseWorker.query<{ id: string }>(
            `SELECT id
             FROM ai_agent_messages
             WHERE session_id = $1
               AND (
                 (content LIKE '%"type":"nimbalyst_tool_result"%' AND content LIKE $2)
                 OR (content LIKE '%"type":"ask_user_question_response"%' AND content LIKE $2)
                 OR (content LIKE '%"type":"permission_response"%' AND content LIKE $2)
               )
             LIMIT 1`,
            [sessionId, `%"${escapedPromptId}"%`]
          );

          if (resultRows.length > 0) {
            continue;
          }

          if (content.name === 'AskUserQuestion') {
            return {
              id: row.id,
              promptId,
              promptType: 'ask_user_question_request',
              createdAt: toMillis(row.created_at)!,
              content: {
                ...content,
                questions: content.input?.questions || [],
                questionId: promptId,
              },
            };
          }

          if (content.name === 'ToolPermission') {
            return {
              id: row.id,
              promptId: content.input?.requestId || promptId,
              promptType: 'permission_request',
              createdAt: toMillis(row.created_at)!,
              content: {
                type: 'permission_request',
                requestId: content.input?.requestId || promptId,
                toolName: content.input?.toolName || 'unknown',
                rawCommand: content.input?.rawCommand || '',
                pattern: content.input?.pattern || '',
                patternDisplayName: content.input?.patternDisplayName || '',
                isDestructive: content.input?.isDestructive || false,
                warnings: content.input?.warnings || [],
                status: 'pending',
              },
            };
          }

          continue;
        }

        // Handle exit_plan_mode_request format
        if (content.type === 'exit_plan_mode_request' && content.status === 'pending') {
          const promptId = content.requestId;
          if (!promptId) {
            continue;
          }

          const escapedPromptId = this.escapeLikePattern(promptId);
          const { rows: responseRows } = await databaseWorker.query<{ id: string }>(
            `SELECT id
             FROM ai_agent_messages
             WHERE session_id = $1
               AND content LIKE '%"type":"exit_plan_mode_response"%'
               AND content LIKE $2
             LIMIT 1`,
            [sessionId, `%"requestId":"${escapedPromptId}"%`]
          );

          if (responseRows.length > 0) {
            continue;
          }

          return {
            id: row.id,
            promptId,
            promptType: 'exit_plan_mode_request',
            createdAt: toMillis(row.created_at)!,
            content,
          };
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private async getSessionStatusRow(sessionId: string, workspaceId: string): Promise<any | null> {
    const { rows } = await databaseWorker.query<any>(
      `SELECT id, title, provider, model, status, last_activity, updated_at, created_by_session_id, agent_role
       FROM ai_sessions
       WHERE id = $1 AND workspace_id = $2
       LIMIT 1`,
      [sessionId, workspaceId]
    );
    return rows[0] || null;
  }

  private async ensurePlanTrackerItem(workspaceId: string, sessionId: string, result: SessionResultData): Promise<void> {
    const pendingPrompt = result.pendingPrompt;
    if (!pendingPrompt || pendingPrompt.promptType !== 'exit_plan_mode_request') {
      return;
    }

    const sourceRef = `meta-agent-plan:${sessionId}:${pendingPrompt.promptId}`;
    const { rows: existing } = await databaseWorker.query<{ id: string }>(
      `SELECT id FROM tracker_items WHERE workspace = $1 AND source_ref = $2 LIMIT 1`,
      [workspaceId, sourceRef]
    );
    if (existing.length > 0) {
      return;
    }

    const trackerId = randomUUID();
    const title = `Plan review: ${result.title}`;
    const description = typeof pendingPrompt.content.planFilePath === 'string'
      ? `Plan generated by child session ${sessionId}.\nPlan file: ${pendingPrompt.content.planFilePath}`
      : `Plan generated by child session ${sessionId}.`;

    const data = {
      title,
      status: 'in-review',
      priority: 'medium',
      created: new Date().toISOString().split('T')[0],
      description,
      tags: ['meta-agent', 'plan-review'],
      childSessionId: sessionId,
    };

    await databaseWorker.query(
      `INSERT INTO tracker_items (
        id, type, data, workspace, document_path, line_number,
        created, updated, last_indexed, sync_status,
        content, archived, source, source_ref
      ) VALUES ($1, $2, $3, $4, '', NULL, NOW(), NOW(), NOW(), 'pending', $5, FALSE, $6, $7)`,
      [
        trackerId,
        'plan',
        JSON.stringify(data),
        workspaceId,
        JSON.stringify({
          planFilePath: pendingPrompt.content.planFilePath || null,
          allowedPrompts: pendingPrompt.content.allowedPrompts || [],
        }),
        'meta-agent',
        sourceRef,
      ]
    );

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('document-service:tracker-items-changed', {
          added: [],
          updated: [],
          removed: [],
          timestamp: new Date(),
        });
      }
    }
  }

  private extractLastAgentResponse(messages: Array<{ direction: string; content: string; metadata?: Record<string, unknown> | null }>, maxLength: number = 500): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.direction !== 'output') continue;
      const extracted = extractMessageText(message.content, message.metadata);
      if (extracted) {
        return extracted.length > maxLength ? `${extracted.slice(0, maxLength)}...` : extracted;
      }
    }
    return null;
  }

  /**
   * The child's full final turn: every output message since the last input
   * (user) message, joined. extractLastAgentResponse returns only the single
   * last output message, which decapitates a child whose substance spans
   * several output messages (tool narration then a final answer). Capped, with
   * an explicit marker when truncated so the reader knows content was dropped.
   */
  private extractLastAgentTurn(
    messages: Array<{ direction: string; content: string; metadata?: Record<string, unknown> | null }>,
    maxLength: number = 50000
  ): string | null {
    let lastInputIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].direction === 'input') {
        lastInputIndex = index;
        break;
      }
    }
    const parts: string[] = [];
    for (let index = lastInputIndex + 1; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.direction !== 'output') continue;
      const text = extractMessageText(message.content, message.metadata);
      if (text) parts.push(text);
    }
    if (lastInputIndex === -1 || parts.length === 0) {
      // No input row to anchor the turn (or no output after it): use the single
      // last output message rather than concatenating output across turns.
      return this.extractLastAgentResponse(messages, maxLength);
    }
    const sep = String.fromCharCode(10) + String.fromCharCode(10);
    const joined = parts.join(sep);
    return joined.length > maxLength
      ? joined.slice(0, maxLength) + sep + '[truncated: turn exceeded ' + maxLength + ' characters]'
      : joined;
  }

  private extractRecentMessages(
    messages: Array<{ direction: string; content: string; metadata?: Record<string, unknown> | null }>,
    limit: number,
    // Cap each message so a verbose child cannot inline an unbounded block
    // into the auto-injected [Child Session Update] notification.
    maxPerMessage: number = 2000
  ): Array<{ direction: 'input' | 'output'; text: string }> {
    const collected: Array<{ direction: 'input' | 'output'; text: string }> = [];
    for (let index = messages.length - 1; index >= 0 && collected.length < limit; index -= 1) {
      const message = messages[index];
      const text = extractMessageText(message.content, message.metadata);
      if (!text) {
        continue;
      }
      collected.push({
        direction: message.direction === 'input' ? 'input' : 'output',
        text: text.length > maxPerMessage ? `${text.slice(0, maxPerMessage)}...` : text,
      });
    }
    return collected.reverse();
  }

  private extractErrorMessage(messages: Array<{ direction: string; content: string }>): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      try {
        const parsed = JSON.parse(message.content);
        if (typeof parsed.error === 'string' && parsed.error.trim()) {
          return parsed.error.trim();
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private deriveTitleFromPrompt(prompt?: string): string | null {
    if (!prompt?.trim()) {
      return null;
    }
    const firstLine = prompt.trim().split('\n')[0].trim();
    if (!firstLine) {
      return null;
    }
    return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  }

  private escapeLikePattern(value: string): string {
    return value.replace(/[%_\\]/g, '\\$&');
  }

  private stripWorkspacePath(filePath: string, workspacePath: string): string {
    if (!workspacePath) return filePath;
    return path.relative(workspacePath, filePath);
  }
}
