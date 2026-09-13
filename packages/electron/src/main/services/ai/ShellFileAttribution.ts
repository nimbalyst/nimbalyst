import path from 'node:path';
import { randomUUID } from 'node:crypto';
export interface ShellFileState {
  fingerprint: string;
  modifiedAt: number;
}
export interface ShellFileEvidence {
  sessionId: string;
  workspacePath: string;
  filePath: string;
  toolUseId: string;
  timestamp: number;
  source: 'shell-hook-inferred';
}
export interface ShellAttributionDependencies {
  subscribe(workspace: string, changed: (file: string) => void): Promise<() => void>;
  read(file: string): Promise<ShellFileState | null>;
  knownWrite(file: string, state: ShellFileState | null): boolean;
  otherSessions(workspace: string, filePath: string): string[];
  persist(evidence: ShellFileEvidence): Promise<void>;
  now?: () => number;
  settleMs?: number;
}
export class ShellFileAttribution {
  private readonly sessions = new Map<string, { sessionId: string; workspace: string }>();
  private readonly workspaces = new Map<string, Promise<() => void>>();
  private readonly windows = new Map<
    string,
    { generation: string; id: string; tool: string; start: number; files: Set<string> }
  >();
  private readonly cache = new Map<string, string | null>();
  private readonly stats = { ambiguous: 0, suppressed: 0, overflow: 0 };
  private readonly disabled = new Set<string>();
  private pending = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  constructor(private readonly deps: ShellAttributionDependencies) {
    this.now = deps.now ?? Date.now;
  }

  async register(sessionId: string, workspacePath: string): Promise<string> {
    const workspace = path.resolve(workspacePath),
      generation = randomUUID();
    this.sessions.set(generation, { sessionId, workspace });
    if (!this.workspaces.has(workspace))
      this.workspaces.set(
        workspace,
        this.deps.subscribe(workspace, (file) => this.changed(workspace, file))
      );
    try {
      await this.workspaces.get(workspace);
    } catch (error) {
      this.sessions.delete(generation);
      this.workspaces.delete(workspace);
      throw error;
    }
    return generation;
  }
  async pre(generation: string, id: string, tool: string): Promise<void> {
    await this.flush();
    if (!this.sessions.has(generation) || !id || id.length > 256) return;
    // A bounded per-generation registry. Missing post hooks never grow it
    // without limit; at the cap tracking abstains until lifecycle cleanup.
    if (this.windows.size >= 256) {
      this.stats.overflow++;
      this.disabled.add(generation);
      return;
    }
    const key = generation + '|' + id;
    if (!this.windows.has(key))
      this.windows.set(key, { generation, id, tool, start: this.now(), files: new Set() });
  }
  async post(generation: string, id: string): Promise<void> {
    // Shared bus delivery includes atomic-write/debounce delays on Linux.
    // Keep the window open while draining; this is inference, not an OS barrier.
    if (!this.windows.has(generation + '|' + id)) return;
    await new Promise((r) => setTimeout(r, this.deps.settleMs ?? 150));
    await this.flush();
    this.windows.delete(generation + '|' + id);
  }
  async flush(): Promise<void> {
    await this.queue;
  }
  endTurn(generation: string): void {
    this.disabled.delete(generation);
    for (const [key, w] of this.windows) if (w.generation === generation) this.windows.delete(key);
  }
  async release(generation: string): Promise<void> {
    const s = this.sessions.get(generation);
    this.sessions.delete(generation);
    this.disabled.delete(generation);
    for (const [key, w] of this.windows) if (w.generation === generation) this.windows.delete(key);
    await this.flush();
    if (s && ![...this.sessions.values()].some((x) => x.workspace === s.workspace)) {
      const release = await this.workspaces.get(s.workspace);
      release?.();
      this.workspaces.delete(s.workspace);
      for (const file of this.cache.keys()) if (this.contains(s.workspace, file)) this.cache.delete(file);
    }
  }
  getStats() {
    return {
      ...this.stats,
      pending: this.pending,
      activeWindows: this.windows.size,
      cachedFiles: this.cache.size,
    };
  }
  private contains(workspace: string, file: string): boolean {
    const rel = path.relative(workspace, file);
    return !!rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
  }
  private changed(workspace: string, rawPath: string): void {
    const filePath = path.resolve(rawPath);
    if (!this.contains(workspace, filePath)) return;
    if (this.pending >= 500) {
      this.stats.overflow++;
      for (const [generation, s] of this.sessions)
        if (this.contains(s.workspace, filePath)) this.disabled.add(generation);
      return;
    }
    const timestamp = this.now();
    // Freeze the candidates now: a later post hook must not turn an overlap
    // into a single-owner event while the filesystem read waits in the queue.
    const candidates = [...this.windows.values()]
      .filter((w) => {
        const s = this.sessions.get(w.generation);
        return s && this.contains(s.workspace, filePath);
      })
      .map((w) => ({ ...w, sessionId: this.sessions.get(w.generation)!.sessionId }));
    // Idle cached providers must not hash every workspace event. Invalidate a
    // known baseline so a later command cannot inherit an unobserved change.
    if (candidates.length === 0) {
      this.cache.delete(filePath);
      return;
    }
    const disabledAtArrival = [...this.disabled].some((g) => {
      const s = this.sessions.get(g);
      return s && this.contains(s.workspace, filePath);
    });
    const registered = new Set(
      [...this.sessions.values()].filter((s) => this.contains(s.workspace, filePath)).map((s) => s.sessionId)
    );
    const hasUninstrumentedSession = this.deps
      .otherSessions(workspace, filePath)
      .some((id) => !registered.has(id));
    this.pending++;
    this.queue = this.queue
      .then(async () => {
        const state = await this.deps.read(filePath),
          fingerprint = state?.fingerprint ?? null;
        const cached = this.cache.get(filePath);
        this.cache.delete(filePath);
        this.cache.set(filePath, fingerprint);
        if (this.cache.size > 2048) this.cache.delete(this.cache.keys().next().value!);
        if (cached !== undefined && cached === fingerprint) return;
        if (this.deps.knownWrite(filePath, state)) {
          this.stats.suppressed++;
          return;
        }
        if (candidates.length === 0) return;
        const owners = new Set(candidates.map((w) => w.sessionId));
        if (
          hasUninstrumentedSession ||
          disabledAtArrival ||
          owners.size !== 1 ||
          candidates.some((w) => w.tool !== 'Bash' || this.disabled.has(w.generation))
        ) {
          this.stats.ambiguous++;
          return;
        }
        const winner = candidates.find((w) => this.sessions.has(w.generation));
        if (!winner) return;
        // A metadata-only notification for an old file is not a new edit. An
        // uncached disappearance might be a directory; only known files qualify.
        if (state && state.modifiedAt <= winner.start) return;
        if (!state && (cached === undefined || cached === null)) return;
        if (winner.files.has(filePath)) return;
        const session = this.sessions.get(winner.generation);
        if (!session) return;
        if (winner.files.size >= 500) {
          this.stats.overflow++;
          this.disabled.add(winner.generation);
          return;
        }
        winner.files.add(filePath);
        await this.deps.persist({
          sessionId: session.sessionId,
          workspacePath: session.workspace,
          filePath,
          toolUseId: winner.id,
          timestamp,
          source: 'shell-hook-inferred',
        });
      })
      .catch(() => {
        this.stats.suppressed++;
      })
      .finally(() => {
        this.pending--;
      });
  }
}
