import { afterEach, describe, expect, it } from "vitest";
import {
  HarnessClient,
  HarnessDocumentServer,
  waitFor,
} from "./helpers/DocumentSyncHarness";

let server: HarnessDocumentServer | null = null;
let client: HarnessClient | null = null;

afterEach(() => {
  client?.destroy();
  server?.destroy();
  client = null;
  server = null;
});

describe("DocumentSync durable outbox replay", () => {
  it("retains an edit that lands while durable outbox replay is starting", async () => {
    server = new HarnessDocumentServer();
    client = new HarnessClient("user-a", server);
    await client.connect();
    const delayedWrite = client.delayNextReplicaWrite();

    client.edit("before-replay", "sent");
    await delayedWrite.started;
    const providerInternals = client.provider as unknown as { synced: boolean };
    providerInternals.synced = false;
    client.edit("during-replay", "must survive");
    providerInternals.synced = true;
    delayedWrite.release();

    await waitFor(
      () => server?.content("during-replay") === "must survive",
      "during-replay server update"
    );
    await client.waitForOutbox("clean");
    expect(server.content("during-replay")).toBe("must survive");
    await client.restart({ connect: false });

    expect(client.content("before-replay")).toBe("sent");
    expect(client.content("during-replay")).toBe("must survive");
  });

  it("drops a drainer-acked phantom row and replays later edits", async () => {
    server = new HarnessDocumentServer();
    client = new HarnessClient("user-a", server);
    client.edit("drained", "already acknowledged");
    await waitFor(
      () => client?.persistedOutboxStates()[0] === "queued",
      "first durable outbox row"
    );

    await client.acknowledgeOldestOutboxExternally(1);
    client.edit("after-handoff", "must still send");
    await client.connect();
    await waitFor(
      () => server?.content("after-handoff") === "must still send",
      "post-handoff server update"
    );
    await client.waitForOutbox("clean");

    expect(server.content("after-handoff")).toBe("must still send");
    expect(client.persistedOutboxStates()).toEqual([]);
  });
});
