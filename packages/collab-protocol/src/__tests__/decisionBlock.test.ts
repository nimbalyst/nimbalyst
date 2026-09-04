// @vitest-environment node
/**
 * The aggregations a document needs and a transcript does not.
 *
 * In the transcript one person answers and the widget is done. Here N people
 * answer, so every ask type needs a tally -- and three of them have no obvious
 * one. Those three are what this file mostly covers.
 */

import { describe, expect, it } from "vitest";
import {
  buildDecisionSealedRecord,
  canViewerSeeDecisionTally,
  checkDecisionSeal,
  decisionDefaultVisibility,
  decisionOutcomeSummary,
  decisionProgress,
  decisionRatingScaleValues,
  isValidDecisionAnswer,
  proposeDecisionOutcome,
  tallyDecision,
  type DecisionBlockSource,
  type DecisionVote,
} from "../decisionBlock.js";
import type { FeedbackAnswer, FeedbackAskType } from "../feedbackRequest.js";

function source(
  type: FeedbackAskType,
  entryIds: string[],
  extra: Partial<DecisionBlockSource> = {}
): DecisionBlockSource {
  return {
    id: "dcn-1",
    ask: "Q",
    type,
    entries: entryIds.map((id) => ({ id, label: id })),
    asked: [],
    visibility: decisionDefaultVisibility(type),
    raw: {},
    ...extra,
  };
}

function vote(
  voterId: string,
  answer: FeedbackAnswer,
  at: number
): DecisionVote {
  return { voterId, answer, at };
}

describe("decision tallies", () => {
  it("aggregates reorder to one team order by mean position, with a delta against the viewer", () => {
    // Four people submit four orderings. Drawing all four produces something
    // nobody reads, so the answered state shows one order and a delta chip.
    const block = source("reorder", [
      "docs",
      "trackers",
      "messaging",
      "editors",
    ]);
    const votes = [
      vote(
        "greg",
        {
          type: "reorder",
          orderedIds: ["trackers", "docs", "messaging", "editors"],
          removedIds: [],
        },
        1
      ),
      vote(
        "karl",
        {
          type: "reorder",
          orderedIds: ["docs", "trackers", "messaging", "editors"],
          removedIds: [],
        },
        2
      ),
      vote(
        "sam",
        {
          type: "reorder",
          orderedIds: ["docs", "trackers", "editors", "messaging"],
          removedIds: [],
        },
        3
      ),
      vote(
        "mel",
        {
          type: "reorder",
          orderedIds: ["docs", "trackers", "messaging", "editors"],
          removedIds: [],
        },
        4
      ),
    ];

    const tally = tallyDecision(block, votes, "greg");
    expect(tally.type).toBe("reorder");
    if (tally.type !== "reorder") return;

    expect(tally.entries.map((entry) => entry.entryId)).toEqual([
      "docs",
      "trackers",
      "messaging",
      "editors",
    ]);
    expect(tally.entries[0]!.firstPlaceCount).toBe(3);
    // Greg ranked docs second; the team put it first.
    expect(tally.entries[0]!.viewerPosition).toBe(2);
    expect(tally.entries[0]!.teamRank).toBe(1);
  });

  it("sinks an entry nobody ranked to the bottom rather than the top", () => {
    // An empty mean would otherwise sort as 0 and win the whole ranking.
    const block = source("reorder", ["a", "b", "c"], {
      entries: [
        { id: "a", label: "a" },
        { id: "b", label: "b" },
        { id: "c", label: "c", removable: true },
      ],
    });
    const tally = tallyDecision(block, [
      vote(
        "greg",
        { type: "reorder", orderedIds: ["b", "a"], removedIds: ["c"] },
        1
      ),
    ]);
    if (tally.type !== "reorder") throw new Error("wrong tally");
    expect(tally.entries.at(-1)?.entryId).toBe("c");
    expect(tally.entries.at(-1)?.removedByVoterIds).toEqual(["greg"]);
  });

  it("tallies editText as discrete proposals, merging only identical wording", () => {
    // There is nothing to average in prose, and a CRDT merge of four rewrites
    // produces text nobody wrote. Two people who typed the same thing back one
    // proposal; everything else stays a separate alternative.
    const block = source("editText", [], { seed: "Original wording." });
    const tally = tallyDecision(block, [
      vote(
        "greg",
        { type: "editText", text: "Greg's rewrite.", edited: true },
        1
      ),
      vote(
        "karl",
        { type: "editText", text: "Karl's rewrite.", edited: true },
        2
      ),
      vote(
        "sam",
        { type: "editText", text: "Karl's rewrite.", edited: true },
        3
      ),
      vote(
        "mel",
        { type: "editText", text: "Original wording.", edited: false },
        4
      ),
    ]);
    if (tally.type !== "editText") throw new Error("wrong tally");

    expect(tally.proposals).toHaveLength(3);
    expect(tally.proposals[0]).toMatchObject({
      voterId: "karl",
      count: 2,
      backerIds: ["karl", "sam"],
    });
    expect(tally.proposals.find((p) => p.voterId === "mel")?.unchanged).toBe(
      true
    );
  });

  it("covers every rating step even where nobody picked it", () => {
    // The histogram needs an empty column, not a missing one.
    const block = source("rating", [], { min: 1, max: 5 });
    const tally = tallyDecision(
      block,
      [
        vote("greg", { type: "rating", value: 4 }, 1),
        vote("karl", { type: "rating", value: 4 }, 2),
        vote("sam", { type: "rating", value: 2 }, 3),
      ],
      "sam"
    );
    if (tally.type !== "rating") throw new Error("wrong tally");

    expect(tally.distribution.map((bucket) => bucket.count)).toEqual([
      0, 1, 0, 2, 0,
    ]);
    expect(tally.mean).toBeCloseTo(10 / 3);
    expect(tally.viewerValue).toBe(2);
  });

  it("rejects unsafe rating scales and values that are not on a rendered step", () => {
    const unsafe = source("rating", [], { min: 1, max: 5, step: 1e-300 });
    expect(decisionRatingScaleValues(unsafe)).toEqual([]);
    expect(tallyDecision(unsafe, [])).toMatchObject({
      type: "rating",
      distribution: [],
    });

    const stepped = source("rating", [], { min: 1, max: 5, step: 2 });
    expect(decisionRatingScaleValues(stepped)).toEqual([1, 3, 5]);
    expect(isValidDecisionAnswer(stepped, { type: "rating", value: 2 })).toBe(
      false
    );
    const tally = tallyDecision(stepped, [
      vote("stale", { type: "rating", value: 2 }, 1),
      vote("valid", { type: "rating", value: 3 }, 2),
    ]);
    expect(tally.respondentCount).toBe(1);

    const decimal = source("rating", [], { min: 0, max: 1, step: 0.1 });
    const decimalTally = tallyDecision(decimal, [
      vote("decimal", { type: "rating", value: 0.3 }, 1),
    ]);
    expect(decimalTally).toMatchObject({
      type: "rating",
      respondentCount: 1,
      mean: 0.3,
    });
    if (decimalTally.type === "rating") {
      expect(decimalTally.distribution.find((bucket) => bucket.count === 1)?.value).toBeCloseTo(0.3);
    }
  });

  it("ignores malformed or stale CRDT answers before tallying and progress", () => {
    const block = source("reorder", ["a", "b"]);
    const malformed = {
      voterId: "ghost",
      answer: { type: "reorder" },
      at: 1,
    } as unknown as DecisionVote;
    expect(() => tallyDecision(block, [malformed])).not.toThrow();
    expect(tallyDecision(block, [malformed]).respondentCount).toBe(0);
    expect(decisionProgress(block, [malformed]).answered).toBe(0);
  });

  it("counts multiSelect rows independently, not as a ranking", () => {
    const block = source("multiSelect", ["a", "b"]);
    const tally = tallyDecision(block, [
      vote("greg", { type: "multiSelect", selectedIds: ["a", "b"] }, 1),
      vote("karl", { type: "multiSelect", selectedIds: ["a"] }, 2),
    ]);
    if (tally.type !== "multiSelect") throw new Error("wrong tally");
    expect(tally.entries.map((e) => e.count)).toEqual([2, 1]);
    expect(tally.entries[0]!.share).toBe(1);
    expect(tally.entries[1]!.share).toBe(0.5);
  });
});

