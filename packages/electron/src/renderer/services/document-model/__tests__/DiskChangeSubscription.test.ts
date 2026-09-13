// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { store } from "@nimbalyst/runtime/store";
import { DiskChangeSubscription } from "../DiskChangeSubscription";
import {
  activeFileReconciliations,
  fileChangedOnDiskAtomFamily,
  fileDeletedAtomFamily,
} from "../../../store/atoms/fileWatch";

vi.mock("../../ErrorNotificationService", () => ({
  errorNotificationService: { showWarning: vi.fn() },
}));
const subscriptions: DiskChangeSubscription[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  subscriptions.splice(0).forEach((subscription) => subscription.dispose());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("invalidates a pending disk read on deletion without resurrecting the deleted model", async () => {
  let finish!: (value: string) => void;
  const load = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      })
  );
  const changed = vi.fn();
  const deleted = vi.fn();
  subscriptions.push(
    new DiskChangeSubscription("/test/deleted.md", load, changed, deleted)
  );
  store.set(fileChangedOnDiskAtomFamily("/test/deleted.md"), 1);
  store.set(fileDeletedAtomFamily("/test/deleted.md"), 1);
  finish("stale bytes");
  await vi.advanceTimersByTimeAsync(0);
  expect(deleted).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledTimes(1);
});

it("coalesces reads and only delivers the latest completion", async () => {
  const finishes: Array<(value: string) => void> = [];
  const load = vi.fn(
    () => new Promise<string>((resolve) => finishes.push(resolve))
  );
  const changed = vi.fn();
  subscriptions.push(
    new DiskChangeSubscription("/test/coalesce.md", load, changed, vi.fn())
  );
  for (let i = 1; i <= 10; i++)
    store.set(fileChangedOnDiskAtomFamily("/test/coalesce.md"), i);
  expect(load).toHaveBeenCalledTimes(1);
  finishes[0]("old");
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).not.toHaveBeenCalled();
  finishes[1]("latest");
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ content: "latest" })
  );
});

it("releases a registration acknowledged after dispose and removes its delivery token", async () => {
  let finish!: () => void;
  const invoke = vi.fn((channel: string, _token?: string, _path?: string) =>
    channel === "file:register-open"
      ? new Promise<void>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve()
  );
  vi.stubGlobal("window", { electronAPI: { invoke } });
  const subscription = new DiskChangeSubscription(
    "/test/late.md",
    vi.fn(),
    vi.fn(),
    vi.fn()
  );
  const token = invoke.mock.calls[0][1];
  subscription.dispose();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(invoke).toHaveBeenLastCalledWith("file:unregister-open", token);
  expect(activeFileReconciliations.has(token!)).toBe(false);
});

it("retries transient registration failure and cancels future retries on dispose", async () => {
  const invoke = vi
    .fn()
    .mockRejectedValueOnce(new Error("IPC temporarily unavailable"))
    .mockResolvedValue({ success: true });
  vi.stubGlobal("window", { electronAPI: { invoke } });
  const subscription = new DiskChangeSubscription(
    "/test/retry.md",
    vi.fn(),
    vi.fn(),
    vi.fn()
  );
  subscriptions.push(subscription);
  await vi.advanceTimersByTimeAsync(1000);
  expect(
    invoke.mock.calls.filter(([channel]) => channel === "file:register-open")
  ).toHaveLength(2);
  subscription.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
