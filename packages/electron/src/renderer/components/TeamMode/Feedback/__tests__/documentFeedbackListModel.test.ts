// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { DocumentFeedbackIndexEntry } from "@nimbalyst/collab-protocol";
import {
  selectUnifiedFeedbackRows,
  documentFeedbackDeepLink,
} from "../documentFeedbackListModel";

const entry: DocumentFeedbackIndexEntry = {
  orgId: "org",
  documentId: "doc",
  blockId: "one",
  projectId: "project",
  title: "Approve?",
  sentBy: "sender",
  sentAt: 1,
  updatedAt: 1,
  sealed: false,
  availability: "available",
  recipientCount: 2,
  answeredCount: 1,
  quorum: 1,
  isRecipient: true,
  needsMyResponse: true,
};
const select = (question: DocumentFeedbackIndexEntry) =>
  selectUnifiedFeedbackRows({
    requests: [],
    questions: [question],
    viewerUserId: "recipient",
    memberNames: {},
    filter: "all",
    query: "",
    now: 2,
  });
describe("document feedback lifecycle", () => {
  it("keeps an unanswered recipient pending after quorum and stops after their answer or settlement", () => {
    expect(select(entry).counts).toMatchObject({
      answered: 1,
      closed: 0,
      open: 0,
      needsMyResponse: 1,
    });
    expect(
      select({ ...entry, needsMyResponse: false }).counts.needsMyResponse
    ).toBe(0);
    expect(
      select({ ...entry, sealed: true, needsMyResponse: false }).counts
    ).toMatchObject({ closed: 1, answered: 0, needsMyResponse: 0 });
  });
  it("opens a removed question at its document without targeting another block", () => {
    expect(
      documentFeedbackDeepLink({ ...entry, availability: "blockRemoved" })
    ).toBe("nimbalyst://doc/doc?orgId=org&projectId=project");
  });
});
