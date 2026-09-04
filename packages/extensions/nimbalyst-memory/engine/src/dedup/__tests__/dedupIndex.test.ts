// @vitest-environment node
/**
 * The index turns comparisons into one action. The cases worth the tokens are
 * the ones where an action is not the obvious reading of a score: an extension
 * must be stored *and* retire what it extends, a subset must be dropped even
 * though it is perfectly accurate, and an ambiguous overlap must go to a human
 * rather than be resolved by a threshold.
 *
 * The LSH parity test is the other one that earns its place. Banding is an
 * optimisation, and an optimisation that silently drops the supersede case —
 * whose Jaccard is low by construction — would be invisible until the store
 * grew past the exhaustive-scan cutoff in production.
 */
import { describe, expect, it } from "vitest";
import { DedupIndex } from "../dedupIndex.js";

const BASE = `We moved the SQLite writes behind a WriteCoordinator because concurrent writers were hitting lock contention during tracker sync. The coordinator batches small writes into a single lane and chunks large migrations onto a background lane, so an interactive query is never queued behind a bulk import. This was a day-one architectural component rather than an optimisation added later.`;

const NEAR_RESTATEMENT = `SQLite writes were moved behind a WriteCoordinator because concurrent writers hit lock contention during tracker sync. The coordinator batches small writes into one lane and chunks large migrations onto a background lane, so an interactive query is never queued behind a bulk import. It was a day-one architectural component rather than an optimisation added later.`;

const SUPERSET = `${BASE}

A later measurement showed the batched lane cut p99 write latency from 340ms to 45ms on a six gigabyte database. We added a heartbeat so a stalled lane surfaces in the health view instead of silently backing up. The chunk size is 512 rows, tuned against the largest workspace we have on disk today.`;

const SUBSET = `The coordinator batches small writes into a single lane and chunks large migrations onto a background lane, so an interactive query is never queued behind a bulk import.`;

const MODERATE_PARAPHRASE = `Lock contention during tracker sync was the reason for the WriteCoordinator: concurrent writers were competing for the same SQLite lock. Bulk migrations now take a background lane so interactive queries do not wait.`;

const UNRELATED = `Frameless windows need explicit drag regions, and every interactive control inside one needs no-drag or it stops responding. Persisted bounds must be clamped against the current display arrangement at creation time, not after the window is shown.`;

function seeded(): DedupIndex {
  const index = new DedupIndex();
  index.add("mem-writecoordinator", BASE);
  index.add("mem-frameless", UNRELATED);
  return index;
}

