// @vitest-environment node
import { EventEmitter } from "events";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const platform = vi.hoisted(() => {
  const original = process.platform;
  Object.defineProperty(process, "platform", {
    value: "linux",
    configurable: true,
  });
  return original;
});
vi.mock("chokidar", () => ({ default: { watch: vi.fn() } }));
import chokidar from "chokidar";
import {
  createWorkspaceNativeWatcher,
  drainNativeFileEvents,
  supportsRecursiveWatch,
  type NativeWatchHandle,
} from "../WorkspaceNativeWatcher";
import { RecoveringFileWatcher } from "../RecoveringFileWatcher";

afterAll(() => Object.defineProperty(process, "platform", { value: platform }));
afterEach(() => vi.useRealTimers());

it("recovers a failed Linux chokidar handle and fences its late events", async () => {
  vi.useFakeTimers();
  const handles: Array<EventEmitter & { close: ReturnType<typeof vi.fn> }> = [];
  vi.mocked(chokidar.watch).mockImplementation(() => {
    const handle = Object.assign(new EventEmitter(), {
      close: vi.fn().mockResolvedValue(undefined),
    });
    handles.push(handle);
    return handle as unknown as ReturnType<typeof chokidar.watch>;
  });
  const deliver = vi.fn();
  const lifecycle = new RecoveringFileWatcher(
    (current, fail, ready) =>
      createWorkspaceNativeWatcher(
        "/test/root",
        current,
        fail,
        () => false,
        deliver,
        ready
      ),
    vi.fn(),
    vi.fn()
  );
  try {
    expect(supportsRecursiveWatch).toBe(false);
    await lifecycle.start();
    handles[0].emit(
      "error",
      Object.assign(new Error("inotify exhausted"), { code: "ENOSPC" })
    );
    expect(lifecycle.health.state).toBe("recovering");
    // ENOSPC is a capacity failure: the inotify limit does not change between retries.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(handles).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(handles).toHaveLength(2);
    expect(handles[0].close).toHaveBeenCalledTimes(1);
    handles[0].emit("unlink", "/test/root/note.md");
    expect(deliver).not.toHaveBeenCalled();
    handles[1].emit("change", "/test/root/note.md");
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      "change",
      "/test/root/note.md",
      expect.any(Number)
    );
  } finally {
    await lifecycle.stop();
  }
  await vi.advanceTimersByTimeAsync(120_000);
  expect(handles).toHaveLength(2);
});

it("publishes watching only after chokidar finishes its initial scan", async () => {
  vi.useFakeTimers();
  const handles: Array<EventEmitter & { close: ReturnType<typeof vi.fn> }> = [];
  vi.mocked(chokidar.watch).mockImplementation(() => {
    const handle = Object.assign(new EventEmitter(), {
      close: vi.fn().mockResolvedValue(undefined),
    });
    handles.push(handle);
    return handle as unknown as ReturnType<typeof chokidar.watch>;
  });
  const lifecycle = new RecoveringFileWatcher(
    (current, fail, ready) =>
      createWorkspaceNativeWatcher(
        "/test/root",
        current,
        fail,
        () => false,
        vi.fn(),
        ready
      ),
    vi.fn(),
    vi.fn()
  );
  try {
    await lifecycle.start();
    expect(lifecycle.health.state).toBe("starting");
    handles[0].emit("ready");
    expect(lifecycle.health.state).toBe("watching");
    handles[0].emit(
      "error",
      Object.assign(new Error("watch failed"), { code: "EMFILE" })
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(handles).toHaveLength(2);
    // A late ready from the retired handle must not mark the new scan ready.
    handles[0].emit("ready");
    expect(lifecycle.health.state).toBe("starting");
    handles[1].emit("ready");
    expect(lifecycle.health.state).toBe("watching");
  } finally {
    await lifecycle.stop();
  }
});

describe("C5: a backlog overflow during the initial chokidar scan", () => {
  const handles: Array<EventEmitter & { close: ReturnType<typeof vi.fn> }> = [];
  const deliver = vi.fn();
  const changed = vi.fn();
  let lifecycle: RecoveringFileWatcher<NativeWatchHandle>;
  const states = () => changed.mock.calls.map(([health]) => health.state);
  const storm = (count: number, name: string) => {
    for (let i = 0; i < count; i++) handles[0].emit("change", `/test/root/${name}-${i}.md`);
  };
  const drained = () => drainNativeFileEvents(handles[0] as unknown as NativeWatchHandle);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    handles.length = 0;
    deliver.mockReset();
    changed.mockReset();
    vi.mocked(chokidar.watch).mockImplementation(() => {
      const handle = Object.assign(new EventEmitter(), {
        close: vi.fn().mockResolvedValue(undefined),
      });
      handles.push(handle);
      return handle as unknown as ReturnType<typeof chokidar.watch>;
    });
    lifecycle = new RecoveringFileWatcher(
      (current, fail, ready) =>
        createWorkspaceNativeWatcher("/test/root", current, fail, () => false, deliver, ready),
      changed,
      vi.fn()
    );
    await lifecycle.start();
    expect(lifecycle.health.state).toBe("starting");
  });
  afterEach(() => lifecycle.stop());

  it("keeps the scan and waits for ready after the backlog is delivered", async () => {
    storm(16_600, "storm");
    expect(lifecycle.health).toMatchObject({ state: "recovering", reason: "event_queue_overflow" });
    await drained();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(handles).toHaveLength(1);
    expect(handles[0].close).not.toHaveBeenCalled();
    expect(deliver.mock.calls.at(-1)?.[1]).toBe("/test/root/storm-16599.md");
    expect(lifecycle.health.state).toBe("recovering");
    handles[0].emit("ready");
    expect(states()).toEqual(["starting", "recovering", "watching"]);
  });

  it("waits for the backlog after a ready that arrives during the episode", async () => {
    storm(16_384 + 1000, "storm");
    handles[0].emit("ready");
    expect(lifecycle.health.state).toBe("recovering");
    let deliveredAtWatching = -1;
    changed.mockImplementation((health) => {
      if (health.state === "watching") deliveredAtWatching = deliver.mock.calls.length;
    });
    await drained();
    expect(states()).toEqual(["starting", "recovering", "watching"]);
    expect(deliveredAtWatching).toBe(deliver.mock.calls.length);
    expect(handles).toHaveLength(1);
  });

  it("waits for a later overflow's backlog after the first one was delivered during the scan", async () => {
    storm(16_600, "first");
    await drained();
    storm(16_384 + 1000, "second");
    handles[0].emit("ready");
    expect(lifecycle.health.state).toBe("recovering");
    await drained();
    expect(states()).toEqual(["starting", "recovering", "watching"]);
    expect(deliver.mock.calls.at(-1)?.[1]).toBe("/test/root/second-17383.md");
  });
});
