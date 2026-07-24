/**
 * TeammateManager: manages the lifecycle, messaging, and state of managed teammates
 * spawned by the lead agent via query().
 *
 * Extracted from ClaudeCodeProvider to isolate the teammate subsystem.
 */

import { query, type SDKUserMessage, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// Query interface not properly exported by SDK, so we define it inline
interface Query extends AsyncGenerator<SDKMessage, void> {
  streamInput(stream: AsyncIterable<any>): Promise<void>;
}
import path from 'path';
import fsp from 'fs/promises';
import os from 'os';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ManagedTeammate {
  teamName: string;
  name: string;
  agentId: string;       // "name@teamName"
  abort: AbortController;
  streamPromise: Promise<{ capturedSessionId: string | undefined; approvedShutdown: boolean }>;
  query: Query | null;   // Reference to the query object for streamInput() injection
  sessionId?: string;    // Latest captured SDK session ID (for streamInput payloads)
  color: string;
  agentType: string;
  model?: string;
  isBackgroundAgent: boolean;  // true for fire-and-forget background sub-agents (no team, no idle)
  startedAt: number;           // epoch ms when spawned
  lastActiveAt: number;        // epoch ms of most recent chunk
  toolCallCount: number;       // count of tool_use blocks observed
}

export interface IdleTeammate {
  teamName: string;
  name: string;
  sessionId: string;     // SDK session ID for resume
  agentType: string;
  model: string | undefined;
  color: string;
  cwd: string;
  prompt: string;        // original prompt
  startedAt?: number;    // epoch ms when originally spawned (preserved across idle)
}

export interface PendingMessage {
  recipient: string;
  content: string;
  summary: string;
  queuedAt: number;
}

/**
 * Dependency interface injected by the host provider (ClaudeCodeProvider).
 * Keeps TeammateManager decoupled from BaseAIProvider / EventEmitter.
 */
export interface TeammateToLeadMessage {
  teammateName: string;
  teammateAgentId: string;
  content: string;
  summary: string;
}

/**
 * Dependency interface injected by the host provider (ClaudeCodeProvider).
 * Keeps TeammateManager decoupled from BaseAIProvider / EventEmitter.
 */
export interface TeammateManagerDeps {
  logNonBlocking(sessionId: string, source: string, direction: 'input' | 'output', content: string, metadata?: Record<string, unknown>): void;
  emit(event: string, payload: any): void;
  createPreToolUseHook(cwd: string, sessionId: string | undefined, permissionsPath: string | undefined, context: { isTeammateSession: boolean }): any;
  createPostToolUseHook(cwd: string, sessionId: string | undefined): any;
  getAbortSignal(): AbortSignal | undefined;
  /** Interrupt the lead agent and deliver a teammate message */
  interruptWithMessage(message: string): Promise<void>;
  /** Create a canUseTool handler that delegates to the lead's permission system */
  createCanUseToolHandler(
    sessionId: string | undefined,
    workspacePath: string,
    permissionsPath: string | undefined,
    teammateName?: string,
  ): (toolName: string, input: any, options: { signal: AbortSignal; toolUseID?: string }) =>
    Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string }>;
}

/**
 * Packaged-build options for spawning Claude Code subprocesses.
 * In production Electron builds, the SDK needs environment and binary path
 * configuration since the native binary lives inside asar-unpacked.
 */
export interface PackagedBuildOptions {
  env: Record<string, string | undefined>;
  pathToClaudeCodeExecutable?: string;
}

// ─── Class ──────────────────────────────────────────────────────────────────

export class TeammateManager {
  // ── State ─────────────────────────────────────────────────────────────────

  private managedTeammates: Map<string, ManagedTeammate> = new Map();
  private idleTeammates: Map<string, IdleTeammate> = new Map();
  private completedTeammates: Set<string> = new Set();  // agentIds
  private currentTeamContext?: string;

  private pendingLeadMessages: Map<string, PendingMessage[]> = new Map();
  private pendingLeadMessageFlushes: Set<string> = new Set();

  // tool_use_ids of shutdown_request SendMessage calls already handled by handlePreToolUse
  // (resumed idle teammate for approval handshake). processTeammateToolResult must skip these.
  private handledShutdownToolUseIds: Set<string> = new Set();

  // Queue of teammate messages waiting to be delivered to the lead agent
  private pendingTeammateToLeadMessages: TeammateToLeadMessage[] = [];

  private static readonly MAX_COMPLETED_TEAMMATES = 100;
  private static readonly TEAMMATE_COLORS = ['blue', 'green', 'yellow', 'purple'];
  private teammateColorIndex: number = 0;
  private bgAgentCounter: number = 0;
  private subAgentCounter: number = 0;

  // Debounce state for emitTeammateUpdate
  private pendingStatusOverrides: Map<string, 'running' | 'completed' | 'errored' | 'idle'> = new Map();
  private pendingEmitSessionId?: string;
  private emitDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Packaged-build options set by ClaudeCodeProvider for production Electron builds */
  packagedBuildOptions?: PackagedBuildOptions;
  private static readonly EMIT_DEBOUNCE_MS = 100;

  /** Captured from lead's sendMessage() for teammate spawning. */
  lastUsedCwd?: string;
  lastUsedSessionId?: string;
  lastUsedPermissionsPath?: string;

  constructor(private readonly deps: TeammateManagerDeps) {}

  // ─── Teammate-to-lead message queue ────────────────────────────────────

  /** Check if any teammate messages are waiting to be delivered to the lead. */
  hasPendingTeammateMessages(): boolean {
    return this.pendingTeammateToLeadMessages.length > 0;
  }

  /** Remove and return the next pending teammate-to-lead message (FIFO). */
  drainNextTeammateMessage(): TeammateToLeadMessage | undefined {
    return this.pendingTeammateToLeadMessages.shift();
  }

  /** Re-queue a message at the front (used when streamInput fails). */
  requeueTeammateMessage(msg: TeammateToLeadMessage): void {
    this.pendingTeammateToLeadMessages.unshift(msg);
  }

  /** Check if any managed teammates are currently running (not idle). */
  hasRunningTeammates(): boolean {
    return this.managedTeammates.size > 0;
  }

  /** Check if any teammates are active (running or idle). */
  hasActiveTeammates(): boolean {
    return this.managedTeammates.size > 0 || this.idleTeammates.size > 0;
  }

  /** Check if all active agents are background-only (sub-agents or background agents, no idle teammates). */
  hasOnlyBackgroundAgents(): boolean {
    if (this.idleTeammates.size > 0) return false;
    if (this.managedTeammates.size === 0) return false;
    for (const tm of this.managedTeammates.values()) {
      if (!tm.isBackgroundAgent) return false;
    }
    return true;
  }

  /** Get count of active agents (running + idle). */
  getActiveAgentCount(): number {
    return this.managedTeammates.size + this.idleTeammates.size;
  }

  /**
   * Abandon all idle teammates (mark completed, clear from idle map).
   * Called when the lead's transport dies and idle teammates can no longer
   * be resumed. Emits teammates:allCompleted if no running teammates remain.
   */
  abandonIdleTeammates(sessionId: string | undefined): void {
    if (this.idleTeammates.size === 0) return;

    const overrides = new Map<string, 'running' | 'completed' | 'errored' | 'idle'>();
    for (const agentId of this.idleTeammates.keys()) {
      this.markCompleted(agentId);
      this.clearPendingMessages(agentId);
      overrides.set(agentId, 'completed');
      console.log(`[MANAGED-TEAMMATE] Abandoning idle teammate "${agentId}" (lead transport dead)`);
    }
    this.idleTeammates.clear();

    this.scheduleEmitTeammateUpdate(sessionId, overrides);

    if (!this.hasActiveTeammates()) {
      console.log(`[MANAGED-TEAMMATE] All teammates completed after idle abandon, emitting teammates:allCompleted`);
      this.deps.emit('teammates:allCompleted', { sessionId });
    }
  }

