// @vitest-environment node
/**
 * Sealing writes into the file, and that is the one operation here that
 * overwrites a durable record. The two things worth holding down are that the
 * outcome lands in the markdown in the shape the type promised, and that two
 * clients sealing at once cannot both write.
 */

import { describe, expect, it } from "vitest";
import type { DecisionVote } from "@nimbalyst/collab-protocol";
import {
  parseDecisionFence,
  reconcileDecisionFence,
  sealDecisionFence,
} from "../decisionFence";

const AT = new Date("2026-09-04T14:22:00.000Z");

const OPEN = `id: dcn-7f3a2c
ask: Which navigation model for the web console?
type: singleSelect
options:
  - id: gutter
    label: Icon gutter that expands to words
  - id: topbar
    label: Top bar with a project switcher
asked:
  - greg
  - karl`;

function vote(
  voterId: string,
  selectedId: string,
  note?: string
): DecisionVote {
  return {
    voterId,
    voterName: voterId,
    answer: { type: "singleSelect", selectedId },
    at: 1,
    ...(note !== undefined ? { note } : {}),
  };
}

describe("sealDecisionFence", () => {
  it("writes the outcome and the attributed tally into the fence", () => {
    const result = sealDecisionFence(OPEN, {
      outcome: "gutter",
      resolvedBy: "greg",
      resolvedAt: AT,
      votes: [
        vote("greg", "gutter"),
        vote(
          "karl",
          "gutter",
          "the words are the whole point on a narrow window"
        ),
        vote("sam", "topbar"),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.content).toContain("resolved: gutter");
    expect(result.content).toContain("resolvedBy: greg");
    expect(result.content).toContain('resolvedAt: "2026-09-04T14:22:00.000Z"');
    expect(result.content).toContain(
      'karl: gutter ("the words are the whole point on a narrow window")'
    );

    // The question and options are still there: a sealed decision has to stay
    // readable, or the record says what was chosen without saying from what.
    expect(result.content).toContain(
      "ask: Which navigation model for the web console?"
    );
    expect(result.content).toContain("id: topbar");

    // And it still round-trips.
    const reparsed = parseDecisionFence(result.content);
    expect(reparsed?.sealed?.resolved).toBe("gutter");
    expect(reparsed?.sealed?.votes).toHaveLength(3);
  });

  it("refuses a second seal, which is the concurrent-seal guard", () => {
    const first = sealDecisionFence(OPEN, {
      outcome: "gutter",
      resolvedBy: "greg",
      resolvedAt: AT,
      votes: [vote("greg", "gutter")],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // A peer sealed while this client was composing. Because the caller passes
    // the *live* fence text, the loser sees the winner's seal and aborts rather
    // than appending a second `resolved:` line.
    const second = sealDecisionFence(first.content, {
      outcome: "topbar",
      resolvedBy: "karl",
      resolvedAt: AT,
      votes: [vote("karl", "topbar")],
    });

    expect(second).toEqual({ ok: false, reason: "alreadySealed" });
  });

  it("will not seal a rating on its mean alone", () => {
    const rating = `id: dcn-3e5b64
ask: How confident are you in the 900px design target?
type: rating
min: 1
max: 5`;
    const votes: DecisionVote[] = [
      { voterId: "greg", answer: { type: "rating", value: 4 }, at: 1 },
      { voterId: "karl", answer: { type: "rating", value: 3 }, at: 2 },
    ];

    expect(
      sealDecisionFence(rating, {
        outcome: "",
        resolvedBy: "greg",
        resolvedAt: AT,
        votes,
      })
    ).toEqual({ ok: false, reason: "conclusionRequired" });

    const sealed = sealDecisionFence(rating, {
      outcome: "Keeping the 900px target",
      resolvedBy: "greg",
      resolvedAt: AT,
      votes,
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    // The written conclusion is the outcome; the number is recorded beside it.
    expect(sealed.content).toContain("resolved: Keeping the 900px target");
    expect(sealed.content).toContain("score: 3.5");
    expect(sealed.content).toContain("distribution:");
  });

  it("records which proposal an editText seal accepted", () => {
    const editText = `id: dcn-c204e8
ask: Final wording for the beta announcement
type: editText
seed: Teams can now work in the same document.`;

    const result = sealDecisionFence(editText, {
      outcome: "Your team edits the same document at once.",
      resolvedBy: "greg",
      resolvedAt: AT,
      resolvedFrom: "karl",
      votes: [
        {
          voterId: "karl",
          voterName: "karl",
          answer: {
            type: "editText",
            text: "Your team edits the same document at once.",
            edited: true,
          },
          at: 1,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Without `resolvedFrom` the record would say what was chosen but not whose
    // wording it was, which is the attribution the type exists to preserve.
    expect(result.content).toContain("resolvedFrom: karl");
    expect(result.content).toContain(
      "karl: Your team edits the same document at once."
    );
  });

  it("preserves an unknown key through a seal", () => {
    const result = sealDecisionFence(`${OPEN}\nsupersedes: dcn-001122`, {
      outcome: "gutter",
      resolvedBy: "greg",
      resolvedAt: AT,
      votes: [vote("greg", "gutter")],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("supersedes: dcn-001122");
  });

  it("reconciles an already-rendered seal to an authoritative winning claim", () => {
    const first = sealDecisionFence(OPEN, {
      outcome: "gutter",
      resolvedBy: "greg",
      resolvedAt: AT,
      votes: [vote("greg", "gutter")],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const reconciled = reconcileDecisionFence(first.content, {
      outcome: "topbar",
      resolvedBy: "karl",
      resolvedAt: new Date("2026-09-04T14:23:00.000Z"),
      votes: [vote("greg", "gutter"), vote("karl", "topbar")],
    });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    expect(reconciled.source.sealed).toMatchObject({
      resolved: "topbar",
      resolvedBy: "karl",
    });
    expect(reconciled.source.sealed?.votes).toHaveLength(2);
  });

  it("reports an unreadable fence instead of overwriting it", () => {
    // Never rewrite a block we could not parse: whatever is in there is the
    // user's, and a "seal" that replaced it would destroy it.
    expect(
      sealDecisionFence("- not a mapping", {
        outcome: "x",
        resolvedBy: "greg",
        resolvedAt: AT,
        votes: [],
      })
    ).toEqual({ ok: false, reason: "unparseable" });
  });
});
