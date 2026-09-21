import * as path from "path";
import { AISessionsRepository } from "@nimbalyst/runtime/storage/repositories/AISessionsRepository";
import { TranscriptMigrationRepository } from "@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository";
import { getSessionStateManager } from "@nimbalyst/runtime/ai/server/SessionStateManager";
import { database } from "../../database/PGLiteDatabaseWorker";
import { listOpenWorkspacePaths, windows } from "../../window/windowState";
import { getSettingsService } from "../SettingsService";
import { createWorktreeStore } from "../WorktreeStore";
import { whenFirstUsable } from "../startupMaintenanceGate";
import { logger } from "../../utils/logger";
import { ClaudeCodeSource } from "./ClaudeCodeSource";
import { CodexSource } from "./CodexSource";
import { ExternalSessionPersistence } from "./ExternalSessionPersistence";
import {
  ExternalSessionIngestor,
  hasPendingExternalOwnership,
  readLegacyExternalMessages,
  type ExternalWorkspaceRoute,
} from "./ExternalSessionIngestor";
import {
  ExternalSessionWatcher,
  type ExternalScope,
} from "./ExternalSessionWatcher";
import type {
  ExternalProviderId,
  ExternalSessionRef,
  ExternalSessionSource,
} from "./types";
import type {
  ExternalSessionSelection,
  ExternalSessionSummary,
  ExternalSessionSyncResult,
} from "../../../shared/externalSessions";

const FOLLOW_KEY = "app.externalSessionFollowEnabled";
interface Dependencies {
  settings: {
    get: (key: typeof FOLLOW_KEY) => unknown;
    subscribe: (fn: (key: string, value: unknown) => void) => () => void;
  };
  firstUsable: () => Promise<void>;
  createWatcher: () => Pick<ExternalSessionWatcher, "start" | "stop">;
  ingestor: ExternalSessionIngestor;
  createSources: () => ExternalSessionSource[];
  persistence: ExternalSessionPersistence;
  sessions: ReturnType<typeof AISessionsRepository.getStore>;
  getRoutes: () => Promise<ExternalScope[]>;
  subscribeLocalActivity?: (
    onActivity: (sessionId: string) => void
  ) => () => void;
}

export class ExternalSessionService {
  private initialized = false;
  private stopped = false;
  private generation = 0;
  private unsubscribe?: () => void;
  private unsubscribeActivity?: () => void;
  private watcher?: Pick<ExternalSessionWatcher, "start" | "stop">;
  private closing: Promise<unknown> = Promise.resolve();
  private manual = new Set<Promise<unknown>>();
  constructor(private readonly deps: Dependencies) {}

  initialize(): void {
    if (this.initialized || this.stopped) return;
    this.initialized = true;
    this.unsubscribeActivity = this.deps.subscribeLocalActivity?.((id) => {
      this.deps.ingestor.fenceLocalOwnership(id);
    });
    this.unsubscribe = this.deps.settings.subscribe((key) => {
      if (key === FOLLOW_KEY) this.reconcile();
    });
    this.reconcile();
  }
  private reconcile(): void {
    const generation = ++this.generation;
    // stop() revokes the watcher's eligibility before its first asynchronous close.
    if (this.watcher) {
      const stopped = this.watcher.stop();
      this.watcher = undefined;
      this.closing = Promise.allSettled([this.closing, stopped]);
    }
    if (this.stopped || this.deps.settings.get(FOLLOW_KEY) !== true) return;
    void this.enable(generation).catch((error) =>
      logger.main.warn("[ExternalSessions] Enable failed", error)
    );
  }
  private async enable(generation: number): Promise<void> {
    await this.deps.firstUsable();
    await this.closing;
    if (
      this.stopped ||
      generation !== this.generation ||
      this.deps.settings.get(FOLLOW_KEY) !== true
    )
      return;
    this.watcher = this.deps.createWatcher();
    await this.watcher.start();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribeActivity?.();
    this.reconcile();
    // Stop the writer synchronously too; manual imports are independent of the
    // opt-in, but must never outlive the database.
    const writer = this.deps.ingestor.stop();
    await Promise.allSettled([this.closing, writer, ...this.manual]);
  }

  claimLocalExecution(sessionId: string): Promise<void> {
    if (this.stopped)
      return Promise.reject(new Error("External session service stopped"));
    return this.deps.ingestor.takeLocalOwnership(sessionId);
  }

