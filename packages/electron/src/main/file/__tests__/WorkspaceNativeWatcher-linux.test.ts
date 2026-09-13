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
    (current, fail) =>
      createWorkspaceNativeWatcher(
        "/test/root",
        current,
        fail,
        () => false,
        deliver
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
    await vi.advanceTimersByTimeAsync(1000);
    expect(handles).toHaveLength(2);
    expect(handles[0].close).toHaveBeenCalledTimes(1);
    handles[0].emit("unlink", "/test/root/note.md");
    expect(deliver).not.toHaveBeenCalled();
    handles[1].emit("change", "/test/root/note.md");
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      "change",
      "/test/root/note.md"
    );
  } finally {
    await lifecycle.stop();
  }
  await vi.advanceTimersByTimeAsync(120_000);
  expect(handles).toHaveLength(2);
});
