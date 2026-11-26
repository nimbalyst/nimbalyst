// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  RecoveringFileWatcher,
  type WatchHandle,
} from "../RecoveringFileWatcher";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("invalidates old callbacks, backs off repeated failures, and cancels recovery on stop", async () => {
  const attempts: Array<{
    current: () => boolean;
    fail: (reason: string) => void;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const watcher = new RecoveringFileWatcher(
    (current, fail) => {
      const attempt = { current, fail, close: vi.fn() };
      attempts.push(attempt);
      return attempt;
    },
    vi.fn(),
    vi.fn()
  );
  await watcher.start();
  attempts[0].fail("EMFILE");
  expect(attempts[0].current()).toBe(false);
  expect(attempts[0].close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(attempts[0].close).toHaveBeenCalledTimes(1);
  expect(attempts).toHaveLength(2);
  attempts[0].fail("late_error");
  // The replacement is still scanning: `starting`, not `recovering`.
  expect(watcher.health.state).toBe("starting");
  attempts[1].fail("ENFILE");
  await vi.advanceTimersByTimeAsync(4999);
  expect(attempts).toHaveLength(2);
  await watcher.stop();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(attempts).toHaveLength(2);
});

it("closes a handle returned after stop without publishing it as healthy", async () => {
  let complete!: (value: WatchHandle) => void;
  const changed = vi.fn();
  const watcher = new RecoveringFileWatcher(
    () =>
      new Promise<WatchHandle>((resolve) => {
        complete = resolve;
      }),
    changed,
    vi.fn()
  );
  const starting = watcher.start();
  await vi.advanceTimersByTimeAsync(0);
  const stopping = watcher.stop();
  const handle = { close: vi.fn() };
  complete(handle);
  await Promise.all([starting, stopping]);
  expect(handle.close).toHaveBeenCalledTimes(1);
  expect(watcher.health.state).toBe("stopped");
  expect(
    changed.mock.calls.some(([health]) => health.state === "watching")
  ).toBe(false);
});

type Attempt = {
  current: () => boolean;
  fail: (reason: string) => void;
  ready: () => void;
  close: ReturnType<typeof vi.fn>;
};

function recordingWatcher(readyOnCreate = false) {
  const attempts: Attempt[] = [];
  const changed = vi.fn();
  const watcher = new RecoveringFileWatcher(
    (current, fail, ready) => {
      const attempt = { current, fail, ready, close: vi.fn() };
      attempts.push(attempt);
      if (readyOnCreate) ready();
      return attempt;
    },
    changed,
    vi.fn()
  );
  const delay = () => watcher.health.nextRetryAt! - Date.now();
  // Fail the newest handle, check the chosen delay, then let the retry start.
  const failAndRetry = async (reason: string) => {
    attempts[attempts.length - 1].fail(reason);
    const chosen = delay();
    await vi.advanceTimersByTimeAsync(chosen);
    return chosen;
  };
  return { attempts, changed, watcher, delay, failAndRetry };
}

it("waits at least a minute after ENOSPC from a scan that never became ready", async () => {
  const { attempts, watcher, delay } = recordingWatcher();
  await watcher.start();
  await vi.advanceTimersByTimeAsync(70_000);
  attempts[0].fail("ENOSPC");
  expect(watcher.health).toMatchObject({ state: "recovering", reason: "ENOSPC" });
  expect(delay()).toBeGreaterThanOrEqual(60_000);
  // Let the deferred close of the failed handle run before stopping.
  await vi.advanceTimersByTimeAsync(1);
  await watcher.stop();
});

it("keeps escalating failures of scans that never became ready, however long they ran", async () => {
  const { watcher, failAndRetry } = recordingWatcher();
  await watcher.start();
  await vi.advanceTimersByTimeAsync(70_000);
  expect(await failAndRetry("EMFILE")).toBe(1000);
  await vi.advanceTimersByTimeAsync(70_000);
  expect(await failAndRetry("watcher_error")).toBe(5000);
  await watcher.stop();
});

it("resets backoff once a ready watcher has stayed up for a minute", async () => {
  const { attempts, watcher, failAndRetry } = recordingWatcher();
  await watcher.start();
  expect(await failAndRetry("EMFILE")).toBe(1000);
  expect(await failAndRetry("EMFILE")).toBe(5000);
  attempts[2].ready();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await failAndRetry("EMFILE")).toBe(1000);
  // Ready for less than a minute does not count as healthy.
  attempts[3].ready();
  await vi.advanceTimersByTimeAsync(59_000);
  expect(await failAndRetry("EMFILE")).toBe(5000);
  await watcher.stop();
});

it("ignores ready from a superseded generation", async () => {
  const { attempts, watcher, failAndRetry } = recordingWatcher();
  await watcher.start();
  expect(await failAndRetry("EMFILE")).toBe(1000);
  attempts[0].ready();
  expect(watcher.health.state).toBe("starting");
  await vi.advanceTimersByTimeAsync(70_000);
  expect(await failAndRetry("EMFILE")).toBe(5000);
  await watcher.stop();
});

it("backs off ENOSPC on its own schedule, capped at thirty minutes", async () => {
  const { attempts, watcher, failAndRetry } = recordingWatcher();
  await watcher.start();
  const delays = [];
  for (let i = 0; i < 5; i++) delays.push(await failAndRetry("ENOSPC"));
  expect(delays).toEqual([60_000, 300_000, 900_000, 1_800_000, 1_800_000]);
  // Other transient failures keep their own short schedule.
  expect(await failAndRetry("EMFILE")).toBe(1000);
  // A ready watcher that stays up a minute resets the capacity schedule too.
  attempts[attempts.length - 1].ready();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await failAndRetry("ENOSPC")).toBe(60_000);
  await watcher.stop();
});

it("publishes watching only once the first scan is ready", async () => {
  const { attempts, changed, watcher, failAndRetry } = recordingWatcher();
  await watcher.start();
  expect(watcher.health.state).toBe("starting");
  await failAndRetry("EMFILE");
  expect(watcher.health.state).toBe("starting");
  attempts[1].ready();
  attempts[1].ready();
  expect(changed.mock.calls.map(([health]) => health.state)).toEqual([
    "starting",
    "recovering",
    "starting",
    "watching",
  ]);
  await watcher.stop();
});

it("publishes watching when ready is signalled before the handle is returned", async () => {
  const { changed, watcher } = recordingWatcher(true);
  await watcher.start();
  expect(watcher.health.state).toBe("watching");
  expect(changed.mock.calls.map(([health]) => health.state)).toEqual([
    "starting",
    "watching",
  ]);
  await watcher.stop();
});
