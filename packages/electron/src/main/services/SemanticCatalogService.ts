/**
 * SemanticCatalogService — bridges DB-resident content (tracker items today; AI
 * sessions later) into the nimbalyst-memory extension's hybrid index, and serves
 * the Quick Open global semantic search.
 *
 * It is entirely reactive to the memory engine's lifecycle: the engine only runs
 * when the user has enabled the (off-by-default) memory extension, so this
 * service does nothing until a `com.nimbalyst.memory/memory-engine` module
 * reaches `running` for a workspace. At that point it backfills the workspace's
 * trackers and subscribes to live changes; when the module stops it tears those
 * subscriptions down. Embeddings are the engine's local, rebuildable shadow
 * index — nothing here is synced.
 */
import type {
  TrackerItem,
  TrackerItemChangeEvent,
  SessionMeta,
} from '@nimbalyst/runtime';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { getPrivilegedExtensionHost, type ModuleHandle } from '../extensions/PrivilegedExtensionHost';
import { documentServices } from '../window/WindowManager';
import { getAppSetting, setAppSetting } from '../utils/store';

const EXT_ID = 'com.nimbalyst.memory';
const MODULE_ID = 'memory-engine';

/** App-setting key gating session indexing (opt-in, off by default). */
const SESSIONS_SETTING_KEY = 'memoryIndexSessions';

/** Coalesce live tracker changes before flushing them to the engine. */
const FLUSH_DEBOUNCE_MS = 800;

/** Cap records per ingest RPC so a large backfill is many bounded messages. */
const INGEST_BATCH = 200;

/** Bound the session backfill so a huge history can't stall the first index. */
const MAX_SESSIONS = 400;
/** Messages read per session, and per-message / per-session text caps. */
const SESSION_MSG_LIMIT = 60;
const PER_MESSAGE_CAP = 2000;
const SESSION_TEXT_CAP = 8000;

/** Recheck a running engine while its initial index is still becoming ready. */
const READINESS_RETRY_MS = 1000;

/** Mirror of the engine-side VirtualRecord shape (host-agnostic by design). */
interface VirtualRecord {
  id: string;
  sourceClass: string;
  refType: string;
  refId: string;
  title?: string;
  text: string;
}

/** Mirror of the backend `globalSearch` result shape. */
export interface SemanticSearchResult {
  refType: string;
  refId: string;
  sourceClass: string;
  sourcePath: string;
  title: string;
  snippet: string;
  score: number;
  signals: { dense: boolean; sparse: boolean };
  /**
   * Raw pre-fusion scores. `score` is an RRF rank reciprocal — comparable
   * within one query's result list, meaningless across queries — so a caller
   * that needs an absolute threshold (duplicate detection) reads
   * `similarity.cosine`. Absent when the engine predates the passthrough.
   */
  similarity?: { cosine?: number; bm25?: number };
}

/**
 * Keeps "index unavailable" distinct from "available with no matches" for
 * main-process callers without changing the renderer's result-array contract.
 */
export type SemanticQueryOutcome =
  | { available: false; results: [] }
  | { available: true; results: SemanticSearchResult[] };

/**
 * The fields we read off the memory backend's read-only `status` RPC.
 *
 * `ready` is the backend module's own flag (`nimbalyst-memory/src/backend.ts`):
 * `false` when the engine failed to construct, and in that branch none of the
 * engine fields are present at all. The rest is
 * `buildPublicEngineStatus(engine.status())` — the engine's `EngineStatus`
 * minus `lastEmbedError`. Mirrored rather than imported so the main process
 * does not depend on the extension's build output; the readiness test type-
 * checks its fixtures against the real `EngineStatus`, so a field invented here
 * fails to compile there.
 */
interface MemoryEngineStatus {
  ready?: boolean;
  chunks?: number;
  indexing?: boolean;
}

interface PendingChanges {
  upserts: Map<string, VirtualRecord>;
  removes: Set<string>;
  timer: NodeJS.Timeout | null;
}

interface WiredWorkspace {
  unwatch: () => void;
  pending: PendingChanges;
}

