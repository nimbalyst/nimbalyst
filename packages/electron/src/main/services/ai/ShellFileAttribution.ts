import type { ShellCoverageReason } from '@nimbalyst/runtime/ai/shellTrackingCoverage';
import type { CodexShellToolKind } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/shellTracking';
import type { ShellCheckoutBaseline } from './ShellCheckoutBaseline';
import { SHELL_BASELINE_CAPTURE_MS } from './ShellContentBaseline';
import { boundedDrain, type ShellHookDiagnostics } from './ShellTrackingCoverage';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractFilePathsFromCommand } from './extractFilePathsFromCommand';
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
export type ShellPersistenceOutcome = 'persisted' | 'excluded' | 'throttled' | 'quota' | 'failed';
export class ExcludedShellCandidate extends Error {}
export interface ShellHookIdentity { sessionId?: string; turnId?: string; agentType?: string }
export interface ShellAttributionDependencies {
  subscribe(workspace: string, changed: (file: string, observedAt?: number) => void): Promise<() => void>;
  prepareCheckout?(workspace: string): Promise<ShellCheckoutBaseline | undefined>;
  drainEvents?(workspace: string): Promise<void>;
  activity?(generation: string, id: string, active: boolean): Promise<void>;
  observation?(generation: string, healthy: boolean): void;
  read(file: string): Promise<ShellFileState | null>;
  knownWrite(file: string, state: ShellFileState | null): boolean;
  otherSessions(workspace: string, filePath: string): string[];
  persist(evidence: ShellFileEvidence): Promise<ShellPersistenceOutcome>;
  report?(generation: string, reason: ShellCoverageReason, turnId?: string, toolUseId?: string, hook?: ShellHookDiagnostics): void;
  currentTurn?(generation: string): string | undefined;
  retryDelayMs?: number;
  now?: () => number;
  settleMs?: number;
  /** How long a pre-hook waits for earlier windows to retire before this command abstains alone. */
  preDrainMs?: number;
}
const mayWriteFiles = (tool: string) => tool === 'Bash' || tool === 'apply_patch' || tool === 'Uninstrumented';
const baselineFailure = (hook: ShellHookDiagnostics | undefined, site: string, error: unknown): ShellHookDiagnostics =>
  ({ ...hook, error: `${site}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) });
export class ShellFileAttribution {
  private readonly sessions = new Map<string, { sessionId: string; workspace: string }>();
  private readonly workspaces = new Map<string, Promise<() => void>>();
  private readonly windows = new Map<
    string,
    {
      generation: string;
      id: string;
      tool: string;
      command?: string;
      start: number;
      files: Set<string>;
      observation: { lost: boolean; events?: boolean };
      hook?: ShellHookDiagnostics;
      checkout?: ShellCheckoutBaseline;
      deferred: Map<string, { evidence: ShellFileEvidence; fingerprint: string | null; turnId?: string; ambiguity?: ShellCoverageReason }>;
    }
  >();
  private readonly terminal = new Map<string, Set<string>>();
  private readonly observed = new Map<string, Set<string>>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly cache = new Map<string, string | null>();
  private readonly stats = { ambiguous: 0, suppressed: 0, overflow: 0 };
  private readonly disabled = new Set<string>();
  private readonly unhealthy = new Set<string>();
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
    this.terminal.set(generation, new Set());
    this.observed.set(generation, new Set());
    if (!this.workspaces.has(workspace))
      this.workspaces.set(
        workspace,
        this.deps.subscribe(workspace, (file, observedAt) => this.changed(workspace, file, observedAt))
      );
    try {
      await this.workspaces.get(workspace);
    } catch (error) {
      this.sessions.delete(generation);
      this.terminal.delete(generation);
      this.observed.delete(generation);
      this.workspaces.delete(workspace);
      throw error;
    }
    return generation;
  }
  async pre(generation: string, id: string, tool: string, identity: ShellHookIdentity = {}, command?: string): Promise<void> {
    if (!this.sessions.has(generation) || !id || id.length > 256) return;
    const hook = this.hookDiagnostics(generation, tool, identity);
    if (this.foreignHook(generation, id, hook)) return;
    // Terminal app-server notifications do not wait for our watcher drain.
    // Finish retiring those tools before allowing another command to execute.
    // If a large burst is still being hashed when the budget expires, only this
    // command abstains: disabling the whole turn turned one slow build into a
    // missing-edits warning for every command that followed it.
    const drained = await this.drain([this.sessions.get(generation)?.sessionId ?? ''], this.deps.preDrainMs ?? 1500);
    if (!this.sessions.has(generation) || !id || id.length > 256) return;
    if (this.terminal.get(generation)?.has(id)) {
      this.report(generation, 'staleEvent', undefined, id, hook);
      return;
    }
    // A bounded per-generation registry. Missing post hooks never grow it
    // without limit; at the cap tracking abstains until lifecycle cleanup.
    if (this.windows.size >= 256) {
      this.stats.overflow++;
      this.report(generation, 'overflow');
      this.disabled.add(generation);
      return;
    }
    let checkout: ShellCheckoutBaseline | undefined;
    let captureFailure: ShellHookDiagnostics | undefined;
    const captured = tool !== 'Bash' || !drained || await boundedDrain(
      Promise.resolve().then(() => this.deps.prepareCheckout?.(this.sessions.get(generation)!.workspace))
        .then(value => { checkout = value; }, error => { captureFailure = baselineFailure(hook, 'capture failed', error); throw error; }),
      SHELL_BASELINE_CAPTURE_MS);
    if (!this.sessions.has(generation) || this.terminal.get(generation)?.has(id)) return;
    // A baseline read can outlive the turn that admitted the hook. Preserve the
    // arrival diagnostics, but recheck ownership before installing its window.
    if (identity.turnId !== undefined && identity.turnId !== this.deps.currentTurn?.(generation)) {
      this.report(generation, 'foreignTool', undefined, id, hook);
      return;
    }
    if (!captured) this.report(generation, 'checkoutBaseline', undefined, id,
      captureFailure ?? baselineFailure(hook, 'capture timeout', `${SHELL_BASELINE_CAPTURE_MS} ms budget exceeded`));
    if (this.unhealthy.has(this.sessions.get(generation)!.workspace)) this.report(generation, 'watcherLoss');
    this.observed.get(generation)?.add(id);
    const key = generation + '|' + id;
    if (!this.windows.has(key) || ['Uninstrumented', 'MCP'].includes(this.windows.get(key)!.tool))
      this.windows.set(key, {
        generation,
        id,
        tool,
        command,
        hook,
        start: this.now(),
        files: new Set(),
        // Missing capture evidence abstains for this command, including every
        // known worktree root; never fall back to cold-cache inferred links.
        observation: { lost: !drained || !captured || this.unhealthy.has(this.sessions.get(generation)!.workspace) },
        checkout,
        deferred: new Map(),
      });
    await this.activity(generation, id, mayWriteFiles(tool));
  }
  private async activity(generation: string, id: string, active: boolean): Promise<void> {
    try { await this.deps.activity?.(generation, id, active); }
    catch { this.disabled.add(generation); this.report(generation, 'coveragePersistence', undefined, id); }
  }
  watcherLost(workspace: string): void {
    this.unhealthy.add(workspace);
    const affected = new Set<string>();
    for (const window of this.windows.values()) {
      if (this.sessions.get(window.generation)?.workspace === workspace) {
        window.observation.lost = true;
        affected.add(window.generation);
      }
    }
    for (const [generation, session] of this.sessions) if (session.workspace === workspace) {
      this.deps.observation?.(generation, false);
      if (affected.has(generation)) this.report(generation, 'watcherLoss');
    }
    for (const file of this.cache.keys()) if (this.contains(workspace, file)) this.cache.delete(file);
  }
  watcherRecovered(workspace: string): void {
    this.unhealthy.delete(workspace);
    for (const [generation, session] of this.sessions) if (session.workspace === workspace)
      this.deps.observation?.(generation, true);
    // Interrupted windows remain ineligible until their own terminal boundary.
  }
  private hookDiagnostics(generation: string, tool: string, identity: ShellHookIdentity): ShellHookDiagnostics {
    return {
      tool,
      ...(identity.sessionId !== undefined && { hookSessionId: identity.sessionId }),
      ...(identity.turnId !== undefined && { hookTurnId: identity.turnId, turnMatched: identity.turnId === this.deps.currentTurn?.(generation) }),
      ...(identity.agentType !== undefined && { agentType: identity.agentType }),
    };
  }
  private report(generation: string, reason: ShellCoverageReason, turnId?: string, toolUseId?: string, hook?: ShellHookDiagnostics): void {
    const window = toolUseId ? this.windows.get(generation + '|' + toolUseId) : undefined;
    this.deps.report?.(generation, reason, turnId, toolUseId, hook ?? (window && (window.hook ?? { tool: window.tool })));
  }
  private foreignHook(generation: string, id: string, hook: ShellHookDiagnostics): boolean {
    if (hook.turnMatched !== false && hook.agentType === undefined) return false;
    this.report(generation, 'foreignTool', undefined, id, hook);
    return true;
  }
  started(generation: string, id: string, kind: CodexShellToolKind): void {
    if (!this.sessions.has(generation) || this.terminal.get(generation)?.has(id)) return;
    const key = generation + '|' + id;
    if (this.windows.has(key)) return;
    if (this.windows.size >= 256) {
      this.disabled.add(generation);
      this.report(generation, 'overflow');
      return;
    }
    // A notification is not a pre-execution barrier. It can only guard against
    // attributing an uninstrumented execution's writes to another open tool.
    this.windows.set(key, {
      generation,
      id,
      tool: kind === 'mcp' ? 'MCP' : 'Uninstrumented',
      start: this.now(),
      files: new Set(),
      observation: { lost: this.unhealthy.has(this.sessions.get(generation)!.workspace) },
      deferred: new Map(),
    });
    if (kind !== 'mcp') void this.activity(generation, id, true);
  }
  completed(generation: string, id: string): Promise<void> {
    if (!this.sessions.has(generation) || this.terminal.get(generation)?.has(id)) return Promise.resolve();
    if (!this.observed.get(generation)?.has(id)) this.report(generation, 'missingPre', undefined, id);
    this.rememberTerminal(generation, id);
    return this.post(generation, id);
  }
  private rememberTerminal(generation: string, id: string): void {
    const seen = this.terminal.get(generation);
    if (!seen) return;
    seen.add(id);
    if (seen.size > 2048) {
      seen.delete(seen.values().next().value!);
      this.disabled.add(generation);
      this.report(generation, 'overflow');
    }
    this.observed.get(generation)?.delete(id);
  }
  async drain(sessionIds: string[], timeoutMs = 1500, report = true): Promise<boolean> {
    const work = async () => {
      do {
        await Promise.all([...new Set([...this.sessions.values()].map(s => s.workspace))].map(w => this.deps.drainEvents?.(w)));
        await Promise.all(this.closing.values());
        const queue = this.queue;
        await queue;
        if (!this.closing.size && queue === this.queue) return;
      } while (true);
    };
    const success = await boundedDrain(work(), timeoutMs);
    if (!success && report)
      for (const [generation, session] of this.sessions) {
        if (sessionIds.includes(session.sessionId)) this.report(generation, 'drainTimeout');
      }
    return success;
  }
  post(generation: string, id: string, identity?: ShellHookIdentity & { tool: string }): Promise<void> {
    if (identity && this.foreignHook(generation, id, this.hookDiagnostics(generation, identity.tool, identity))) return Promise.resolve();
    // Shared bus delivery includes atomic-write/debounce delays on Linux.
    // Keep the window open while draining; this is inference, not an OS barrier.
    const key = generation + '|' + id;
    const closing = this.closing.get(key);
    if (closing) return closing;
    const window = this.windows.get(key);
    if (!window) return Promise.resolve();
    // A post-only identity is diagnostic evidence, never a pre-execution boundary.
    if (!window.hook && identity) window.hook = this.hookDiagnostics(generation, window.tool, identity);
    this.rememberTerminal(generation, id);
    const drain = (async () => {
      await new Promise((r) => setTimeout(r, this.deps.settleMs ?? 150));
      const workspace = this.sessions.get(generation)?.workspace;
      if (workspace) await this.deps.drainEvents?.(workspace);
      await this.flush();
      if (window.checkout && window.deferred.size && !window.observation.lost && this.sessions.has(generation)) {
        try {
          const candidates = [...window.deferred.values()];
          const results = await window.checkout.finish(candidates.map(c => ({ filePath: c.evidence.filePath, fingerprint: c.fingerprint })));
          for (const candidate of candidates) {
            if (window.observation.lost || this.disabled.has(generation) || !this.sessions.has(generation)) break;
            const result = results.get(candidate.evidence.filePath);
            if (result === 'unchanged') continue;
            if (candidate.ambiguity) {
              this.report(generation, candidate.ambiguity, candidate.turnId, id);
              continue;
            }
            if (result === 'edit') {
              if (window.files.size >= 500) {
                this.report(generation, 'overflow', candidate.turnId, id);
                break;
              }
              await this.save(candidate.evidence, generation, candidate.turnId, window.files);
            }
            else this.report(generation, result === 'initialization' ? 'initialization' : 'checkoutBaseline', candidate.turnId, id,
              result === 'initialization' ? window.hook : baselineFailure(window.hook, 'finish', 'candidate baseline unavailable or unstable'));
          }
        } catch (error) {
          this.report(generation, 'checkoutBaseline', undefined, id, baselineFailure(window.hook, 'finish failed', error));
        }
      }
      if (this.windows.get(key) === window) this.windows.delete(key);
      await this.activity(generation, id, false);
    })().finally(() => this.closing.delete(key));
    this.closing.set(key, drain);
    return drain;
  }
  async flush(): Promise<void> {
    for (;;) {
      const queue = this.queue;
      await queue;
      if (queue === this.queue) return;
    }
  }
  endTurn(generation: string): void {
    for (const [key, w] of this.windows)
      if (w.generation === generation) {
        if (!this.closing.has(key)) {
          const eventFree = !w.observation.events && w.files.size === 0 && w.deferred.size === 0;
          if (mayWriteFiles(w.tool) && (w.tool === 'Uninstrumented' || !eventFree))
            this.report(generation, 'unmatchedTool', undefined, w.id);
          // Queue the same reconciliation as a completion, including candidates
          // whose observed events are still waiting for a read. Detach below so
          // later writes cannot enter this ended turn while persistence drains.
          if (w.tool === 'Bash' && w.checkout && !eventFree) {
            if (this.disabled.has(generation)) w.observation.lost = true;
            void this.post(generation, w.id);
          } else w.observation.lost = true;
        }
        this.rememberTerminal(generation, w.id);
        this.windows.delete(key);
        if (!this.closing.has(key)) void this.activity(generation, w.id, false);
      }
    this.observed.get(generation)?.clear();
    this.disabled.delete(generation);
  }
  async release(generation: string): Promise<void> {
    const s = this.sessions.get(generation);
    // A completion still draining must persist its deferred links and clear its
    // durable tool marker before the owner disappears; otherwise a quit right
    // after a command finishes reports an interruption on the next launch.
    this.endTurn(generation);
    // Bounded wait for turn-end reconciliation; a slow quit is not a coverage fault.
    await this.drain(s ? [s.sessionId] : [], 1500, false);
    this.sessions.delete(generation);
    this.terminal.delete(generation);
    this.observed.delete(generation);
    this.disabled.delete(generation);
    for (const [key, w] of this.windows) if (w.generation === generation) this.windows.delete(key);
    await boundedDrain(this.flush(), 1500);
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
  private changed(workspace: string, rawPath: string, observedAt = this.now()): void {
    const filePath = path.resolve(rawPath);
    if (!this.contains(workspace, filePath)) return;
    if (this.pending >= 16_384) {
      this.stats.overflow++;
      for (const [generation, s] of this.sessions)
        if (this.contains(s.workspace, filePath)) {
          this.disabled.add(generation);
          this.report(generation, 'overflow');
        }
      return;
    }
    const timestamp = observedAt;
    // Freeze the candidates now: a later post hook must not turn an overlap
    // into a single-owner event while the filesystem read waits in the queue.
    const candidates = [...this.windows.values()]
      .filter((w) => {
        const s = this.sessions.get(w.generation);
        return s && w.start <= timestamp && this.contains(s.workspace, filePath);
      })
      .map((w) => ({
        ...w,
        sessionId: this.sessions.get(w.generation)!.sessionId,
        workspacePath: this.sessions.get(w.generation)!.workspace,
        turnId: this.deps.currentTurn?.(w.generation),
      }));
    // Idle cached providers must not hash every workspace event. Invalidate a
    // known baseline so a later command cannot inherit an unobserved change.
    if (candidates.length === 0) {
      this.cache.delete(filePath);
      return;
    }
    // Capture arrival before queued reads, exclusions, or failed persistence.
    for (const candidate of candidates) candidate.observation.events = true;
    const disabledAtArrival = this.unhealthy.has(workspace) || candidates.some(w => w.observation.lost) || [...this.disabled].some((g) => {
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
          for (const generation of new Set(candidates.map((w) => w.generation)))
            this.report(
              generation,
              'knownWrite',
              candidates.find((w) => w.generation === generation)?.turnId,
                candidates.find((w) => w.generation === generation)?.id
            );
          return;
        }
        if (candidates.length === 0) return;
        let eligible = candidates;
        let owners = new Set(eligible.map((w) => w.sessionId));
        if (owners.size !== 1 && candidates.every(w => w.tool === 'Bash')) {
          const named = candidates.filter(w => w.command !== undefined &&
            extractFilePathsFromCommand(w.command, w.workspacePath)
              .some(candidate => path.resolve(candidate) === filePath));
          // Select a window, not merely a session. Observation loss anywhere in
          // the frozen overlap still abstains, and checkout reconciliation below
          // remains authoritative for whether the changed bytes are an edit.
          if (named.length === 1) {
            eligible = named;
            owners = new Set(named.map(w => w.sessionId));
          }
        }
        if (
          disabledAtArrival ||
          owners.size !== 1 ||
          candidates.some((w) => w.tool !== 'Bash' || w.observation.lost || this.disabled.has(w.generation))
        ) {
          this.stats.ambiguous++;
          const reason =
            disabledAtArrival || candidates.some(w => w.observation.lost || this.disabled.has(w.generation)) ? 'observationGap' :
            owners.size !== 1 ? 'competingOwners' : 'toolOverlap';
          if (candidates.some((w) => w.tool === 'Bash' || w.tool === 'Uninstrumented'))
            for (const generation of new Set(candidates.map((w) => w.generation))) {
              const candidate = candidates.find(w => w.generation === generation && w.checkout) ?? candidates.find(w => w.generation === generation)!;
              // Ownership is irrelevant when final bytes equal the pre-command
              // baseline. Defer the warning, but never promote ambiguous evidence
              // into an authored link if the competing tool finishes first.
              if (!disabledAtArrival && candidate.checkout && !candidate.observation.lost && !this.disabled.has(generation)) {
                try {
                  if (await candidate.checkout.defer(filePath) && (candidate.deferred.has(filePath) || candidate.deferred.size < 16_384)) {
                    candidate.deferred.set(filePath, {
                      evidence: { sessionId: candidate.sessionId, workspacePath: workspace, filePath, toolUseId: candidate.id, timestamp, source: 'shell-hook-inferred' },
                      fingerprint, turnId: candidate.turnId, ambiguity: reason,
                    });
                    continue;
                  }
                } catch (error) {
                  this.report(generation, 'checkoutBaseline', candidate.turnId, candidate.id, baselineFailure(candidate.hook, 'defer failed', error));
                }
              }
              this.report(generation, reason, candidate.turnId, candidate.id);
            }
          return;
        }
        const winner = eligible.find((w) => this.sessions.has(w.generation));
        if (!winner) return;
        // A metadata-only notification for an old file is not a new edit. An
        // uncached disappearance might be a directory; only known files qualify.
        if (state && state.modifiedAt <= winner.start) return;
        if (winner.files.has(filePath)) return;
        const session = this.sessions.get(winner.generation);
        if (!session) return;
        if (winner.files.size >= 500) {
          this.stats.overflow++;
          this.disabled.add(winner.generation);
          this.report(winner.generation, 'overflow');
          return;
        }
        const evidence: ShellFileEvidence = {
          sessionId: session.sessionId,
          workspacePath: session.workspace,
          filePath,
          toolUseId: winner.id,
          timestamp,
          source: 'shell-hook-inferred',
        };
        // Another agent's turn in this workspace is weaker evidence than a
        // hook-bounded shell window. Links are inferred and non-exclusive, so
        // note the overlap for diagnostics without withholding the link;
        // suppressing it made every parallel session a permanent warning.
        if (hasUninstrumentedSession) this.report(winner.generation, 'uninstrumented', winner.turnId, winner.id);
        if (winner.checkout) {
          let defer: boolean;
          try { defer = await winner.checkout.defer(filePath); }
          catch (error) {
            this.report(winner.generation, 'checkoutBaseline', winner.turnId, winner.id, baselineFailure(winner.hook, 'defer failed', error));
            return;
          }
          if (defer) {
            if (winner.deferred.size >= 16_384 && !winner.deferred.has(filePath)) {
              winner.observation.lost = true;
              this.report(winner.generation, 'overflow', winner.turnId);
              return;
            }
            winner.deferred.set(filePath, { evidence, fingerprint, turnId: winner.turnId, ambiguity: winner.deferred.get(filePath)?.ambiguity });
            return;
          }
        }
        if (!state && (cached === undefined || cached === null)) return;
        if (winner.observation.lost || this.disabled.has(winner.generation) || !this.sessions.has(winner.generation)) return;
        await this.save(evidence, winner.generation, winner.turnId, winner.files);
      })
      .catch((error) => {
        for (const generation of new Set(candidates.map((w) => w.generation)))
          this.report(
            generation,
            error instanceof ExcludedShellCandidate ? 'excluded' : 'readFailure',
            candidates.find((w) => w.generation === generation)?.turnId,
                candidates.find((w) => w.generation === generation)?.id
          );
        this.stats.suppressed++;
      })
      .finally(() => {
        this.pending--;
      });
  }
  private async save(evidence: ShellFileEvidence, generation: string, turnId: string | undefined, files: Set<string>): Promise<void> {
    let outcome: ShellPersistenceOutcome = 'failed';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        outcome = await this.deps.persist(evidence);
      } catch {
        outcome = 'failed';
      }
      if (outcome !== 'failed' && outcome !== 'throttled') break;
      if (attempt < 2)
        await new Promise((r) => setTimeout(r, this.deps.retryDelayMs ?? 100 * (attempt + 1)));
    }
    if (outcome === 'persisted') files.add(evidence.filePath);
    else {
      this.cache.delete(evidence.filePath);
      this.report(generation, outcome === 'failed' ? 'persistence' : outcome, turnId, evidence.toolUseId);
    }
  }
}
