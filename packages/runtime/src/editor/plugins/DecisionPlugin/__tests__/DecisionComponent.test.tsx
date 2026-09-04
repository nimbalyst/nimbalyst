/**
 * The one thing about this block a reader cannot see from the source: what
 * happens at the moment you answer.
 *
 * In the transcript a widget is done once you answer. Here the block flips from
 * control to tally, and for the two hidden-until-answered types that flip is
 * also when the results become visible at all. That transition is the feature.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as Y from "yjs";

const testNode = vi.hoisted(() => ({
  content: "",
  getContent() {
    return this.content;
  },
  setContent(next: string) {
    this.content = next;
  },
}));

vi.mock("lexical", async (importOriginal) => ({
  ...(await importOriginal<typeof import("lexical")>()),
  $getNodeByKey: () => testNode,
}));

// The block reaches the editor only to write a seal. Mocking the narrowest
// module keeps the whole Lexical tree -- and ~2.6s of import cost -- out of
// this file.
vi.mock("@lexical/react/LexicalComposerContext", () => ({
  useLexicalComposerContext: () => [{ update: (fn: () => void) => fn() }],
}));

// `DecisionNode` lazy-imports this very component, so importing it here would
// close a cycle through the module under test. The seal's write-back is covered
// directly in `sealDecisionFence.test.ts`, which is where the logic now lives;
// what this file covers is everything up to that call.
vi.mock("../DecisionNode", () => ({
  $isDecisionNode: (node: unknown) => node === testNode,
}));

import DecisionComponent from "../DecisionComponent";
import { DecisionsProvider, YDocDecisionRepository } from "../../../decisions";
import type { DecisionsConfig } from "../../../decisions/types";

function renderBlock(
  fence: string,
  options: { viewerId?: string; doc?: Y.Doc } = {}
): { doc: Y.Doc } {
  testNode.content = fence;
  const doc = options.doc ?? new Y.Doc();
  const config: DecisionsConfig = {
    getYDoc: () => doc,
    currentUser: { id: options.viewerId ?? "greg", name: "Greg" },
    getMembers: () => [
      { id: "greg", name: "Greg" },
      { id: "karl", name: "Karl" },
    ],
  };

  render(
    <DecisionsProvider config={config}>
      <DecisionComponent className="" content={fence} nodeKey="k1" />
    </DecisionsProvider>
  );
  return { doc };
}

const SINGLE = `id: dcn-1
ask: Which navigation model?
type: singleSelect
options:
  - id: gutter
    label: Icon gutter
  - id: topbar
    label: Top bar`;

describe("DecisionComponent", () => {
  it("flips from control to tally when you answer, and records the vote", () => {
    const { doc } = renderBlock(SINGLE);

    // Before answering there is an Answer button and no tally.
    const answer = screen.getByTestId("decision-answer") as HTMLButtonElement;
    expect(answer.disabled).toBe(true);
    expect(screen.queryByTestId("decision-change")).toBeNull();

    fireEvent.click(screen.getByText("Icon gutter"));
    expect(answer.disabled).toBe(false);
    fireEvent.click(answer);

    // The vote is in the Y.Doc, under the flat key.
    const stored = doc.getMap("decisions").toJSON();
    expect(Object.keys(stored)).toEqual(["dcn-1\x1fgreg"]);
    expect(stored["dcn-1\x1fgreg"].answer).toEqual({
      type: "singleSelect",
      selectedId: "gutter",
    });

    // And the footer has flipped to the answered shape.
    expect(screen.getByTestId("decision-change")).toBeTruthy();
    expect(screen.getByTestId("decision-seal")).toBeTruthy();
    expect(screen.getByText(/1 answered/)).toBeTruthy();
  });

  it("hides a multiSelect tally until you have answered, then shows it", () => {
    const multi = `id: dcn-2
ask: Which surfaces ship in the beta?
type: multiSelect
items:
  - id: trackers
    title: Editable trackers
  - id: docs
    title: Collaborative documents`;

    const doc = new Y.Doc();
    // Karl has already voted. Greg must not see what he picked before answering.
    new YDocDecisionRepository(doc).castVote("dcn-2", {
      voterId: "karl",
      voterName: "Karl",
      answer: { type: "multiSelect", selectedIds: ["trackers"] },
      at: 1,
    });

    renderBlock(multi, { doc, viewerId: "greg" });

    expect(screen.getByText(/results hidden until you answer/)).toBeTruthy();

    fireEvent.click(screen.getByText("Editable trackers"));
    fireEvent.click(screen.getByTestId("decision-answer"));

    expect(screen.queryByText(/results hidden until you answer/)).toBeNull();
    expect(screen.getByText(/2 answered/)).toBeTruthy();
  });

  it("leaves confirm unanswered rather than defaulting to no", () => {
    renderBlock(`id: dcn-3
ask: Ship it?
type: confirm`);

    // A silent false from someone who never opened the document would be
    // indistinguishable from a considered no.
    const group = screen.getByRole("radiogroup");
    expect(group.getAttribute("data-checked")).toBe("unanswered");
    expect(
      (screen.getByTestId("decision-answer") as HTMLButtonElement).disabled
    ).toBe(true);

    fireEvent.click(screen.getByText("No"));
    expect(group.getAttribute("data-checked")).toBe("false");
    expect(
      (screen.getByTestId("decision-answer") as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("renders an agent recommendation outside the tally and labels it uncounted", () => {
    const doc = new Y.Doc();
    const repository = new YDocDecisionRepository(doc);
    repository.castVote("dcn-1", {
      voterId: "karl",
      answer: { type: "singleSelect", selectedId: "gutter" },
      at: 1,
    });
    repository.setRecommendation("dcn-1", {
      agentId: "agent-1",
      agentName: "Claude",
      answer: { type: "singleSelect", selectedId: "topbar" },
      rationale: "The top bar survives a narrow window better.",
      at: 2,
    });

    renderBlock(SINGLE, { doc, viewerId: "greg" });

    expect(screen.getByTestId("decision-recommendation")).toBeTruthy();
    expect(screen.getByText(/not counted/)).toBeTruthy();
    // One human vote, and the agent has not made it two.
    expect(screen.getByText(/1 answered/)).toBeTruthy();
  });

  it("seals a solo answer straight into the fence when there is no Y.Doc", () => {
    testNode.content = SINGLE;
    const config: DecisionsConfig = {
      getYDoc: () => null,
      currentUser: { id: "greg", name: "Greg" },
    };
    render(
      <DecisionsProvider config={config}>
        <DecisionComponent className="" content={SINGLE} nodeKey="k1" />
      </DecisionsProvider>
    );

    // Solo is not an error state, but it must not pretend to be a poll.
    expect(screen.getByText(/seals straight to the file/)).toBeTruthy();
    fireEvent.click(screen.getByText("Icon gutter"));
    fireEvent.click(screen.getByTestId("decision-answer"));
    expect(testNode.content).toContain("resolved: gutter");
    expect(testNode.content).toContain("resolvedBy: Greg");
    expect(testNode.content).toContain("Greg: gutter");
  });

  it("lets the sealer override a tied single-select tally", () => {
    const doc = new Y.Doc();
    const repository = new YDocDecisionRepository(doc);
    repository.castVote("dcn-1", {
      voterId: "greg",
      answer: { type: "singleSelect", selectedId: "gutter" },
      at: 1,
    });
    repository.castVote("dcn-1", {
      voterId: "karl",
      answer: { type: "singleSelect", selectedId: "topbar" },
      at: 2,
    });
    renderBlock(SINGLE, { doc, viewerId: "greg" });

    fireEvent.click(screen.getByTestId("decision-seal"));
    const outcome = screen.getByTestId(
      "decision-seal-outcome"
    ) as HTMLSelectElement;
    fireEvent.change(outcome, { target: { value: "topbar" } });
    fireEvent.click(screen.getByTestId("decision-seal-confirm"));
    expect(repository.getSnapshot().sealClaimsByBlock["dcn-1"]?.outcome).toBe(
      "topbar"
    );
  });

  it("shows a sealed block as one collapsed row that expands to the tally", () => {
    render(
      <DecisionsProvider>
        <DecisionComponent
          className=""
          nodeKey="k1"
          content={`${SINGLE}
resolved: gutter
resolvedAt: "2026-09-04T14:22:00Z"
resolvedBy: greg
votes:
  - greg: gutter
  - karl: topbar`}
        />
      </DecisionsProvider>
    );

    expect(screen.getByText("Icon gutter")).toBeTruthy();
    expect(screen.getByText(/Decided by greg/)).toBeTruthy();
    // The attributed tally is behind the chevron, not on screen by default --
    // a document full of expanded tallies stops reading as a document.
    expect(screen.queryByText("Which navigation model?")).toBeNull();

    fireEvent.click(
      screen.getByTestId("decision-sealed").querySelector("button")!
    );
    expect(screen.getByText("Which navigation model?")).toBeTruthy();
  });
});
