import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  HarnessClient,
  HarnessDocumentServer,
  TwoProviderDocumentSyncHarness,
  waitFor,
} from "./helpers/DocumentSyncHarness";

const activeHarnesses: TwoProviderDocumentSyncHarness[] = [];
const activeServers: HarnessDocumentServer[] = [];
const activeClients: HarnessClient[] = [];

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) harness.destroy();
  for (const client of activeClients.splice(0)) client.destroy();
  for (const server of activeServers.splice(0)) server.destroy();
});

function createHarness(): TwoProviderDocumentSyncHarness {
  const harness = new TwoProviderDocumentSyncHarness();
  activeHarnesses.push(harness);
  return harness;
}

function createClientServer(): {
  server: HarnessDocumentServer;
  client: HarnessClient;
} {
  const server = new HarnessDocumentServer();
  const client = new HarnessClient("user-a", server);
  activeServers.push(server);
  activeClients.push(client);
  return { server, client };
}

describe("DocumentSync Slice 0 harness controls", () => {
  it("tracks local readiness, network readiness, and outbox state independently", async () => {
    const { server, client } = createClientServer();

    client.expectReadiness({
      localReady: true,
      networkReady: false,
      outbox: "clean",
    });

    client.edit("offline", "saved");
    client.expectReadiness({
      localReady: true,
      networkReady: false,
      outbox: "pending",
    });

    await client.connect();
    await client.waitForOutbox("clean");
    client.expectReadiness({
      localReady: true,
      networkReady: true,
      outbox: "clean",
    });
  });

  it("restores the one unacknowledged collabPendingUpdates blob after restart", async () => {
    const { client } = createClientServer();
    client.edit("unacked", "survives");

    await client.restart({ connect: false });

    client.expectReadiness({
      localReady: true,
      networkReady: false,
      outbox: "pending",
    });
    expect(client.content("unacked")).toBe("survives");
  });

  it("reconnects two providers after network loss and catches up the missed update", async () => {
    const harness = createHarness();
    await harness.connectBoth();

    harness.loseNetwork();
    harness.b.edit("from-b", "during-a-outage");
    harness.b.expectReadiness({
      localReady: true,
      networkReady: false,
      outbox: "pending",
    });
    expect(harness.a.content("from-b")).toBeUndefined();

    harness.restoreNetwork();
    await harness.b.connect();
    await harness.b.waitForOutbox("clean");
    await harness.a.connect();

    await harness.a.waitForContent("from-b", "during-a-outage");
    harness.a.expectReadiness({
      localReady: true,
      networkReady: true,
      outbox: "clean",
    });
  });

  it("paginates server updates using hasMore and the response cursor", async () => {
    const { server, client } = createClientServer();
    server.pageSize = 1;
    server.seedChange("one", "1");
    server.seedChange("two", "2");
    server.seedChange("three", "3");

    await client.connect();

    expect(
      server.syncRequests
        .filter((request) => request.userId === client.userId)
        .map((request) => request.sinceSeq)
    ).toEqual([0, 1, 2]);
    expect(client.content("one")).toBe("1");
    expect(client.content("two")).toBe("2");
    expect(client.content("three")).toBe("3");
  });

  it("hydrates a compacted snapshot and the update tail after replacesUpTo", async () => {
    const { server, client } = createClientServer();
    server.seedChange("before-a", "A");
    server.seedChange("before-b", "B");
    server.compactCurrentState();
    server.seedChange("after", "C");

    await client.connect();

    expect(server.snapshotReplacesUpTo).toBe(2);
    expect(server.syncResponses[0]).toMatchObject({
      includedSnapshot: true,
      updateCount: 1,
      hasMore: false,
    });
    expect(client.provider?.getLastSeq()).toBe(3);
    expect(client.content("before-a")).toBe("A");
    expect(client.content("before-b")).toBe("B");
    expect(client.content("after")).toBe("C");
  });

  it("resumes a cold DocumentSyncProvider from its durable cursor", async () => {
    const { server, client } = createClientServer();
    server.seedChange("server", "state");

    await client.connect();
    await client.restart({ connect: true });

    expect(
      server.syncRequests
        .filter((request) => request.userId === client.userId)
        .map((request) => request.sinceSeq)
    ).toEqual([0, 1]);
  });

  it("blocks a compaction attempt while the current in-memory outbox is pending", async () => {
    const { server, client } = createClientServer();
    await client.connect();
    client.disconnect();
    client.edit("offline", "pending");
    client.expectReadiness({
      localReady: true,
      networkReady: false,
      outbox: "pending",
    });

    // Attach an open transport without replaying the outbox so maybeCompact
    // reaches its pending-write guard. Slice 2 must preserve this guarantee for
    // the durable outbox, not just today's queued/inflight memory blobs.
    const internals = client.provider as unknown as {
      ws: WebSocket;
      synced: boolean;
    };
    internals.ws = server.createWebSocket(client.userId);
    internals.synced = true;
    await waitFor(
      () => internals.ws.readyState === WebSocket.OPEN,
      "fake socket open"
    );
    await client.attemptServerCompaction();

    expect(server.compactionAttempts).toHaveLength(0);

    // The durable row is an independent safety gate. Clearing the provider's
    // transient merged blobs must still leave compaction ineligible.
    client.clearTransientPendingState();
    await client.attemptServerCompaction();
    expect(server.compactionAttempts).toHaveLength(0);
  });
});