  scan(
    workspacePath?: string,
    providerId?: ExternalProviderId
  ): Promise<ExternalSessionSummary[]> {
    return this.trackManual(async () => {
      const sources = this.deps
        .createSources()
        .filter((source) => !providerId || source.providerId === providerId);
      try {
        const refs = await this.discoverManual(sources, workspacePath);
        const routes = await this.deps.getRoutes();
        const summaries: ExternalSessionSummary[] = [];
        for (const ref of refs.filter((ref) => !ref.parentToolUseId)) {
          if (this.stopped) throw new Error("External session service stopped");
          let route: ExternalWorkspaceRoute;
          try {
            route = resolveExternalRoute(ref.workspacePath, routes);
          } catch {
            // One multiply-owned worktree must not hide other selectable sessions.
            continue;
          }
          const localId = await this.deps.persistence.resolveSessionId({
            ...ref,
            workspaceId: route.workspacePath,
          });
          const local = localId ? await this.deps.sessions.get(localId) : null;
          summaries.push({
            providerId: ref.providerId,
            sessionId: ref.externalId,
            workspacePath: ref.workspacePath,
            title: ref.title ?? "Imported Session",
            createdAt: ref.createdAt ?? ref.updatedAt,
            updatedAt: ref.updatedAt,
            messageCount: null,
            tokenUsage: null,
            syncStatus: !local
              ? "new"
              : ref.updatedAt > local.updatedAt + 1000
              ? "needs-update"
              : "up-to-date",
          });
        }
        return summaries;
      } finally {
        await Promise.all(sources.map((source) => source.dispose()));
      }
    });
  }
  sync(
    selections: ExternalSessionSelection[],
    _workspacePath?: string
  ): Promise<ExternalSessionSyncResult[]> {
    return this.trackManual(async () => {
      if (selections.length > 256)
        throw new Error("Select at most 256 sessions per import");
      const sources = this.deps.createSources();
      try {
        // Re-resolve every selected identity on main. Renderer file paths are never accepted.
        const refs: ExternalSessionRef[] = [];
        // The dialog can explicitly select rows from its all-workspace fallback.
        // Its original workspace hint must not replace those selected identities.
        for (const selectedWorkspace of new Set(
          selections.map((selection) => selection.workspacePath)
        )) {
          refs.push(...(await this.discoverManual(sources, selectedWorkspace)));
        }
        const routes = await this.deps.getRoutes();
        const results: ExternalSessionSyncResult[] = [];
        for (const selection of selections) {
          let messagesAdded = 0;
          try {
            const matches = refs.filter(
              (ref) =>
                ref.providerId === selection.providerId &&
                ref.externalId === selection.sessionId &&
                ref.workspacePath === selection.workspacePath
            );
            const parents = matches.filter((ref) => !ref.parentToolUseId);
            if (parents.length !== 1)
              throw new Error(
                parents.length
                  ? "Ambiguous external session identity"
                  : "External session not found"
              );
            const source = sources.find(
              (source) => source.providerId === selection.providerId
            )!;
            const route = resolveExternalRoute(selection.workspacePath, routes);
            for (const ref of [
              ...parents,
              ...matches.filter((ref) => ref.parentToolUseId),
            ]) {
              let hasMore = true;
              while (hasMore) {
                if (this.stopped)
                  throw new Error("External session service stopped");
                const result = await this.deps.ingestor.ingest(
                  source,
                  ref,
                  route,
                  { manual: true, isEligible: () => !this.stopped }
                );
                messagesAdded += result.messagesAdded;
                hasMore = result.hasMore;
                // Yield between bounded batches so manual backfill does not monopolize the worker.
                if (hasMore)
                  await new Promise((resolve) => setTimeout(resolve, 0));
              }
            }
            results.push({ ...selection, success: true, messagesAdded });
          } catch (error) {
            results.push({
              ...selection,
              success: false,
              messagesAdded,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return results;
      } finally {
        await Promise.all(sources.map((source) => source.dispose()));
      }
    });
  }
  private async discoverManual(
    sources: ExternalSessionSource[],
    workspacePath?: string
  ): Promise<ExternalSessionRef[]> {
    const refs = new Map<string, ExternalSessionRef>();
    for (const source of sources) {
      let hasMore = true;
      while (hasMore) {
        if (this.stopped) throw new Error("External session service stopped");
        const page = await source.discoverPage(workspacePath);
        for (const ref of page.sessions) {
          refs.set(
            JSON.stringify([ref.providerId, ref.externalId, ref.filePath]),
            ref
          );
          if (refs.size > 10000)
            throw new Error(
              "Too many external files; choose a workspace to narrow the import"
            );
        }
        hasMore = page.hasMore;
        if (hasMore) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    return [...refs.values()];
  }
  private trackManual<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped)
      return Promise.reject(new Error("External session service stopped"));
    if (this.manual.size >= 4)
      return Promise.reject(
        new Error("An external session import is already busy")
      );
    const task = operation();
    this.manual.add(task);
    return task.finally(() => this.manual.delete(task));
  }
}

export function resolveExternalRoute(
  cwd: string,
  scopes: ExternalScope[]
): ExternalWorkspaceRoute {
  const matches = scopes.filter(
    (scope) => path.resolve(scope.cwd) === path.resolve(cwd)
  );
  const identities = new Map(
    matches.map((scope) => [
      JSON.stringify([scope.workspacePath, scope.worktreeId]),
      scope,
    ])
  );
  if (identities.size > 1)
    throw new Error("Ambiguous external workspace ownership");
  return identities.values().next().value ?? { workspacePath: cwd };
}

let singleton: ExternalSessionService | undefined;
export function getExternalSessionService(): ExternalSessionService {
  if (!singleton) {
    const sessions = AISessionsRepository.getStore();
    const persistence = new ExternalSessionPersistence(database);
    const ingestor = new ExternalSessionIngestor({
      sessions,
      persistence,
      getSessionState: (id) => getSessionStateManager().getSessionState(id),
      hasPendingOwnership: (ref, route) =>
        hasPendingExternalOwnership(
          sessions,
          getSessionStateManager(),
          ref,
          route
        ),
      readLegacyMessages: (id, provider, afterId) =>
        readLegacyExternalMessages(database, id, provider, afterId),
      processNewMessages: (id, provider) =>
        TranscriptMigrationRepository.getService().processNewMessages(
          id,
          provider
        ),
      refresh: (workspacePath) => {
        for (const win of windows.values()) {
          if (!win.isDestroyed())
            win.webContents.send("sessions:refresh-list", { workspacePath });
        }
      },
    });
    const createSources = () => [new ClaudeCodeSource(), new CodexSource()];
    const worktrees = createWorktreeStore(database);
    const getRoutes = async (): Promise<ExternalScope[]> => {
      const routes: ExternalScope[] = [];
      for (const workspacePath of listOpenWorkspacePaths()) {
        routes.push({ cwd: workspacePath, workspacePath });
        for (const tree of await worktrees.list(workspacePath))
          routes.push({ cwd: tree.path, workspacePath, worktreeId: tree.id });
      }
      return routes;
    };
    singleton = new ExternalSessionService({
      sessions,
      persistence,
      ingestor,
      createSources,
      getRoutes,
      settings: getSettingsService(),
      firstUsable: whenFirstUsable,
      subscribeLocalActivity: (onActivity) => {
        const manager = getSessionStateManager();
        const unsubscribe = manager.subscribe((event) => {
          if (
            [
              "session:started",
              "session:streaming",
              "session:waiting",
            ].includes(event.type)
          )
            onActivity(event.sessionId);
        });
        for (const id of manager.getTrackedSessionIds()) {
          const state = manager.getSessionState(id);
          if (
            state &&
            (state.isStreaming || !["idle", "error"].includes(state.status))
          )
            onActivity(id);
        }
        return unsubscribe;
      },
      createWatcher: () =>
        new ExternalSessionWatcher({
          sources: createSources(),
          ingestor,
          getRoutes,
          scopeIsCurrent: (route) =>
            listOpenWorkspacePaths().includes(route.workspacePath),
        }),
    });
  }
  return singleton;
}
export function stopExternalSessionService(): Promise<void> {
  return singleton?.stop() ?? Promise.resolve();
}

/** Lazy callers avoid initializing watchers or introducing a startup cycle. */
export function claimExternalSessionForLocalExecution(
  sessionId: string
): Promise<void> {
  return getExternalSessionService().claimLocalExecution(sessionId);
}
