import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
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

describe("DocumentSync explicit server-state capability", () => {
  it("bootstraps only when the explicit serverHasState bit is false", async () => {
    server = new HarnessDocumentServer();
    client = new HarnessClient("user-a", server);
    const local = new Y.Doc();
    local.getMap<string>("content").set("local", "bootstrap me");
    client.installHydratedReplica(Y.encodeStateAsUpdate(local), 0);
    local.destroy();

    await client.connect();
    await client.waitForOutbox("clean");

    expect(server.updates).toHaveLength(1);
    expect(server.updates[0].clientUpdateId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("falls back from a durable cursor to a full resync on an older server", async () => {
    server = new HarnessDocumentServer();
    server.exposeExplicitState = false;
    server.seedChange("server", "authoritative");
    client = new HarnessClient("user-a", server);
    const local = new Y.Doc();
    local.getMap<string>("content").set("server", "authoritative");
    client.installHydratedReplica(
      Y.encodeStateAsUpdate(local),
      server.headSequence
    );
    local.destroy();

    await client.connect();

    expect(server.syncRequests.map((request) => request.sinceSeq)).toEqual([
      1, 0,
    ]);
    expect(server.updates).toHaveLength(1);
  });

  it("never bootstraps local state from an older server's empty response", async () => {
    server = new HarnessDocumentServer();
    server.exposeExplicitState = false;
    client = new HarnessClient("user-a", server);
    const local = new Y.Doc();
    local.getMap<string>("content").set("local", "must stay local");
    client.installHydratedReplica(Y.encodeStateAsUpdate(local), 0);
    local.destroy();

    await client.connect();

    expect(server.syncRequests.map((request) => request.sinceSeq)).toEqual([0]);
    expect(server.updates).toHaveLength(0);
  });

  it("keeps a live rotation-lock rejection retryable", async () => {
    server = new HarnessDocumentServer();
    client = new HarnessClient("user-a", server);
    await client.connect();
    server.rejectNextLiveWith = "write_rejected";

    client.edit("rotation", "retry after barrier");
    await waitFor(
      () => client?.persistedOutboxErrors()[0] === "write_rejected",
      "retryable live write error"
    );

    expect(client.persistedOutboxStates()).toEqual(["inflight"]);
    expect(server.updates).toHaveLength(0);

    await client.connect();
    await client.waitForOutbox("clean");
    expect(server.content("rotation")).toBe("retry after barrier");
    expect(server.updates).toHaveLength(1);
  });

  it("ignores an error frame that does not name the inflight client update", async () => {
    server = new HarnessDocumentServer();
    client = new HarnessClient("user-a", server);
    await client.connect();
    server.rejectNextLiveWith = "MEMBERSHIP_REVOKED";
    server.rejectNextLiveClientUpdateId = "another-client-update";

    client.edit("correlation", "keep pending");
    await waitFor(
      () => client?.persistedOutboxStates()[0] === "inflight",
      "inflight outbox claim"
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(client.persistedOutboxStates()).toEqual(["inflight"]);
    expect(client.persistedOutboxErrors()).toEqual([null]);
  });

  it("falls back to in-memory sending when replica persistence is unavailable", async () => {
    server = new HarnessDocumentServer();
    client = new HarnessClient("user-a", server);
    client.markReplicaUnavailable();
    client.edit("degraded", "still send online");

    await client.connect();
    await waitFor(
      () => server?.content("degraded") === "still send online",
      "degraded in-memory send"
    );

    expect(server.updates).toHaveLength(1);
  });
});