  /**
   * Create an async iterable yielding a single SDKUserMessage.
   * Public so ClaudeCodeProvider can use it for streamInput injection.
   */
  createInjectedUserMessageStream(content: string): AsyncIterable<SDKUserMessage> {
    const payload: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
      session_id: '',  // Populated by SDK on delivery
    };
    async function* stream() {
      yield payload;
    }
    return stream();
  }

  private markCompleted(agentId: string): void {
    this.completedTeammates.add(agentId);
    while (this.completedTeammates.size > TeammateManager.MAX_COMPLETED_TEAMMATES) {
      const oldest = this.completedTeammates.values().next().value;
      if (oldest !== undefined) {
        this.completedTeammates.delete(oldest);
      } else {
        break;
      }
    }
  }

  // ─── Name / ID helpers ──────────────────────────────────────────────────

  /**
   * Sanitize a team or teammate name to prevent path traversal.
   */
  sanitizeName(name: string, type: 'team' | 'teammate'): string {
    if (!name || typeof name !== 'string') {
      throw new Error(`${type} name must be a non-empty string`);
    }

    const sanitized = name
      .replace(/[\/\\]/g, '')
      .replace(/\.\./g, '')
      .replace(/^\.+/, '')
      .trim();

    if (!/^[a-zA-Z0-9_-]+$/.test(sanitized)) {
      throw new Error(
        `Invalid ${type} name: "${name}". Must contain only letters, numbers, hyphens, and underscores.`
      );
    }

    if (sanitized.length > 100) {
      throw new Error(`${type} name too long (max 100 characters): "${name}"`);
    }

    return sanitized;
  }

  private sanitizeTeamNameOrUndefined(teamName: unknown): string | undefined {
    if (typeof teamName !== 'string' || !teamName.trim()) {
      return undefined;
    }
    try {
      return this.sanitizeName(teamName.trim(), 'team');
    } catch {
      return undefined;
    }
  }

  /**
   * Extract the teammate name from an agentId ("name@teamName").
   */
  extractAgentName(agentId: string): string | null {
    const atIndex = agentId.indexOf('@');
    if (atIndex <= 0) return null;
    return agentId.substring(0, atIndex);
  }

  /**
   * Extract the team name from an agentId ("name@teamName").
   */
  extractTeamName(agentId: string): string | null {
    const atIndex = agentId.indexOf('@');
    if (atIndex <= 0) return null;
    return agentId.substring(atIndex + 1);
  }

  /**
   * Check if an agentId matches a recipient name (with optional team qualification).
   */
  agentIdMatchesRecipient(agentId: string, recipient: string, preferredTeam?: string): boolean {
    const name = this.extractAgentName(agentId);
    if (!name) return false;

    if (recipient.includes('@')) {
      return agentId === recipient;
    }

    if (name === recipient) {
      if (preferredTeam) {
        const team = this.extractTeamName(agentId);
        return team === preferredTeam;
      }
      return true;
    }

    return false;
  }

  private collectUniqueTeamNames(agentIds: Iterable<string>): string[] {
    const teams = new Set<string>();
    for (const agentId of agentIds) {
      const team = this.extractTeamName(agentId);
      if (team === '_background' || team === '_subagent') continue;  // Skip background/plain sub-agents
      const sanitized = this.sanitizeTeamNameOrUndefined(team);
      if (sanitized) {
        teams.add(sanitized);
      }
    }
    return [...teams];
  }

  // ─── Team context resolution ────────────────────────────────────────────

  private resolveTeamContextFromTrackedTeammates(): string | undefined {
    const activeTeams = [
      ...this.collectUniqueTeamNames(this.managedTeammates.keys()),
      ...this.collectUniqueTeamNames(this.idleTeammates.keys()),
    ];
    const uniqueActiveTeams = [...new Set(activeTeams)];
    if (uniqueActiveTeams.length === 1) {
      return uniqueActiveTeams[0];
    }

    if (uniqueActiveTeams.length === 0) {
      const completedTeams = this.collectUniqueTeamNames(this.completedTeammates.values());
      if (completedTeams.length === 1) {
        return completedTeams[0];
      }
    }

    return undefined;
  }

  private async resolveTeamContextFromSessionMetadata(sessionId?: string): Promise<string | undefined> {
    if (!sessionId) {
      return undefined;
    }

    try {
      const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');
      const session = await AISessionsRepository.get(sessionId);
      const metadata = session?.metadata as any;

      const storedTeamContext = this.sanitizeTeamNameOrUndefined(metadata?.currentTeamContext);
      if (storedTeamContext) {
        return storedTeamContext;
      }

      const teammates = Array.isArray(metadata?.currentTeammates) ? metadata.currentTeammates : [];
      if (teammates.length === 0) {
        return undefined;
      }

      const runningOrIdle = teammates.filter((tm: any) => tm?.status === 'running' || tm?.status === 'idle');
      const runningOrIdleTeams: string[] = Array.from(new Set(
        runningOrIdle
          .map((tm: any) => this.sanitizeTeamNameOrUndefined(tm?.teamName))
          .filter((team: string | undefined): team is string => typeof team === 'string' && team.length > 0)
      ));

      if (runningOrIdleTeams.length === 1) {
        return runningOrIdleTeams[0];
      }

      const allTeams: string[] = Array.from(new Set(
        teammates
          .map((tm: any) => this.sanitizeTeamNameOrUndefined(tm?.teamName))
          .filter((team: string | undefined): team is string => typeof team === 'string' && team.length > 0)
      ));

      if (allTeams.length === 1) {
        return allTeams[0];
      }

      for (let i = teammates.length - 1; i >= 0; i--) {
        const candidate = this.sanitizeTeamNameOrUndefined(teammates[i]?.teamName);
        if (candidate) {
          return candidate;
        }
      }
    } catch (error) {
      console.warn('[TEAM-CONTEXT] Failed to resolve team context from session metadata:', error);
    }

    return undefined;
  }

  private async resolveTeamContextFromClaudeDirectories(): Promise<string | undefined> {
    try {
      const teamRoot = path.join(os.homedir(), '.claude', 'teams');
      try {
        await fsp.access(teamRoot);
      } catch {
        return undefined;
      }

      const dirEntries = await fsp.readdir(teamRoot, { withFileTypes: true });
      const entries = dirEntries
        .filter(entry => entry.isDirectory())
        .map(entry => this.sanitizeTeamNameOrUndefined(entry.name))
        .filter((team: string | undefined): team is string => Boolean(team));

      if (entries.length === 1) {
        return entries[0];
      }
    } catch (error) {
      console.warn('[TEAM-CONTEXT] Failed to resolve team context from ~/.claude/teams:', error);
    }

    return undefined;
  }

  async resolveTeamContext(sessionId?: string): Promise<string | undefined> {
    const existing = this.sanitizeTeamNameOrUndefined(this.currentTeamContext);
    if (existing) {
      return existing;
    }

    const fromTracked = this.resolveTeamContextFromTrackedTeammates();
    if (fromTracked) {
      this.currentTeamContext = fromTracked;
      console.log(`[TEAM-CONTEXT] Rehydrated team context from teammate state: "${fromTracked}"`);
      return fromTracked;
    }

    const fromMetadata = await this.resolveTeamContextFromSessionMetadata(sessionId);
    if (fromMetadata) {
      this.currentTeamContext = fromMetadata;
      console.log(`[TEAM-CONTEXT] Rehydrated team context from session metadata: "${fromMetadata}"`);
      return fromMetadata;
    }

    const fromDirectories = await this.resolveTeamContextFromClaudeDirectories();
    if (fromDirectories) {
      this.currentTeamContext = fromDirectories;
      console.log(`[TEAM-CONTEXT] Rehydrated team context from ~/.claude/teams: "${fromDirectories}"`);
      return fromDirectories;
    }

    return undefined;
  }

  // ─── Team context from tool results ─────────────────────────────────────

  /**
   * Extract team name from TeamCreate tool result content.
   */
  extractTeamNameFromToolResult(toolResult: unknown): string | undefined {
    if (!toolResult) return undefined;

    if (typeof toolResult === 'object' && !Array.isArray(toolResult)) {
      const obj = toolResult as Record<string, unknown>;
      if (typeof obj.team_name === 'string' && obj.team_name.trim()) {
        return obj.team_name.trim();
      }
      if (typeof obj.teamName === 'string' && obj.teamName.trim()) {
        return obj.teamName.trim();
      }
      if (typeof obj.text === 'string') {
        const fromText = this.extractTeamNameFromToolResult(obj.text);
        if (fromText) return fromText;
      }
      if (obj.data) {
        const fromData = this.extractTeamNameFromToolResult(obj.data);
        if (fromData) return fromData;
      }
      if (obj.content) {
        const fromContent = this.extractTeamNameFromToolResult(obj.content);
        if (fromContent) return fromContent;
      }
    }

    if (Array.isArray(toolResult)) {
      for (const item of toolResult) {
        const fromItem = this.extractTeamNameFromToolResult(item);
        if (fromItem) return fromItem;
      }
      return undefined;
    }

    if (typeof toolResult === 'string') {
      const trimmed = toolResult.trim();
      if (!trimmed) return undefined;

      try {
        const parsed = JSON.parse(trimmed);
        const fromParsed = this.extractTeamNameFromToolResult(parsed);
        if (fromParsed) return fromParsed;
      } catch {
        // fall through to regex
      }

      const jsonMatch = trimmed.match(/"team_name"\s*:\s*"([^"]+)"/);
      if (jsonMatch?.[1]) {
        return jsonMatch[1];
      }

      const leadAgentMatch = trimmed.match(/team-lead@([a-zA-Z0-9_-]+)/);
      if (leadAgentMatch?.[1]) {
        return leadAgentMatch[1];
      }

      const configPathMatch = trimmed.match(/\.claude[\/\\]teams[\/\\]([a-zA-Z0-9_-]+)[\/\\]config\.json/);
      if (configPathMatch?.[1]) {
        return configPathMatch[1];
      }

      const cleanupMatch = trimmed.match(/Cleaned up directories and worktrees for team\s+"([a-zA-Z0-9_-]+)"/i);
      if (cleanupMatch?.[1]) {
        return cleanupMatch[1];
      }
    }

    return undefined;
  }

  /**
   * Update/clear the current team context based on TeamCreate/TeamDelete results.
   */
  updateTeamContextFromToolResult(
    toolName: string,
    toolArgs: Record<string, unknown> | undefined,
    toolResult: unknown,
    isError: boolean,
  ): void {
    if (toolName === 'TeamCreate' && !isError) {
      const resultTeamName = this.extractTeamNameFromToolResult(toolResult);
      const candidateTeam = resultTeamName || (typeof toolArgs?.team_name === 'string' ? toolArgs.team_name : undefined);
      if (!candidateTeam) return;

      try {
        const sanitized = this.sanitizeName(candidateTeam, 'team');
        this.currentTeamContext = sanitized;
        console.log(`[TEAM-CONTEXT] Set current team context to "${sanitized}"`);
      } catch (error) {
        console.warn('[TEAM-CONTEXT] Ignoring invalid TeamCreate team name in result:', candidateTeam, error);
      }
      return;
    }

    if (toolName === 'TeamDelete' && !isError) {
      const deletedTeam = this.extractTeamNameFromToolResult(toolResult) || (typeof toolArgs?.team_name === 'string' ? toolArgs.team_name : undefined);
      const sanitizedDeletedTeam = this.sanitizeTeamNameOrUndefined(deletedTeam);
      if (!sanitizedDeletedTeam) {
        console.warn('[TEAM-CONTEXT] TeamDelete returned without a resolvable team name; preserving current context');
        return;
      }

      if (!this.currentTeamContext || this.currentTeamContext === sanitizedDeletedTeam) {
        console.log(`[TEAM-CONTEXT] Cleared current team context (deleted "${sanitizedDeletedTeam}")`);
        this.currentTeamContext = undefined;
      } else {
        console.log(
          `[TEAM-CONTEXT] TeamDelete removed "${sanitizedDeletedTeam}" but current context is "${this.currentTeamContext}", preserving current context`
        );
      }
    }
  }

  // ─── Synthetic logging ──────────────────────────────────────────────────

  /**
   * Log a synthetic tool_use + tool_result pair to the session transcript.
   */
  private logSyntheticToolPair(
    sessionId: string | undefined,
    toolUseId: string,
    toolName: string,
    toolInput: any,
    resultContent: any,
    useMessageType?: string
  ): void {
    if (!sessionId) return;

    this.deps.logNonBlocking(
      sessionId,
      'claude-code',
      'output',
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: toolUseId,
            name: toolName,
            input: toolInput,
          }]
        },
        parent_tool_use_id: null,
      }),
      { messageType: useMessageType ? `${useMessageType}_use` : 'synthetic_tool_use' }
    );

    this.deps.logNonBlocking(
      sessionId,
      'claude-code',
      'output',
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: typeof resultContent === 'string'
              ? resultContent
              : JSON.stringify(resultContent)
          }]
        },
        parent_tool_use_id: null,
      }),
      { messageType: useMessageType ? `${useMessageType}_result` : 'synthetic_tool_result' }
    );
  }

  // ─── Team config file I/O ──────────────────────────────────────────────

  private async updateTeamConfig(
    teamName: string,
    agentId: string,
    name: string,
    agentType: string,
    model: string | undefined,
    cwd: string,
    prompt: string,
    color: string
  ): Promise<void> {
    try {
      const sanitizedTeamName = this.sanitizeName(teamName, 'team');
      const sanitizedName = this.sanitizeName(name, 'teammate');

      const homeDir = os.homedir();
      const teamConfigPath = path.join(homeDir, '.claude', 'teams', sanitizedTeamName, 'config.json');
      const teamDir = path.dirname(teamConfigPath);

      await fsp.mkdir(teamDir, { recursive: true });

      const inboxesDir = path.join(teamDir, 'inboxes');
      await fsp.mkdir(inboxesDir, { recursive: true });

      const inboxPath = path.join(inboxesDir, `${sanitizedName}.json`);
      try {
        await fsp.access(inboxPath);
      } catch {
        await fsp.writeFile(inboxPath, JSON.stringify({ messages: [] }, null, 2));
      }

      const configLockPath = teamConfigPath + '.lock';
      const result = await this.withSimpleFileLock(configLockPath, async () => {
        let config: any;

        let configExists = false;
        try {
          await fsp.access(teamConfigPath);
          configExists = true;
        } catch { /* does not exist */ }

        if (configExists) {
          const configContent = await fsp.readFile(teamConfigPath, 'utf-8');
          config = JSON.parse(configContent);

          const existingMember = config.members?.find((m: any) => m.agentId === agentId);
          if (existingMember) {
            console.log(`[TEAM-CONFIG] Teammate "${agentId}" already registered in team config`);
            return;
          }

          if (!config.members) {
            config.members = [];
          }

          config.members.push({
            agentId,
            name,
            agentType,
            model: model || 'haiku',
            color,
            planModeRequired: false,
            joinedAt: Date.now(),
            tmuxPaneId: 'in-process',
            cwd,
            subscriptions: [],
            prompt,
            backendType: 'in-process',
          });
        } else {
          console.warn(`[TEAM-CONFIG] Creating new team config for "${teamName}" - this should have been created by TeamCreate`);
          config = {
            name: teamName,
            description: '',
            createdAt: Date.now(),
            leadAgentId: `team-lead@${teamName}`,
            members: [{
              agentId,
              name,
              agentType,
              model: model || 'haiku',
              color,
              planModeRequired: false,
              joinedAt: Date.now(),
              tmuxPaneId: 'in-process',
              cwd,
              subscriptions: [],
              prompt,
              backendType: 'in-process',
            }],
          };
        }

        const tmpPath = teamConfigPath + '.tmp';
        await fsp.writeFile(tmpPath, JSON.stringify(config, null, 2));
        await fsp.rename(tmpPath, teamConfigPath);
        console.log(`[TEAM-CONFIG] Registered teammate "${agentId}" in team config at ${teamConfigPath}`);
      });

      if (result === null) {
        console.warn(`[TEAM-CONFIG] Timed out acquiring config lock for team "${teamName}" - teammate "${agentId}" not registered`);
      }
    } catch (error) {
      console.error(`[TEAM-CONFIG] Failed to update team config for "${agentId}":`, error);
    }
  }

  private async removeTeammateFromConfig(teamName: string, agentId: string): Promise<void> {
    try {
      const sanitizedTeamName = this.sanitizeName(teamName, 'team');

      const homeDir = os.homedir();
      const teamConfigPath = path.join(homeDir, '.claude', 'teams', sanitizedTeamName, 'config.json');

      try {
        await fsp.access(teamConfigPath);
      } catch {
        console.log(`[TEAM-CONFIG] No config file found for team "${teamName}" - nothing to remove`);
        return;
      }

      const configContent = await fsp.readFile(teamConfigPath, 'utf-8');
      const config = JSON.parse(configContent);

      if (!config.members || !Array.isArray(config.members)) {
        return;
      }

      const originalLength = config.members.length;
      config.members = config.members.filter((m: any) => m.agentId !== agentId);

      if (config.members.length < originalLength) {
        const tmpPath = teamConfigPath + '.tmp';
        await fsp.writeFile(tmpPath, JSON.stringify(config, null, 2));
        await fsp.rename(tmpPath, teamConfigPath);
        console.log(`[TEAM-CONFIG] Removed completed teammate "${agentId}" from team config`);
      } else {
        console.log(`[TEAM-CONFIG] Teammate "${agentId}" not found in team config members - already removed`);
      }
    } catch (error) {
      console.error(`[TEAM-CONFIG] Failed to remove teammate "${agentId}" from config:`, error);
    }
  }

  // ─── File lock utility ──────────────────────────────────────────────────

  private async withSimpleFileLock<T>(
    lockPath: string,
    action: () => Promise<T>,
    timeoutMs: number = 5000,
    retryDelayMs: number = 25,
  ): Promise<T | null> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      let fh: import('fs/promises').FileHandle | null = null;
      try {
        fh = await fsp.open(lockPath, 'wx');
        try {
          return await action();
        } finally {
          if (fh !== null) {
            try {
              await fh.close();
            } catch {
              // Ignore close errors
            }
          }
          try {
            await fsp.unlink(lockPath);
          } catch {
            // Ignore lock cleanup errors
          }
        }
      } catch (error: any) {
        const code = error?.code;
        if (code !== 'EEXIST') {
          throw error;
        }
        // Check for stale locks (e.g., process crashed while holding lock)
        try {
          const lockStat = await fsp.stat(lockPath);
          const lockAgeMs = Date.now() - lockStat.mtimeMs;
          if (lockAgeMs > 30000) {
            console.warn(`[FILE-LOCK] Removing stale lock at "${lockPath}" (age: ${Math.round(lockAgeMs / 1000)}s)`);
            try {
              await fsp.unlink(lockPath);
            } catch {
              // Another process may have cleaned it up
            }
          }
        } catch {
          // Lock file may have been removed between our check and stat
        }
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }

    return null;
  }

  // ─── Message helpers ────────────────────────────────────────────────────

  private buildShutdownRequestPrompt(requestId: string, messageFromLead?: string): string {
    const trimmedMessage = typeof messageFromLead === 'string' ? messageFromLead.trim() : '';
    const lines = [
      'The team lead sent you a shutdown request. You must process it now.',
      `request_id: ${requestId}`,
      trimmedMessage ? `lead_message: ${trimmedMessage}` : '',
      'Immediately call SendMessage with:',
      'type: "shutdown_response"',
      'recipient: "team-lead"',
      `request_id: "${requestId}"`,
      'approve: true',
      'content: "Shutting down now."',
      'After sending the shutdown_response, stop all work and exit.',
    ];
    return lines.filter(Boolean).join('\n');
  }

  // ─── Message delivery ───────────────────────────────────────────────────

  private queueLeadMessage(
    agentId: string,
    recipient: string,
    content: string,
    summary: string,
  ): number {
    const queue = this.pendingLeadMessages.get(agentId) || [];
    queue.push({
      recipient,
      content,
      summary,
      queuedAt: Date.now(),
    });
    this.pendingLeadMessages.set(agentId, queue);
    return queue.length;
  }

  private clearPendingMessages(agentId: string): void {
    this.pendingLeadMessages.delete(agentId);
    this.pendingLeadMessageFlushes.delete(agentId);
  }

  private async appendToInbox(
    agentId: string,
    message: { content: string; summary: string; queuedAt: number },
  ): Promise<boolean> {
    try {
      const teammateName = this.extractAgentName(agentId);
      const rawTeamName = this.extractTeamName(agentId);
      const teamName = this.sanitizeTeamNameOrUndefined(rawTeamName);
      if (!teammateName || !teamName) {
        return false;
      }

      const sanitizedTeammateName = this.sanitizeName(teammateName, 'teammate');
      const inboxDir = path.join(os.homedir(), '.claude', 'teams', teamName, 'inboxes');
      const inboxPath = path.join(inboxDir, `${sanitizedTeammateName}.json`);
      const lockPath = `${inboxPath}.lock`;
      await fsp.mkdir(inboxDir, { recursive: true });

      const wrote = await this.withSimpleFileLock(lockPath, async () => {
        let inboxFile: any = [];
        let inboxArray: any[] = [];

        try {
          const raw = (await fsp.readFile(inboxPath, 'utf-8')).trim();
          if (raw.length > 0) {
            try {
              inboxFile = JSON.parse(raw);
              if (Array.isArray(inboxFile)) {
                inboxArray = inboxFile;
              } else if (inboxFile && Array.isArray(inboxFile.messages)) {
                inboxArray = inboxFile.messages;
              }
            } catch (parseError) {
              console.warn(`[MANAGED-TEAMMATE] Failed to parse inbox file "${inboxPath}", recreating:`, parseError);
              inboxFile = [];
              inboxArray = [];
            }
          }
        } catch (readError: any) {
          if (readError?.code !== 'ENOENT') throw readError;
          // File doesn't exist yet - start with empty arrays
        }

        inboxArray.push({
          from: 'team-lead',
          text: message.content,
          summary: message.summary || 'Message from lead',
          timestamp: new Date(message.queuedAt || Date.now()).toISOString(),
          read: false,
        });

        const nextInboxFile = Array.isArray(inboxFile)
          ? inboxArray
          : { ...inboxFile, messages: inboxArray };

        const tmpPath = `${inboxPath}.tmp-${process.pid}-${Date.now()}`;
        await fsp.writeFile(tmpPath, JSON.stringify(nextInboxFile, null, 2), 'utf-8');
        await fsp.rename(tmpPath, inboxPath);
        return true;
      });

      if (wrote === null) {
        console.warn(`[MANAGED-TEAMMATE] Timed out acquiring inbox lock for "${agentId}" at ${lockPath}`);
        return false;
      }

      return wrote;
    } catch (error) {
      console.warn(`[MANAGED-TEAMMATE] Failed to append message to inbox for "${agentId}":`, error);
      return false;
    }
  }

  private async flushPendingMessages(
    agentId: string,
    teammateQuery: Query | null,
  ): Promise<void> {
    const initialQueue = this.pendingLeadMessages.get(agentId);
    if (!initialQueue || initialQueue.length === 0) {
      return;
    }
    if (this.pendingLeadMessageFlushes.has(agentId)) {
      return;
    }

    this.pendingLeadMessageFlushes.add(agentId);
    try {
      while (true) {
        const queue = this.pendingLeadMessages.get(agentId);
        if (!queue || queue.length === 0) {
          break;
        }

        const nextMessage = queue[0];
        const formattedMessage = `[Message from team-lead]\n\n${nextMessage.content}`;

        if (teammateQuery && typeof teammateQuery.streamInput === 'function') {
          try {
            await teammateQuery.streamInput(this.createInjectedUserMessageStream(formattedMessage));
            queue.shift();
            console.log(`[MANAGED-TEAMMATE] Delivered queued message via streamInput to "${nextMessage.recipient}" (agentId: ${agentId}). Remaining queue=${queue.length}`);
            continue;
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`[MANAGED-TEAMMATE] streamInput delivery failed for "${nextMessage.recipient}" (agentId: ${agentId}); keeping queued for retry: ${reason}`);
          }
        }

        const appendedToInbox = await this.appendToInbox(agentId, nextMessage);
        if (appendedToInbox) {
          queue.shift();
          console.log(`[MANAGED-TEAMMATE] Delivered queued message via inbox for "${nextMessage.recipient}" (agentId: ${agentId}). Remaining queue=${queue.length}`);
          continue;
        }

        const streamAvailable = teammateQuery && typeof teammateQuery.streamInput === 'function';
        const reason = streamAvailable ? 'streamInput failed' : 'streamInput unavailable';
        console.warn(`[MANAGED-TEAMMATE] Pausing flush for "${nextMessage.recipient}" (agentId: ${agentId}); both delivery methods failed: ${reason}`);
        break;
      }
    } finally {
      const queue = this.pendingLeadMessages.get(agentId);
      if (queue && queue.length === 0) {
        this.pendingLeadMessages.delete(agentId);
      }
      this.pendingLeadMessageFlushes.delete(agentId);
    }
  }

  /**
   * Deliver a teammate's message to the lead agent.
   *
   * Queues the message internally and interrupts the lead agent so it can
   * process the message. Messages never enter the user-facing prompt queue.
   */
  private deliverMessageToLead(
    sessionId: string | undefined,
    teammateAgentId: string,
    teammateName: string,
    content: string,
    summary: string,
  ): void {
    if (sessionId) {
      const teammateMessageChunk = {
        type: 'teammate_message_to_lead',
        _isTeammateOutput: true,
        _teammateAgentId: teammateAgentId,
        _teammateName: teammateName,
        content,
        summary,
        timestamp: Date.now(),
      };
      this.deps.logNonBlocking(
        sessionId, 'claude-code', 'output',
        JSON.stringify(teammateMessageChunk),
        { messageType: 'teammate_message_to_lead' }
      );
    }

    // Queue the message and interrupt the lead to process it
    this.pendingTeammateToLeadMessages.push({
      teammateName,
      teammateAgentId,
      content,
      summary,
    });

    const formattedMessage = `[Teammate message from "${teammateName}"]\n\n${content}`;
    this.deps.interruptWithMessage(formattedMessage).catch(err => {
      console.warn(`[MANAGED-TEAMMATE] Failed to interrupt lead with teammate message:`, err);
    });

    this.deps.emit('message:logged', {
      sessionId,
      direction: 'output' as const,
    });
  }

  // ─── UI sync ────────────────────────────────────────────────────────────

  /**
   * Debounced version of emitTeammateUpdate. Accumulates status overrides
   * and flushes after EMIT_DEBOUNCE_MS to batch rapid lifecycle transitions.
   */
  private scheduleEmitTeammateUpdate(
    sessionId: string | undefined,
    statusOverrides?: Map<string, 'running' | 'completed' | 'errored' | 'idle'>
  ): void {
    if (!sessionId) return;

    this.pendingEmitSessionId = sessionId;
    if (statusOverrides) {
      for (const [agentId, status] of statusOverrides) {
        this.pendingStatusOverrides.set(agentId, status);
      }
    }

    if (this.emitDebounceTimer !== null) {
      clearTimeout(this.emitDebounceTimer);
    }

    this.emitDebounceTimer = setTimeout(() => {
      this.emitDebounceTimer = null;
      const overrides = new Map(this.pendingStatusOverrides);
      const sid = this.pendingEmitSessionId;
      this.pendingStatusOverrides.clear();
      this.pendingEmitSessionId = undefined;

      this.emitTeammateUpdate(sid, overrides).catch(err => {
        console.error('[CLAUDE-CODE] Failed to emit debounced teammate update:', err);
      });
    }, TeammateManager.EMIT_DEBOUNCE_MS);
  }

  /**
   * Flush any pending debounced teammate update immediately.
   */
  private flushPendingEmit(): void {
    if (this.emitDebounceTimer !== null) {
      clearTimeout(this.emitDebounceTimer);
      this.emitDebounceTimer = null;

      const overrides = new Map(this.pendingStatusOverrides);
      const sid = this.pendingEmitSessionId;
      this.pendingStatusOverrides.clear();
      this.pendingEmitSessionId = undefined;

      if (sid) {
        this.emitTeammateUpdate(sid, overrides).catch(err => {
          console.error('[CLAUDE-CODE] Failed to emit flushed teammate update:', err);
        });
      }
    }
  }

  async emitTeammateUpdate(
    sessionId: string | undefined,
    statusOverrides?: Map<string, 'running' | 'completed' | 'errored' | 'idle'>
  ): Promise<void> {
    if (!sessionId) {
      return;
    }

    try {
      const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');
      const currentSession = await AISessionsRepository.get(sessionId);
      const currentMetadata = currentSession?.metadata || {};

      const existingTeammates: Array<{
        name: string;
        agentId: string;
        teamName: string;
        agentType: string;
        status: 'running' | 'completed' | 'errored' | 'idle';
        model?: string;
        startedAt?: number;
        lastActiveAt?: number;
        toolCallCount?: number;
      }> = Array.isArray(currentMetadata.currentTeammates) ? currentMetadata.currentTeammates as any[] : [];

      const seenAgentIds = new Set<string>();
      const updatedTeammates = existingTeammates.map(tm => {
        seenAgentIds.add(tm.agentId);
        const managed = this.managedTeammates.get(tm.agentId);
        const activityFields = managed ? {
          startedAt: managed.startedAt,
          lastActiveAt: managed.lastActiveAt,
          toolCallCount: managed.toolCallCount,
        } : {};
        if (statusOverrides?.has(tm.agentId)) {
          return { ...tm, ...activityFields, status: statusOverrides.get(tm.agentId)! };
        } else if (managed) {
          return { ...tm, ...activityFields, status: 'running' as const };
        } else if (this.idleTeammates.has(tm.agentId)) {
          return { ...tm, status: 'idle' as const };
        }
        return tm;
      });

      for (const [agentId, tm] of this.managedTeammates) {
        if (!seenAgentIds.has(agentId)) {
          updatedTeammates.push({
            name: tm.name,
            agentId: tm.agentId,
            teamName: tm.teamName,
            agentType: tm.agentType,
            status: statusOverrides?.has(agentId) ? statusOverrides.get(agentId)! : 'running',
            model: tm.model,
            startedAt: tm.startedAt,
            lastActiveAt: tm.lastActiveAt,
            toolCallCount: tm.toolCallCount,
          });
        }
      }

      for (const [agentId, tm] of this.idleTeammates) {
        if (!seenAgentIds.has(agentId)) {
          updatedTeammates.push({
            name: tm.name,
            agentId,
            teamName: tm.teamName,
            agentType: tm.agentType,
            status: statusOverrides?.has(agentId) ? statusOverrides.get(agentId)! : 'idle',
            model: tm.model,
            startedAt: tm.startedAt,
          });
        }
      }

      await AISessionsRepository.updateMetadata(sessionId, {
        metadata: {
          ...currentMetadata,
          currentTeammates: updatedTeammates,
        }
      });

      this.deps.emit('message:logged', {
        sessionId,
        direction: 'output'
      });
    } catch (error) {
      console.error('[CLAUDE-CODE] Failed to update session metadata with teammates:', error);
    }
  }

  // ─── Lifecycle: shared completion handler ────────────────────────────────

  /**
   * Handle teammate stream completion or error. Called from both spawn and resume paths.
   */
  private handleStreamCompletion(
    sessionId: string | undefined,
    agentId: string,
    teamName: string,
    idleTemplate: IdleTeammate,
    result: { capturedSessionId: string | undefined; approvedShutdown: boolean; capturedResultText: string | undefined; sentMessageToLead: boolean },
  ): void {
    const managed = this.managedTeammates.get(agentId);
    const isBackground = managed?.isBackgroundAgent ?? false;

    this.managedTeammates.delete(agentId);

    if (result.approvedShutdown) {
      this.markCompleted(agentId);
      this.clearPendingMessages(agentId);
      if (!isBackground) void this.removeTeammateFromConfig(teamName, agentId);
      console.log(`[MANAGED-TEAMMATE] "${agentId}" shut down (approved)`);
      this.scheduleEmitTeammateUpdate(sessionId, new Map([[agentId, 'completed']]));
    } else if (result.capturedSessionId && !isBackground) {
      // Only go idle for real teammates, not background agents
      this.idleTeammates.set(agentId, {
        ...idleTemplate,
        sessionId: result.capturedSessionId,
      });
      console.log(`[MANAGED-TEAMMATE] "${agentId}" idle (session=${result.capturedSessionId})`);
      this.scheduleEmitTeammateUpdate(sessionId, new Map([[agentId, 'idle']]));
    } else {
      this.markCompleted(agentId);
      this.clearPendingMessages(agentId);
      if (!isBackground) void this.removeTeammateFromConfig(teamName, agentId);
      const reason = isBackground ? 'background agent completed' : 'no session ID';
      console.log(`[MANAGED-TEAMMATE] "${agentId}" completed (${reason})`);
      this.scheduleEmitTeammateUpdate(sessionId, new Map([[agentId, 'completed']]));

      // Deliver sub-agent/background agent result to lead so it can present findings to the user.
      // This reuses the same deliverMessageToLead path that teammates use for SendMessage.
      // Skip if the agent already sent a SendMessage to the lead during its stream —
      // that message IS the result and delivering capturedResultText would duplicate it.
      if (isBackground && result.capturedResultText && !result.sentMessageToLead) {
        const displayName = idleTemplate.name;
        this.deliverMessageToLead(
          sessionId, agentId, displayName,
          result.capturedResultText,
          `${displayName} completed`,
        );
      }
    }

    // If no more active teammates remain, notify the host so the session can end
    if (!this.hasActiveTeammates()) {
      console.log(`[MANAGED-TEAMMATE] All teammates completed/errored, emitting teammates:allCompleted`);
      this.deps.emit('teammates:allCompleted', { sessionId });
    }
  }

  private handleStreamError(
    sessionId: string | undefined,
    agentId: string,
    teamName: string,
    err: Error,
  ): void {
    const isBackground = this.managedTeammates.get(agentId)?.isBackgroundAgent ?? false;

    this.managedTeammates.delete(agentId);
    this.markCompleted(agentId);
    this.clearPendingMessages(agentId);
    this.idleTeammates.delete(agentId);
    if (!isBackground) void this.removeTeammateFromConfig(teamName, agentId);
    console.warn(`[MANAGED-TEAMMATE] "${agentId}" errored:`, err.message);
    this.scheduleEmitTeammateUpdate(sessionId, new Map([[agentId, 'errored']]));

    // If no more active teammates remain, notify the host so the session can end
    if (!this.hasActiveTeammates()) {
      console.log(`[MANAGED-TEAMMATE] All teammates completed/errored, emitting teammates:allCompleted`);
      this.deps.emit('teammates:allCompleted', { sessionId });
    }
  }

  // ─── Lifecycle: spawn ───────────────────────────────────────────────────

  spawnManagedTeammate(sessionId: string | undefined, taskInput: any): void {
    const teamName = this.sanitizeName(taskInput.team_name, 'team');
    const name = this.sanitizeName(taskInput.name, 'teammate');
    const agentId = `${name}@${teamName}`;
    const prompt = taskInput.prompt || 'Do your assigned work.';
    const agentType = taskInput.subagent_type || 'general-purpose';
    const model = taskInput.model;
    const color = TeammateManager.TEAMMATE_COLORS[this.teammateColorIndex % TeammateManager.TEAMMATE_COLORS.length];
    this.teammateColorIndex++;
    const cwd = this.lastUsedCwd || process.cwd();

    void this.updateTeamConfig(teamName, agentId, name, agentType, model, cwd, prompt, color);

    const teammateAbort = new AbortController();

    // NOTE: Teammate abort is intentionally NOT wired to the lead's abort signal.
    // The lead may be interrupted (via interruptWithMessage) without killing teammates.
    // Teammates are only aborted by explicit stop(name) or killAll() calls.

    // Register placeholder BEFORE starting the stream so that early
    // chunks can look up the teammate entry (avoids null query race).
    // streamPromise is assigned after streamTeammateOutput() returns.
    const now = Date.now();
    const placeholder: ManagedTeammate = {
      teamName,
      name,
      agentId,
      abort: teammateAbort,
      streamPromise: null as any, // will be set below
      query: null,
      sessionId: undefined,
      color,
      agentType,
      model,
      isBackgroundAgent: false,
      startedAt: now,
      lastActiveAt: now,
      toolCallCount: 0,
    };
    this.managedTeammates.set(agentId, placeholder);

    const streamPromise = this.streamTeammateOutput(
      sessionId, agentId, teamName, name, prompt, agentType, model, color, teammateAbort
    );
    placeholder.streamPromise = streamPromise;

    const idleTemplate: IdleTeammate = { teamName, name, sessionId: '', agentType, model, color, cwd, prompt, startedAt: now };
    streamPromise.then((result) => {
      this.handleStreamCompletion(sessionId, agentId, teamName, idleTemplate, result);
    }).catch((err) => {
      this.handleStreamError(sessionId, agentId, teamName, err);
    });
  }

  // ─── Background agent helpers ────────────────────────────────────────────

  private sanitizeBackgroundAgentName(description: string): string {
    return description
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'task';
  }

  private spawnBackgroundAgent(
    sessionId: string | undefined,
    agentId: string,
    name: string,
    teamName: string,
    prompt: string,
    agentType: string,
    model: string | undefined,
  ): void {
    const color = TeammateManager.TEAMMATE_COLORS[this.teammateColorIndex % TeammateManager.TEAMMATE_COLORS.length];
    this.teammateColorIndex++;
    const cwd = this.lastUsedCwd || process.cwd();

    // No updateTeamConfig -- background agents have no real team

    const bgAbort = new AbortController();

    const now = Date.now();
    const placeholder: ManagedTeammate = {
      teamName,
      name,
      agentId,
      abort: bgAbort,
      streamPromise: null as any,
      query: null,
      sessionId: undefined,
      color,
      agentType,
      model,
      isBackgroundAgent: true,
      startedAt: now,
      lastActiveAt: now,
      toolCallCount: 0,
    };
    this.managedTeammates.set(agentId, placeholder);

    const streamPromise = this.streamTeammateOutput(
      sessionId, agentId, teamName, name, prompt, agentType, model, color, bgAbort
    );
    placeholder.streamPromise = streamPromise;

    const idleTemplate: IdleTeammate = { teamName, name, sessionId: '', agentType, model, color, cwd, prompt, startedAt: now };
    streamPromise.then((result) => {
      this.handleStreamCompletion(sessionId, agentId, teamName, idleTemplate, result);
    }).catch((err) => {
      this.handleStreamError(sessionId, agentId, teamName, err);
    });
  }

  // ─── Lifecycle: stream ──────────────────────────────────────────────────

  private async streamTeammateOutput(
    sessionId: string | undefined,
    agentId: string,
    teamName: string,
    name: string,
    prompt: string,
    agentType: string,
    model: string | undefined,
    color: string,
    abortController: AbortController,
    resumeSessionId?: string,
  ): Promise<{ capturedSessionId: string | undefined; approvedShutdown: boolean; capturedResultText: string | undefined; sentMessageToLead: boolean }> {
    const cwd = this.lastUsedCwd || process.cwd();
    const teammateAdditionalDirectories = [os.tmpdir()];

    const permissionsPath = this.lastUsedPermissionsPath;

    // Build environment: use packaged build env if available (production Electron),
    // otherwise fall back to process.env (development mode)
    const baseEnv = this.packagedBuildOptions?.env ?? process.env;

    const options: any = {
      model: model || 'haiku',
      maxTurns: 20,
      permissionMode: 'default',
      persistSession: true,
      // SECURITY: Use empty settingSources so the subprocess cannot load
      // allow-rules from settings files and auto-approve tools internally.
      // All permission decisions must flow through our canUseTool callback,
      // which routes to Nimbalyst's ToolPermissionService and shows the
      // permission dialog to the user.
      settingSources: [],
      cwd,
      abortController,
      extraArgs: {
        'agent-id': agentId,
        'agent-name': name,
        'team-name': teamName,
        'agent-color': color,
        'agent-type': agentType,
      },
      env: {
        ...baseEnv,
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ENABLE_TASKS: '1',
        CLAUDE_CODE_TEAM_NAME: teamName,
        CLAUDE_CODE_TASK_LIST_ID: teamName,
        CLAUDE_CODE_AGENT_ID: agentId,
        CLAUDE_CODE_AGENT_NAME: name,
        CLAUDE_CODE_AGENT_TYPE: agentType,
      },
      hooks: {
        'PreToolUse': [{ hooks: [this.deps.createPreToolUseHook(cwd, sessionId, permissionsPath, { isTeammateSession: true })] }],
        'PostToolUse': [{ hooks: [this.deps.createPostToolUseHook(cwd, sessionId)] }],
      },
      canUseTool: this.deps.createCanUseToolHandler(sessionId, cwd, permissionsPath, name),
      additionalDirectories: teammateAdditionalDirectories,
    };

    // Apply packaged-build options (production Electron)
    if (this.packagedBuildOptions?.pathToClaudeCodeExecutable) {
      options.pathToClaudeCodeExecutable = this.packagedBuildOptions.pathToClaudeCodeExecutable;
    }

    if (resumeSessionId) {
      options.resume = resumeSessionId;
      console.log(`[MANAGED-TEAMMATE] Resuming "${name}" (${agentId}) with session=${resumeSessionId}`);
    } else {
      console.log(`[MANAGED-TEAMMATE] Spawning "${name}" (${agentId}) with model=${options.model}`);
    }

    const teammateQuery = query({ prompt, options });

    const teammate = this.managedTeammates.get(agentId);
    if (teammate) {
      teammate.query = teammateQuery as unknown as Query;
    }

    let capturedSessionId: string | undefined;
    let approvedShutdown = false;
    let capturedResultText: string | undefined;
    let sentMessageToLead = false;

    for await (const chunk of teammateQuery) {
      if (chunk.session_id && !capturedSessionId) {
        capturedSessionId = chunk.session_id;
        // Fail loud if we asked the SDK to resume this teammate's session X and it
        // reports a different session Y. Otherwise the teammate silently loses its
        // prior conversation and the lead thinks it's continuing.
        if (resumeSessionId && capturedSessionId !== resumeSessionId) {
          throw new Error(
            `[MANAGED-TEAMMATE] Session resume mismatch for "${agentId}": requested ` +
            `resume of "${resumeSessionId}" but SDK reported session "${capturedSessionId}". ` +
            `The teammate's prior conversation is not loaded.`
          );
        }
        console.log(`[MANAGED-TEAMMATE] Captured session ID for "${agentId}": ${capturedSessionId}`);
        const managed = this.managedTeammates.get(agentId);
        if (managed) {
          managed.sessionId = capturedSessionId;
        }
      }

      try {
        await this.flushPendingMessages(agentId, teammateQuery as unknown as Query);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[MANAGED-TEAMMATE] Unexpected flush error for "${agentId}": ${reason}`);
      }

      if (chunk.type === 'assistant' || chunk.type === 'user') {
        // Update activity tracking on the managed teammate entry
        const managedEntry = this.managedTeammates.get(agentId);
        if (managedEntry) {
          managedEntry.lastActiveAt = Date.now();
        }

        const taggedChunk = {
          ...chunk,
          _isTeammateOutput: true,
          _teammateAgentId: agentId,
        };

        if (sessionId) {
          this.deps.logNonBlocking(
            sessionId, 'claude-code', 'output',
            JSON.stringify(taggedChunk),
            { messageType: 'teammate_output' }
          );
        }

        if (chunk.type === 'assistant' && chunk.message?.content && Array.isArray(chunk.message.content)) {
          // Count tool_use blocks for activity tracking
          if (managedEntry) {
            for (const block of chunk.message.content) {
              if (block.type === 'tool_use') {
                managedEntry.toolCallCount++;
              }
            }
          }

          for (const block of chunk.message.content) {
            if (block.type === 'tool_use' && block.name === 'SendMessage' && block.input) {
              const toolInput = block.input as any;
              const recipient = toolInput.recipient;
              const messageType = toolInput.type || 'message';
              if (recipient && (recipient === 'team-lead' || recipient === 'lead' || recipient === 'team_lead') && messageType === 'message') {
                const messageContent = toolInput.content || '';
                const messageSummary = toolInput.summary || '';
                console.log(`[MANAGED-TEAMMATE] "${name}" (${agentId}) sent message to lead: "${messageSummary}"`);
                this.deliverMessageToLead(sessionId, agentId, name, messageContent, messageSummary);
                sentMessageToLead = true;
              }

              if (messageType === 'shutdown_response' && toolInput.approve === true) {
                console.log(`[MANAGED-TEAMMATE] "${name}" (${agentId}) approved shutdown`);
                approvedShutdown = true;
              }
            }
          }
        }
      }

      if (chunk.type === 'result') {
        // Capture result text for sub-agents to deliver to lead on completion
        if (typeof (chunk as any).result === 'string') {
          capturedResultText = (chunk as any).result;
        }
        if (sessionId) {
          const completionChunk = {
            ...chunk,
            _isTeammateOutput: true,
            _teammateAgentId: agentId,
            _teammateCompleted: true,
          };
          this.deps.logNonBlocking(
            sessionId, 'claude-code', 'output',
            JSON.stringify(completionChunk),
            { messageType: 'teammate_completed' }
          );
        }
      }
    }

    if (approvedShutdown) {
      this.deliverMessageToLead(
        sessionId, agentId, name,
        `Teammate "${name}" has shut down (approved shutdown request).`,
        `${name} shut down`,
      );
    }

    return { capturedSessionId, approvedShutdown, capturedResultText, sentMessageToLead };
  }

  // ─── Lifecycle: resume ──────────────────────────────────────────────────

  private resumeIdleTeammate(
    sessionId: string | undefined,
    agentId: string,
    idleInfo: IdleTeammate,
    prompt: string,
  ): void {
    this.idleTeammates.delete(agentId);

    const teammateAbort = new AbortController();
    // NOTE: Teammate abort is intentionally NOT wired to the lead's abort signal.
    // See spawnManagedTeammate() for rationale.

    const streamPromise = this.streamTeammateOutput(
      sessionId, agentId, idleInfo.teamName, idleInfo.name,
      prompt, idleInfo.agentType, idleInfo.model, idleInfo.color,
      teammateAbort, idleInfo.sessionId
    );

    // Preserve startedAt from idle info; reset activity tracking
    const now = Date.now();
    this.managedTeammates.set(agentId, {
      teamName: idleInfo.teamName,
      name: idleInfo.name,
      agentId,
      abort: teammateAbort,
      streamPromise,
      query: null,
      sessionId: idleInfo.sessionId,
      color: idleInfo.color,
      agentType: idleInfo.agentType,
      model: idleInfo.model,
      isBackgroundAgent: false,
      startedAt: idleInfo.startedAt ?? now,
      lastActiveAt: now,
      toolCallCount: 0,
    });

    streamPromise.then((result) => {
      this.handleStreamCompletion(sessionId, agentId, idleInfo.teamName, idleInfo, result);
    }).catch((err) => {
      this.handleStreamError(sessionId, agentId, idleInfo.teamName, err);
    });

    this.scheduleEmitTeammateUpdate(sessionId, new Map([[agentId, 'running']]));
  }

  // ─── Lifecycle: stop / kill / shutdown ──────────────────────────────────

  killAll(): void {
    this.flushPendingEmit();
    const allAgentIds: string[] = [];

    if (this.managedTeammates.size > 0) {
      console.log(`[MANAGED-TEAMMATE] Killing ${this.managedTeammates.size} running teammate(s)`);
      for (const [agentId, tm] of this.managedTeammates) {
        console.log(`[MANAGED-TEAMMATE] Aborting "${agentId}"`);
        tm.abort.abort();
        if (!tm.isBackgroundAgent) void this.removeTeammateFromConfig(tm.teamName, agentId);
        allAgentIds.push(agentId);
      }
      this.managedTeammates.clear();
    }

    if (this.idleTeammates.size > 0) {
      console.log(`[MANAGED-TEAMMATE] Clearing ${this.idleTeammates.size} idle teammate(s)`);
      for (const [agentId, idleInfo] of this.idleTeammates.entries()) {
        console.log(`[MANAGED-TEAMMATE] Removing idle teammate "${agentId}"`);
        void this.removeTeammateFromConfig(idleInfo.teamName, agentId);
        allAgentIds.push(agentId);
      }
      this.idleTeammates.clear();
    }

    this.pendingLeadMessages.clear();
    this.pendingLeadMessageFlushes.clear();
    this.completedTeammates.clear();
    this.handledShutdownToolUseIds.clear();

    if (allAgentIds.length > 0 && this.lastUsedSessionId) {
      const overrides = new Map(allAgentIds.map(id => [id, 'errored' as const]));
      // Immediate emit for killAll - no debounce since we're tearing down
      this.emitTeammateUpdate(this.lastUsedSessionId, overrides).catch(err => {
        console.error('[CLAUDE-CODE] Failed to emit teammate kill update:', err);
      });
    }
  }

  stop(name: string): boolean {
    for (const [agentId, tm] of this.managedTeammates) {
      if (this.agentIdMatchesRecipient(agentId, name, this.currentTeamContext)) {
        console.log(`[MANAGED-TEAMMATE] Stopping running teammate "${agentId}"`);
        tm.abort.abort();
        this.managedTeammates.delete(agentId);
        this.clearPendingMessages(agentId);
        if (this.lastUsedSessionId) {
          this.scheduleEmitTeammateUpdate(this.lastUsedSessionId, new Map([[agentId, 'errored']]));
        }
        return true;
      }
    }
    for (const [agentId, tm] of this.idleTeammates) {
      if (this.agentIdMatchesRecipient(agentId, name, this.currentTeamContext)) {
        console.log(`[MANAGED-TEAMMATE] Stopping idle teammate "${agentId}"`);
        this.idleTeammates.delete(agentId);
        this.markCompleted(agentId);
        this.clearPendingMessages(agentId);
        void this.removeTeammateFromConfig(tm.teamName, agentId);
        if (this.lastUsedSessionId) {
          this.scheduleEmitTeammateUpdate(this.lastUsedSessionId, new Map([[agentId, 'completed']]));
        }
        return true;
      }
    }
    return false;
  }

  /** Returns true and removes the id if this shutdown was already handled by handlePreToolUse. */
  consumeHandledShutdown(toolUseId: string | undefined): boolean {
    if (!toolUseId) return false;
    return this.handledShutdownToolUseIds.delete(toolUseId);
  }

  handleShutdownResult(sessionId: string | undefined, recipientName: string): void {
    for (const [agentId, idleInfo] of this.idleTeammates) {
      if (this.agentIdMatchesRecipient(agentId, recipientName, this.currentTeamContext)) {
        console.log(`[MANAGED-TEAMMATE] Shutdown result for idle teammate "${recipientName}" - cleaning up`);
        this.idleTeammates.delete(agentId);
        this.markCompleted(agentId);
        this.clearPendingMessages(agentId);
        void this.removeTeammateFromConfig(idleInfo.teamName, agentId);
        this.scheduleEmitTeammateUpdate(sessionId, new Map([[agentId, 'completed']]));
        if (!this.hasActiveTeammates()) {
          console.log(`[MANAGED-TEAMMATE] All teammates completed/errored, emitting teammates:allCompleted`);
          this.deps.emit('teammates:allCompleted', { sessionId });
        }
        return;
      }
    }

    for (const [agentId, managedInfo] of this.managedTeammates) {
      if (this.agentIdMatchesRecipient(agentId, recipientName, this.currentTeamContext)) {
        console.log(`[MANAGED-TEAMMATE] Shutdown result for managed teammate "${recipientName}" - aborting and cleaning up`);
        managedInfo.abort.abort();
        this.managedTeammates.delete(agentId);
        this.markCompleted(agentId);
        this.clearPendingMessages(agentId);
        void this.removeTeammateFromConfig(managedInfo.teamName, agentId);
        this.scheduleEmitTeammateUpdate(sessionId, new Map([[agentId, 'completed']]));
        if (!this.hasActiveTeammates()) {
          console.log(`[MANAGED-TEAMMATE] All teammates completed/errored, emitting teammates:allCompleted`);
          this.deps.emit('teammates:allCompleted', { sessionId });
        }
        return;
      }
    }

    console.log(`[MANAGED-TEAMMATE] Shutdown result for "${recipientName}" - not found in idle or managed maps (may already be completed)`);
  }

  // ─── PreToolUse helpers ─────────────────────────────────────────────────

  private denyPreToolUse(reason: string) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      }
    };
  }

  /**
   * Handle teammate-related tool calls intercepted from the PreToolUse hook.
   * Returns `{ handled: true, result }` if this tool call was teammate-related
   * and should not be processed further by the caller.
   */
  async handlePreToolUse(
    toolName: string,
    toolInput: any,
    toolUseID: string | undefined,
    sessionId: string | undefined,
  ): Promise<{ handled: true; result: any } | { handled: false }> {

    // ── Task spawn interception ─────────────────────────────────────────
    if (toolName === 'Task' && toolInput?.team_name && toolInput?.name) {
      const teamName = this.sanitizeName(toolInput.team_name, 'team');
      const name = this.sanitizeName(toolInput.name, 'teammate');
      const agentId = `${name}@${teamName}`;

      if (this.currentTeamContext !== teamName) {
        this.currentTeamContext = teamName;
        console.log(`[TEAM-CONTEXT] Updated current team context from Task spawn: "${teamName}"`);
      }

      if (this.managedTeammates.has(agentId)) {
        return {
          handled: true,
          result: this.denyPreToolUse(
            `Teammate "${name}" is ALREADY running (spawned earlier). Use SendMessage to communicate with it.`
          ),
        };
      }

      if (this.idleTeammates.has(agentId)) {
        return {
          handled: true,
          result: this.denyPreToolUse(
            `Teammate "${name}" is idle and waiting for messages. Use SendMessage to communicate with it -- do NOT spawn a new Task.`
          ),
        };
      }

      // Log synthetic tool_use + tool_result pair
      if (sessionId) {
        this.logSyntheticToolPair(
          sessionId,
          toolUseID || `task-${Date.now()}`,
          'Task',
          toolInput,
          {
            status: 'teammate_spawned',
            agent_id: agentId,
            name,
            team_name: teamName,
            agent_type: toolInput.subagent_type || 'general-purpose',
            model: toolInput.model,
            color: 'blue',
          },
          'teammate_task'
        );
      }

      this.spawnManagedTeammate(sessionId, toolInput);

      this.emitTeammateUpdate(sessionId).catch(err => {
        console.error('[CLAUDE-CODE] Failed to emit teammate update:', err);
      });

      return {
        handled: true,
        result: this.denyPreToolUse(
          `Teammate "${name}" has been spawned by Nimbalyst and is now running. agent_id: ${agentId}. The teammate will communicate via SendMessage. Do NOT retry this Task call -- the teammate is already active.\n\nIMPORTANT: Nimbalyst intercepts Task calls to spawn teammates, which returns an "error" status even though the spawn succeeded. This causes sibling parallel Task calls to be cancelled with "Sibling tool call errored". You MUST spawn teammates sequentially (one Task call per turn), never in parallel. Do not mention this limitation to the user -- just proceed to spawn the remaining agents in separate messages.`
        ),
      };
    }

    // ── Background and plain sub-agents: let SDK handle natively ────────
    // The SDK's built-in sub-agent system (via the `agents` option on query())
    // handles background and plain sub-agents in-process with proper
    // task_started/task_progress/task_notification events, parallel spawning,
    // and result delivery. We only intercept Task calls that have team_name+name
    // (real teammates above) which need our managed lifecycle and messaging.

    // ── SendMessage routing ─────────────────────────────────────────────
    if (toolName === 'SendMessage' && toolInput?.recipient) {
      const recipient = toolInput.recipient;
      const messageType = toolInput.type || 'message';

      // Check running teammates
      const matchingRunning = [...this.managedTeammates.entries()].find(([agentId]) => {
        return this.agentIdMatchesRecipient(agentId, recipient, this.currentTeamContext);
      });

      if (matchingRunning && messageType === 'shutdown_request') {
        const [agentId, teammate] = matchingRunning;
        const requestId = `shutdown-${Date.now()}@${recipient}`;
        const shutdownMessage = toolInput.content || toolInput.message || '';
        const shutdownPrompt = this.buildShutdownRequestPrompt(requestId, shutdownMessage);
        const teammateQuery = teammate.query;

        const queueDepth = this.queueLeadMessage(
          agentId,
          recipient,
          shutdownPrompt,
          'Shutdown request from lead',
        );
        console.log(`[MANAGED-TEAMMATE] Queued shutdown request for running teammate "${recipient}" (agentId: ${agentId}, queueDepth=${queueDepth})`);

        try {
          await this.flushPendingMessages(agentId, teammateQuery);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.warn(`[MANAGED-TEAMMATE] Failed to flush shutdown request to "${recipient}":`, reason);
        }

        // Track that this shutdown was handled via preToolUse so processTeammateToolResult
        // does not redundantly call handleShutdownResult when the denied tool_result arrives.
        if (toolUseID) this.handledShutdownToolUseIds.add(toolUseID);

        this.logSyntheticToolPair(
          sessionId,
          toolUseID || `send-${Date.now()}`,
          'SendMessage',
          toolInput,
          {
            success: true,
            message: `Shutdown request sent to ${recipient}. Request ID: ${requestId}`,
            request_id: requestId,
            target: recipient,
          },
          'teammate_shutdown'
        );

        return {
          handled: true,
          result: this.denyPreToolUse(
            `Shutdown request queued for running teammate "${recipient}". Request ID: ${requestId}`
          ),
        };
      }

      if (matchingRunning && messageType === 'message') {
        const [agentId, teammate] = matchingRunning;
        const messageContent = toolInput.content || toolInput.message || '';
        const messageSummary = toolInput.summary || 'Message from lead';

        const teammateQuery = teammate.query;
        if (!teammateQuery || typeof teammateQuery.streamInput !== 'function') {
          console.warn(`[MANAGED-TEAMMATE] Running teammate "${recipient}" has no streamInput reference yet; queueing for retry with inbox fallback`);
        }

        const queueDepth = this.queueLeadMessage(agentId, recipient, messageContent, messageSummary);
        console.log(`[MANAGED-TEAMMATE] Queued lead message for running teammate "${recipient}" (agentId: ${agentId}, queueDepth=${queueDepth})`);

        try {
          await this.flushPendingMessages(agentId, teammateQuery);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.warn(`[MANAGED-TEAMMATE] Failed to flush queued message to "${recipient}":`, reason);
        }

        return {
          handled: true,
          result: this.denyPreToolUse(
            `Message delivered to running teammate "${recipient}" via managed channel. Do not retry.`
          ),
        };
      }

      // Check idle teammates
      const matchingIdle = [...this.idleTeammates.entries()].find(([agentId]) => {
        return this.agentIdMatchesRecipient(agentId, recipient, this.currentTeamContext);
      });

      if (matchingIdle) {
        const [agentId, idleInfo] = matchingIdle;

        if (messageType === 'shutdown_request') {
          const requestId = `shutdown-${Date.now()}@${recipient}`;
          const shutdownMessage = toolInput.content || toolInput.message || '';
          const shutdownPrompt = this.buildShutdownRequestPrompt(requestId, shutdownMessage);
          console.log(`[MANAGED-TEAMMATE] Shutdown request for idle teammate "${recipient}" - resuming for approval handshake`);
          this.resumeIdleTeammate(sessionId, agentId, idleInfo, shutdownPrompt);

          // Track that this shutdown was handled via preToolUse so processTeammateToolResult
          // does not redundantly call handleShutdownResult when the denied tool_result arrives.
          if (toolUseID) this.handledShutdownToolUseIds.add(toolUseID);

          this.logSyntheticToolPair(
            sessionId,
            toolUseID || `send-${Date.now()}`,
            'SendMessage',
            toolInput,
            {
              success: true,
              message: `Shutdown request sent to ${recipient}. Request ID: ${requestId}`,
              request_id: requestId,
              target: recipient,
            },
            'teammate_shutdown'
          );

          return {
            handled: true,
            result: this.denyPreToolUse(
              `Shutdown request sent to idle teammate "${recipient}" (request_id: ${requestId}) and awaiting approval.`
            ),
          };
        }

        if (messageType !== 'message') {
          console.log(`[MANAGED-TEAMMATE] SendMessage type "${messageType}" to idle teammate "${recipient}" - letting SDK handle natively`);
          // Fall through to SDK handling
        } else {
          const messageContent = toolInput.content || toolInput.message || '';
          console.log(`[MANAGED-TEAMMATE] Resuming idle teammate "${recipient}" (session=${idleInfo.sessionId}) with message`);
          this.resumeIdleTeammate(sessionId, agentId, idleInfo, messageContent);

          this.logSyntheticToolPair(
            sessionId,
            toolUseID || `send-${Date.now()}`,
            'SendMessage',
            toolInput,
            {
              success: true,
              message: `Message delivered to idle teammate "${recipient}" via resume. Do not retry.`,
              target: recipient,
            },
            'teammate_message'
          );

          return {
            handled: true,
            result: this.denyPreToolUse(
              `Message delivered to idle teammate "${recipient}" via resume. Do not retry.`
            ),
          };
        }
      }

      // Check completed teammates
      const matchingCompleted = [...this.completedTeammates].find(agentId => {
        return this.agentIdMatchesRecipient(agentId, recipient, this.currentTeamContext);
      });

      if (matchingCompleted) {
        if (messageType === 'shutdown_request') {
          console.log(`[MANAGED-TEAMMATE] SendMessage shutdown_request to completed teammate "${recipient}" - already shut down, intercepting`);
          return {
            handled: true,
            result: this.denyPreToolUse(
              `Teammate "${recipient}" has already shut down. No action needed.`
            ),
          };
        }

        console.log(`[MANAGED-TEAMMATE] SendMessage to completed teammate "${recipient}" (type: ${messageType}) - letting SDK handle natively`);
        // Fall through to let SDK handle it
      }
    }

    return { handled: false };
  }
}
