// @vitest-environment node
/**
 * Two clients, one document, votes cast at the same moment.
 *
 * The first test here is the one the whole storage design exists for. An
 * earlier draft of this repository nested a `Y.Map` per block inside a map of
 * blocks. That shape loses votes: when nobody has voted on a block yet and two
 * people vote simultaneously, both clients construct a nested map and `set` it,
 * Yjs keeps one of them, and the vote inside the discarded map is gone. It is
 * acknowledged locally, it survives every single-client test, and it disappears
 * on merge. The flat `blockId \x1f voterId` keyspace is what makes it safe, and
 * this file is what holds that shape in place.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { YDocDecisionRepository } from "../YDocDecisionRepository";

const REMOTE = Symbol("test-remote");
const BLOCK = "dcn-7f3a2c";

/**
 * Two docs with a manually pumped link. Buffering is the point: delivering each
 * update immediately would serialize the clients and never produce the
 * concurrent case.
 */
function makeLink(docA: Y.Doc, docB: Y.Doc): () => void {
  const toB: Uint8Array[] = [];
  const toA: Uint8Array[] = [];
  docA.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) toB.push(update);
  });
  docB.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) toA.push(update);
  });
  return () => {
    const a = toB.splice(0);
    const b = toA.splice(0);
    for (const update of a) Y.applyUpdate(docB, update, REMOTE);
    for (const update of b) Y.applyUpdate(docA, update, REMOTE);
  };
}

function setUp() {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
  const flush = makeLink(docA, docB);
  return {
    docA,
    docB,
    flush,
    a: new YDocDecisionRepository(docA),
    b: new YDocDecisionRepository(docB),
  };
}

function pick(voterId: string, selectedId: string, at: number) {
  return {
    voterId,
    answer: { type: "singleSelect", selectedId } as const,
    at,
  };
}

