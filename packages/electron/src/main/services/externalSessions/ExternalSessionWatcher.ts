import { watch as watchDir, type FSWatcher } from "fs";
import * as path from "path";
import { logger } from "../../utils/logger";
import { supportsRecursiveWatch } from "../../file/WorkspaceNativeWatcher";
import {
  ExternalIngestQueueFullError,
  type ExternalSessionRef,
  type ExternalSessionSource,
} from "./types";
import type {
  ExternalSessionIngestor,
  ExternalWorkspaceRoute,
} from "./ExternalSessionIngestor";

export interface ExternalScope extends ExternalWorkspaceRoute {
  cwd: string;
}
interface Dependencies {
  sources: ExternalSessionSource[];
  ingestor: Pick<ExternalSessionIngestor, "ingest">;
  getRoutes: () => Promise<ExternalScope[]>;
  watch?: (
    root: string,
    options: { recursive: boolean; persistent: boolean },
    listener: (type: string, filename: string | null) => void
  ) => Pick<FSWatcher, "on" | "close">;
  intervalMs?: number;
  scopeIsCurrent?: (scope: ExternalScope) => boolean;
}
// GitHub #1812: when a session file fails to import, leave it alone for a while
// instead of trying it again on every scan. The first wait is one minute. The
// wait doubles after each failure in a row, up to 30 minutes. A file that has
// changed on disk, or that imports successfully, starts over with no wait.
const RETRY_BACKOFF_BASE_MS = 60_000;
const RETRY_BACKOFF_MAX_MS = 30 * 60_000;
// Same size limit as the settled-file list below: the oldest entry goes first.
const MAX_FAILING_FILES = 8192;

/** Bounded discovery is also the recovery path for dropped events, absent roots,
 * new workspaces and Codex date rollover. No filesystem work occurs before start. */
export class ExternalSessionWatcher {
  private generation = 0;
  private enabled = false;
  // One directory handle per root. A per-file watcher held a descriptor for
  // every transcript under ~/.claude/projects (2,096 on one machine).
  private handles = new Map<string, Pick<FSWatcher, "on" | "close">>();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private roots = new Set<string>();
  private changed = new Set<string>();
  private routes = new Map<string, ExternalScope>();
  private discoveryIndex = 0;
  // Keep at most one source-bounded page (100 entries for production sources).
  // Never ask the source to advance while an earlier page still has a tail.
  private pendingDiscovery?: {
    source: ExternalSessionSource;
    cwd: string;
    route: ExternalScope;
    refs: ExternalSessionRef[];
    /** Discovery-time stamps: taken before the read, so a later append never looks settled. */
    stamps: Map<string, string>;
    next: number;
  };
  // Files whose last ingest could learn nothing more, keyed to the stamp they had.
  // Discovery is the recovery path for missed events; revisiting these every
  // pass re-read and re-queried every log in the project.
  private settled = new Map<string, string>();
  // Files whose last import failed. Each entry remembers what the file looked
  // like at the time (so a change is noticed), how many failures in a row, and
  // when the next try is allowed.
  private failing = new Map<
    string,
    {
      /** Discovery-time stamp, when the source reports one. */
      stamp?: string;
      updatedAt: number;
      failures: number;
      retryAt: number;
    }
  >();
  constructor(private readonly deps: Dependencies) {}

  start(): Promise<void> {
    if (this.enabled) return this.running ?? Promise.resolve();
    this.enabled = true;
    this.generation++;
    return this.tick();
  }

