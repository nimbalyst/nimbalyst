import path from 'node:path';

/**
 * Cross-provider record of which agent tools are executing, so inferred file
 * attribution (Codex shell windows, the workspace watcher matcher) can tell a
 * concurrent session that is idle or reading apart from one that may be
 * writing. Providers report from pre-execution hooks where they have them.
 *
 * A session that never declared itself is uninstrumented: callers must treat
 * it as a possible writer. A declared session with no overlapping
 * write-capable window did not write the file through a reported tool.
 */

/** Tools that never change workspace files themselves. Subagent spawns are
 * listed because the subagent's own tool calls report through the same hooks. */
const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite',
  'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'BashOutput', 'TaskOutput',
  'KillShell', 'ToolSearch', 'Skill', 'Task', 'Agent',
  'ListMcpResourcesTool', 'ReadMcpResourceTool',
]);
const PATH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export type ToolWriteEffect =
  | { kind: 'none' }
  | { kind: 'paths'; paths: string[] }
  | { kind: 'unknown'; detached: boolean };

/** What a tool call can do to workspace files, from its name and input alone.
 * `unknown` means any file: a shell command, an MCP tool, or an unrecognized tool. */
export function toolWriteEffect(toolName: string, input: unknown, workspacePath: string): ToolWriteEffect {
  if (READ_ONLY_TOOLS.has(toolName)) return { kind: 'none' };
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (PATH_TOOLS.has(toolName)) {
    const raw = [args.file_path, args.notebook_path].filter((p): p is string => typeof p === 'string' && p.length > 0);
    // A path tool whose target we cannot read is no better than a shell command.
    if (raw.length === 0) return { kind: 'unknown', detached: false };
    return { kind: 'paths', paths: raw.map(p => path.resolve(workspacePath, p)) };
  }
  // A backgrounded command keeps running after its acknowledgement.
  return { kind: 'unknown', detached: toolName === 'Bash' && args.run_in_background === true };
}

/** How long after a tool ends a watcher event may still belong to it. */
const UNKNOWN_TAIL_MS = 2_000;
const PATH_TAIL_MS = 5_000;
/** Start-time slack for providers that only see a tool after it may have begun. */
const APPROXIMATE_LEAD_MS = 2_000;
/** Closed windows are kept this long for queued, late-evaluated events. */
const RETAIN_CLOSED_MS = 60_000;
/** An open window older than this lost its end signal; stop treating it as live. */
const OPEN_EXPIRY_MS = 2 * 60 * 60_000;
const MAX_WINDOWS_PER_SESSION = 256;

interface ToolWindow {
  toolUseId: string;
  effect: Exclude<ToolWriteEffect, { kind: 'none' }>;
  startedAt: number;
  endedAt?: number;
  lead: number;
}
interface SessionActivity {
  workspacePath: string;
  windows: Map<string, ToolWindow>;
}

export type OtherWriterEvidence =
  /** Not instrumented: may have written anything. */
  | 'unknown'
  /** An overlapping path tool (Edit, Write) named this file. */
  | 'edited'
  /** An overlapping tool that may write unknown paths (Bash, MCP). */
  | 'possible'
  /** Reported tools did not overlap a write to this file. */
  | 'idle';

function contains(workspace: string, file: string): boolean {
  const rel = path.relative(workspace, file);
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

export class AgentToolActivityRegistry {
  private readonly sessions = new Map<string, SessionActivity>();
  constructor(private readonly now: () => number = Date.now) {}

  /** The session reports every tool call before it executes. */
  declare(sessionId: string, workspacePath: string): void {
    const workspace = path.resolve(workspacePath);
    const existing = this.sessions.get(sessionId);
    if (existing) existing.workspacePath = workspace;
    else this.sessions.set(sessionId, { workspacePath: workspace, windows: new Map() });
  }

  isDeclared(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Record a tool start. `approximate` marks a start observed after the tool
   * may already have begun (a stream message rather than a pre-execution hook).
   */
  started(sessionId: string, toolUseId: string | undefined, toolName: string, input: unknown, options: { approximate?: boolean } = {}): void {
    const session = this.sessions.get(sessionId);
    if (!session || !toolUseId || session.windows.has(toolUseId)) return;
    const effect = toolWriteEffect(toolName, input, session.workspacePath);
    if (effect.kind === 'none') return;
    this.prune(session);
    if (session.windows.size >= MAX_WINDOWS_PER_SESSION) {
      const oldestClosed = [...session.windows.values()].find(w => w.endedAt !== undefined);
      // Every window is open: dropping one would hide a live writer.
      if (!oldestClosed) return;
      session.windows.delete(oldestClosed.toolUseId);
    }
    session.windows.set(toolUseId, {
      toolUseId,
      effect,
      startedAt: this.now(),
      lead: options.approximate ? APPROXIMATE_LEAD_MS : 0,
    });
  }

  /** Record a tool end. A backgrounded command stays open until its turn ends. */
  finished(sessionId: string, toolUseId: string | undefined): void {
    const window = toolUseId ? this.sessions.get(sessionId)?.windows.get(toolUseId) : undefined;
    if (!window || window.endedAt !== undefined) return;
    if (window.effect.kind === 'unknown' && window.effect.detached) return;
    window.endedAt = this.now();
  }

  /** The turn and any background work it drained are over. */
  endTurn(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const at = this.now();
    for (const window of session.windows.values()) window.endedAt ??= at;
  }

  /** Declared sessions with a write-capable window near `at` for a file in their workspace. */
  activeSessions(filePath: string, at: number): string[] {
    const file = path.resolve(filePath);
    return [...this.sessions].filter(([, session]) =>
      contains(session.workspacePath, file) &&
      [...session.windows.values()].some(w => this.overlaps(w, at, PATH_TAIL_MS))
    ).map(([id]) => id);
  }

  /** What `sessionId`'s reported tools say about a change to `filePath` observed at `at`. */
  writerEvidence(sessionId: string, filePath: string, at: number): OtherWriterEvidence {
    const session = this.sessions.get(sessionId);
    if (!session) return 'unknown';
    const file = path.resolve(filePath);
    let possible = false;
    for (const window of session.windows.values()) {
      if (window.effect.kind === 'paths') {
        if (window.effect.paths.includes(file) && this.overlaps(window, at, PATH_TAIL_MS)) return 'edited';
      } else if (this.overlaps(window, at, UNKNOWN_TAIL_MS)) possible = true;
    }
    return possible ? 'possible' : 'idle';
  }

  private overlaps(window: ToolWindow, at: number, tail: number): boolean {
    if (at < window.startedAt - window.lead) return false;
    if (window.endedAt === undefined) return this.now() - window.startedAt <= OPEN_EXPIRY_MS;
    return at <= window.endedAt + tail;
  }

  private prune(session: SessionActivity): void {
    const now = this.now();
    for (const [id, window] of session.windows)
      if (window.endedAt !== undefined ? now - window.endedAt > RETAIN_CLOSED_MS : now - window.startedAt > OPEN_EXPIRY_MS)
        session.windows.delete(id);
  }
}

export const agentToolActivity = new AgentToolActivityRegistry();
