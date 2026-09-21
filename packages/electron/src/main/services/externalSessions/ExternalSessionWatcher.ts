import { watch as watchFiles, type FSWatcher } from "chokidar";
import * as path from "path";
import { logger } from "../../utils/logger";
import type { ExternalSessionRef, ExternalSessionSource } from "./types";
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
  watch?: typeof watchFiles;
  intervalMs?: number;
  scopeIsCurrent?: (scope: ExternalScope) => boolean;
}
/** Bounded discovery is also the recovery path for dropped events, absent roots,
 * new workspaces and Codex date rollover. No filesystem work occurs before start. */
export class ExternalSessionWatcher {
  private generation = 0;
  private enabled = false;
  private handle?: FSWatcher;
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
    next: number;
  };
  constructor(private readonly deps: Dependencies) {}

  start(): Promise<void> {
    if (this.enabled) return this.running ?? Promise.resolve();
    this.enabled = true;
    this.generation++;
    this.handle = (this.deps.watch ?? watchFiles)([], {
      ignoreInitial: true,
      persistent: false,
      depth: 6,
      ignored: (file) => this.ignorePath(file),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    this.handle.on("all", (_event, file) => {
      if (!this.enabled) return;
      if (file.endsWith(".jsonl") && this.changed.size < 512)
        this.changed.add(file);
      this.schedule(100);
    });
    this.handle.on("error", (error) =>
      logger.main.warn(
        "[ExternalSessions] Watch error; scoped polling will retry",
        error
      )
    );
    return this.tick();
  }

  /** The generation changes before the first await. */
  async stop(): Promise<void> {
    this.enabled = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close();
    await this.running;
    await Promise.all(this.deps.sources.map((source) => source.dispose()));
    this.changed.clear();
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
    for (const root of this.roots)
      if (!roots.has(root)) await this.handle?.unwatch(root);
    if (!eligible()) return;
    const previousRoots = this.roots;
    this.roots = roots;
    for (const root of roots)
      if (!previousRoots.has(root)) this.handle?.add(root);
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
        const refs = await source.discover(cwd);
        pagesRead++;
        if (!eligible()) return;
        this.pendingDiscovery = { source, cwd, route, refs, next: 0 };
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
        } catch (error) {
          logger.main.warn(
            "[ExternalSessions] Import batch failed; next scoped scan retries",
            error
          );
        }
      }
      if (page.next === page.refs.length) this.pendingDiscovery = undefined;
    }
  }
}