describe("DedupIndex.classify", () => {
  it("stores a page nothing collides with", () => {
    const decision = seeded().classify(
      "Voice sessions clamp each audio chunk to the current playback clock, because a start time left in the past plays the tail of a response at several times speed."
    );

    expect(decision.action).toBe("store");
    expect(decision.matches).toEqual([]);
  });

  it("discards a restatement and names what it repeats", () => {
    const decision = seeded().classify(NEAR_RESTATEMENT);

    expect(decision.action).toBe("discard");
    expect(decision.duplicateOf).toBe("mem-writecoordinator");
    expect(decision.supersedes).toEqual([]);
  });

  it("supersedes rather than discards when the new page adds material", () => {
    const decision = seeded().classify(SUPERSET);

    expect(decision.action).toBe("supersede");
    expect(decision.supersedes).toEqual(["mem-writecoordinator"]);
    expect(decision.duplicateOf).toBeUndefined();
  });

  it("discards a page already covered by a longer stored one", () => {
    const decision = seeded().classify(SUBSET);

    expect(decision.action).toBe("discard");
    expect(decision.matches[0]?.verdict).toBe("subsumed");
  });

  it("sends an ambiguous overlap to review instead of deciding", () => {
    const decision = seeded().classify(MODERATE_PARAPHRASE);

    expect(decision.action).toBe("review");
    expect(decision.matches[0]?.id).toBe("mem-writecoordinator");
    expect(decision.matches[0]?.rationale).toMatch(/overlaps/);
  });

  it("supersedes every stored page the new one covers", () => {
    const index = seeded();
    index.add("mem-lane-detail", SUBSET);

    const decision = index.classify(SUPERSET);

    expect(decision.action).toBe("supersede");
    expect([...decision.supersedes].sort()).toEqual([
      "mem-lane-detail",
      "mem-writecoordinator",
    ]);
  });

  it("excludes the page being edited from its own comparison", () => {
    const index = seeded();

    expect(index.classify(BASE).action).toBe("discard");
    expect(
      index.classify(BASE, { exclude: ["mem-writecoordinator"] }).action
    ).toBe("store");
  });

  it("accepts embedder cosines per id without any other change", () => {
    const index = seeded();
    const reworded =
      "Bulk jobs and short reads used to fight over one database handle. Putting a serialising layer in front of the engine, with separate paths for big and small work, ended that.";

    expect(index.classify(reworded).action).toBe("store");
    expect(
      index.classify(reworded, {
        semanticScores: new Map([["mem-writecoordinator", 0.94]]),
      }).action
    ).toBe("discard");
  });

  it("keeps semantic-only candidates after the index switches to LSH", () => {
    const index = new DedupIndex({ exhaustiveBelow: 0 });
    const reworded =
      "Bulk jobs and short reads used to fight over one database handle. Putting a serialising layer in front of the engine, with separate paths for big and small work, ended that.";
    index.add("mem-writecoordinator", BASE);

    expect(index.classify(reworded).action).toBe("store");
    expect(
      index.classify(reworded, {
        semanticScores: new Map([["mem-writecoordinator", 0.94]]),
      }).action
    ).toBe("discard");
  });
});

describe("DedupIndex membership", () => {
  it("replaces an entry when the same id is re-added", () => {
    const index = new DedupIndex();
    index.add("mem-1", BASE);
    index.add("mem-1", UNRELATED);

    expect(index.size).toBe(1);
    expect(index.classify(NEAR_RESTATEMENT).action).toBe("store");
    expect(index.classify(UNRELATED).action).toBe("discard");
  });

  it("stops matching a removed page", () => {
    const index = seeded();

    expect(index.remove("mem-writecoordinator")).toBe(true);
    expect(index.remove("mem-writecoordinator")).toBe(false);
    expect(index.has("mem-writecoordinator")).toBe(false);
    expect(index.classify(NEAR_RESTATEMENT).action).toBe("store");
  });

  it("caps the returned matches", () => {
    const index = new DedupIndex();
    for (let i = 0; i < 6; i += 1)
      index.add(`mem-${i}`, `${BASE} Variant ${i}.`);

    expect(index.query(BASE, { limit: 2 })).toHaveLength(2);
  });
});

describe("LSH shortlisting", () => {
  /**
   * A superset has containment 1.0 and Jaccard near 0.57, so it is precisely
   * the pair a conventionally-banded MinHash would filter out before scoring.
   */
  it("finds the supersede pair on the banded path as well as the exhaustive one", () => {
    const build = (exhaustiveBelow: number): DedupIndex => {
      const index = new DedupIndex({ exhaustiveBelow });
      index.add("mem-writecoordinator", BASE);
      index.add("mem-frameless", UNRELATED);
      for (let i = 0; i < 20; i += 1) {
        index.add(
          `filler-${i}`,
          `Unrelated note ${i} about release packaging, notarisation, and the ${i} dmg upload step.`
        );
      }
      return index;
    };

    const exhaustive = build(1000).classify(SUPERSET);
    const banded = build(0).classify(SUPERSET);

    expect(exhaustive.action).toBe("supersede");
    expect(banded.action).toBe("supersede");
    expect(banded.supersedes).toEqual(exhaustive.supersedes);
  });

  it("agrees with the exhaustive path on a restatement", () => {
    const banded = new DedupIndex({ exhaustiveBelow: 0 });
    banded.add("mem-writecoordinator", BASE);

    expect(banded.classify(NEAR_RESTATEMENT).duplicateOf).toBe(
      "mem-writecoordinator"
    );
  });
});
