import { afterEach, describe, expect, it } from "vitest";
import {
  isConfirmedOutboxRevocationCode,
  OUTBOX_STUCK_ATTEMPTS,
} from "../OutboxDrainer";
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

/**
 * A document whose room is permanently unreachable — on the measured install,
 * 22 batches against a room that answered the WebSocket upgrade with HTTP 404
 * since 2026-08-05. Every 30s pass reconnected, merged and re-sent, and
 * `recordOutboxError` neither counted the attempt nor said anything, so the
 * only trace was an idle-looking heartbeat reporting `batchesUploaded: 0`.
 */
describe("OutboxDrainer — a document that never converges", () => {
  it("counts every failed replay, not just the first claim", async () => {
    server = new HarnessDocumentServer();
    server.failEveryDrainWith = "Outbox drain WebSocket rejected with HTTP 404";
    client = new HarnessClient("user-a", server);
    client.edit("stranded", "unsent work");
    await waitFor(
      () => client?.persistedOutboxStates()[0] === "queued",
      "queued durable outbox"
    );
    client.closeEditor({ autoDrain: false });

    await client.drainOutboxOnce();
    await client.drainOutboxOnce();
    await client.drainOutboxOnce();

    expect(client.persistedOutboxStates()).toEqual(["inflight"]);
    expect(client.outboxAttemptCounts()).toEqual([3]);
    expect(server.updates).toHaveLength(0);
  });

  it("reports it as stuck once it has failed repeatedly", async () => {
    server = new HarnessDocumentServer();
    server.failEveryDrainWith = "Outbox drain WebSocket rejected with HTTP 404";
    client = new HarnessClient("user-a", server);
    client.edit("stranded", "unsent work");
    await waitFor(
      () => client?.persistedOutboxStates()[0] === "queued",
      "queued durable outbox"
    );
    client.closeEditor({ autoDrain: false });

    let result = await client.drainOutboxOnce();
    expect(result.stuck).toEqual([]);
    for (let i = 0; i < OUTBOX_STUCK_ATTEMPTS; i += 1) {
      result = await client.drainOutboxOnce();
    }

    expect(result.stuck).toHaveLength(1);
    expect(result.stuck[0]).toMatchObject({
      batchCount: 1,
      lastErrorCode: "Outbox drain WebSocket rejected with HTTP 404",
    });
    expect(result.stuck[0].attemptCount).toBeGreaterThanOrEqual(
      OUTBOX_STUCK_ATTEMPTS
    );
  });

  // The periodic tick is what fired 2,880 times a day. An event-driven trigger
  // is new information and must still retry at once.
  it("defers the periodic retry but never an event-driven one", async () => {
    server = new HarnessDocumentServer();
    server.failEveryDrainWith = "Outbox drain WebSocket rejected with HTTP 404";
    client = new HarnessClient("user-a", server);
    client.edit("stranded", "unsent work");
    await waitFor(
      () => client?.persistedOutboxStates()[0] === "queued",
      "queued durable outbox"
    );
    client.closeEditor({ autoDrain: false });

    await client.drainOutboxOnce();
    await client.drainOutboxOnce();
    const attemptsBefore = client.outboxAttemptCounts()[0];

    const periodic = await client.drainOutboxOnce({ respectBackoff: true });
    expect(periodic.documentsDeferred).toBe(1);
    expect(client.outboxAttemptCounts()[0]).toBe(attemptsBefore);

    const eventDriven = await client.drainOutboxOnce();
    expect(eventDriven.documentsDeferred).toBe(0);
    expect(client.outboxAttemptCounts()[0]).toBe(attemptsBefore + 1);
  });

  it("stops enumerating a document whose batches are all rejected", async () => {
    server = new HarnessDocumentServer();
    server.rejectNextDrainWith = "forbidden";
    client = new HarnessClient("user-a", server);
    client.edit("rejected", "preserve me");
    client.closeEditor();
    await waitFor(
      () => client?.persistedOutboxStates()[0] === "rejected",
      "rejected durable outbox"
    );

    const result = await client.drainOutboxOnce();

    expect(result.documentsExamined).toBe(0);
    // The row itself is untouched — not enumerating it is not discarding it.
    expect(client.persistedOutboxStates()).toEqual(["rejected"]);
  });
});

describe("OutboxDrainer revocation codes", () => {
  it("never retries a commenter update the room refused", () => {
    // The room refuses every later update from that client's Y.Doc too, so a
    // retry cannot succeed; it would only replay the refusal on each reconnect.
    expect(isConfirmedOutboxRevocationCode("document_comment_update_refused")).toBe(true);
    expect(isConfirmedOutboxRevocationCode("document_comment_forbidden")).toBe(true);
    expect(isConfirmedOutboxRevocationCode("write_barrier")).toBe(false);
  });
});
