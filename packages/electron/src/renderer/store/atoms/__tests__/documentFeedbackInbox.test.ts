// @vitest-environment node
import { expect, it } from "vitest";
import { withDocumentFeedbackState } from "../documentFeedbackInbox";
import { inboxNavCount } from "../../../components/TeamMode/Inbox/inboxViewModel";

it("counts only unanswered assignments, never result notifications, and drops answered or unavailable questions", () => {
  const delivery = {
    id: "ask",
    orgId: "org",
    teamMemberId: "me",
    reason: "assignment",
    source: {
      orgId: "org",
      resourceKind: "document",
      resourceId: "doc",
      blockId: "one",
      eventClass: "documentDecisionRequested",
    },
  };
  const snapshot = {
    status: "ready",
    organizations: [],
    deliveries: [
      delivery,
      {
        ...delivery,
        id: "result",
        reason: "reply",
        source: { ...delivery.source, eventClass: "documentDecisionResolved" },
      },
    ],
  } as any;
  const index = {
    workspacePath: "/work",
    orgId: "org",
    teamMemberId: "me",
    state: {
      generation: 1,
      entries: [{ documentId: "doc", blockId: "one", needsMyResponse: true }],
    },
  } as any;
  expect(
    inboxNavCount(
      withDocumentFeedbackState(snapshot, { one: index }),
      "org",
      "awaiting"
    )
  ).toBe(1);
  index.state.entries[0].needsMyResponse = false;
  expect(
    inboxNavCount(
      withDocumentFeedbackState(snapshot, { one: index }),
      "org",
      "awaiting"
    )
  ).toBe(0);
  expect(
    inboxNavCount(withDocumentFeedbackState(snapshot, {}), "org", "awaiting")
  ).toBe(0);
});
