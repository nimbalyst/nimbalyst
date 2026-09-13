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
  expect(watcher.health.state).toBe("watching");
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
