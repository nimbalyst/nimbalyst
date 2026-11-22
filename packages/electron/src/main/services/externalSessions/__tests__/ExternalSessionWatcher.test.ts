// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ExternalSessionWatcher } from "../ExternalSessionWatcher";
import { logger } from "../../../utils/logger";
import type { ExternalSessionIngestor } from "../ExternalSessionIngestor";
import { ExternalIngestQueueFullError } from "../types";

type DirListener = (type: string, filename: string | null) => void;

function harness(intervalMs = 60_000) {
  const handle = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn(),
  };
  const source: any = {
    providerId: "claude-code",
    watchRoots: vi.fn(() => ["/logs"]),
    discover: vi.fn(async () => []),
    identify: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
  const ingest = vi.fn<ExternalSessionIngestor["ingest"]>(async () => ({
    messagesAdded: 0,
    hasMore: false,
  }));
  const routes = vi.fn(async () => [
    { cwd: "/workspace", workspacePath: "/workspace" },
  ]);
  const scopeIsCurrent = vi.fn(() => true);
  const watch = vi.fn<
    (root: string, options: { recursive?: boolean }, listener: DirListener) => typeof handle
  >(() => handle);
  /** Delivers a directory event as fs.watch does: the name is relative to the watched root. */
  const emit = (root: string, filename: string) => {
    const call = watch.mock.calls.find(([watched]) => watched === root);
    if (!call) throw new Error(`No watch on ${root}`);
    call[2]("rename", filename);
  };
  const watcher = new ExternalSessionWatcher({
    sources: [source as any],
    ingestor: { ingest } as any,
    getRoutes: routes,
    watch: watch as any,
    scopeIsCurrent,
    intervalMs,
  });
  return { watcher, source, handle, routes, ingest, scopeIsCurrent, watch, emit };
}
describe("ExternalSessionWatcher", () => {
  it.each(["identify", "ingest"] as const)(
    "isolates a poisoned event's %s error from healthy events and discovery",
    async (failure) => {
      vi.useFakeTimers();
      const h = harness();
      const warning = vi.spyOn(logger.main, "warn");
      const poisonedError = Object.assign(
        new TypeError("private source content"),
        {
          name: "private custom error name",
        }
      );
      try {
        await h.watcher.start();
        const makeRef = (id: string) => ({
          providerId: "claude-code" as const,
          externalId: id,
          workspacePath: "/workspace",
          filePath: `/logs/${id}.jsonl`,
          updatedAt: 1,
        });
        h.source.identify.mockImplementation(async (file: string) => {
          if (failure === "identify" && file.includes("poison"))
            throw poisonedError;
          return makeRef(file.includes("poison") ? "poison" : "healthy-event");
        });
        h.ingest.mockImplementation(async (_source, ref) => {
          if (failure === "ingest" && ref.externalId === "poison")
            throw poisonedError;
          return { messagesAdded: 1, hasMore: false };
        });
        h.source.discover.mockResolvedValue([makeRef("healthy-discovery")]);
        h.emit("/logs", "poison.jsonl");
        h.emit("/logs", "healthy.jsonl");
        await vi.advanceTimersToNextTimerAsync();
        expect(h.ingest.mock.calls.map(([, ref]) => ref.externalId)).toContain(
          "healthy-event"
        );
        expect(h.ingest.mock.calls.map(([, ref]) => ref.externalId)).toContain(
          "healthy-discovery"
        );
        expect(warning).toHaveBeenCalledWith(
          "[ExternalSessions] Event batch failed; scoped discovery will retry",
          {
            providerId: "claude-code",
            filePath: "/logs/poison.jsonl",
            errorName: "TypeError",
          }
        );
        expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
      } finally {
        await h.watcher.stop();
        warning.mockRestore();
        vi.useRealTimers();
      }
    }
  );
  it("revisits unchanged eligible EOF files on periodic discovery and cancels that work on stop", async () => {
    vi.useFakeTimers();
    const h = harness(5000);
    h.source.discover.mockResolvedValue([
      {
        providerId: "claude-code",
        externalId: "idle-file",
        workspacePath: "/workspace",
        filePath: "/logs/idle.jsonl",
        updatedAt: 1,
      },
    ]);
    try {
      await h.watcher.start();
      expect(h.ingest).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.ingest).toHaveBeenCalledTimes(2);
      expect(h.source.identify).not.toHaveBeenCalled();
      await h.watcher.stop();
      await vi.advanceTimersByTimeAsync(10000);
      expect(h.ingest).toHaveBeenCalledTimes(2);
    } finally {
      await h.watcher.stop();
      vi.useRealTimers();
    }
  });
  it("skips a settled file on later discovery passes until its file stamp changes", async () => {
    vi.useFakeTimers();
    const h = harness(5000);
    let stamp = { inode: 1, size: 10, mtimeMs: 1 };
    h.source.discover.mockImplementation(
      async (_cwd: string, options?: { skipUnchanged?: Function }) =>
        options?.skipUnchanged?.("/logs/idle.jsonl", stamp)
          ? []
          : [
              {
                providerId: "claude-code",
                externalId: "idle-file",
                workspacePath: "/workspace",
                filePath: "/logs/idle.jsonl",
                updatedAt: 1,
              },
            ]
    );
    h.ingest.mockResolvedValueOnce({
      messagesAdded: 0,
      hasMore: false,
      skipped: true,
    });
    h.ingest.mockResolvedValue({
      messagesAdded: 0,
      hasMore: false,
      settled: true,
    });
    try {
      await h.watcher.start();
      // An unsettled outcome (e.g. a transient ownership skip) is retried.
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.ingest).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(15000);
      expect(h.ingest).toHaveBeenCalledTimes(2);
      stamp = { ...stamp, size: 20, mtimeMs: 2 };
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.ingest).toHaveBeenCalledTimes(3);
      // Restarting the watcher (setting toggle) forgets every settled stamp.
      await h.watcher.stop();
      await h.watcher.start();
      expect(h.ingest).toHaveBeenCalledTimes(4);
    } finally {
      await h.watcher.stop();
      vi.useRealTimers();
    }
  });
  it("preserves every reference from a discovery page across bounded ticks without filesystem events", async () => {
    vi.useFakeTimers();
    const h = harness();
    const refs = Array.from({ length: 100 }, (_, index) => ({
      providerId: "claude-code",
      externalId: `session-${index}`,
      workspacePath: "/workspace",
      filePath: `/logs/session-${index}.jsonl`,
      updatedAt: 1,
    }));
    h.source.discover.mockResolvedValue(refs);
    try {
      await h.watcher.start();
      expect(h.ingest.mock.calls.length).toBeLessThanOrEqual(64);
      for (let pass = 0; pass < 4; pass++) {
        const before = h.ingest.mock.calls.length;
        await vi.advanceTimersByTimeAsync(100);
        expect(h.ingest.mock.calls.length - before).toBeLessThanOrEqual(64);
      }
      expect(
        new Set(h.ingest.mock.calls.map(([, ref]) => ref.externalId)).size
      ).toBe(100);
      expect(h.source.identify).not.toHaveBeenCalled();
      expect(h.source.discover).toHaveBeenCalledTimes(1);
      // A later regular poll leaves another page tail, which must be discarded
      // if its workspace closes before the continuation.
      await vi.advanceTimersToNextTimerAsync();
      expect(h.ingest).toHaveBeenCalledTimes(164);
      h.routes.mockResolvedValue([]);
      const beforeClose = h.ingest.mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      expect(h.ingest).toHaveBeenCalledTimes(beforeClose);
      await h.watcher.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.ingest).toHaveBeenCalledTimes(beforeClose);
    } finally {
      await h.watcher.stop();
      vi.useRealTimers();
    }
  });

  it("watches only explicit roots and revokes queued discoveries synchronously on stop", async () => {
    const h = harness();
    let resolve!: (refs: any[]) => void;
    h.source.discover.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const start = h.watcher.start();
    await vi.waitFor(() =>
      expect(h.source.discover).toHaveBeenCalledWith(
        "/workspace",
        expect.anything()
      )
    );
    const stop = h.watcher.stop();
    resolve([
      {
        providerId: "claude-code",
        externalId: "id",
        workspacePath: "/workspace",
        filePath: "/logs/id.jsonl",
      },
    ]);
    await Promise.all([start, stop]);
    expect(h.ingest).not.toHaveBeenCalled();
    expect(h.handle.close).toHaveBeenCalledTimes(1);
    expect(h.source.dispose).toHaveBeenCalledTimes(1);
  });
  it("watches each root as one directory, recursive only for leaves, and ignores historical Codex trees", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.source.watchRoots.mockReturnValue([
      "/codex/sessions",
      "/codex/sessions/2026",
      "/codex/sessions/2026/09",
      "/codex/sessions/2026/09/14",
    ]);
    await h.watcher.start();
    // One directory handle per root, never one per file under it.
    expect(
      h.watch.mock.calls.map(([root, options]) => [root, options.recursive])
    ).toEqual([
      ["/codex/sessions", false],
      ["/codex/sessions/2026", false],
      ["/codex/sessions/2026/09", false],
      ["/codex/sessions/2026/09/14", process.platform !== "linux"],
    ]);
    h.emit("/codex/sessions", "2025/01/01/rollout-old.jsonl");
    h.emit("/codex/sessions/2026/09/14", "rollout-live.jsonl");
    await vi.advanceTimersToNextTimerAsync();
    expect(h.source.identify).toHaveBeenCalledWith(
      "/codex/sessions/2026/09/14/rollout-live.jsonl",
      ["/workspace"]
    );
    expect(h.source.identify).not.toHaveBeenCalledWith(
      "/codex/sessions/2025/01/01/rollout-old.jsonl",
      expect.anything()
    );
    await h.watcher.stop();
    vi.useRealTimers();
    expect(h.handle.close).toHaveBeenCalledTimes(4);
  });
  it("retries a root that does not exist yet on the next scan", async () => {
    vi.useFakeTimers();
    const h = harness(5000);
    try {
      h.watch.mockImplementationOnce(() => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      });
      await h.watcher.start();
      expect(h.watch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.watch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.watch).toHaveBeenCalledTimes(2);
    } finally {
      await h.watcher.stop();
      vi.useRealTimers();
    }
  });
  it("revokes a source read when its workspace closes between scan and commit", async () => {
    const h = harness();
    h.source.discover.mockResolvedValue([
      {
        providerId: "claude-code",
        externalId: "id",
        workspacePath: "/workspace",
        filePath: "/logs/id.jsonl",
      },
    ] as any);
    let eligibleAfterClose = true;
    h.ingest.mockImplementation(async (_source, _ref, _route, options) => {
      expect(options!.isEligible!()).toBe(true);
      h.scopeIsCurrent.mockReturnValue(false);
      eligibleAfterClose = options!.isEligible!();
      return { messagesAdded: 0, hasMore: false };
    });
    await h.watcher.start();
    expect(eligibleAfterClose).toBe(false);
    await h.watcher.stop();
  });
  it("rejects ambiguous cwd ownership and does not fall back to unscoped discovery", async () => {
    const h = harness();
    h.routes.mockResolvedValue([
      { cwd: "/tree", workspacePath: "/a" },
      { cwd: "/tree", workspacePath: "/b" },
    ]);
    await h.watcher.start();
    expect(h.source.discover).not.toHaveBeenCalled();
    await h.watcher.stop();
  });

  // GitHub #1812: one session log that can never be imported (for example a
  // history too large to read) used to be retried on every pass, forever.
  describe("back-off for a file that keeps failing to import", () => {
    const BAD = "/logs/bad.jsonl";
    const GOOD = "/logs/good.jsonl";
    function backoffHarness(options: { reportsStamps?: boolean } = {}) {
      const { reportsStamps = true } = options;
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
      const h = harness(5000);
      // What the disk says about each log file right now.
      const disk = new Map([
        [BAD, { size: 10, mtimeMs: 1 }],
        [GOOD, { size: 10, mtimeMs: 1 }],
      ]);
      h.source.discover.mockImplementation(
        async (
          _cwd: string,
          discoverOptions?: { skipUnchanged?: Function }
        ) =>
          [...disk]
            .filter(
              ([filePath, { size, mtimeMs }]) =>
                !(
                  reportsStamps &&
                  discoverOptions?.skipUnchanged?.(filePath, {
                    inode: 1,
                    size,
                    mtimeMs,
                  })
                )
            )
            .map(([filePath, { mtimeMs }]) => ({
              providerId: "claude-code" as const,
              externalId: filePath,
              workspacePath: "/workspace",
              filePath,
              updatedAt: mtimeMs,
            }))
      );
      const state = { badFails: true };
      h.ingest.mockImplementation(async (_source, ref) => {
        if (ref.filePath === BAD && state.badFails)
          throw new Error("history too large");
        return { messagesAdded: 0, hasMore: false };
      });
      const attempts = (file: string) =>
        h.ingest.mock.calls.filter(([, ref]) => ref.filePath === file).length;
      const warning = vi.spyOn(logger.main, "warn").mockImplementation(() => {});
      const cleanup = async () => {
        await h.watcher.stop();
        warning.mockRestore();
        vi.useRealTimers();
      };
      return { ...h, disk, state, attempts, warning, cleanup };
    }

    it("tries an unchanged failing file at most once in the first 10 seconds", async () => {
      const h = backoffHarness();
      try {
        await h.watcher.start();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(h.attempts(BAD)).toBeLessThanOrEqual(1);
      } finally {
        await h.cleanup();
      }
    });

    it("tries again once the wait is over, waits twice as long after each failure, and logs when", async () => {
      const h = backoffHarness();
      try {
        await h.watcher.start();
        await vi.advanceTimersByTimeAsync(59_000);
        expect(h.attempts(BAD)).toBe(1);
        // First wait: 1 minute.
        await vi.advanceTimersByTimeAsync(7_000);
        expect(h.attempts(BAD)).toBe(2);
        // Second wait: 2 minutes, counted from the second failure at 60 s.
        await vi.advanceTimersByTimeAsync(104_000);
        expect(h.attempts(BAD)).toBe(2);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(h.attempts(BAD)).toBe(3);
        // One warning per real attempt, with the planned next try time.
        expect(h.warning).toHaveBeenCalledTimes(3);
        expect(h.warning).toHaveBeenNthCalledWith(
          1,
          "[ExternalSessions] Import batch failed; retrying after a wait",
          expect.any(Error),
          expect.objectContaining({
            filePath: BAD,
            nextRetryAt: "2026-10-19T12:01:00.000Z",
          })
        );
        expect(h.warning).toHaveBeenNthCalledWith(
          2,
          expect.any(String),
          expect.any(Error),
          expect.objectContaining({ nextRetryAt: "2026-10-19T12:03:00.000Z" })
        );
      } finally {
        await h.cleanup();
      }
    });

    it.each([
      ["its size changes (a source that reports file stamps)", true, { size: 20 }],
      ["its modified time changes (a source with no file stamps)", false, { mtimeMs: 2 }],
    ] as const)(
      "tries a failing file again right away when %s",
      async (_name, reportsStamps, change) => {
        const h = backoffHarness({ reportsStamps });
        try {
          await h.watcher.start();
          await vi.advanceTimersByTimeAsync(5_000);
          expect(h.attempts(BAD)).toBe(1);
          h.disk.set(BAD, { ...h.disk.get(BAD)!, ...change });
          await vi.advanceTimersByTimeAsync(5_000);
          expect(h.attempts(BAD)).toBe(2);
        } finally {
          await h.cleanup();
        }
      }
    );

    it("tries a file again on the next poll after the ingest queue was full, with no wait", async () => {
      const h = backoffHarness();
      try {
        let queueFull = true;
        h.ingest.mockImplementation(async (_source, ref) => {
          if (ref.filePath === BAD && queueFull) {
            queueFull = false;
            throw new ExternalIngestQueueFullError();
          }
          return { messagesAdded: 0, hasMore: false };
        });
        await h.watcher.start();
        expect(h.attempts(BAD)).toBe(1);
        // The next poll is 5 seconds away, not a minute.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(h.attempts(BAD)).toBe(2);
      } finally {
        await h.cleanup();
      }
    });

    it("starts the count over when a failing file has changed", async () => {
      const h = backoffHarness();
      try {
        await h.watcher.start();
        // Fails at 0 s, 60 s and 180 s. The wait after the third failure is 4 minutes.
        await vi.advanceTimersByTimeAsync(180_000);
        expect(h.attempts(BAD)).toBe(3);
        // The file changes. It is tried at once and fails again.
        h.disk.set(BAD, { size: 20, mtimeMs: 1 });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(h.attempts(BAD)).toBe(4);
        // The wait is 1 minute again. A kept count would make it 8 minutes.
        await vi.advanceTimersByTimeAsync(55_000);
        expect(h.attempts(BAD)).toBe(4);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(h.attempts(BAD)).toBe(5);
      } finally {
        await h.cleanup();
      }
    });

    it("keeps importing other files while one file is backing off", async () => {
      const h = backoffHarness();
      try {
        await h.watcher.start();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(h.attempts(BAD)).toBe(1);
        expect(h.attempts(GOOD)).toBe(3);
      } finally {
        await h.cleanup();
      }
    });

    it("forgets the back-off after a success, so the next failure starts at 1 minute again", async () => {
      const h = backoffHarness();
      try {
        await h.watcher.start();
        // Fails at 0 s (wait 1 minute), then fails again at 60 s (wait 2 minutes).
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.attempts(BAD)).toBe(2);
        // Succeeds at 180 s.
        h.state.badFails = false;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(h.attempts(BAD)).toBe(3);
        // Fails again on the next pass. A remembered wait would now be 4 minutes.
        h.state.badFails = true;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(h.attempts(BAD)).toBe(4);
        await vi.advanceTimersByTimeAsync(65_000);
        expect(h.attempts(BAD)).toBe(5);
      } finally {
        await h.cleanup();
      }
    });
  });
});

