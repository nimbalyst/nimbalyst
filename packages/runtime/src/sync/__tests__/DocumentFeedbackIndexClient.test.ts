// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentFeedbackIndexClient } from "../DocumentFeedbackIndexClient";

afterEach(() => vi.useRealTimers());
describe("document feedback index connection authority", () => {
  it("clears on disconnect, detects an old server and ignores stale snapshots", () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const client = new DocumentFeedbackIndexClient(changed);
    client.start(vi.fn());
    vi.advanceTimersByTime(10_000);
    expect(changed.mock.lastCall?.[0].status).toBe("unsupported");
    client.receive({
      type: "documentFeedbackIndexSnapshot",
      entries: [],
      generation: 2,
      status: "ready",
    });
    client.receive({
      type: "documentFeedbackIndexSnapshot",
      entries: [],
      generation: 1,
      status: "partial",
    });
    expect(changed.mock.lastCall?.[0].status).toBe("ready");
    client.disconnect();
    client.receive({
      type: "documentFeedbackIndexSnapshot",
      entries: [],
      generation: 3,
      status: "ready",
    });
    expect(changed.mock.lastCall?.[0].status).toBe("disconnected");
  });
});
