// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ExternalSessionService } from "../ExternalSessionService";

function harness(initial: unknown = false) {
  let value = initial;
  let change!: (key: string, value: unknown) => void;
  const settings = {
    get: vi.fn(() => value),
    subscribe: vi.fn((fn: (...args: any[]) => void) => {
      change = fn;
      return vi.fn();
    }),
  };
  const watchers: any[] = [];
  const createWatcher = vi.fn(() => {
    const watcher = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    watchers.push(watcher);
    return watcher;
  });
  let usable!: () => void;
  const firstUsable = new Promise<void>((r) => {
    usable = r;
  });
  let activity!: (id: string) => void;
  const subscribeLocalActivity = vi.fn((fn: (...args: any[]) => void) => {
    activity = fn;
    return vi.fn();
  });
  const ingestor = {
    takeLocalOwnership: vi.fn(async () => {}),
    fenceLocalOwnership: vi.fn(),
    stop: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
    ingest: vi.fn(),
  };
  const service = new ExternalSessionService({
    settings,
    firstUsable: () => firstUsable,
    createWatcher,
    ingestor,
    subscribeLocalActivity,
  } as any);
  return {
    activity: (id: string) => activity(id),
    service,
    settings,
    watchers,
    createWatcher,
    usable,
    ingestor,
    set: (next: unknown) => {
      value = next;
      change("app.externalSessionFollowEnabled", next);
    },
  };
}
describe("ExternalSessionService opt-in lifecycle", () => {
  it.each([undefined, false, "true", 1])(
    "does no automatic discovery or watching with setting %s",
    async (value) => {
      const h = harness(value);
      h.service.initialize();
      h.usable();
      await Promise.resolve();
      await Promise.resolve();
      expect(h.createWatcher).not.toHaveBeenCalled();
      await h.service.stop();
    }
  );
  it("fences local activity without a database operation while automatic follow is OFF", async () => {
    const h = harness(false);
    h.service.initialize();
    h.activity("resumed-import");
    expect(h.ingestor.fenceLocalOwnership).toHaveBeenCalledWith(
      "resumed-import"
    );
    expect(h.createWatcher).not.toHaveBeenCalled();
    await h.service.claimLocalExecution("resumed-import");
    expect(h.ingestor.takeLocalOwnership).toHaveBeenCalledOnce();
    expect(h.createWatcher).not.toHaveBeenCalled();
    await h.service.stop();
  });
  it("waits for first usable; disables synchronously and waits for the old watcher before re-enabling", async () => {
    const h = harness(true);
    h.service.initialize();
    expect(h.createWatcher).not.toHaveBeenCalled();
    h.usable();
    await vi.waitFor(() => expect(h.watchers[0]?.start).toHaveBeenCalledOnce());
    let closed!: () => void;
    h.watchers[0].stop.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          closed = r;
        })
    );
    h.set(false);
    expect(h.watchers[0].stop).toHaveBeenCalledOnce();
    h.set(true);
    await Promise.resolve();
    expect(h.createWatcher).toHaveBeenCalledTimes(1);
    closed();
    await vi.waitFor(() => expect(h.createWatcher).toHaveBeenCalledTimes(2));
    await h.service.stop();
    expect(h.ingestor.stop).toHaveBeenCalledOnce();
    h.set(true);
    expect(h.createWatcher).toHaveBeenCalledTimes(2);
  });
  it("a disable while awaiting first usable cancels initialization", async () => {
    const h = harness(true);
    h.service.initialize();
    h.set(false);
    h.usable();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.createWatcher).not.toHaveBeenCalled();
    await h.service.stop();
  });
});

describe("manual selections", () => {
  it("skips an ambiguously opened worktree while listing and syncing other sessions", async () => {
    const refs = ["/repoA/worktreeW", "/repoA"].map((workspacePath, index) => ({
      providerId: "claude-code",
      externalId: `external-${index}`,
      workspacePath,
      filePath: `/log-${index}`,
      updatedAt: 10,
    }));
    const source = {
      providerId: "claude-code",
      discoverPage: async (scope?: string) => ({
        sessions: refs.filter((ref) => !scope || ref.workspacePath === scope),
        hasMore: false,
      }),
      dispose: vi.fn(),
    };
    const ingestor = {
      ingest: vi.fn(async () => ({ messagesAdded: 1, hasMore: false })),
    };
    const service = new ExternalSessionService({
      createSources: () => [source],
      ingestor,
      persistence: { resolveSessionId: async () => null },
      getRoutes: async () => [
        { cwd: "/repoA", workspacePath: "/repoA" },
        { cwd: "/repoA/worktreeW", workspacePath: "/repoA", worktreeId: "W" },
        { cwd: "/repoA/worktreeW", workspacePath: "/repoA/worktreeW" },
      ],
    } as any);
    expect(await service.scan()).toEqual([
      expect.objectContaining({ sessionId: "external-1" }),
    ]);
    const results = await service.sync(
      refs.map((ref) => ({
        providerId: ref.providerId as "claude-code",
        sessionId: ref.externalId,
        workspacePath: ref.workspacePath,
      }))
    );
    expect(results.map((result) => result.success)).toEqual([false, true]);
    expect(ingestor.ingest).toHaveBeenCalledOnce();
  });
  it("re-resolves the selected workspace after a dialog all-workspace fallback, even with an original workspace hint", async () => {
    const ref = {
      providerId: "openai-codex",
      externalId: "external",
      workspacePath: "/other",
      filePath: "/log",
      updatedAt: 10,
    };
    const source = {
      providerId: "openai-codex",
      discoverPage: vi.fn(async (scope?: string) => ({
        sessions: scope === "/other" ? [ref] : [],
        hasMore: false,
      })),
      dispose: vi.fn(),
    };
    const ingestor = {
      ingest: vi.fn(async () => ({ messagesAdded: 1, hasMore: false })),
    };
    const service = new ExternalSessionService({
      createSources: () => [source],
      getRoutes: async () => [],
      ingestor,
    } as any);
    const results = await service.sync(
      [
        {
          providerId: "openai-codex",
          sessionId: "external",
          workspacePath: "/other",
        },
      ],
      "/original"
    );
    expect(results[0].success).toBe(true);
    expect(source.discoverPage).toHaveBeenCalledWith("/other");
  });
  it("reports absent source aggregates as unknown rather than known zero", async () => {
    const source = {
      providerId: "claude-code",
      discoverPage: async () => ({
        sessions: [
          {
            providerId: "claude-code",
            externalId: "external",
            workspacePath: "/workspace",
            filePath: "/log",
            updatedAt: 10,
          },
        ],
        hasMore: false,
      }),
      dispose: vi.fn(),
    };
    const service = new ExternalSessionService({
      createSources: () => [source],
      getRoutes: async () => [],
      persistence: { resolveSessionId: async () => null },
    } as any);
    const summaries = await service.scan("/workspace");
    expect(summaries[0].messageCount).toBeNull();
    expect(summaries[0].tokenUsage).toBeNull();
  });
});
