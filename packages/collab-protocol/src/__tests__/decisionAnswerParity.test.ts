// @vitest-environment node
/**
 * Holds `isValidDecisionAnswer` in step with the feedback surface's rules.
 *
 * The two implementations exist for a measured bundling reason, documented on
 * `isValidDecisionAnswer`: any value edge from the decision model into
 * `feedbackRequest.ts` turns that module into a shared chunk and pushes the web
 * console's eagerly-loaded feedback-ui entry ~420 gzip bytes over its budget,
 * for code that entry never runs.
 *
 * Duplication without a check is how the `multiSelect` clamp or the `reorder`
 * catalog rule ends up meaning two different things on two surfaces. This file
 * is that check: it drives both implementations over the same matrix and fails
 * the moment they disagree. Test code is not bundled, so reaching the feedback
 * rules here through `validateFeedbackResponse` is free.
 *
 * If you change a rule in one place, this test tells you about the other.
 */

import { describe, expect, it } from "vitest";
import {
  decisionAskFromSource,
  decisionDefaultVisibility,
  isValidDecisionAnswer,
  type DecisionBlockSource,
} from "../decisionBlock.js";
import {
  validateFeedbackResponse,
  type FeedbackAskType,
  type FeedbackResponse,
} from "../feedbackRequest.js";

function source(
  type: FeedbackAskType,
  entries: DecisionBlockSource["entries"],
  extra: Partial<DecisionBlockSource> = {}
): DecisionBlockSource {
  return {
    id: "dcn-1",
    ask: "Q",
    type,
    entries,
    asked: [],
    visibility: decisionDefaultVisibility(type),
    raw: {},
    ...extra,
  };
}

/** The feedback verdict for the same answer, reached through the public API. */
function feedbackSaysValid(block: DecisionBlockSource, answer: unknown): boolean {
  const ask = decisionAskFromSource(block);
  const result = validateFeedbackResponse(
    {
      id: block.id,
      asks: [ask],
      recipients: [{ userId: "greg", name: "Greg" }],
      assignments: [{ askId: ask.id, target: { kind: "user", userId: "greg" } }],
      lifecycle: { status: "open", changedAt: 0 },
    },
    {
      id: "r1",
      requestId: block.id,
      askId: ask.id,
      recipientUserId: "greg",
      answer,
      createdAt: 0,
      updatedAt: 0,
    } as FeedbackResponse
  );
  // Only the answer verdict is comparable; the recipient and assignment checks
  // have no counterpart in a decision and are satisfied by construction. Both
  // answer codes count: the feedback validator reports a wrong `type` as
  // `answerTypeMismatch` and everything else as `invalidAnswer`, while the
  // decision side folds them into one boolean.
  return !result.errors.some(
    (error) => error.code === "invalidAnswer" || error.code === "answerTypeMismatch"
  );
}

const ENTRIES = [
  { id: "a", label: "A" },
  { id: "b", label: "B", removable: true },
  { id: "c", label: "C" },
];