describe("decision visibility and progress", () => {
  it("hides the tally until you answer, for the two types where it changes answers", () => {
    expect(decisionDefaultVisibility("multiSelect")).toBe(
      "hiddenUntilAnswered"
    );
    expect(decisionDefaultVisibility("rating")).toBe("hiddenUntilAnswered");
    expect(decisionDefaultVisibility("singleSelect")).toBe("open");

    const block = source("multiSelect", ["a"]);
    const votes = [
      vote("greg", { type: "multiSelect", selectedIds: ["a"] }, 1),
    ];

    expect(canViewerSeeDecisionTally(block, votes, "karl")).toBe(false);
    expect(canViewerSeeDecisionTally(block, votes, "greg")).toBe(true);
    // The author needs the tally to seal, and already knows what they asked.
    expect(
      canViewerSeeDecisionTally(block, votes, "karl", { isAuthor: true })
    ).toBe(true);
  });

  it("reports progress against the people named in asked:", () => {
    const block = source("confirm", [], { asked: ["greg", "karl"] });
    const one = [vote("greg", { type: "confirm", value: true }, 1)];
    expect(decisionProgress(block, one)).toEqual({
      answered: 1,
      asked: 2,
      complete: false,
    });

    const both = [...one, vote("karl", { type: "confirm", value: false }, 2)];
    expect(decisionProgress(block, both).complete).toBe(true);

    // With nobody named the block is open to any reader, so there is no
    // denominator and completeness is not a thing that can be reached.
    expect(decisionProgress(source("confirm", []), both)).toMatchObject({
      asked: 0,
      complete: false,
    });
  });
});

