// @vitest-environment node
import { EventEmitter } from "events";
import { afterAll, afterEach, expect, it, vi } from "vitest";
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
  supportsRecursiveWatch,
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