const CASES: Array<{ name: string; block: DecisionBlockSource; answer: unknown }> = [
  // singleSelect
  { name: "singleSelect valid", block: source("singleSelect", ENTRIES), answer: { type: "singleSelect", selectedId: "a" } },
  { name: "singleSelect unknown id", block: source("singleSelect", ENTRIES), answer: { type: "singleSelect", selectedId: "z" } },
  { name: "singleSelect other blocked", block: source("singleSelect", ENTRIES), answer: { type: "singleSelect", selectedId: "__other__", otherText: "x" } },
  { name: "singleSelect other allowed", block: source("singleSelect", ENTRIES, { allowOther: true }), answer: { type: "singleSelect", selectedId: "__other__", otherText: "x" } },
  { name: "singleSelect other blank", block: source("singleSelect", ENTRIES, { allowOther: true }), answer: { type: "singleSelect", selectedId: "__other__", otherText: "   " } },
  { name: "singleSelect wrong type", block: source("singleSelect", ENTRIES), answer: { type: "confirm", value: true } },

  // multiSelect
  { name: "multiSelect valid", block: source("multiSelect", ENTRIES), answer: { type: "multiSelect", selectedIds: ["a", "b"] } },
  { name: "multiSelect over max", block: source("multiSelect", ENTRIES, { maxSelected: 1 }), answer: { type: "multiSelect", selectedIds: ["a", "b"] } },
  { name: "multiSelect under min", block: source("multiSelect", ENTRIES, { minSelected: 2 }), answer: { type: "multiSelect", selectedIds: ["a"] } },
  { name: "multiSelect duplicate", block: source("multiSelect", ENTRIES), answer: { type: "multiSelect", selectedIds: ["a", "a"] } },
  { name: "multiSelect unknown id", block: source("multiSelect", ENTRIES), answer: { type: "multiSelect", selectedIds: ["z"] } },
  { name: "multiSelect empty", block: source("multiSelect", ENTRIES), answer: { type: "multiSelect", selectedIds: [] } },

  // reorder
  { name: "reorder full", block: source("reorder", ENTRIES), answer: { type: "reorder", orderedIds: ["c", "a", "b"], removedIds: [] } },
  { name: "reorder drops removable", block: source("reorder", ENTRIES), answer: { type: "reorder", orderedIds: ["a", "c"], removedIds: ["b"] } },
  { name: "reorder drops non-removable", block: source("reorder", ENTRIES), answer: { type: "reorder", orderedIds: ["a", "b"], removedIds: ["c"] } },
  { name: "reorder incomplete catalog", block: source("reorder", ENTRIES), answer: { type: "reorder", orderedIds: ["a"], removedIds: [] } },
  { name: "reorder duplicate", block: source("reorder", ENTRIES), answer: { type: "reorder", orderedIds: ["a", "a", "b"], removedIds: [] } },
  { name: "reorder under minItems", block: source("reorder", ENTRIES, { minItems: 3 }), answer: { type: "reorder", orderedIds: ["a", "c"], removedIds: ["b"] } },

  // editText
  { name: "editText valid", block: source("editText", [], { seed: "s" }), answer: { type: "editText", text: "hello", edited: true } },
  { name: "editText missing edited", block: source("editText", [], { seed: "s" }), answer: { type: "editText", text: "hello" } },
  { name: "editText under minLength", block: source("editText", [], { minLength: 10 }), answer: { type: "editText", text: "short", edited: true } },
  { name: "editText over maxLength", block: source("editText", [], { maxLength: 3 }), answer: { type: "editText", text: "toolong", edited: true } },

  // confirm
  { name: "confirm true", block: source("confirm", []), answer: { type: "confirm", value: true } },
  { name: "confirm false", block: source("confirm", []), answer: { type: "confirm", value: false } },
  { name: "confirm non-boolean", block: source("confirm", []), answer: { type: "confirm", value: "yes" } },

  // rating
  { name: "rating in range", block: source("rating", [], { min: 1, max: 5 }), answer: { type: "rating", value: 3 } },
  { name: "rating above max", block: source("rating", [], { min: 1, max: 5 }), answer: { type: "rating", value: 9 } },
  { name: "rating below min", block: source("rating", [], { min: 2, max: 5 }), answer: { type: "rating", value: 1 } },
  { name: "rating NaN", block: source("rating", [], { min: 1, max: 5 }), answer: { type: "rating", value: Number.NaN } },

  // shapes that are not answers at all
  { name: "null answer", block: source("confirm", []), answer: null },
  { name: "string answer", block: source("confirm", []), answer: "yes" },
];

describe("decision answer validation parity", () => {
  it.each(CASES)("$name agrees with the feedback rules", ({ block, answer }) => {
    expect(isValidDecisionAnswer(block, answer)).toBe(feedbackSaysValid(block, answer));
  });

  it("diverges only where a decision deliberately differs: a sealed block", () => {
    // The feedback surface has no notion of a sealed ask, so this one case is
    // expected to disagree and is asserted rather than left as a surprise.
    const sealed = source("confirm", [], {
      sealed: { resolved: true, resolvedAt: "", resolvedBy: "greg", votes: [] },
    });
    const answer = { type: "confirm", value: true };

    expect(isValidDecisionAnswer(sealed, answer)).toBe(false);
    expect(feedbackSaysValid(sealed, answer)).toBe(true);
  });
});