describe("YDocDecisionRepository", () => {
  it("keeps both votes when two clients vote concurrently on a fresh block", () => {
    const { a, b, flush } = setUp();

    // Neither client has seen a vote on this block, so both are creating its
    // storage for the first time. This is the losing case for a nested design.
    a.castVote(BLOCK, pick("greg", "gutter", 1000));
    b.castVote(BLOCK, pick("karl", "topbar", 1001));

    flush();

    for (const repo of [a, b]) {
      const votes = repo.getVotes(BLOCK);
      expect(votes.map((vote) => vote.voterId)).toEqual(["greg", "karl"]);
      expect(
        votes.map((vote) => (vote.answer as { selectedId: string }).selectedId)
      ).toEqual(["gutter", "topbar"]);
    }
  });

  it("replaces only the voter who changed their mind", () => {
    const { a, b, flush } = setUp();

    a.castVote(BLOCK, pick("greg", "gutter", 1000));
    b.castVote(BLOCK, pick("karl", "topbar", 1001));
    flush();

    // Karl is argued round. Last write wins per voter -- Greg is untouched and
    // Karl's earlier answer is simply gone, which is the agreed semantic.
    b.castVote(BLOCK, pick("karl", "gutter", 2000));
    flush();

    const votes = a.getVotes(BLOCK);
    expect(votes).toHaveLength(2);
    expect(
      votes.map((vote) => [
        vote.voterId,
        (vote.answer as { selectedId: string }).selectedId,
      ])
    ).toEqual([
      ["greg", "gutter"],
      ["karl", "gutter"],
    ]);
  });

  it("converges when the same voter votes differently on two clients at once", () => {
    const { a, b, flush } = setUp();

    // The same person on a laptop and a phone. Both must not survive: one voter
    // is one vote, and the two clients have to agree on which.
    a.castVote(BLOCK, pick("greg", "gutter", 1000));
    b.castVote(BLOCK, pick("greg", "topbar", 1001));
    flush();

    expect(a.getVotes(BLOCK)).toHaveLength(1);
    expect(a.getSnapshot()).toEqual(b.getSnapshot());
  });

  it("keeps blocks independent and clears only the sealed one", () => {
    const { a, b, flush } = setUp();
    const other = "dcn-19c7aa";

    a.castVote(BLOCK, pick("greg", "gutter", 1000));
    a.castVote(other, pick("greg", "trackers", 1001));
    flush();

    a.clearBlock(BLOCK);
    flush();

    expect(b.getVotes(BLOCK)).toEqual([]);
    expect(b.getVotes(other)).toHaveLength(1);
  });

  it("keeps an agent recommendation out of the votes entirely", () => {
    const { a, b, flush } = setUp();

    a.castVote(BLOCK, pick("greg", "gutter", 1000));
    a.setRecommendation(BLOCK, {
      agentId: "agent-1",
      agentName: "Claude",
      onBehalfOfUserId: "greg",
      answer: { type: "singleSelect", selectedId: "topbar" },
      rationale: "The top bar survives a narrow window better.",
      at: 1002,
    });
    flush();

    // A recommendation must never reach a tally. Separating the containers is
    // what makes that structural rather than a flag someone can forget.
    expect(b.getVotes(BLOCK).map((vote) => vote.voterId)).toEqual(["greg"]);
    expect(b.getRecommendations(BLOCK)).toHaveLength(1);
    expect(b.getRecommendations(BLOCK)[0].onBehalfOfUserId).toBe("greg");
  });

  it("notifies subscribers and hands out a frozen snapshot", () => {
    const { a, b, flush } = setUp();
    let notifications = 0;
    const unsubscribe = a.subscribe(() => {
      notifications += 1;
    });

    b.castVote(BLOCK, pick("karl", "topbar", 1000));
    flush();

    expect(notifications).toBeGreaterThan(0);
    expect(Object.isFrozen(a.getSnapshot())).toBe(true);

    unsubscribe();
    const before = notifications;
    b.castVote(BLOCK, pick("sam", "gutter", 1001));
    flush();
    expect(notifications).toBe(before);
  });

  it("ignores malformed stored entries rather than surfacing them as votes", () => {
    const { docA, a } = setUp();

    // A key written by a future version, or a corrupted value. Neither may
    // crash the block or be counted.
    docA
      .getMap("decisions")
      .set("no-separator-key", { answer: { type: "confirm" }, at: 1 });
    docA.getMap("decisions").set(`${BLOCK}\x1fghost`, "not an object");
    docA
      .getMap("decisions")
      .set(`${BLOCK}\x1fmissing-fields`, {
        answer: { type: "reorder" },
        at: 2,
      });

    expect(a.getVotes(BLOCK)).toEqual([]);
    expect(a.getSnapshot().votesByBlock["no-separator-key"]).toBeUndefined();
  });

  it("converges concurrent seal claims without deleting an unseen vote", () => {
    const { a, b, flush } = setUp();

    a.castVote(BLOCK, pick("greg", "gutter", 1000));
    b.castVote(BLOCK, pick("karl", "topbar", 1001));
    a.claimSeal(BLOCK, {
      outcome: "gutter",
      resolvedBy: "Greg",
      resolvedAt: "2026-09-04T14:22:00.000Z",
    });
    b.claimSeal(BLOCK, {
      outcome: "topbar",
      resolvedBy: "Karl",
      resolvedAt: "2026-09-04T14:22:01.000Z",
    });

    flush();

    expect(a.getSnapshot().sealClaimsByBlock[BLOCK]).toEqual(
      b.getSnapshot().sealClaimsByBlock[BLOCK]
    );
    expect(a.getVotes(BLOCK).map((entry) => entry.voterId)).toEqual([
      "greg",
      "karl",
    ]);
    expect(b.getVotes(BLOCK).map((entry) => entry.voterId)).toEqual([
      "greg",
      "karl",
    ]);
  });
});
