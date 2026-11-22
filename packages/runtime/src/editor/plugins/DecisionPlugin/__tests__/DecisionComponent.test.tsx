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
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
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

const authority = { loaded: true, privacyVersion: 1 as const };

function renderBlock(
  fence: string,
  options: {
    viewerId?: string;
    doc?: Y.Doc;
    config?: Partial<DecisionsConfig>;
  } = {}
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
    ...(options.config?.requestDecision
      ? {}
      : {
          onDecisionState: (
            listener: Parameters<
              NonNullable<DecisionsConfig["onDecisionState"]>
            >[0]
          ) => {
            listener([], authority);
            return () => {};
          },
        }),
    ...options.config,
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

  it("writes a hand-written block's id into the fence with the first vote, so the vote survives a reload", () => {
    const { doc } = renderBlock(SINGLE.replace("id: dcn-1\n", ""));
    fireEvent.click(screen.getByText("Icon gutter"));
    fireEvent.click(screen.getByTestId("decision-answer"));

    const [key] = Object.keys(doc.getMap("decisions").toJSON());
    const blockId = key.split("\x1f")[0];
    expect(blockId).toMatch(/^dcn-[0-9a-f]{6}$/);
    expect(testNode.content).toBe(`id: ${blockId}\n${SINGLE.replace("id: dcn-1\n", "")}`);
  });

  it("keeps a private multiSelect tally hidden after one answer until the server unlocks every assigned ask", async () => {
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

    const ownVote = {
      voterId: "greg",
      answer: { type: "multiSelect" as const, selectedIds: ["trackers"] },
      at: 2,
    };
    const state = {
      blockId: "dcn-2",
      recipientIds: ["greg", "karl"],
      sentAt: 1,
      sentBy: "karl",
      quorum: 2,
      answeredIds: [],
      sealed: false,
      privateResponses: { votes: [], canSeeAll: false, responseVersion: 0 },
    };
    let publish!: (
      states: import("@nimbalyst/collab-protocol").DocumentDecisionDeliveryState[]
    ) => void;
    const requestDecision = vi.fn(async (command) => {
      const result = {
        ...authority,
        decisions: [
          command.operation === "list"
            ? state
            : {
                ...state,
                privateResponses: {
                  ...state.privateResponses,
                  myVote: ownVote,
                  responseVersion: 1,
                },
              },
        ],
      };
      publish(result.decisions);
      return result;
    });
    renderBlock(multi, {
      doc,
      viewerId: "greg",
      config: {
        requestDecision,
        onDecisionState: (listener) => {
          publish = (states) => listener(states, authority);
          return () => {};
        },
      },
    });
    await waitFor(() =>
      expect(screen.queryByText("Loading private answer status…")).toBeNull()
    );
    expect(screen.getByText(/Results stay hidden/)).toBeDefined();
    fireEvent.click(screen.getByText("Editable trackers"));
    fireEvent.click(screen.getByTestId("decision-answer"));
    await waitFor(() =>
      expect(screen.getByTestId("decision-change")).toBeDefined()
    );
    expect(screen.getByText(/Results stay hidden/)).toBeDefined();
    expect(doc.getMap("decisions").size).toBe(1);
    act(() =>
      publish([
        {
          ...state,
          privateResponses: {
            ...state.privateResponses,
            myVote: ownVote,
            canSeeAll: true,
            responseVersion: 1,
            votes: [
              { ...ownVote, voterId: "anonymous-1" },
              { ...ownVote, voterId: "anonymous-2" },
            ],
          },
        },
      ])
    );
    expect(screen.queryByText(/Results stay hidden/)).toBeNull();
    expect(screen.getByText(/2 answered/)).toBeDefined();
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

  it("offers a written Other answer when allowOther is set, and seals the text", () => {
    const fence = `${SINGLE}\nallowOther: true`;
    testNode.content = fence;
    const config: DecisionsConfig = {
      getYDoc: () => null,
      currentUser: { id: "greg", name: "Greg" },
    };
    render(
      <DecisionsProvider config={config}>
        <DecisionComponent className="" content={fence} nodeKey="k1" />
      </DecisionsProvider>
    );

    const answer = screen.getByTestId("decision-answer") as HTMLButtonElement;
    fireEvent.click(screen.getByTestId("decision-other-row"));
    // Choosing Other with nothing written is not an answer yet.
    expect(answer.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("decision-other-text"), {
      target: { value: "Both, gutter on desktop" },
    });
    expect(answer.disabled).toBe(false);
    fireEvent.click(answer);
    expect(testNode.content).toContain("resolved: Both, gutter on desktop");
  });

  it("shows no Other row without allowOther", () => {
    renderBlock(SINGLE);
    expect(screen.queryByTestId("decision-other-row")).toBeNull();
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

describe("decision delivery approval", () => {
  it("keeps a failed send retryable and never reports delivery from asked metadata alone", async () => {
    testNode.content = SINGLE;
    const requestDecision = vi.fn(async (command: { operation: string }) => {
      if (command.operation === "list") return { ...authority, decisions: [] };
      throw new Error("Server did not acknowledge the document.");
    });
    const config: DecisionsConfig = {
      getYDoc: () => new Y.Doc(),
      currentUser: { id: "greg", name: "Greg" },
      getMembers: () => [{ id: "karl", name: "Karl" }],
      requestDecision,
    };
    render(
      <DecisionsProvider config={config}>
        <DecisionComponent className="" content={SINGLE} nodeKey="k1" />
      </DecisionsProvider>
    );
    fireEvent.click(screen.getByText("Ask teammates"));
    fireEvent.click(screen.getByLabelText("Karl"));
    fireEvent.click(screen.getByText("Send question"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "did not acknowledge"
      )
    );
    expect(testNode.content).toContain("asked:");
    expect(screen.queryByText("1 of 1 asked teammates answered")).toBeNull();
    fireEvent.click(screen.getByText("Send question"));
    await waitFor(() =>
      expect(
        requestDecision.mock.calls.filter(
          ([command]) => command.operation === "send"
        )
      ).toHaveLength(2)
    );
    expect(requestDecision).toHaveBeenLastCalledWith({
      operation: "send",
      blockId: "dcn-1",
      recipientIds: ["karl"],
    });
  });

  it("refuses to send through an authoring surface made stale by a remote seal", async () => {
    testNode.content = SINGLE;
    const requestDecision = vi.fn(async () => ({
      ...authority,
      decisions: [],
    }));
    const config: DecisionsConfig = {
      getYDoc: () => new Y.Doc(),
      currentUser: { id: "greg", name: "Greg" },
      getMembers: () => [{ id: "karl", name: "Karl" }],
      requestDecision,
    };
    render(
      <DecisionsProvider config={config}>
        <DecisionComponent className="" content={SINGLE} nodeKey="k1" />
      </DecisionsProvider>
    );
    fireEvent.click(screen.getByText("Ask teammates"));
    fireEvent.click(screen.getByLabelText("Karl"));
    testNode.content +=
      '\nresolved: gutter\nresolvedBy: Karl\nresolvedAt: "2026-09-05"';
    fireEvent.click(screen.getByText("Send question"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "question has changed"
      )
    );
    expect(requestDecision).toHaveBeenCalledTimes(1);
    expect(testNode.content).toContain("resolvedBy: Karl");
  });
});

it("shows private save pending and errors without recording an optimistic answer", async () => {
  let rejectAnswer!: (error: Error) => void;
  const state = {
    blockId: "dcn-1",
    recipientIds: ["greg"],
    sentAt: 1,
    sentBy: "karl",
    quorum: 1,
    answeredIds: [],
    sealed: false,
    privateResponses: { votes: [], canSeeAll: false, responseVersion: 0 },
  };
  const requestDecision = vi.fn(async (command) => {
    if (command.operation === "list")
      return { ...authority, decisions: [state] };
    return new Promise<
      import("@nimbalyst/collab-protocol").DocumentDecisionResult
    >((_resolve, reject) => {
      rejectAnswer = reject;
    });
  });
  const { doc } = renderBlock(`${SINGLE}\nvisibility: hiddenUntilAnswered`, {
    config: { requestDecision },
  });
  await waitFor(() =>
    expect(screen.getByText("Icon gutter").closest("button")?.disabled).toBe(
      false
    )
  );
  fireEvent.click(screen.getByText("Icon gutter"));
  fireEvent.click(screen.getByTestId("decision-answer"));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("Saving")
  );
  expect(doc.getMap("decisions").size).toBe(0);
  rejectAnswer(new Error("Private answer could not be acknowledged"));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be acknowledged"
    )
  );
  expect(screen.queryByTestId("decision-change")).toBeNull();
});

it("lets the private author see the anonymous tally and seal without adding their own answer", async () => {
  const state = {
    blockId: "dcn-1",
    recipientIds: ["karl"],
    sentAt: 1,
    sentBy: "greg",
    quorum: 1,
    answeredIds: ["anonymous-1"],
    sealed: false,
    privateResponses: {
      votes: [
        {
          voterId: "anonymous-1",
          answer: { type: "singleSelect" as const, selectedId: "gutter" },
          at: 0,
        },
      ],
      canSeeAll: true,
      responseVersion: 0,
    },
  };
  renderBlock(`${SINGLE}\nvisibility: hiddenUntilAnswered`, {
    config: {
      requestDecision: vi
        .fn()
        .mockResolvedValue({ ...authority, decisions: [state] }),
    },
  });
  await waitFor(() =>
    expect(screen.getByTestId("decision-seal")).toBeDefined()
  );
  expect(screen.getByText(/1 answered/)).toBeDefined();
  expect(screen.queryByText(/results hidden/)).toBeNull();
});

it("reconciles a pinned private seal without copying anonymous ballots, notes or proposal identities to markdown", async () => {
  const doc = new Y.Doc();
  doc.getMap("decisionSeals").set("dcn-1", {
    outcome: "gutter",
    resolvedBy: "Greg",
    resolvedAt: "2026-09-05T12:00:00Z",
    resolvedFrom: "PRIVATE_ID",
  });
  const state = {
    blockId: "dcn-1",
    recipientIds: ["greg"],
    sentAt: 1,
    sentBy: "greg",
    quorum: 1,
    answeredIds: [],
    sealed: false,
    privateResponses: {
      votes: [
        {
          voterId: "anonymous-1",
          answer: { type: "singleSelect" as const, selectedId: "gutter" },
          at: 0,
          note: "PRIVATE_NOTE",
        },
      ],
      canSeeAll: true,
      responseVersion: 0,
    },
  };
  renderBlock(SINGLE, {
    doc,
    config: {
      requestDecision: vi
        .fn()
        .mockResolvedValue({ ...authority, decisions: [state] }),
    },
  });
  await waitFor(() => expect(testNode.content).toContain("resolved: gutter"));
  expect(testNode.content).not.toContain("PRIVATE_");
  expect(testNode.content).not.toContain("votes:");
  expect(testNode.content).not.toContain("anonymous-1");
});

it("keeps private answering disabled through hydration and unsupported or unsent transport", async () => {
  const doc = new Y.Doc();
  const fence = `${SINGLE}\nvisibility: hiddenUntilAnswered`;
  const base: DecisionsConfig = {
    getYDoc: () => doc,
    currentUser: { id: "greg", name: "Greg" },
    isHydrated: () => false,
  };
  testNode.content = fence;
  const view = render(
    <DecisionsProvider config={base}>
      <DecisionComponent className="" content={fence} nodeKey="k1" />
    </DecisionsProvider>
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Loading private answer status"
  );
  expect(
    (screen.getByTestId("decision-answer") as HTMLButtonElement).disabled
  ).toBe(true);
  fireEvent.click(screen.getByTestId("decision-answer"));
  expect(doc.getMap("decisions").size).toBe(0);
  view.rerender(
    <DecisionsProvider config={{ ...base, isHydrated: () => true }}>
      <DecisionComponent className="" content={fence} nodeKey="k1" />
    </DecisionsProvider>
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Send this question before collecting private answers"
  );
  expect(
    (screen.getByTestId("decision-answer") as HTMLButtonElement).disabled
  ).toBe(true);
  const requestDecision = vi
    .fn()
    .mockResolvedValue({ ...authority, decisions: [] });
  view.rerender(
    <DecisionsProvider
      config={{ ...base, isHydrated: () => true, requestDecision }}
    >
      <DecisionComponent className="" content={fence} nodeKey="k1" />
    </DecisionsProvider>
  );
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "Send this question before collecting private answers"
    )
  );
  fireEvent.click(screen.getByTestId("decision-answer"));
  expect(requestDecision).toHaveBeenCalledExactlyOnceWith({
    operation: "list",
  });
  expect(doc.getMap("decisions").size).toBe(0);
});

