import { providerSessionAliases } from "../PGLiteSessionStore";
import type { AppDatabase } from "../../database/PGLiteDatabaseWorker";
import type { SessionStateManager } from "@nimbalyst/runtime/ai/server/SessionStateManager";
import { randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import type { SessionStore } from "@nimbalyst/runtime/ai/adapters/sessionStore";
import { extractSearchable } from "@nimbalyst/runtime/ai/server/transcript/searchableTextExtractor";
import { DEFAULT_MODELS } from "@nimbalyst/runtime/ai/modelConstants";
import type { ExternalSessionPersistence } from "./ExternalSessionPersistence";
import type {
  ExternalCursor,
  ExternalRawMessage,
  ExternalSessionRef,
  ExternalSessionSource,
} from "./types";

export interface ExternalWorkspaceRoute {
  workspacePath: string;
  worktreeId?: string;
}
export interface ExternalIngestOptions {
  /** Revoked synchronously on disable, scope change or shutdown. Manual calls use shutdown eligibility only. */
  isEligible?: () => boolean;
  manual?: boolean;
}
export interface ExternalIngestResult {
  sessionId?: string;
  messagesAdded: number;
  hasMore: boolean;
  skipped?: boolean;
}
export interface LegacyExternalMessage {
  id: number;
  direction: "input" | "output";
  content: string;
  createdAt: Date | string;
}
interface Dependencies {
  sessions: Pick<SessionStore, "get" | "create" | "updateMetadata">;
  persistence: Pick<
    ExternalSessionPersistence,
    "resolveSessionId" | "getCursor" | "appendAndAdvance"
  >;
  getSessionState: (
    id: string
  ) => { status: string; isStreaming?: boolean } | null;
  processNewMessages: (id: string, provider: string) => Promise<unknown>;
  refresh: (workspacePath: string) => void;
  hasPendingOwnership?: (
    ref: ExternalSessionRef,
    route: ExternalWorkspaceRoute
  ) => Promise<boolean>;
  readLegacyMessages?: (
    sessionId: string,
    provider: string,
    afterId: number
  ) => Promise<LegacyExternalMessage[]>;
}

/** The shared live/manual writer. Physical sidecars take their parent's lane. */
export class ExternalSessionIngestor {
  private lanes = new Map<string, Promise<unknown>>();
  // Empty pre-session pages have no row to attach a durable cursor to yet.
  // Cache only pages with no raw messages; eviction/restart safely replays them.
  private provisional = new Map<
    string,
    {
      cursor: ExternalCursor;
      title?: string;
      titleKind?: ExternalSessionRef["titleKind"];
      model?: string;
    }
  >();
  private pending = 0;
  private closed = false;
  private activeBatches = new Set<{
    sessionId?: string;
    revoked: boolean;
    task?: Promise<unknown>;
  }>();
  private handledOwnership = new Set<string>();
  private ownershipWrites = new Map<string, Promise<void>>();
  private uncertainOwnership = new Set<string>();
  constructor(
    private readonly deps: Dependencies,
    private readonly maxPending = 256
  ) {}
  get pendingCount(): number {
    return this.pending;
  }

  ingest(
    source: ExternalSessionSource,
    ref: ExternalSessionRef,
    route: ExternalWorkspaceRoute,
    options: ExternalIngestOptions = {}
  ): Promise<ExternalIngestResult> {
    if (this.closed)
      return Promise.resolve({
        messagesAdded: 0,
        hasMore: false,
        skipped: true,
      });
    if (source.providerId !== ref.providerId)
      return Promise.reject(new Error("External source provider mismatch"));
    if (this.pending >= this.maxPending)
      return Promise.reject(
        new Error("External ingestion queue is full; retry on next scan")
      );
    const key = JSON.stringify([ref.providerId, ref.externalId]);
    this.pending++;
    const fence: {
      sessionId?: string;
      revoked: boolean;
      task?: Promise<unknown>;
    } = { revoked: false };
    this.activeBatches.add(fence);
    const task = (this.lanes.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.ingestBatch(source, ref, route, options, fence));
    fence.task = task;
    this.lanes.set(key, task);
    return task.finally(() => {
      this.pending--;
      this.activeBatches.delete(fence);
      if (this.lanes.get(key) === task) this.lanes.delete(key);
    });
  }

  /** Activity notifications are defensive fences only; they never query per token. */
  fenceLocalOwnership(sessionId: string): void {
    for (const batch of this.activeBatches)
      if (batch.sessionId === sessionId) batch.revoked = true;
  }

  /** Must complete before any local provider or raw-message side effect. Failure
   * aborts local execution, so a retry can safely release its temporary fence. */
  async takeLocalOwnership(sessionId: string): Promise<void> {
    if (this.closed) throw new Error("External session service stopped");
    this.fenceLocalOwnership(sessionId);
    if (this.handledOwnership.has(sessionId)) {
      this.handledOwnership.delete(sessionId);
      this.handledOwnership.add(sessionId);
      return;
    }
    if (this.ownershipWrites.has(sessionId))
      return this.ownershipWrites.get(sessionId);
    if (this.ownershipWrites.size >= this.maxPending)
      throw new Error(
        "Local ownership claims are busy; retry before execution"
      );
    this.uncertainOwnership.add(sessionId);
    const draining = [...this.activeBatches]
      .filter((batch) => batch.sessionId === sessionId)
      .map((batch) => batch.task);
    const write = (async () => {
      if (draining.length) await Promise.allSettled(draining);
      if (this.closed) throw new Error("External session service stopped");
      const session = await this.deps.sessions.get(sessionId);
      if (!session)
        throw new Error("Cannot claim ownership of a missing session");
      if (
        isImportedSessionConfig(session.providerConfig) &&
        session.metadata?.externalIngestionOwner !== "nimbalyst"
      ) {
        await this.deps.sessions.updateMetadata(sessionId, {
          metadata: { externalIngestionOwner: "nimbalyst" },
        });
      }
      if (this.closed) throw new Error("External session service stopped");
      if (this.handledOwnership.size >= this.maxPending)
        this.handledOwnership.delete(
          this.handledOwnership.values().next().value!
        );
      this.handledOwnership.add(sessionId);
    })();
    this.ownershipWrites.set(sessionId, write);
    try {
      await write;
    } finally {
      this.ownershipWrites.delete(sessionId);
      this.uncertainOwnership.delete(sessionId);
    }
  }
  async drain(): Promise<void> {
    await Promise.allSettled([
      ...this.lanes.values(),
      ...this.ownershipWrites.values(),
    ]);
  }
  async stop(): Promise<void> {
    this.closed = true;
    await this.drain();
    this.provisional.clear();
  }

  private async ingestBatch(
    source: ExternalSessionSource,
    ref: ExternalSessionRef,
    route: ExternalWorkspaceRoute,
    options: ExternalIngestOptions,
    fence: { sessionId?: string; revoked: boolean }
  ): Promise<ExternalIngestResult> {
    const eligible = () =>
      !fence.revoked && !this.closed && (options.isEligible?.() ?? true);
    const skipped = (): ExternalIngestResult => ({
      messagesAdded: 0,
      hasMore: false,
      skipped: true,
    });
    if (!eligible()) return skipped();
    // Source cwd stays intact for log verification. Persistence uses list ownership.
    const identity = { ...ref, workspaceId: route.workspacePath };
    let sessionId = await this.deps.persistence.resolveSessionId(identity);
    fence.sessionId = sessionId ?? undefined;
    if (!eligible()) return skipped();
    let session = sessionId ? await this.deps.sessions.get(sessionId) : null;
    if (!eligible()) return skipped();
    const owned = () => {
      const state = this.deps.getSessionState(sessionId ?? ref.externalId);
      if (
        state &&
        (state.isStreaming || !["idle", "error"].includes(state.status))
      )
        return true;
      // Never replay provider logs into a local-owned row, even after its turn ends.
      return (
        this.uncertainOwnership.has(sessionId ?? ref.externalId) ||
        this.handledOwnership.has(sessionId ?? ref.externalId) ||
        (!!session &&
          (!isImportedSessionConfig(session.providerConfig) ||
            session.metadata?.externalIngestionOwner === "nimbalyst"))
      );
    };
    if (owned() || (await this.deps.hasPendingOwnership?.(ref, route)))
      return skipped();
    if (!eligible() || owned()) return skipped();
    const cursor = await this.deps.persistence.getCursor(identity);
    if (!eligible() || owned()) return skipped();
    const provisionalKey = JSON.stringify([
      ref.providerId,
      ref.externalId,
      ref.filePath,
      ref.workspacePath,
      route.workspacePath,
      route.worktreeId,
    ]);
    const provisional =
      !sessionId && !cursor ? this.provisional.get(provisionalKey) : undefined;
    const batch = await source.readSince(
      ref,
      cursor ?? provisional?.cursor ?? null,
      {
        includeFinalLine: options.manual === true,
      }
    );
    if (!eligible() || owned()) return skipped();
    if (await this.deps.hasPendingOwnership?.(ref, route)) return skipped();
    if (!eligible() || owned()) return skipped();
    const newSession = !sessionId;
    let createdTitle: string | undefined;
    let createdTitleKind: ExternalSessionRef["titleKind"];
    if (!sessionId) {
      const prior = batch.reset ? undefined : provisional;
      if (batch.title === undefined && prior?.title !== undefined) {
        batch.title = prior.title;
        batch.titleKind = prior.titleKind;
      }
      batch.model ??= prior?.model;
      if (!batch.messages.length) {
        this.provisional.delete(provisionalKey);
        if (this.provisional.size >= this.maxPending)
          this.provisional.delete(this.provisional.keys().next().value!);
        this.provisional.set(provisionalKey, {
          cursor: batch.cursor,
          title: batch.title,
          titleKind: batch.titleKind,
          model: batch.model,
        });
        return { messagesAdded: 0, hasMore: batch.hasMore };
      }
      createdTitle = ref.parentToolUseId
        ? "Imported Session"
        : batch.title ?? ref.title ?? "Imported Session";
      createdTitleKind = ref.parentToolUseId
        ? "fallback"
        : batch.title !== undefined
        ? titleKind(batch.titleKind)
        : ref.title !== undefined
        ? titleKind(ref.titleKind)
        : "fallback";
      sessionId = randomUUID();
      fence.sessionId = sessionId;
      await this.deps.sessions.create({
        id: sessionId,
        workspaceId: route.workspacePath,
        provider: ref.providerId,
        providerSessionId: ref.externalId,
        sessionType: "session",
        title: createdTitle,
        model: batch.model ?? ref.model ?? DEFAULT_MODELS[ref.providerId],
        providerConfig: {
          imported: true,
          importedAt: Date.now(),
          externalSource: ref.providerId,
        },
        worktreeId: route.worktreeId,
        worktreePath: route.worktreeId ? ref.workspacePath : undefined,
        worktreeProjectPath: route.worktreeId ? route.workspacePath : undefined,
        createdAt: ref.createdAt ?? ref.updatedAt,
        updatedAt: ref.updatedAt,
      });
      if (!eligible()) return skipped();
      session = await this.deps.sessions.get(sessionId);
      if (!eligible() || owned()) return skipped();
    }
    const messages = await this.withoutLegacyDuplicates(
      sessionId,
      ref.providerId,
      batch.messages,
      eligible
    );
    if (!eligible() || owned()) return skipped();
    // Compare the whole contract, including optional provider recovery state.
    const cursorChanged = !isDeepStrictEqual(cursor, batch.cursor);
    if (messages.length || cursorChanged) {
      await this.deps.persistence.appendAndAdvance({
        ref: identity,
        sessionId,
        expectedCursor: cursor,
        cursor: batch.cursor,
        messages: messages.map((message) => ({
          source: ref.providerId,
          direction: message.direction,
          content: message.content,
          metadata: message.metadata ?? undefined,
          createdAt: new Date(message.timestamp),
          providerMessageId: message.sourceEntryId,
          ...extractSearchable({
            source: ref.providerId,
            direction: message.direction,
            content: message.content,
            metadata: message.metadata,
          }),
        })),
      });
    }
    this.provisional.delete(provisionalKey);
    if (!eligible() || owned()) return skipped();
    // Invoke even for an empty/replayed batch: a previous committed write may have
    // been fenced or failed before canonical delivery. The runtime owns its watermark.
    await this.deps.processNewMessages(sessionId, ref.providerId);
    if (!eligible() || owned()) return skipped();
    session = await this.deps.sessions.get(sessionId);
    if (!eligible() || owned()) return skipped();
    // A sidecar describes its task, never the parent session's name. Record even
    // an initial placeholder so a later metadata-only parent rename can replace it.
    const incomingTitle =
      (ref.parentToolUseId ? undefined : batch.title) ?? createdTitle;
    const incomingKind = titleKind(
      !ref.parentToolUseId && batch.title !== undefined
        ? batch.titleKind
        : createdTitleKind
    );
    const lastTitle = session?.metadata?.externalLastImportedTitle;
    const storedKind = session?.metadata?.externalLastImportedTitleKind;
    const placeholder =
      session?.title === "Imported Session" &&
      (lastTitle !== session.title ||
        storedKind === undefined ||
        storedKind === "fallback");
    // Missing historical authority is conservatively generated: accept named
    // updates from legacy sources, but never replace an established name with
    // a prompt fallback after source cache loss or an unavailable title index.
    const authorityAllowed =
      newSession ||
      placeholder ||
      !session?.title ||
      titleRank(incomingKind) >= titleRank(titleKind(storedKind));
    const canUpdateTitle =
      !!incomingTitle &&
      session?.hasBeenNamed !== true &&
      authorityAllowed &&
      (newSession ||
        session?.title === lastTitle ||
        !session?.title ||
        placeholder ||
        (typeof lastTitle !== "string" && storedKind === undefined));
    const adoptTitle =
      !!incomingTitle &&
      session?.hasBeenNamed !== true &&
      authorityAllowed &&
      (canUpdateTitle || incomingTitle === session?.title);
    const metadata = {
      ...(session?.metadata?.externalSource !== ref.providerId
        ? { externalSource: ref.providerId }
        : {}),
      ...(session?.metadata?.externalLastActivityAt !== ref.updatedAt
        ? { externalLastActivityAt: ref.updatedAt }
        : {}),
      ...(adoptTitle && lastTitle !== incomingTitle
        ? { externalLastImportedTitle: incomingTitle }
        : {}),
      ...(adoptTitle && storedKind !== incomingKind
        ? { externalLastImportedTitleKind: incomingKind }
        : {}),
    };
    const titleChanged = canUpdateTitle && incomingTitle !== session?.title;
    const modelChanged = !!batch.model && batch.model !== session?.model;
    const metadataChanged =
      Object.keys(metadata).length > 0 || titleChanged || modelChanged;
    if (metadataChanged) {
      await this.deps.sessions.updateMetadata(sessionId, {
        ...(Object.keys(metadata).length ? { metadata } : {}),
        ...(titleChanged ? { title: incomingTitle } : {}),
        ...(modelChanged ? { model: batch.model } : {}),
      });
    }
    if (
      (newSession || messages.length > 0 || metadataChanged) &&
      eligible() &&
      !owned()
    )
      this.deps.refresh(route.workspacePath);
    return {
      sessionId,
      messagesAdded: messages.length,
      hasMore: batch.hasMore,
    };
  }

  private async withoutLegacyDuplicates(
    sessionId: string,
    provider: string,
    messages: ExternalRawMessage[],
    eligible: () => boolean
  ): Promise<ExternalRawMessage[]> {
    if (!messages.length || !this.deps.readLegacyMessages) return messages;
    const remaining = new Map(
      messages.map((message) => [message.sourceEntryId, message])
    );
    let afterId = 0;
    while (eligible()) {
      const rows = await this.deps.readLegacyMessages(
        sessionId,
        provider,
        afterId
      );
      if (!eligible()) return [];
      for (const row of rows) {
        for (const [id, message] of remaining) {
          if (sameLegacyMessage(row, message)) remaining.delete(id);
        }
        afterId = Math.max(afterId, Number(row.id));
      }
      if (!rows.length || !remaining.size) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return [...remaining.values()];
  }
}

// The pre-authority source contract supplied plain strings; treat those as
// generated for compatibility, never infer explicit user intent from a string.
function titleKind(
  value: unknown
): NonNullable<ExternalSessionRef["titleKind"]> {
  return value === "fallback" || value === "explicit" ? value : "generated";
}
function titleRank(kind: NonNullable<ExternalSessionRef["titleKind"]>): number {
  return { fallback: 0, generated: 1, explicit: 2 }[kind];
}

function sameLegacyMessage(
  row: LegacyExternalMessage,
  message: ExternalRawMessage
): boolean {
  if (row.direction !== message.direction) return false;
  try {
    const old = JSON.parse(row.content);
    const next = JSON.parse(message.content);
    // Claude's durable uuid survives historical storage slimming. Subagent linkage
    // participates so sidecars cannot collide with their parent's native entry.
    if (typeof old.uuid === "string" && typeof next.uuid === "string")
      return (
        old.uuid === next.uuid &&
        old.parent_tool_use_id === next.parent_tool_use_id
      );
    return (
      new Date(row.createdAt).getTime() === Date.parse(message.timestamp) &&
      stableJson(old) === stableJson(next)
    );
  } catch {
    return (
      row.content === message.content &&
      new Date(row.createdAt).getTime() === Date.parse(message.timestamp)
    );
  }
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => JSON.stringify(key) + ":" + stableJson(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}

/** While binding is pending, there is no safe external-id lookup. Defer the
 * matching workspace/provider family until the active local launch has bound. */
export async function hasPendingExternalOwnership(
  sessions: Pick<SessionStore, "get">,
  manager: Pick<
    SessionStateManager,
    "getTrackedSessionIds" | "getSessionState"
  >,
  ref: ExternalSessionRef,
  route: ExternalWorkspaceRoute
): Promise<boolean> {
  const ids = manager.getTrackedSessionIds();
  if (ids.length > 256) return true;
  for (const id of ids) {
    const state = manager.getSessionState(id);
    if (
      !state ||
      (!state.isStreaming && ["idle", "error"].includes(state.status))
    )
      continue;
    if (
      state.workspacePath &&
      ![ref.workspacePath, route.workspacePath].includes(state.workspacePath)
    )
      continue;
    const local = await sessions.get(id);
    if (!local) return true;
    if (!providerSessionAliases(ref.providerId).includes(local.provider))
      continue;
    if (
      local.workspacePath &&
      ![ref.workspacePath, route.workspacePath].includes(local.workspacePath)
    )
      continue;
    if (!local.providerSessionId || local.providerSessionId === ref.externalId)
      return true;
  }
  return false;
}
export async function readLegacyExternalMessages(
  db: Pick<AppDatabase, "query">,
  sessionId: string,
  provider: string,
  afterId: number
): Promise<LegacyExternalMessage[]> {
  const [canonical, alias] = providerSessionAliases(provider);
  const { rows } = await db.query<{
    id: number;
    direction: "input" | "output";
    content: string;
    created_at: Date | string;
  }>(
    `SELECT id, direction, content, created_at FROM ai_agent_messages
     WHERE session_id = $1 AND id > $2 AND source IN ($3, $4) AND provider_message_id IS NULL ORDER BY id LIMIT 256`,
    [sessionId, afterId, canonical, alias]
  );
  return rows.map((row) => ({ ...row, createdAt: row.created_at }));
}

function isImportedSessionConfig(config: unknown): boolean {
  return (
    !!config &&
    typeof config === "object" &&
    "imported" in config &&
    config.imported === true
  );
}
