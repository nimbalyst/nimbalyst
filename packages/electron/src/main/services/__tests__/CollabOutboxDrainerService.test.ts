import { describe, expect, it, vi } from "vitest";

import {
  OutboxUpgradeRejectedError,
  retryOutboxConnectAfterAuthRejection,
} from "../OutboxTransportAuthRetry";

describe("Collab outbox transport authentication", () => {
  it("retries one connect-time 403 with a forced fresh JWT", async () => {
    const forceRefreshCalls: boolean[] = [];

    const result = await retryOutboxConnectAfterAuthRejection(
      async (forceRefresh) => {
        forceRefreshCalls.push(forceRefresh);
        if (!forceRefresh) throw new OutboxUpgradeRejectedError(403);
        return "connected";
      }
    );

    expect(result).toBe("connected");
    expect(forceRefreshCalls).toEqual([false, true]);
  });

  it("does not retry non-auth upgrade failures", async () => {
    const connect = vi.fn(async () => {
      throw new OutboxUpgradeRejectedError(503);
    });

    await expect(retryOutboxConnectAfterAuthRejection(connect)).rejects.toThrow(
      "HTTP 503"
    );
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