describe("DocumentSync full-replica contracts", () => {
  it("reopens acknowledged local state from the complete replica while offline", async () => {
    const { server, client } = createClientServer();
    await client.connect();
    client.edit("acknowledged-local", "must survive");
    await waitFor(
      () => server.updates.length === 1,
      "acknowledged server insert"
    );
    await client.waitForOutbox("clean");

    await client.restart({ connect: false });

    client.expectReadiness({
      localReady: true,
      networkReady: false,
      outbox: "clean",
    });
    expect(client.content("acknowledged-local")).toBe("must survive");
  });

  it("reopens a received remote update from the complete replica while offline", async () => {
    const harness = createHarness();
    await harness.connectBoth();
    harness.b.edit("remote", "must survive");
    await harness.a.waitForContent("remote", "must survive");
    await harness.b.waitForOutbox("clean");

    await harness.a.restart({ connect: false });

    harness.a.expectReadiness({
      localReady: true,
      networkReady: false,
      outbox: "clean",
    });
    expect(harness.a.content("remote")).toBe("must survive");
  });

  it("does not bootstrap-push local state when reconnecting exactly at server head", async () => {
    const { server, client } = createClientServer();
    server.seedChange("server", "authoritative");

    const localReplica = new Y.Doc();
    localReplica.getMap<string>("content").set("server", "authoritative");
    client.installHydratedReplica(
      Y.encodeStateAsUpdate(localReplica),
      server.headSequence
    );
    localReplica.destroy();
    const rowsBeforeReconnect = server.updates.length;

    await client.connect();
    await waitFor(
      () =>
        server.syncResponses.some(
          (response) => response.userId === client.userId
        ),
      "reconnect-at-head response"
    );

    expect(server.syncResponses.at(-1)).toMatchObject({
      updateCount: 0,
      includedSnapshot: false,
      hasMore: false,
    });
    expect(server.updates).toHaveLength(rowsBeforeReconnect);
  });

  it("resends the same stable batch id after an ack is lost and inserts one server row", async () => {
    const { server, client } = createClientServer();
    await client.connect();
    server.dropNextUpdateAck = true;
    client.edit("ack-loss", "once");
    await waitFor(
      () => server.updates.length === 1,
      "insert whose ack is lost"
    );

    await client.restart({ connect: true });
    await client.waitForOutbox("clean");

    const attemptedBatchIds = server.updates.map(
      (update) => update.clientUpdateId
    );
    expect(new Set(attemptedBatchIds).size).toBe(1);
    expect(server.updates).toHaveLength(1);
    expect(server.updates[0].clientUpdateId).toBeDefined();
  });

  it("drains a persisted outbox after restart without an editor/provider attached", async () => {
    const { server, client } = createClientServer();
    client.edit("headless", "upload me");
    client.closeEditor();

    client.expectReadiness({
      localReady: false,
      networkReady: false,
      outbox: "pending",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(server.updates).toHaveLength(1);
  });
});