it("retains authorized private delivery after a successful Send through a request-only host", async () => {
  const state = {
    blockId: "dcn-1",
    recipientIds: ["greg"],
    sentAt: 1,
    sentBy: "greg",
    quorum: 1,
    answeredIds: [],
    sealed: false,
    privateResponses: { votes: [], canSeeAll: true, responseVersion: 0 },
  };
  const requestDecision = vi.fn(async (command) => ({
    ...authority,
    decisions:
      command.operation === "list"
        ? []
        : [
            {
              ...state,
              ...(command.operation === "nudge" ? { answeredCount: 1 } : {}),
            },
          ],
  }));
  renderBlock(`${SINGLE}\nvisibility: hiddenUntilAnswered`, {
    config: { requestDecision },
  });
  await waitFor(() =>
    expect(
      screen.getByText("Send this question before collecting private answers.")
    ).toBeDefined()
  );
  fireEvent.click(screen.getByText("Ask teammates"));
  fireEvent.click(screen.getByLabelText("Greg"));
  fireEvent.click(screen.getByText("Send question"));
  await waitFor(() =>
    expect(screen.getByText("0 of 1 asked teammates answered")).toBeDefined()
  );
  expect(
    screen.queryByText("Send this question before collecting private answers.")
  ).toBeNull();
  fireEvent.click(screen.getByText("Remind unanswered teammates"));
  await waitFor(() =>
    expect(screen.getByText("1 of 1 asked teammates answered")).toBeDefined()
  );
});
