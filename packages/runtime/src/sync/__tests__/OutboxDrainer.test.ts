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

describe("OutboxDrainer", () => {
  it("yields queued work to an attached live provider", async () => {
    server = new HarnessDocumentServer();
    client = new HarnessClient("user-a", server);
    client.edit("live", "provider owns this batch");
    await waitFor(
      () => client?.persistedOutboxStates()[0] === "queued",
      "queued durable outbox"
    );

    const result = await client.drainOutboxOnce();

    expect(result.batchesUploaded).toBe(0);
    expect(server.updates).toHaveLength(0);
    expect(client.persistedOutboxStates()).toEqual(["queued"]);
  });

  it("freezes a rejected headless write without discarding or retrying it", async () => {
    server = new HarnessDocumentServer();
    server.rejectNextDrainWith = "forbidden";
    client = new HarnessClient("user-a", server);
    client.edit("rejected", "preserve me");
    client.closeEditor();

    await waitFor(
      () => client?.persistedOutboxStates()[0] === "rejected",
      "rejected durable outbox"
    );
    expect(server.updates).toHaveLength(0);

    await client.drainOutboxOnce();
    expect(client.persistedOutboxStates()).toEqual(["rejected"]);
    expect(server.updates).toHaveLength(0);
  });

  it("keeps a rotation-lock rejection retryable", async () => {
    server = new HarnessDocumentServer();
    server.rejectNextDrainWith = "write_rejected";
    client = new HarnessClient("user-a", server);
    client.edit("rotation", "retry me");
    await waitFor(
      () => client?.persistedOutboxStates()[0] === "queued",
      "rotation durable outbox row"
    );
    client.closeEditor({ autoDrain: false });

    await client.drainOutboxOnce();

    expect(client.persistedOutboxStates()).toEqual(["inflight"]);
    expect(client.persistedOutboxErrors()).toEqual(["write_rejected"]);
    expect(server.updates).toHaveLength(0);

    await client.drainOutboxOnce();
    expect(client.persistedOutboxStates()).toEqual([]);
    expect(server.content("rotation")).toBe("retry me");
  });

  it("merges every currently queued row into one stable wire batch", async () => {
    server = new HarnessDocumentServer();
    client = new HarnessClient("user-a", server);
    client.edit("first", "one");
    client.edit("second", "two");
    await waitFor(
      () => (client?.persistedOutboxStates().length ?? 0) === 2,
      "two durable outbox rows"
    );
    client.closeEditor({ autoDrain: false });

    await client.drainOutboxOnce();

    expect(server.updates).toHaveLength(1);
    expect(server.content("first")).toBe("one");
    expect(server.content("second")).toBe("two");
    expect(client.persistedOutboxStates()).toEqual([]);
  });

  it("settles an in-flight drain before handing the document to a provider", async () => {
    server = new HarnessDocumentServer();
    client = new HarnessClient("user-a", server);
    client.edit("handoff", "send once");
    await waitFor(
      () => client?.persistedOutboxStates()[0] === "queued",
      "handoff durable outbox"
    );
    client.closeEditor({ autoDrain: false });
    const gate = server.delayNextDrain();
    const drain = client.drainOutboxOnce();
    await gate.started;

    const attach = client.attachProviderAfterDrainerHandoff();
    let attached = false;
    void attach.then(() => {
      attached = true;
    });
    await Promise.resolve();
    expect(attached).toBe(false);

    gate.release();
    await Promise.all([drain, attach]);
    await client.connect();

    expect(server.updates).toHaveLength(1);
    expect(server.content("handoff")).toBe("send once");
    expect(client.persistedOutboxStates()).toEqual([]);
  });
});