interface ReadinessCheck {
  generation: number;
  promise: Promise<void>;
}

/** Recursively pull visible text out of a Lexical editor-state JSON blob. */
function lexicalToText(content: unknown): string {
  if (!content) return '';
  let root: unknown = content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) return trimmed; // already plain text/markdown
    try {
      root = JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  const out: string[] = [];
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') out.push(node.text);
    if (node.root) walk(node.root);
    if (Array.isArray(node.children)) for (const child of node.children) walk(child);
  };
  walk(root);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Build the indexable record for a tracker item (title + metadata + body). */
function buildTrackerRecord(item: TrackerItem): VirtualRecord {
  const typeLabel = (item.typeTags?.length ? item.typeTags : [item.type]).join(', ');
  const meta = [
    item.issueKey,
    `Type: ${typeLabel}`,
    item.status ? `Status: ${item.status}` : '',
    item.priority ? `Priority: ${item.priority}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const tags = item.tags?.length ? `Tags: ${item.tags.join(', ')}` : '';
  const body = lexicalToText(item.content);
  const text = [meta, tags, item.description ?? '', body].filter(Boolean).join('\n\n');
  return {
    id: `tracker:${item.id}`,
    sourceClass: 'trackers',
    refType: 'tracker',
    refId: item.id,
    title: item.title || item.issueKey || 'Untitled',
    text,
  };
}

/** Heuristic: skip assistant messages whose content is raw tool/structured JSON. */
function looksLikeJson(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

export class SemanticCatalogService {
  private static instance: SemanticCatalogService | null = null;
  private wired = new Map<string, WiredWorkspace>();
  private readiness = new Map<string, boolean>();
  private readinessGenerations = new Map<string, number>();
  private readinessChecks = new Map<string, ReadinessCheck>();
  private readinessRetryTimers = new Map<string, NodeJS.Timeout>();
  private started = false;

  static getInstance(): SemanticCatalogService {
    if (!this.instance) this.instance = new SemanticCatalogService();
    return this.instance;
  }

  /** Begin reacting to memory-engine lifecycle. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const host = getPrivilegedExtensionHost();

    // Wire any memory modules that are already running (service may init after
    // the user enabled memory in a prior window).
    for (const handle of host.list()) this.onModuleState(handle);

    host.onStateChanged((handle) => this.onModuleState(handle));
  }

  private onModuleState(handle: ModuleHandle): void {
    if (handle.extensionId !== EXT_ID || handle.moduleId !== MODULE_ID) return;
    const generation = this.invalidateReadiness(handle.workspacePath);
    if (handle.state.status === 'running') {
      this.wireWorkspace(handle.workspacePath);
      void this.refreshReadiness(handle.workspacePath, generation);
    } else {
      this.unwireWorkspace(handle.workspacePath);
    }
  }

  // --- Quick Open query (Phase 3) ------------------------------------------

  /**
   * Synchronous hot-path read of the last engine-readiness signal. Unknown and
   * stale states fail closed; lifecycle events refresh the cache in background.
   */
  isAvailable(workspacePath: string): boolean {
    return this.readiness.get(workspacePath) === true;
  }

  async query(
    workspacePath: string,
    query: string,
    k = 20,
    sourceClasses?: string[],
  ): Promise<SemanticQueryOutcome> {
    if (!this.isAvailable(workspacePath)) {
      // The index may have gained its first chunks since our last check (from
      // the engine's own watcher, or a rebuild). Re-check so an actively
      // searching user recovers within a second; the pending-timer guard in
      // scheduleReadinessRefresh collapses a burst of keystrokes into one RPC.
      this.scheduleReadinessRefresh(workspacePath, this.currentGeneration(workspacePath));
      return { available: false, results: [] };
    }
    if (!query.trim()) return { available: true, results: [] };
    try {
      const res = await getPrivilegedExtensionHost().request<{ results: SemanticSearchResult[] }>({
        extensionId: EXT_ID,
        moduleId: MODULE_ID,
        workspacePath,
        method: 'globalSearch',
        params: { query, k, ...(sourceClasses?.length ? { sourceClasses } : {}) },
        requiredPermission: null,
      });
      return { available: true, results: res?.results ?? [] };
    } catch (err) {
      console.error('[SemanticCatalog] query failed:', (err as Error).message);
      const generation = this.invalidateReadiness(workspacePath);
      this.scheduleReadinessRefresh(workspacePath, generation);
      return { available: false, results: [] };
    }
  }

  private currentGeneration(workspacePath: string): number {
    // Absent means we have never seen the module run here, so every refresh
    // path below no-ops — which is what we want when memory is disabled.
    return this.readinessGenerations.get(workspacePath) ?? -1;
  }

  private invalidateReadiness(workspacePath: string): number {
    const generation = (this.readinessGenerations.get(workspacePath) ?? 0) + 1;
    this.readinessGenerations.set(workspacePath, generation);
    this.readiness.set(workspacePath, false);
    const timer = this.readinessRetryTimers.get(workspacePath);
    if (timer) clearTimeout(timer);
    this.readinessRetryTimers.delete(workspacePath);
    return generation;
  }

  private refreshReadiness(workspacePath: string, generation: number): Promise<void> {
    if (this.readinessGenerations.get(workspacePath) !== generation) return Promise.resolve();
    const existing = this.readinessChecks.get(workspacePath);
    if (existing?.generation === generation) return existing.promise;

    const promise = (async () => {
      const host = getPrivilegedExtensionHost();
      if (host.getState(EXT_ID, MODULE_ID, workspacePath)?.status !== 'running') return;

      let ready = false;
      let fillingEmptyIndex = false;
      try {
        const status = await host.request<MemoryEngineStatus>({
          extensionId: EXT_ID,
          moduleId: MODULE_ID,
          workspacePath,
          method: 'status',
          requiredPermission: null,
        });
        // Available means "the index holds something searchable", NOT "the
        // initial pass has finished". The engine republishes its retrieval
        // snapshot every 25 files during a full pass precisely so partial
        // results are searchable in seconds instead of after a multi-minute
        // corpus walk, so gating on `indexing` would blank Quick Open out on
        // every cold start and discard that. What is genuinely unavailable is a
        // cold, empty index: advertising search over zero chunks is what made
        // Quick Open silently return nothing.
        //
        // Deliberately not consulted: `retrieval.mode === 'keyword-only'` and
        // `denseChunks === 0` are *working* states (the sparse fallback), not
        // unavailable ones.
        ready = status?.ready === true && (status.chunks ?? 0) > 0;
        fillingEmptyIndex = status?.ready === true && !ready && status.indexing === true;
      } catch {
        // Unknown readiness fails closed until a module transition or failed query retries it.
      }

      if (this.readinessGenerations.get(workspacePath) !== generation) return;
      if (host.getState(EXT_ID, MODULE_ID, workspacePath)?.status !== 'running') return;
      this.readiness.set(workspacePath, ready);
      // Only poll while chunks are actively landing; this stops on the first
      // non-empty status, or when the pass ends still empty.
      if (fillingEmptyIndex) this.scheduleReadinessRefresh(workspacePath, generation);
    })();

    this.readinessChecks.set(workspacePath, { generation, promise });
    void promise.finally(() => {
      if (this.readinessChecks.get(workspacePath)?.promise === promise) {
        this.readinessChecks.delete(workspacePath);
      }
    });
    return promise;
  }

  private scheduleReadinessRefresh(workspacePath: string, generation: number): void {
    if (this.readinessGenerations.get(workspacePath) !== generation) return;
    if (
      getPrivilegedExtensionHost().getState(EXT_ID, MODULE_ID, workspacePath)?.status !== 'running'
    ) {
      return;
    }
    if (this.readinessRetryTimers.has(workspacePath)) return;
    const timer = setTimeout(() => {
      this.readinessRetryTimers.delete(workspacePath);
      void this.refreshReadiness(workspacePath, generation);
    }, READINESS_RETRY_MS);
    timer.unref?.();
    this.readinessRetryTimers.set(workspacePath, timer);
  }

  // --- Tracker backfill + live sync (Phase 2) ------------------------------

  private wireWorkspace(workspacePath: string): void {
    if (this.wired.has(workspacePath)) return;
    const docService = documentServices.get(workspacePath);
    if (!docService) {
      // The engine runs only in an open workspace, so this is unexpected; live
      // changes will still arrive once the service exists, but backfill is
      // skipped. Don't mark wired so a later state event can retry.
      console.warn(`[SemanticCatalog] no document service for ${workspacePath}; skipping backfill`);
      return;
    }

    const pending: PendingChanges = { upserts: new Map(), removes: new Set(), timer: null };
    const unwatch = docService.watchTrackerItems((change: TrackerItemChangeEvent) => {
      this.enqueueChange(workspacePath, change);
    });
    this.wired.set(workspacePath, { unwatch, pending });

    void this.backfillTrackers(workspacePath);
    if (this.sessionsEnabled()) void this.backfillSessions(workspacePath);
  }

  private unwireWorkspace(workspacePath: string): void {
    const entry = this.wired.get(workspacePath);
    if (!entry) return;
    entry.unwatch();
    if (entry.pending.timer) clearTimeout(entry.pending.timer);
    this.wired.delete(workspacePath);
  }

  private async backfillTrackers(workspacePath: string): Promise<void> {
    const docService = documentServices.get(workspacePath);
    if (!docService) return;
    try {
      const items = await docService.listTrackerItems();
      const records = items.filter((i) => !i.archived).map(buildTrackerRecord);
      for (let i = 0; i < records.length; i += INGEST_BATCH) {
        const batch = records.slice(i, i + INGEST_BATCH);
        await this.ingest(workspacePath, batch);
      }
      console.log(
        `[SemanticCatalog] backfilled ${records.length} tracker(s) for ${workspacePath}`,
      );
    } catch (err) {
      console.error('[SemanticCatalog] tracker backfill failed:', (err as Error).message);
    }
  }

  private enqueueChange(workspacePath: string, change: TrackerItemChangeEvent): void {
    const entry = this.wired.get(workspacePath);
    if (!entry) return;
    const { upserts, removes } = entry.pending;
    for (const item of [...change.added, ...change.updated]) {
      const recordId = `tracker:${item.id}`;
      if (item.archived) {
        upserts.delete(recordId);
        removes.add(recordId);
      } else {
        removes.delete(recordId);
        upserts.set(recordId, buildTrackerRecord(item));
      }
    }
    for (const id of change.removed) {
      const recordId = `tracker:${id}`;
      upserts.delete(recordId);
      removes.add(recordId);
    }
    this.scheduleFlush(workspacePath);
  }

  private scheduleFlush(workspacePath: string): void {
    const entry = this.wired.get(workspacePath);
    if (!entry) return;
    if (entry.pending.timer) clearTimeout(entry.pending.timer);
    entry.pending.timer = setTimeout(() => void this.flush(workspacePath), FLUSH_DEBOUNCE_MS);
  }

  private async flush(workspacePath: string): Promise<void> {
    const entry = this.wired.get(workspacePath);
    if (!entry) return;
    const { upserts, removes } = entry.pending;
    const records = Array.from(upserts.values());
    const ids = Array.from(removes);
    upserts.clear();
    removes.clear();
    entry.pending.timer = null;

    try {
      if (records.length) await this.ingest(workspacePath, records);
      if (ids.length) {
        await getPrivilegedExtensionHost().request({
          extensionId: EXT_ID,
          moduleId: MODULE_ID,
          workspacePath,
          method: 'removeRecords',
          params: { ids },
          requiredPermission: null,
        });
      }
    } catch (err) {
      console.error('[SemanticCatalog] flush failed:', (err as Error).message);
    }
  }

  private async ingest(workspacePath: string, records: VirtualRecord[]): Promise<void> {
    if (!records.length) return;
    await getPrivilegedExtensionHost().request({
      extensionId: EXT_ID,
      moduleId: MODULE_ID,
      workspacePath,
      method: 'ingestRecords',
      params: { records },
      requiredPermission: null,
    });
    // Our tracker/session records can be the first content in an otherwise
    // empty index (a workspace with no indexable files), and nothing else would
    // tell readiness that chunks now exist.
    if (!this.isAvailable(workspacePath)) {
      this.scheduleReadinessRefresh(workspacePath, this.currentGeneration(workspacePath));
    }
  }

  // --- AI session indexing (Phase 4, opt-in / off by default) --------------

  sessionsEnabled(): boolean {
    return getAppSetting<boolean>(SESSIONS_SETTING_KEY) === true;
  }

  /** Toggle session indexing and (un)backfill every wired workspace to match. */
  async setSessionsEnabled(enabled: boolean): Promise<void> {
    setAppSetting(SESSIONS_SETTING_KEY, enabled);
    for (const workspacePath of this.wired.keys()) {
      if (enabled) await this.backfillSessions(workspacePath);
      else await this.clearSessions(workspacePath);
    }
  }

  /** Build the indexable record for a session: title + tags + prompts + replies.
   *  Never the raw transcript — user inputs are plain text; assistant outputs are
   *  included only when not raw tool/structured JSON. */
  private async buildSessionRecord(meta: SessionMeta): Promise<VirtualRecord | null> {
    let messages: Array<{ direction: string; content: unknown }> = [];
    try {
      messages = (await AgentMessagesRepository.list(meta.id, {
        limit: SESSION_MSG_LIMIT,
        includeHidden: false,
      })) as Array<{ direction: string; content: unknown }>;
    } catch {
      messages = [];
    }
    const prompts: string[] = [];
    const replies: string[] = [];
    for (const m of messages) {
      const content = typeof m.content === 'string' ? m.content.slice(0, PER_MESSAGE_CAP) : '';
      if (!content.trim()) continue;
      if (m.direction === 'input') prompts.push(content);
      else if (m.direction === 'output' && !looksLikeJson(content)) replies.push(content);
    }
    const tags = meta.tags?.length ? `Tags: ${meta.tags.join(', ')}` : '';
    const text = [
      meta.phase ? `Phase: ${meta.phase}` : '',
      tags,
      prompts.length ? `Prompts:\n${prompts.join('\n')}` : '',
      replies.length ? `Responses:\n${replies.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, SESSION_TEXT_CAP);
    if (!text.trim() && !meta.title) return null;
    return {
      id: `session:${meta.id}`,
      sourceClass: 'sessions',
      refType: 'session',
      refId: meta.id,
      title: meta.title || 'Untitled session',
      text,
    };
  }

  private async backfillSessions(workspacePath: string): Promise<void> {
    try {
      const metas = await AISessionsRepository.list(workspacePath);
      const active = metas.filter((m) => !m.isArchived).slice(0, MAX_SESSIONS);
      let batch: VirtualRecord[] = [];
      let count = 0;
      for (const meta of active) {
        const rec = await this.buildSessionRecord(meta);
        if (!rec) continue;
        batch.push(rec);
        count++;
        if (batch.length >= INGEST_BATCH) {
          await this.ingest(workspacePath, batch);
          batch = [];
        }
      }
      if (batch.length) await this.ingest(workspacePath, batch);
      console.log(`[SemanticCatalog] backfilled ${count} session(s) for ${workspacePath}`);
    } catch (err) {
      console.error('[SemanticCatalog] session backfill failed:', (err as Error).message);
    }
  }

  private async clearSessions(workspacePath: string): Promise<void> {
    try {
      const metas = await AISessionsRepository.list(workspacePath);
      const ids = metas.map((m) => `session:${m.id}`);
      for (let i = 0; i < ids.length; i += INGEST_BATCH) {
        const batch = ids.slice(i, i + INGEST_BATCH);
        await getPrivilegedExtensionHost().request({
          extensionId: EXT_ID,
          moduleId: MODULE_ID,
          workspacePath,
          method: 'removeRecords',
          params: { ids: batch },
          requiredPermission: null,
        });
      }
    } catch (err) {
      console.error('[SemanticCatalog] clear sessions failed:', (err as Error).message);
    }
  }
}