  /** The generation changes before the first await. */
  async stop(): Promise<void> {
    this.enabled = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const handle of this.handles.values()) handle.close();
    this.handles.clear();
    await this.running;
    await Promise.all(this.deps.sources.map((source) => source.dispose()));
    this.changed.clear();
    this.settled.clear();
    this.failing.clear();
    this.pendingDiscovery = undefined;
    this.routes.clear();
    this.roots.clear();
  }

  private ignorePath(file: string): boolean {
    const candidate = path.resolve(file);
    const contains = (root: string, child: string) =>
      child === root || child.startsWith(root + path.sep);
    const roots = [...this.roots];
    // Ancestors are watched shallowly for creation/rollover. Only leaf roots
    // admit descendants, so the Codex session root never watches past dates.
    return !roots.some(
      (root) =>
        contains(candidate, root) ||
        (!roots.some((other) => other !== root && contains(root, other)) &&
          contains(root, candidate))
    );
  }
  private syncWatches(): void {
    for (const [root, handle] of this.handles)
      if (!this.roots.has(root)) {
        handle.close();
        this.handles.delete(root);
      }
    for (const root of this.roots) {
      if (this.handles.has(root)) continue;
      // Ancestors report only the creation of their children. Leaves admit
      // descendants (Claude subagent logs); Linux has no native recursive
      // watch, so discovery picks those up there.
      const leaf = ![...this.roots].some(
        (other) => other !== root && other.startsWith(root + path.sep)
      );
      try {
        const handle = (this.deps.watch ?? watchDir)(
          root,
          { recursive: leaf && supportsRecursiveWatch, persistent: false },
          (_type, filename) => this.onEvent(root, filename)
        );
        handle.on("error", (error) => {
          handle.close();
          if (this.handles.get(root) === handle) this.handles.delete(root);
          logger.main.warn(
            "[ExternalSessions] Watch error; scoped polling will retry",
            error
          );
        });
        this.handles.set(root, handle);
      } catch (error: any) {
        // A root created later (a new day, a first session) is retried next scan.
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR")
          logger.main.warn(
            "[ExternalSessions] Watch failed; scoped polling will retry",
            error
          );
      }
    }
  }
  /** True while a file that failed to import is unchanged and its wait is not over. */
  private isBackingOff(ref: ExternalSessionRef, stamp?: string): boolean {
    const failure = this.failing.get(ref.filePath);
    if (!failure || Date.now() >= failure.retryAt) return false;
    // A file that changed since the failure may import now, so try it at once.
    return failure.stamp === stamp && failure.updatedAt === ref.updatedAt;
  }
  /** Remembers a failure and returns when the next try is allowed. */
  private recordFailure(ref: ExternalSessionRef, stamp?: string) {
    const previous = this.failing.get(ref.filePath);
    // A file that changed since its last failure starts over at one.
    const failures =
      previous &&
      previous.stamp === stamp &&
      previous.updatedAt === ref.updatedAt
        ? previous.failures + 1
        : 1;
    const wait = Math.min(
      RETRY_BACKOFF_BASE_MS * 2 ** (failures - 1),
      RETRY_BACKOFF_MAX_MS
    );
    const retryAt = Date.now() + wait;
    this.failing.delete(ref.filePath);
    this.failing.set(ref.filePath, {
      stamp,
      updatedAt: ref.updatedAt,
      failures,
      retryAt,
    });
    if (this.failing.size > MAX_FAILING_FILES)
      this.failing.delete(this.failing.keys().next().value!);
    return { failures, retryAt };
  }
  private onEvent(root: string, filename: string | null): void {
    if (!this.enabled || !filename) return;
    const file = path.join(root, filename);
    if (this.ignorePath(file)) return;
    if (file.endsWith(".jsonl") && this.changed.size < 512)
      this.changed.add(file);
    this.schedule(100);
  }
  private schedule(delay: number): void {
    if (!this.enabled || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
    this.timer.unref?.();
  }
  private tick(): Promise<void> {
    if (this.running) return this.running;
    const generation = this.generation;
    this.running = this.scan(generation)
      .catch((error) =>
        logger.main.warn("[ExternalSessions] Scoped scan failed", error)
      )
      .finally(() => {
        this.running = undefined;
        this.schedule(
          this.changed.size || this.pendingDiscovery
            ? 100
            : this.deps.intervalMs ?? 5000
        );
      });
    return this.running;
  }
  private async scan(generation: number): Promise<void> {
    const eligible = () => this.enabled && this.generation === generation;
    const scopes = await this.deps.getRoutes();
    if (!eligible()) return;
    const routes = new Map<string, ExternalScope>();
    const ambiguous = new Set<string>();
    for (const scope of scopes) {
      const cwd = path.resolve(scope.cwd);
      const previous = routes.get(cwd);
      if (
        previous &&
        (previous.workspacePath !== scope.workspacePath ||
          previous.worktreeId !== scope.worktreeId)
      )
        ambiguous.add(cwd);
      routes.set(cwd, scope);
    }
    for (const cwd of ambiguous) routes.delete(cwd);
    this.routes = routes;
    const roots = new Set(
      this.deps.sources.flatMap((source) =>
        routes.size ? source.watchRoots([...routes.keys()]) : []
      )
    );
    this.roots = roots;
    this.syncWatches();
    // Process event files directly; source identify validates cwd and ignores foreign paths.
    const files = [...this.changed].slice(0, 32);
    for (const file of files) {
      this.changed.delete(file);
      for (const source of this.deps.sources) {
        if (!eligible()) return;
        try {
          const ref = await source.identify(file, [...routes.keys()]);
          if (!eligible()) return;
          const route = ref && routes.get(path.resolve(ref.workspacePath));
          if (ref && route) {
            const result = await this.deps.ingestor.ingest(source, ref, route, {
              isEligible: () =>
                eligible() && (this.deps.scopeIsCurrent?.(route) ?? true),
            });
            if (result.hasMore && this.changed.size < 512)
              this.changed.add(file);
          }
        } catch (error) {
          // Classify against built-ins; both message and a custom name may contain source data.
          const errorName =
            [
              TypeError,
              SyntaxError,
              RangeError,
              ReferenceError,
              URIError,
              EvalError,
              Error,
            ].find((kind) => error instanceof kind)?.name ?? "UnknownError";
          logger.main.warn(
            "[ExternalSessions] Event batch failed; scoped discovery will retry",
            { providerId: source.providerId, filePath: file, errorName }
          );
        }
      }
    }
    // At most four discovery calls and 64 discovered references per pass.
    // A source advances its own iterator when returning a page, so retaining the
    // unprocessed tail is essential: rediscovery does not promise to revisit it.
    const pairs = this.deps.sources.flatMap((source) =>
      [...routes].map(([cwd, route]) => ({ source, cwd, route }))
    );
    // Finish a carried page before waiting for the normal poll interval. Filling
    // another page immediately would keep a >64-entry directory on a 100ms loop.
    const maxPages = this.pendingDiscovery ? 0 : Math.min(4, pairs.length);
    let pagesRead = 0;
    let remaining = 64;
    while (remaining > 0 && (this.pendingDiscovery || pagesRead < maxPages)) {
      if (!eligible()) return;
      if (!this.pendingDiscovery) {
        const { source, cwd, route } =
          pairs[this.discoveryIndex++ % pairs.length];
        const stamps = new Map<string, string>();
        const refs = await source.discover(cwd, {
          skipUnchanged: (file, { inode, size, mtimeMs }) => {
            const stamp = `${inode}:${size}:${mtimeMs}`;
            if (this.settled.get(file) === stamp) return true;
            stamps.set(file, stamp);
            return false;
          },
        });
        pagesRead++;
        if (!eligible()) return;
        this.pendingDiscovery = { source, cwd, route, refs, stamps, next: 0 };
      }
      const page = this.pendingDiscovery;
      const route = routes.get(page.cwd);
      if (
        !route ||
        route.workspacePath !== page.route.workspacePath ||
        route.worktreeId !== page.route.worktreeId ||
        !(this.deps.scopeIsCurrent?.(route) ?? true)
      ) {
        this.pendingDiscovery = undefined;
        continue;
      }
      while (remaining > 0 && page.next < page.refs.length) {
        if (!eligible()) return;
        const ref = page.refs[page.next++];
        remaining--;
        if (path.resolve(ref.workspacePath) !== page.cwd) continue;
        const stamp = page.stamps.get(ref.filePath);
        if (this.isBackingOff(ref, stamp)) continue;
        try {
          const result = await this.deps.ingestor.ingest(
            page.source,
            ref,
            route,
            {
              isEligible: () =>
                eligible() && (this.deps.scopeIsCurrent?.(route) ?? true),
            }
          );
          if (result.hasMore && this.changed.size < 512)
            this.changed.add(ref.filePath);
          this.failing.delete(ref.filePath);
          this.settled.delete(ref.filePath);
          if (result.settled && stamp) {
            this.settled.set(ref.filePath, stamp);
            if (this.settled.size > 8192)
              this.settled.delete(this.settled.keys().next().value!);
          }
        } catch (error) {
          this.settled.delete(ref.filePath);
          if (error instanceof ExternalIngestQueueFullError) {
            // A full queue says nothing about the file, so it earns no wait.
            logger.main.warn(
              "[ExternalSessions] Import queue full; next scoped scan retries",
              { filePath: ref.filePath }
            );
            continue;
          }
          const { failures, retryAt } = this.recordFailure(ref, stamp);
          logger.main.warn(
            "[ExternalSessions] Import batch failed; retrying after a wait",
            error,
            {
              filePath: ref.filePath,
              failures,
              nextRetryAt: new Date(retryAt).toISOString(),
            }
          );
        }
      }
      if (page.next === page.refs.length) this.pendingDiscovery = undefined;
    }
  }
}
