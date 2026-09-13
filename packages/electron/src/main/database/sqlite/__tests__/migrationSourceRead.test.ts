// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerRequestTracker } from "../../WorkerRequestTracker";
import {
  MigrationSourceReader,
  isSettledMigrationTimeout,
} from "../migrationSourceRead";
import {
  serializeBridgeError,
  deserializeBridgeError,
  createMigrationBridgeReader,
} from "../worker/migrationReadBridge";
import { serializeWorkerError } from "../../workerErrorSerialization";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  const posted: Array<{ id: string }> = [];
  const tracker = new WorkerRequestTracker((message) =>
    posted.push(message as { id: string })
  );
  const reader = new MigrationSourceReader();
  const read = () => reader.read(() => tracker.send("queryReadOnly", {}, null));
  return { posted, tracker, reader, read };
}

describe("migration source completion", () => {
  it("keeps ownership past the soft deadline, then allows retry only after the actual response", async () => {
    const f = fixture();
    let settled = false;
    const result = f.read().catch((error) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(settled).toBe(false);
    expect(() => f.read()).toThrow(/has not finished/);
    expect(f.posted).toHaveLength(1);
    f.tracker.receive({
      id: f.posted[0].id,
      success: true,
      data: { rows: [{ id: 1 }] },
    });
    const error = await result;
    expect(
      isSettledMigrationTimeout(
        deserializeBridgeError(structuredClone(serializeBridgeError(error)))
      )
    ).toBe(true);
    const retry = f.read();
    await vi.advanceTimersByTimeAsync(0);
    f.tracker.receive({
      id: f.posted[1].id,
      success: true,
      data: { rows: [{ id: 1 }] },
    });
    await expect(retry).resolves.toEqual({ rows: [{ id: 1 }] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a stalled read but gates a new migration until actual source settlement", async () => {
    const f = fixture();
    const result = f.read().catch((error) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    const error = await result;
    expect(error.code).toBe("migration_source_stalled");
    expect(isSettledMigrationTimeout(error)).toBe(false);
    expect(() => f.reader.assertAvailable()).toThrow(/has not finished/);
    expect(f.posted).toHaveLength(1);
    f.tracker.receive({
      id: f.posted[0].id,
      success: true,
      data: { rows: [] },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(() => f.reader.assertAvailable()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.tracker.receive({ id: f.posted[0].id, success: true })).toBe(
      false
    );
  });

  it("preserves a late backup error through both serialization hops instead of making it retryable", async () => {
    const f = fixture();
    const result = f.read().catch((error) => error);
    await vi.advanceTimersByTimeAsync(31_000);
    const sourceError = Object.assign(
      new Error("could not read blocks: Resource busy"),
      { code: "XX000" }
    );
    f.tracker.receive({
      id: f.posted[0].id,
      success: false,
      errorData: serializeWorkerError(sourceError),
    });
    const error = deserializeBridgeError(
      structuredClone(serializeBridgeError(await result))
    );
    expect(error).toMatchObject({
      code: "XX000",
      message: sourceError.message,
    });
    expect(isSettledMigrationTimeout(error)).toBe(false);
    expect(() => f.reader.assertAvailable()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears normal request timers and releases migration ownership on worker exit", async () => {
    const f = fixture();
    const ordinary = f.tracker.send("query").catch((error) => error);
    const migration = f.read().catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    const exit = new Error("Worker exited with code 0");
    f.tracker.rejectAll(exit);
    expect(await ordinary).toBe(exit);
    expect(await migration).toBe(exit);
    expect(() => f.reader.assertAvailable()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans timers after ordinary success, caller timeout, and synchronous dispatch failure", async () => {
    const f = fixture();
    const success = f.tracker.send("query");
    f.tracker.receive({ id: f.posted[0].id, success: true, data: 1 });
    await expect(success).resolves.toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    const timed = f.tracker.send("query").catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await timed).message).toBe("Request query timed out");
    expect(f.tracker.receive({ id: f.posted[1].id, success: true })).toBe(
      false
    );
    await expect(
      f.reader.read(() => {
        throw new Error("post failed");
      })
    ).rejects.toThrow("post failed");
    expect(() => f.reader.assertAvailable()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the bridge open for source settlement and never classifies a lost bridge as a retry", async () => {
    const request = vi.fn(async () => ({ rows: [{ id: 1 }] }));
    const bridge = createMigrationBridgeReader(request);
    await expect(bridge.queryReadOnly("SELECT 1", [], 30_000)).resolves.toEqual(
      { rows: [{ id: 1 }] }
    );
    expect(request).toHaveBeenCalledWith(
      "pgliteReadRequest",
      { sql: "SELECT 1", params: [], timeoutMs: 30_000 },
      130_000
    );
    request.mockRejectedValueOnce(new Error("Bridge request timed out"));
    const error = await bridge
      .queryReadOnly("SELECT 1")
      .catch((error) => error);
    expect(isSettledMigrationTimeout(error)).toBe(false);
  });
});