it("finds a newly created scoped Codex root, follows date rollover, and stops importing after close", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const { CodexSource } = await import("../CodexSource");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "external-watcher-"));
  let now = new Date("2026-09-14T23:59:00Z");
  const source = new CodexSource({
    rootDir: path.join(dir, "sessions"),
    now: () => now,
  });
  const ingest = vi.fn<ExternalSessionIngestor["ingest"]>(async () => ({
    messagesAdded: 1,
    hasMore: false,
  }));
  const watcher = new ExternalSessionWatcher({
    sources: [source],
    ingestor: { ingest } as any,
    getRoutes: async () => [{ cwd: "/workspace", workspacePath: "/workspace" }],
    intervalMs: 20,
  });
  const write = async (date: string, id: string) => {
    const file = path.join(dir, "sessions", date, `rollout-${id}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        type: "session_meta",
        timestamp: now.toISOString(),
        payload: { id, cwd: "/workspace" },
      }) + "\n"
    );
  };
  try {
    await watcher.start();
    expect(ingest).not.toHaveBeenCalled();
    await write("2026/09/14", "today");
    await vi.waitFor(() =>
      expect(
        ingest.mock.calls.some(([, ref]) => ref.externalId === "today")
      ).toBe(true)
    );
    now = new Date("2026-09-15T00:01:00Z");
    await write("2026/09/15", "tomorrow");
    await write("2025/01/01", "historical");
    await vi.waitFor(() =>
      expect(
        ingest.mock.calls.some(([, ref]) => ref.externalId === "tomorrow")
      ).toBe(true)
    );
    expect(
      ingest.mock.calls.some(([, ref]) => ref.externalId === "historical")
    ).toBe(false);
    await watcher.stop();
    const count = ingest.mock.calls.length;
    await write("2026/09/15", "after-stop");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ingest).toHaveBeenCalledTimes(count);
  } finally {
    await watcher.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
