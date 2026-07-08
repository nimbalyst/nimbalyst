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
import { AISessionsRepository, AgentMessagesRepository } from '@nimbalyst/runtime';
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
    if (handle.state.status === 'running') this.wireWorkspace(handle.workspacePath);
    else this.unwireWorkspace(handle.workspacePath);
  }

  // --- Quick Open query (Phase 3) ------------------------------------------

  /** True when the memory engine is running for this workspace. */
  isAvailable(workspacePath: string): boolean {
    return (
      getPrivilegedExtensionHost().getState(EXT_ID, MODULE_ID, workspacePath)?.status === 'running'
    );
  }

  async query(
    workspacePath: string,
    query: string,
    k = 20,
    sourceClasses?: string[],
  ): Promise<SemanticSearchResult[]> {
    if (!query.trim() || !this.isAvailable(workspacePath)) return [];
    try {
      const res = await getPrivilegedExtensionHost().request<{ results: SemanticSearchResult[] }>({
        extensionId: EXT_ID,
        moduleId: MODULE_ID,
        workspacePath,
        method: 'globalSearch',
        params: { query, k, ...(sourceClasses?.length ? { sourceClasses } : {}) },
        requiredPermission: null,
      });
      return res?.results ?? [];
    } catch (err) {
      console.error('[SemanticCatalog] query failed:', (err as Error).message);
      return [];
    }
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