describe("sealing", () => {
  it("never seals on a tally alone, and demands a written conclusion for rating", () => {
    const rating = source("rating", [], { min: 1, max: 5 });
    // A 3.7 average is a reading, not an outcome.
    expect(checkDecisionSeal(rating, "")).toEqual({
      ok: false,
      reason: "conclusionRequired",
    });
    expect(checkDecisionSeal(rating, "Keeping the 900px target").ok).toBe(true);

    const single = source("singleSelect", ["a"]);
    expect(checkDecisionSeal(single, undefined)).toEqual({
      ok: false,
      reason: "noOutcome",
    });
    expect(checkDecisionSeal(single, [])).toEqual({
      ok: false,
      reason: "noOutcome",
    });

    const alreadySealed = source("confirm", [], {
      sealed: { resolved: true, resolvedAt: "", resolvedBy: "greg", votes: [] },
    });
    expect(checkDecisionSeal(alreadySealed, false)).toEqual({
      ok: false,
      reason: "alreadySealed",
    });
  });

  it("records a rating's distribution beside its written conclusion", () => {
    const block = source("rating", [], { min: 1, max: 3 });
    const record = buildDecisionSealedRecord({
      source: block,
      outcome: "Keeping the 900px target",
      resolvedBy: "greg",
      resolvedAt: new Date("2026-09-04T14:22:00Z"),
      votes: [
        vote("greg", { type: "rating", value: 3 }, 1),
        vote("karl", { type: "rating", value: 2 }, 2),
      ],
    });

    expect(record.resolved).toBe("Keeping the 900px target");
    expect(record.score).toBe(2.5);
    expect(record.distribution).toEqual({ "2": 1, "3": 1 });
    expect(record.votes).toEqual([
      { voter: "greg", value: "3" },
      { voter: "karl", value: "2" },
    ]);
  });

  it("carries a voter's note into the sealed record", () => {
    // The rationale is the part a reader reopening this a year later needs;
    // losing it turns the record back into a bare count.
    const block = source("singleSelect", ["gutter", "topbar"]);
    const record = buildDecisionSealedRecord({
      source: block,
      outcome: "gutter",
      resolvedBy: "greg",
      resolvedAt: new Date("2026-09-04T14:22:00Z"),
      votes: [
        {
          voterId: "karl",
          voterName: "karl",
          answer: { type: "singleSelect", selectedId: "gutter" },
          at: 1,
          note: "the words are the whole point on a narrow window",
        },
      ],
    });

    expect(record.votes[0]!.value).toBe(
      'gutter ("the words are the whole point on a narrow window")'
    );
  });

  it("retains edit-text proposals and seals unanimously removed reorder entries", () => {
    const edit = source("editText", [], { seed: "Original" });
    const editRecord = buildDecisionSealedRecord({
      source: edit,
      outcome: "Accepted",
      resolvedBy: "greg",
      resolvedAt: new Date("2026-09-04T14:22:00Z"),
      votes: [
        vote(
          "karl",
          { type: "editText", text: "Losing proposal", edited: true },
          1
        ),
      ],
    });
    expect(editRecord.votes).toEqual([
      { voter: "karl", value: "Losing proposal" },
    ]);

    const reorder = source("reorder", ["a", "b"], {
      entries: [
        { id: "a", label: "a" },
        { id: "b", label: "b", removable: true },
      ],
    });
    const reorderVotes = [
      vote(
        "greg",
        { type: "reorder", orderedIds: ["a"], removedIds: ["b"] },
        1
      ),
      vote(
        "karl",
        { type: "reorder", orderedIds: ["a"], removedIds: ["b"] },
        2
      ),
    ];
    expect(proposeDecisionOutcome(reorder, reorderVotes)).toEqual(["a"]);
    expect(
      buildDecisionSealedRecord({
        source: reorder,
        outcome: ["a"],
        resolvedBy: "greg",
        resolvedAt: new Date("2026-09-04T14:22:00Z"),
        votes: reorderVotes,
      }).removed
    ).toEqual(["b"]);
  });

  it("summarizes every type into the same one-line slot", () => {
    const seal = (
      block: DecisionBlockSource,
      resolved: string | boolean | string[]
    ): DecisionBlockSource => ({
      ...block,
      sealed: { resolved, resolvedAt: "", resolvedBy: "greg", votes: [] },
    });

    expect(
      decisionOutcomeSummary(seal(source("singleSelect", ["gutter"]), "gutter"))
    ).toBe("gutter");
    expect(
      decisionOutcomeSummary(seal(source("reorder", ["a", "b"]), ["b", "a"]))
    ).toBe("b → a");
    expect(decisionOutcomeSummary(seal(source("confirm", []), false))).toBe(
      "No"
    );
    expect(
      decisionOutcomeSummary(
        seal(source("multiSelect", ["a", "b"]), ["a", "b"])
      )
    ).toBe("a, b");
  });
});
