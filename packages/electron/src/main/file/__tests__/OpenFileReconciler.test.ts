// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rename, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { OpenFileReconciler } from "../OpenFileReconciler";

describe("open-file reconciliation without native events", () => {
  let reconciler: OpenFileReconciler;
  beforeEach(() => {
    vi.useFakeTimers();
    reconciler = new OpenFileReconciler();
  });
  afterEach(() => {
    reconciler.stop();
    vi.useRealTimers();
  });

  it("observes an atomic external replacement, deduplicates owners, and stops after final release", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nim-reconcile-"));
    try {
      const path = join(dir, "note.md");
      await writeFile(path, "old");
      const first = vi.fn();
      const second = vi.fn();
      reconciler.register("window1", "token1", path, first);
      reconciler.register("window2", "token2", path, second);
      await reconciler.reconcile();
      first.mockClear();
      second.mockClear();
      await writeFile(join(dir, "replacement"), "new");
      await rename(join(dir, "replacement"), path);
      await reconciler.reconcile();
      expect(first).toHaveBeenCalledWith({ status: "changed" });
      expect(second).toHaveBeenCalledTimes(1);
      expect(await readFile(path, "utf8")).toBe("new");
      reconciler.releaseOwner("window1");
      expect(reconciler.getStats().registeredPaths).toBe(1);
      reconciler.releaseOwner("window2");
      const probes = reconciler.getStats().probes;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(reconciler.getStats().probes).toBe(probes);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forces a periodic read even when metadata is unchanged and keeps idle checks cheap", async () => {
    reconciler = new OpenFileReconciler(
      vi
        .fn()
        .mockResolvedValue({ dev: 1, ino: 1, size: 3, mtimeMs: 1, ctimeMs: 1 })
    );
    const notify = vi.fn();
    reconciler.register("window", "token", "/test/note.md", notify);
    await reconciler.reconcile();
    notify.mockClear();
    await vi.advanceTimersByTimeAsync(55_000);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(notify).toHaveBeenCalledTimes(1);
    await reconciler.reconcile(true, "unrelated-window");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not deliver a stale deletion after the last owner closes and reopens the same path", async () => {
    let finish!: (exists: boolean) => void;
    const stat = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("missing"), { code: "ENOENT" })
      );
    reconciler = new OpenFileReconciler(
      stat,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const old = vi.fn();
    const fresh = vi.fn();
    reconciler.register("window", "old", "/test/note.md", old);
    await vi.advanceTimersByTimeAsync(0);
    reconciler.unregister("window", "old");
    stat.mockResolvedValue({ dev: 1, ino: 2, size: 3, mtimeMs: 2, ctimeMs: 2 });
    reconciler.register("window", "new", "/test/note.md", fresh);
    finish(false);
    await reconciler.reconcile();
    expect(old).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledWith({ status: "changed" });
  });

  it("does not turn a permission error into deletion and retries on the next pass", async () => {
    const stat = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("denied"), { code: "EACCES" })
      );
    reconciler = new OpenFileReconciler(stat);
    const notify = vi.fn();
    reconciler.register("window", "token", "/test/note.md", notify);
    await reconciler.reconcile();
    expect(notify).toHaveBeenCalledWith({
      status: "error",
      errorCode: "EACCES",
    });
    stat.mockResolvedValue({ dev: 1, ino: 1, size: 3, mtimeMs: 1, ctimeMs: 1 });
    await reconciler.reconcile();
    expect(notify).toHaveBeenLastCalledWith({ status: "changed" });
  });

  it("bounds simultaneous probes and coalesces repeated requests while a path is busy", async () => {
    const finishes: Array<() => void> = [];
    let running = 0;
    let peak = 0;
    reconciler = new OpenFileReconciler(async () => {
      peak = Math.max(peak, ++running);
      await new Promise<void>((resolve) => finishes.push(resolve));
      running--;
      return { dev: 1, ino: 1, size: 3, mtimeMs: 1, ctimeMs: 1 };
    });
    for (let i = 0; i < 20; i++)
      reconciler.register("window", String(i), `/test/${i}.md`, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(running).toBe(4);
    for (let i = 0; i < 10; i++) void reconciler.reconcile(true);
    while (finishes.length) {
      finishes.splice(0).forEach((finish) => finish());
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(peak).toBe(4);
    expect(reconciler.getStats().probes).toBe(24);
  });
});
